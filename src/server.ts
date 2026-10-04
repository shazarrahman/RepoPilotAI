import Fastify from "fastify";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./db.js";
import { hashPassword, verifyPassword } from "./services/passwords.js";
import { splitIntoChunks } from "./services/chunks.js";
import { AIProviderError, aiProvider, embedTexts, mockRelevance } from "./services/ai-provider.js";
import { fetchGitHubRepository, GitHubImportError } from "./services/github.js";
import { AIUsageLimitError, estimateAITokens, reserveAIUsage } from "./services/usage.js";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

declare module "@fastify/jwt" { interface FastifyJWT { user: { id: string; email: string } } }

const app = Fastify({ logger: true });
app.addHook("onSend", async (_request, reply, payload) => {
  reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (config.NODE_ENV === "production") reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return payload;
});
await app.register(jwt, { secret: config.JWT_SECRET, verify: { algorithms: ["HS256"] } });
await app.register(multipart, { limits: { fileSize: 2_000_000, files: 1 } });
await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
const auth = async (request: typeof app extends infer _ ? any : never) => request.jwtVerify();
const credentials = z.object({ email: z.string().email(), password: z.string().min(8).max(128) });
const reserveForAI = async (userId: string, text: string, outputTokens = 0) => {
  if (config.AI_PROVIDER === "mock") return;
  await reserveAIUsage(db, userId, estimateAITokens(text, outputTokens), config.AI_USER_DAILY_TOKEN_LIMIT, config.AI_GLOBAL_DAILY_TOKEN_LIMIT);
};

const health = async (_request: unknown, reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) => {
  try {
    const url = new URL(config.DATABASE_URL);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("Unsupported protocol");
  } catch {
    return reply.code(503).send({ status: "error", database: "invalid_configuration", message: "DATABASE_URL must be a valid PostgreSQL URI. URL-encode reserved characters in the username or password." });
  }
  try {
    const result = await db.query(`SELECT
      to_regclass('public.users') IS NOT NULL AS users,
      to_regclass('public.workspaces') IS NOT NULL AS workspaces,
      to_regclass('public.documents') IS NOT NULL AS documents,
      to_regclass('public.document_chunks') IS NOT NULL AS document_chunks,
      to_regclass('public.ai_usage_daily') IS NOT NULL AS ai_usage_daily,
      to_regclass('public.ai_usage_global_daily') IS NOT NULL AS ai_usage_global_daily,
      to_regclass('public.conversations') IS NOT NULL AS conversations,
      to_regclass('public.messages') IS NOT NULL AS messages,
      to_regtype('extensions.vector') IS NOT NULL AS pgvector`);
    const checks = result.rows[0] as Record<string, boolean>;
    const missing = Object.entries(checks).filter(([, available]) => !available).map(([name]) => name);
    if (missing.length) return reply.code(503).send({ status: "error", database: "connected", schema: "not_ready", missing });
    return { status: "ok", database: "connected", schema: "ready", pgvector: "enabled" };
  } catch {
    return reply.code(503).send({ status: "error", database: "unavailable" });
  }
};
app.get("/health", health);
app.get("/v1/health", health);
app.get("/", async (_request, reply) => reply.type("text/html").send(await readFile(join(process.cwd(), "public", "index.html"), "utf8")));
app.get("/app.css", async (_request, reply) => reply.type("text/css").send(await readFile(join(process.cwd(), "public", "app.css"), "utf8")));
app.get("/app.js", async (_request, reply) => reply.type("application/javascript").send(await readFile(join(process.cwd(), "public", "app.js"), "utf8")));
app.get("/favicon.svg", async (_request, reply) => reply.type("image/svg+xml").send(await readFile(join(process.cwd(), "public", "favicon.svg"), "utf8")));
app.post("/v1/auth/register", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
  const body = credentials.parse(request.body); const passwordHash = await hashPassword(body.password);
  try { const result = await db.query("INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email", [body.email.toLowerCase(), passwordHash]); return reply.code(201).send({ user: result.rows[0] }); }
  catch (error) {
    if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: "Email is already registered." });
    throw error;
  }
});
app.post("/v1/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
  const body = credentials.parse(request.body); const result = await db.query("SELECT id,email,password_hash FROM users WHERE email=$1", [body.email.toLowerCase()]); const user = result.rows[0];
  if (!user || !(await verifyPassword(body.password, user.password_hash))) return reply.code(401).send({ error: "Invalid email or password." });
  return { token: app.jwt.sign({ id: user.id, email: user.email }, { expiresIn: "15m" }), user: { id: user.id, email: user.email } };
});
app.get("/v1/workspaces", { preHandler: auth }, async (request) => (await db.query("SELECT id,name,created_at FROM workspaces WHERE owner_id=$1 ORDER BY created_at DESC", [request.user.id])).rows);
app.get("/v1/usage", { preHandler: auth }, async (request) => {
  const result = await db.query("SELECT estimated_tokens,request_count FROM ai_usage_daily WHERE user_id=$1 AND usage_date=(now() AT TIME ZONE 'UTC')::date", [request.user.id]);
  const estimatedTokens = Number(result.rows[0]?.estimated_tokens ?? 0);
  return { estimatedTokens, requests: Number(result.rows[0]?.request_count ?? 0), dailyLimit: config.AI_USER_DAILY_TOKEN_LIMIT, remainingTokens: Math.max(0, config.AI_USER_DAILY_TOKEN_LIMIT - estimatedTokens), resetTime: "midnight UTC" };
});
app.post("/v1/workspaces", { preHandler: auth }, async (request, reply) => {
  const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(request.body);
  const result = await db.query("INSERT INTO workspaces(owner_id,name) VALUES($1,$2) RETURNING id,name,created_at", [request.user.id, body.name]);
  return reply.code(201).send(result.rows[0]);
});
app.get("/v1/workspaces/:id/documents", { preHandler: auth }, async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const result = await db.query("SELECT d.id,d.filename,d.created_at FROM documents d JOIN workspaces w ON w.id=d.workspace_id WHERE w.id=$1 AND w.owner_id=$2 ORDER BY d.created_at", [params.id, request.user.id]);
  const ownsWorkspace = await db.query("SELECT 1 FROM workspaces WHERE id=$1 AND owner_id=$2", [params.id, request.user.id]);
  if (!ownsWorkspace.rowCount) return reply.code(404).send({ error: "Workspace not found." });
  return result.rows;
});
app.delete("/v1/workspaces/:id/documents/:documentId", { preHandler: auth }, async (request, reply) => {
  const params = z.object({ id: z.string().uuid(), documentId: z.string().uuid() }).parse(request.params);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("DELETE FROM documents d USING workspaces w WHERE d.id=$1 AND d.workspace_id=$2 AND w.id=d.workspace_id AND w.owner_id=$3 RETURNING d.id,d.filename", [params.documentId, params.id, request.user.id]);
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "Source not found in this workspace." });
    }
    const removedChats = await client.query(`DELETE FROM conversations c
      WHERE c.workspace_id=$1 AND EXISTS (
        SELECT 1 FROM messages m, jsonb_array_elements(m.citations) citation
        WHERE m.conversation_id=c.id AND citation->>'filename'=$2
      )`, [params.id, result.rows[0].filename]);
    await client.query("COMMIT");
    return { deleted: true, source: result.rows[0], conversationsDeleted: removedChats.rowCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});
app.delete("/v1/workspaces/:id", { preHandler: auth }, async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const result = await db.query("DELETE FROM workspaces WHERE id=$1 AND owner_id=$2 RETURNING id,name", [params.id, request.user.id]);
  if (!result.rowCount) return reply.code(404).send({ error: "Workspace not found." });
  return { deleted: true, workspace: result.rows[0] };
});
app.post("/v1/workspaces/:id/documents", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params); const own = await db.query("SELECT id FROM workspaces WHERE id=$1 AND owner_id=$2", [params.id, request.user.id]); if (!own.rowCount) return reply.code(404).send({ error: "Workspace not found." });
  const file = await request.file(); if (!file || !["text/plain", "text/markdown"].includes(file.mimetype) || !/\.(txt|md)$/i.test(file.filename)) return reply.code(400).send({ error: "Upload a .txt or .md file." });
  const content = (await file.toBuffer()).toString("utf8").trim(); if (!content) return reply.code(400).send({ error: "Document is empty." });
  const filename = basename(file.filename.replace(/\\/g, "/"));
  const chunkTexts = splitIntoChunks(content);
  const embeddings = await embedTexts(chunkTexts, async (chunk) => {
    await reserveForAI(request.user.id, chunk);
    return aiProvider.embed(chunk, "RETRIEVAL_DOCUMENT");
  }, { concurrency: 2, retries: 3, baseDelayMs: 1000 });
  const chunks = chunkTexts.map((chunk, index) => ({ index, content: chunk, embedding: `[${embeddings[index].join(",")}]` }));
  const client = await db.connect();
  let document;
  try {
    await client.query("BEGIN");
    document = await client.query("INSERT INTO documents(workspace_id,filename,content) VALUES($1,$2,$3) RETURNING id,filename", [params.id, filename, content]);
    for (const chunk of chunks) await client.query("INSERT INTO document_chunks(document_id,chunk_index,content,embedding) VALUES($1,$2,$3,$4::extensions.vector)", [document.rows[0].id, chunk.index, chunk.content, chunk.embedding]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return reply.code(201).send({ document: document.rows[0], chunksCreated: chunks.length });
});
app.post("/v1/workspaces/:id/repositories", { preHandler: auth, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({ repositoryUrl: z.string().url().max(500), accessToken: z.string().max(500).optional() }).parse(request.body);
  const own = await db.query("SELECT id FROM workspaces WHERE id=$1 AND owner_id=$2", [params.id, request.user.id]);
  if (!own.rowCount) return reply.code(404).send({ error: "Workspace not found." });

  const repository = await fetchGitHubRepository(body.repositoryUrl, body.accessToken || config.GITHUB_API_TOKEN);
  const prefix = `github.com/${repository.fullName}/`;
  const prepared = [];
  for (const file of repository.files) {
    const chunkTexts = splitIntoChunks(file.content, 1800, 200);
    const embeddings = await embedTexts(chunkTexts, async (chunk) => {
      await reserveForAI(request.user.id, chunk);
      return aiProvider.embed(chunk, "RETRIEVAL_DOCUMENT");
    }, { concurrency: 2, retries: 3, baseDelayMs: 1000 });
    const chunks = chunkTexts.map((chunk, index) => ({ index, content: chunk, embedding: `[${embeddings[index].join(",")}]` }));
    prepared.push({ filename: `${prefix}${file.path}`, content: file.content, chunks });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM conversations c
      WHERE c.workspace_id=$1 AND EXISTS (
        SELECT 1 FROM messages m, jsonb_array_elements(m.citations) citation
        WHERE m.conversation_id=c.id AND left(citation->>'filename',length($2))=$2
      )`, [params.id, prefix]);
    await client.query("DELETE FROM documents WHERE workspace_id=$1 AND left(filename,length($2))=$2", [params.id, prefix]);
    let chunksCreated = 0;
    for (const file of prepared) {
      const document = await client.query("INSERT INTO documents(workspace_id,filename,content) VALUES($1,$2,$3) RETURNING id", [params.id, file.filename, file.content]);
      for (const chunk of file.chunks) {
        await client.query("INSERT INTO document_chunks(document_id,chunk_index,content,embedding) VALUES($1,$2,$3,$4::extensions.vector)", [document.rows[0].id, chunk.index, chunk.content, chunk.embedding]);
        chunksCreated += 1;
      }
    }
    await client.query("COMMIT");
    return reply.code(201).send({ repository: repository.fullName, branch: repository.defaultBranch, filesIndexed: prepared.length, skippedFiles: repository.skippedFiles, chunksCreated });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});
app.post("/v1/workspaces/:id/questions", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params); const body = z.object({ question: z.string().min(3).max(2000), conversationId: z.string().uuid().optional() }).parse(request.body);
  const own = await db.query("SELECT id FROM workspaces WHERE id=$1 AND owner_id=$2", [params.id, request.user.id]);
  if (!own.rowCount) return reply.code(404).send({ error: "Workspace not found." });
  let history: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (body.conversationId) {
    const conversation = await db.query("SELECT id FROM conversations WHERE id=$1 AND workspace_id=$2", [body.conversationId, params.id]);
    if (!conversation.rowCount) return reply.code(404).send({ error: "Conversation not found in this workspace." });
    const previous = await db.query("SELECT role,content FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 8", [body.conversationId]);
    history = previous.rows.reverse().map((message) => ({ role: message.role, content: message.content }));
  }
  const contextualQuestion = [...history.filter((message) => message.role === "user").slice(-3).map((message) => message.content), body.question].join("\n");
  await reserveForAI(request.user.id, contextualQuestion);
  const embedding = await aiProvider.embed(contextualQuestion, "QUESTION_ANSWERING");
  const result = await db.query("SELECT d.filename,c.chunk_index,c.content,(c.embedding <=> $3::extensions.vector) AS distance FROM document_chunks c JOIN documents d ON d.id=c.document_id JOIN workspaces w ON w.id=d.workspace_id WHERE w.id=$1 AND w.owner_id=$2 AND c.embedding IS NOT NULL ORDER BY c.embedding <=> $3::extensions.vector LIMIT 5", [params.id, request.user.id, `[${embedding.join(",")}]`]);
  const matches = result.rows.filter((row) => config.AI_PROVIDER === "mock" ? mockRelevance(body.question, row.content) >= 0.25 : Number(row.distance) <= 0.55);
  const noEvidenceAnswer = "I could not find enough relevant evidence for this question in your indexed sources.";
  const citations = matches.map((row) => ({ filename: row.filename, chunkIndex: row.chunk_index }));
  const context = matches.map((row) => `[${row.filename}, chunk ${row.chunk_index}]\n${row.content}`).join("\n\n");
  const answer = matches.length
    ? (await reserveForAI(request.user.id, `${body.question}\n${JSON.stringify(history)}\n${context}`, config.AI_MAX_OUTPUT_TOKENS), await aiProvider.answer(body.question, context, history))
    : noEvidenceAnswer;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const conversationId = body.conversationId
      ? (await client.query("SELECT id FROM conversations WHERE id=$1 AND workspace_id=$2", [body.conversationId, params.id])).rows[0]?.id
      : (await client.query("INSERT INTO conversations(workspace_id,title) VALUES($1,$2) RETURNING id", [params.id, body.question.slice(0, 120)])).rows[0].id;
    if (!conversationId) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "Conversation not found in this workspace." });
    }
    await client.query("INSERT INTO messages(conversation_id,role,content,citations) VALUES($1,'user',$2,'[]'::jsonb),($1,'assistant',$3,$4::jsonb)", [conversationId, body.question, answer, JSON.stringify(citations)]);
    await client.query("UPDATE conversations SET updated_at=now() WHERE id=$1", [conversationId]);
    await client.query("COMMIT");
    return reply.send({ answer, citations, conversationId });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});
app.get("/v1/workspaces/:id/conversations", { preHandler: auth }, async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const owns = await db.query("SELECT 1 FROM workspaces WHERE id=$1 AND owner_id=$2", [params.id, request.user.id]);
  if (!owns.rowCount) return reply.code(404).send({ error: "Workspace not found." });
  return (await db.query("SELECT id,title,created_at,updated_at FROM conversations WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 50", [params.id])).rows;
});
app.get("/v1/workspaces/:id/conversations/:conversationId", { preHandler: auth }, async (request, reply) => {
  const params = z.object({ id: z.string().uuid(), conversationId: z.string().uuid() }).parse(request.params);
  const owns = await db.query("SELECT c.id,c.title,c.created_at,c.updated_at FROM conversations c JOIN workspaces w ON w.id=c.workspace_id WHERE c.id=$1 AND c.workspace_id=$2 AND w.owner_id=$3", [params.conversationId, params.id, request.user.id]);
  if (!owns.rowCount) return reply.code(404).send({ error: "Conversation not found in this workspace." });
  const messages = await db.query("SELECT id,role,content,citations,created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at,id", [params.conversationId]);
  return { conversation: owns.rows[0], messages: messages.rows };
});
app.delete("/v1/workspaces/:id/conversations/:conversationId", { preHandler: auth }, async (request, reply) => {
  const params = z.object({ id: z.string().uuid(), conversationId: z.string().uuid() }).parse(request.params);
  const result = await db.query("DELETE FROM conversations c USING workspaces w WHERE c.id=$1 AND c.workspace_id=$2 AND w.id=c.workspace_id AND w.owner_id=$3 RETURNING c.id", [params.conversationId, params.id, request.user.id]);
  if (!result.rowCount) return reply.code(404).send({ error: "Conversation not found in this workspace." });
  return { deleted: true };
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof AIProviderError) return reply.code(error.statusCode).send({ error: error.message, providerStatus: error.providerStatus });
  if (error instanceof AIUsageLimitError) return reply.code(error.statusCode).send({ error: error.message, scope: error.scope });
  if (error instanceof GitHubImportError) return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request.", details: error.flatten() });
  const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
  if (statusCode < 500) return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "Request failed." });
  app.log.error(error); return reply.code(500).send({ error: "The server could not complete this request. Check the database or AI provider connection and try again." });
});
await app.listen({ port: config.PORT, host: config.HOST });

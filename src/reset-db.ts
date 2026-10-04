import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "./db.js";

const prompt = createInterface({ input: stdin, output: stdout });
const answer = await prompt.question("WARNING: this deletes all RepoPilotAI users, workspaces, sources, chats, and usage history in DATABASE_URL. Type RESET to continue: ");
prompt.close();

if (answer !== "RESET") {
  console.log("Database reset cancelled.");
  await db.end();
  process.exit(0);
}

const client = await db.connect();
try {
  await client.query("BEGIN");
  await client.query(`DROP TABLE IF EXISTS
    public.messages,
    public.conversations,
    public.document_chunks,
    public.documents,
    public.workspaces,
    public.ai_usage_daily,
    public.ai_usage_global_daily,
    public.schema_migrations,
    public.users
    CASCADE`);
  await client.query(await readFile(join(process.cwd(), "db", "schema.sql"), "utf8"));
  await client.query("COMMIT");
  console.log("RepoPilotAI tables reset and rebuilt. PostgreSQL extensions were preserved.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await db.end();
}
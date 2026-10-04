# RepoPilotAI

RepoPilotAI is an AI-powered developer workspace for understanding documents and codebases. Users will be able to upload documents or connect supported GitHub repositories, ask questions in plain language, and receive answers grounded in the indexed source material.

The project is being built step by step as a practical learning journey into TypeScript, Node.js, APIs, databases, RAG, and production-minded AI engineering.

## MVP

The current MVP lets a user:

- Register and log in securely
- Create a workspace
- Upload text and Markdown documents
- Connect public GitHub repositories or private repositories using an optional one-time read-only token
- Search document and source-code content using embeddings and vector search
- Ask questions about indexed sources and receive file-path or document citations

RepoPilotAI is a source-grounded assistant for your documents and codebase, not a general-purpose ChatGPT replacement. Repository imports are read-only, bounded to 40 text/code files and 500 KB per import, and never execute repository content.

## How It Works

1. A user uploads a document or connects a GitHub repository to a workspace.
2. RepoPilotAI extracts document text or reads supported repository text/code files, then splits them into chunks.
3. Each chunk is converted into an embedding and stored for semantic search.
4. When the user asks a question, the application retrieves the most relevant chunks.
5. An AI model uses that context to produce an answer with citations.

## Run Locally

1. Put your PostgreSQL connection URI in `.env` as `DATABASE_URL`. The database user needs permission to create the `vector` extension and application tables. The application loads `.env` automatically; do not share or commit it.
2. Install dependencies and create or update the application schema from this repository:

   ```bash
   npm install
   npm run db:migrate
   ```

3. Start the API:

   ```bash
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000).

To erase **all RepoPilotAI users, workspaces, sources, conversations, and usage history** and rebuild a fresh schema, run `npm run db:reset`. It connects to the `DATABASE_URL` in `.env` and proceeds only if you type `RESET` at the confirmation prompt. PostgreSQL extensions are preserved. Back up anything you need first; this cannot be undone.

The default `mock` AI provider needs no key. For meaningful semantic retrieval and generated answers, set `AI_PROVIDER=gemini` and add your private Gemini key in `.env`; see `.env.example`.

Public GitHub repositories can be imported by URL without a token. To avoid the shared anonymous API quota on a self-hosted instance, the administrator can optionally set `GITHUB_API_TOKEN` in the server's `.env` using a fine-grained token with public repository read-only access. Users can also provide a token in the import form; for a private repository, it needs **Contents: Read-only** access to that repository. User-provided tokens are used for that request only and are not saved. Never put a GitHub token in a repository URL.

Each account can create multiple workspaces. Documents, indexed repository files, and saved conversations are scoped to their workspace. Remove a source from the source list to delete its content and chunks; chats citing that source are deleted as well. Re-importing a repository replaces its previous indexed snapshot and removes chats citing that snapshot. Deleting a workspace removes all its sources and conversations. There is no automatic expiry; users control retention explicitly.

Paid Gemini calls reserve conservative per-user and shared daily token budgets before calling the provider. Defaults are 50,000 estimated tokens per user and 250,000 across the service per UTC day; tune `AI_USER_DAILY_TOKEN_LIMIT`, `AI_GLOBAL_DAILY_TOKEN_LIMIT`, and `AI_MAX_OUTPUT_TOKENS` in `.env`. Reservations are intentionally not refunded when a provider call fails. These are application-level token limits, not a guarantee of a specific invoice amount; configure provider-side quotas/billing alerts as a second control.

## Stack

- **Backend:** Node.js, TypeScript, Fastify
- **Database:** PostgreSQL with pgvector
- **Validation:** Zod
- **Authentication:** JWT with securely hashed passwords
- **Testing:** Vitest (test suite to be expanded)
- **Database hosting:** your configured PostgreSQL + pgvector instance; Docker is not required


## Guiding Principles

- Build a small, working feature before adding complexity.
- Keep answers grounded in retrieved source material.
- Show citations so users can verify AI responses.
- Keep each user's workspace data private and separate.
- Test, document, and understand each feature before moving on.

## Roadmap

1. API foundation, database, authentication, workspaces, and uploads
2. Cited RAG document questions with swappable AI provider support
3. Expanded codebase chat, broader repository indexing, tests, CI, and deployment polish

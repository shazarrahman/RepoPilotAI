# RepoPilotAI

RepoPilotAI is an AI-powered developer workspace for understanding documents and codebases. Users will be able to upload documents or connect supported GitHub repositories, ask questions in plain language, and receive answers grounded in the indexed source material.

The project is being built step by step as a practical learning journey into TypeScript, Node.js, APIs, databases, RAG, and production-minded AI engineering.

## MVP

The first version will allow a user to:

- Register and log in securely
- Create a workspace
- Upload text, Markdown, and PDF documents
- Search document content using embeddings and vector search
- Ask questions and receive answers with source citations

Repository ingestion, code explanation, documentation generation, and workflow orchestration are planned after the document RAG foundation is reliable.

## How It Works

1. A user uploads a document to a workspace.
2. RepoPilotAI extracts the text and splits it into small chunks.
3. Each chunk is converted into an embedding and stored for semantic search.
4. When the user asks a question, the application retrieves the most relevant chunks.
5. An AI model uses that context to produce an answer with citations.

## Planned Stack

- **Backend:** Node.js, TypeScript, Fastify
- **Database:** PostgreSQL with pgvector
- **Validation:** Zod
- **Authentication:** JWT with securely hashed passwords
- **Testing:** Vitest
- **Code quality:** ESLint and Prettier
- **Local services:** Docker Compose


## Guiding Principles

- Build a small, working feature before adding complexity.
- Keep answers grounded in retrieved source material.
- Show citations so users can verify AI responses.
- Keep each user's workspace data private and separate.
- Test, document, and understand each feature before moving on.

## Roadmap

1. API foundation, database, authentication, and tests
2. Workspaces and document upload
3. RAG search with cited answers
4. Public GitHub repository ingestion
5. Developer-focused AI features
6. Optional workflow orchestration
7. Docker, CI, deployment, and portfolio polish
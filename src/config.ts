import { z } from "zod";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

export const config = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().url().refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol), "DATABASE_URL must be a PostgreSQL URI").default("postgres://repopilot:repopilot@localhost:5432/repopilot"),
  JWT_SECRET: z.string().min(16).default("development-secret-change-me"),
  AI_PROVIDER: z.enum(["mock", "gemini"]).default("mock"),
  AI_BASE_URL: z.string().url().optional(), AI_API_KEY: z.string().optional(), AI_CHAT_MODEL: z.string().optional(), AI_EMBEDDING_MODEL: z.string().optional(),
  GITHUB_API_TOKEN: z.string().min(1).optional(),
  AI_USER_DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().default(1_000_000),
  AI_GLOBAL_DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().default(5_000_000),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(2048).default(512)
}).parse(process.env);

if (config.NODE_ENV === "production") {
  if (!process.env.JWT_SECRET || config.JWT_SECRET.length < 32 || /development-secret|replace-with|change-me|your-secret|placeholder|example/i.test(config.JWT_SECRET)) {
    throw new Error("Production requires an explicitly configured JWT_SECRET with at least 32 characters.");
  }
  if (!process.env.DATABASE_URL) throw new Error("Production requires an explicitly configured DATABASE_URL.");
  if (config.AI_PROVIDER === "mock") throw new Error("Production cannot use the mock AI provider.");
  if (config.AI_PROVIDER === "gemini" && !config.AI_API_KEY) throw new Error("Production Gemini configuration requires AI_API_KEY.");
}

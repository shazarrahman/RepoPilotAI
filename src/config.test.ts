import { afterEach, describe, expect, it, vi } from "vitest";

describe("production configuration", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("refuses production with the development secret and mock AI", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://repo:secret@db.example.test:5432/repo?sslmode=require");
    vi.stubEnv("AI_PROVIDER", "mock");
    vi.stubEnv("JWT_SECRET", "development-secret-change-me");

    await expect(import("./config.js")).rejects.toThrow(/JWT_SECRET/);
  });

  it("accepts explicit production secrets and a real provider", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://repo:secret@db.example.test:5432/repo?sslmode=require");
    vi.stubEnv("JWT_SECRET", "a-long-random-production-secret-with-more-than-thirty-two-characters");
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("AI_API_KEY", "test-key");

    const { config } = await import("./config.js");
    expect(config.NODE_ENV).toBe("production");
    expect(config.AI_PROVIDER).toBe("gemini");
  });
});
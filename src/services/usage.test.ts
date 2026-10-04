import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { AIUsageLimitError, estimateAITokens, reserveAIUsage } from "./usage.js";

function fakePool(runQuery: (sql: string) => { rowCount: number; rows: Array<{ estimated_tokens: number }> }) {
  const query = vi.fn(async (sql: string) => runQuery(sql));
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { pool: { connect: vi.fn(async () => client) } as unknown as Pool, query, client };
}

describe("AI usage budgets", () => {
  it("estimates input conservatively and includes the output cap", () => {
    expect(estimateAITokens("hello", 512)).toBe(Buffer.byteLength("hello", "utf8") + 640);
  });

  it("reserves a user's and the shared daily budget atomically", async () => {
    const { pool, query, client } = fakePool((sql) => {
      if (sql.includes("INSERT INTO ai_usage_daily")) return { rowCount: 1, rows: [{ estimated_tokens: 120 }] };
      if (sql.includes("INSERT INTO ai_usage_global_daily")) return { rowCount: 1, rows: [{ estimated_tokens: 120 }] };
      return { rowCount: 1, rows: [] };
    });

    const usage = await reserveAIUsage(pool, "user-id", 120, 1000, 5000);

    expect(usage).toEqual({ userTokens: 120, globalTokens: 120 });
    expect(query.mock.calls.some(([sql]) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back when a user's daily limit would be exceeded", async () => {
    const { pool, query } = fakePool((sql) => sql.includes("INSERT INTO ai_usage_daily")
      ? { rowCount: 0, rows: [] }
      : { rowCount: 1, rows: [] });

    await expect(reserveAIUsage(pool, "user-id", 101, 100, 5000)).rejects.toBeInstanceOf(AIUsageLimitError);
    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO ai_usage_global_daily"))).toBe(false);
  });

  it("rolls back a user reservation when the shared daily limit is reached", async () => {
    const { pool, query } = fakePool((sql) => sql.includes("INSERT INTO ai_usage_global_daily")
      ? { rowCount: 0, rows: [] }
      : { rowCount: 1, rows: [{ estimated_tokens: 100 }] });

    await expect(reserveAIUsage(pool, "user-id", 101, 1000, 100)).rejects.toMatchObject({ scope: "global", statusCode: 429 });
    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
  });
});
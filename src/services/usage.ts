import type { Pool } from "pg";

export class AIUsageLimitError extends Error {
  readonly statusCode = 429;

  constructor(readonly scope: "user" | "global") {
    super(scope === "user"
      ? "Your daily AI budget has been reached. It resets at midnight UTC."
      : "The service has reached its shared daily AI budget. Try again tomorrow.");
  }
}

export function estimateAITokens(text: string, outputTokens = 0) {
  return Math.max(1, Buffer.byteLength(text, "utf8") + outputTokens + 128);
}

export async function reserveAIUsage(pool: Pool, userId: string, estimatedTokens: number, userLimit: number, globalLimit: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('repopilot-ai-budget'), hashtext((now() AT TIME ZONE 'UTC')::date::text))");
    const userUsage = await client.query(`
      INSERT INTO ai_usage_daily (user_id, usage_date, estimated_tokens, request_count)
      VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $2, 1)
      ON CONFLICT (user_id, usage_date) DO UPDATE SET
        estimated_tokens = ai_usage_daily.estimated_tokens + EXCLUDED.estimated_tokens,
        request_count = ai_usage_daily.request_count + 1
      WHERE ai_usage_daily.estimated_tokens + EXCLUDED.estimated_tokens <= $3
      RETURNING estimated_tokens`, [userId, estimatedTokens, userLimit]);
    if (!userUsage.rowCount) throw new AIUsageLimitError("user");

    const globalUsage = await client.query(`
      INSERT INTO ai_usage_global_daily (usage_date, estimated_tokens, request_count)
      VALUES ((now() AT TIME ZONE 'UTC')::date, $1, 1)
      ON CONFLICT (usage_date) DO UPDATE SET
        estimated_tokens = ai_usage_global_daily.estimated_tokens + EXCLUDED.estimated_tokens,
        request_count = ai_usage_global_daily.request_count + 1
      WHERE ai_usage_global_daily.estimated_tokens + EXCLUDED.estimated_tokens <= $2
      RETURNING estimated_tokens`, [estimatedTokens, globalLimit]);
    if (!globalUsage.rowCount) throw new AIUsageLimitError("global");

    await client.query("COMMIT");
    return { userTokens: userUsage.rows[0].estimated_tokens as number, globalTokens: globalUsage.rows[0].estimated_tokens as number };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
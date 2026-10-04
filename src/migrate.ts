import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "./db.js";

const client = await db.connect();

try {
  await client.query("SELECT pg_advisory_lock(hashtext('repopilot-schema-setup'))");
  await client.query("BEGIN");
  await client.query(await readFile(join(process.cwd(), "db", "schema.sql"), "utf8"));
  await client.query("COMMIT");
  console.log("RepoPilotAI schema is ready.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('repopilot-schema-setup'))");
  client.release();
  await db.end();
}
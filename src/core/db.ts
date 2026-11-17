import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 5),
      ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: true } : undefined,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

// Resolved from the working directory (repo root, or /app in the container) so bundlers leave it alone.
const MIGRATIONS = process.env.MIGRATIONS_DIR ?? join(process.cwd(), "db", "migrations");

/** Apply db/migrations/*.sql in order, each once, each in its own transaction. */
export async function migrate(db: pg.Pool = getPool(), dir = MIGRATIONS): Promise<string[]> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(join(dir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

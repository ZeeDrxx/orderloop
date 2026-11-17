/**
 * Incremental sync: SAP → PostgreSQL.
 *
 * For each entity, read only what changed since the last successful run (the watermark), upsert it,
 * and move the watermark forward, all page by page inside transactions. Properties:
 *  - Idempotent: re-running, or re-reading the boundary second, never duplicates (ON CONFLICT upserts).
 *  - Resumable: the watermark only moves after a page is committed; a crash re-reads at most one page.
 *  - Observable: every run is recorded in sync_runs with counts and the error, if any.
 */
import type pg from "pg";

import { ENTITIES, type EntitySpec, type Row } from "./entities.ts";
import { literal, pages, type ODataConfig, type Query } from "./odata.ts";

export type SyncResult = { entity: string; fetched: number; upserted: number; status: "ok" | "failed"; error?: string };

export function sapConfigFromEnv(env = process.env): ODataConfig {
  const baseUrl = env.SAP_BASE_URL ?? "https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap";
  return {
    baseUrl,
    apiKey: env.SAP_API_KEY || undefined,
    basicAuth: env.SAP_USER && env.SAP_PASSWORD ? { user: env.SAP_USER, password: env.SAP_PASSWORD } : undefined,
    pageSize: Number(env.SAP_PAGE_SIZE ?? 500),
  };
}

export function queryFor(spec: EntitySpec, watermark: Date | null, now = new Date()): Query {
  const q: Query = { expand: spec.expand };
  if (spec.incremental) {
    if (watermark) q.filter = `${spec.incremental.field} ge ${literal(spec.incremental.kind, startOf(spec.incremental.kind, watermark))}`;
    q.orderby = spec.incremental.field;
  } else if (spec.window) {
    // First run: full history. Afterwards: re-read a rolling window, because what changes on these
    // documents (a clearing date) does not move any change timestamp we could filter on.
    const from = watermark ? new Date(now.getTime() - spec.window.days * 86_400_000) : null;
    q.filter = [spec.window.extraFilter, from && `${spec.window.field} ge ${literal("datetime", startOf("datetime", from))}`]
      .filter(Boolean).join(" and ") || undefined;
  }
  return q;
}

// Edm.DateTime change fields are dates: re-read the whole watermark day rather than risk a gap.
function startOf(kind: "datetimeoffset" | "datetime", d: Date): Date {
  return kind === "datetime" ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : d;
}

function upsertSql(table: string, rows: Row[], key: string[]): { text: string; values: unknown[] } {
  const cols = Object.keys(rows[0]);
  const values: unknown[] = [];
  const tuples = rows.map((row) => `(${cols.map((c) => { values.push(row[c]); return `$${values.length}`; }).join(", ")})`);
  const updates = cols.filter((c) => !key.includes(c)).map((c) => `${c} = EXCLUDED.${c}`);
  const hasSyncedAt = !["delivery_links", "billing_links"].includes(table);
  if (hasSyncedAt) updates.push("synced_at = now()");
  return {
    text: `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${tuples.join(", ")}
           ON CONFLICT (${key.join(", ")}) ${updates.length ? `DO UPDATE SET ${updates.join(", ")}` : "DO NOTHING"}`,
    values,
  };
}

export async function syncEntity(db: pg.Pool, sap: ODataConfig, spec: EntitySpec, trigger: string, now = new Date()): Promise<SyncResult> {
  const state = await db.query<{ watermark: Date | null }>("SELECT watermark FROM sync_state WHERE entity = $1", [spec.name]);
  const watermark = state.rows[0]?.watermark ?? null;
  const run = await db.query<{ id: string }>("INSERT INTO sync_runs (entity, trigger) VALUES ($1, $2) RETURNING id", [spec.name, trigger]);
  const runId = run.rows[0].id;
  let fetched = 0;
  let upserted = 0;
  let maxChange = watermark;

  try {
    for await (const page of pages(sap, spec.path, queryFor(spec, watermark, now))) {
      fetched += page.length;
      // Map, drop records that are not ours (e.g. supplier-only partners), and keep the last copy of any
      // key seen twice in one page: a single INSERT … ON CONFLICT may not touch the same row twice.
      const byKey = new Map<string, { raw: (typeof page)[number]; row: Row }>();
      for (const raw of page) {
        const row = spec.map(raw);
        if (row) byKey.set(spec.key.map((k) => String(row[k])).join("\u0000"), { raw, row });
      }
      const rows = [...byKey.values()];
      if (!rows.length) continue;
      for (const { raw } of rows) {
        const changed = spec.changedAt?.(raw);
        if (changed && (!maxChange || changed > maxChange)) maxChange = changed;
      }
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(upsertSql(spec.table, rows.map((r) => r.row), spec.key));
        if (spec.links) {
          const parents = rows.map((r) => r.row[spec.links!.parentKey]);
          await client.query(`DELETE FROM ${spec.links.table} WHERE ${spec.links.parentKey} = ANY($1)`, [parents]);
          const links = rows.flatMap((r) => spec.links!.map(r.raw));
          if (links.length) await client.query(upsertSql(spec.links.table, links, Object.keys(links[0])));
        }
        // Never move the watermark past the moment this run started: a source clock running ahead
        // (or a future-dated record) would otherwise make the next run skip real changes.
        const mark = spec.incremental ? (maxChange && maxChange < now ? maxChange : maxChange && now) : now;
        if (mark) {
          await client.query(
            `INSERT INTO sync_state (entity, watermark) VALUES ($1, $2)
             ON CONFLICT (entity) DO UPDATE SET watermark = GREATEST(sync_state.watermark, EXCLUDED.watermark), updated_at = now()`,
            [spec.name, mark],
          );
        }
        await client.query("COMMIT");
        upserted += rows.length;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
    await db.query("UPDATE sync_runs SET finished_at = now(), fetched = $2, upserted = $3, status = 'ok' WHERE id = $1", [runId, fetched, upserted]);
    return { entity: spec.name, fetched, upserted, status: "ok" };
  } catch (err) {
    const error = (err as Error).message;
    await db.query("UPDATE sync_runs SET finished_at = now(), fetched = $2, upserted = $3, status = 'failed', error = $4 WHERE id = $1",
      [runId, fetched, upserted, error]);
    return { entity: spec.name, fetched, upserted, status: "failed", error };
  }
}

/** Sync every entity in dependency order. One entity failing does not stop the others. */
export async function syncAll(db: pg.Pool, sap: ODataConfig, trigger = "manual", entities = ENTITIES): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const spec of entities) results.push(await syncEntity(db, sap, spec, trigger));
  return results;
}

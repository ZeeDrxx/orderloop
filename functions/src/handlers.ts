import type pg from "pg";

import { getPool } from "../../src/core/db.ts";
import type { ODataConfig } from "../../src/core/odata.ts";
import { sapConfigFromEnv, syncAll, type SyncResult } from "../../src/core/sync.ts";

export type Log = { log: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

/**
 * One sync run, as the Functions host sees it. Partial failures are logged as warnings (the other
 * entities still synced); if everything failed, the invocation throws so it shows as failed in
 * Application Insights and alerts can fire.
 */
export async function runSync(
  trigger: "schedule" | "manual",
  log: Log,
  deps: { db?: pg.Pool; sap?: ODataConfig } = {},
): Promise<SyncResult[]> {
  const results = await syncAll(deps.db ?? getPool(), deps.sap ?? sapConfigFromEnv(), trigger);
  for (const r of results) {
    const line = `${r.entity}: ${r.status}, fetched ${r.fetched}, upserted ${r.upserted}`;
    if (r.status === "ok") log.log(line);
    else log.warn(`${line}: ${r.error}`);
  }
  if (results.every((r) => r.status === "failed")) {
    throw new Error(`SAP sync failed for every entity: ${results[0]?.error}`);
  }
  return results;
}

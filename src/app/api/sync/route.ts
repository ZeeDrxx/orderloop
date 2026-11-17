import { timingSafeEqual } from "node:crypto";

import { getPool } from "@/core/db.ts";
import { sapConfigFromEnv, syncAll } from "@/core/sync.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const expected = process.env.SYNC_TOKEN;
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || expected.length < 16) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** POST /api/sync with `Authorization: Bearer $SYNC_TOKEN`: run a sync now (the schedule runs in Azure Functions). */
export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const results = await syncAll(getPool(), sapConfigFromEnv(), "manual");
  const ok = results.every((r) => r.status === "ok");
  return Response.json({ ok, results }, { status: ok ? 200 : 502 });
}

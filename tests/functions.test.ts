import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runSync } from "../functions/src/handlers.ts";
import { makeFixtures } from "../mock-sap/generate.ts";
import { mockFetch } from "../mock-sap/handler.ts";
import { migrate } from "../src/core/db.ts";

const url = process.env.DATABASE_URL;
let db: pg.Pool;
const lines: string[] = [];
const log = { log: (m: unknown) => lines.push(`log ${m}`), warn: (m: unknown) => lines.push(`warn ${m}`), error: () => {} };
const world = makeFixtures(new Date("2026-11-17T12:00:00Z"));

describe.skipIf(!url)("Azure Functions handler", () => {
  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: url });
    await admin.query("DROP DATABASE IF EXISTS orderloop_fn_test WITH (FORCE)");
    await admin.query("CREATE DATABASE orderloop_fn_test");
    await admin.end();
    const u = new URL(url!);
    u.pathname = "/orderloop_fn_test";
    db = new pg.Pool({ connectionString: u.href });
    await migrate(db);
  });
  afterAll(async () => db?.end());

  it("logs each entity and returns results", async () => {
    const results = await runSync("schedule", log, { db, sap: { baseUrl: "http://mock/sap/opu/odata/sap", fetch: mockFetch(() => world) } });
    expect(results).toHaveLength(5);
    expect(lines.filter((l) => l.startsWith("log "))).toHaveLength(5);
  });

  it("partial failure: warns, does not throw", async () => {
    const sap = { baseUrl: "http://mock/sap/opu/odata/sap", maxRetries: 0, fetch: mockFetch(() => world, (u) => (u.pathname.includes("A_SalesOrder") ? new Response("boom", { status: 500 }) : undefined)) };
    const results = await runSync("schedule", log, { db, sap });
    expect(results.filter((r) => r.status === "failed")).toHaveLength(1);
    expect(lines.some((l) => l.startsWith("warn sales_orders: failed"))).toBe(true);
  });

  it("total failure throws, so the invocation is marked failed", async () => {
    const sap = { baseUrl: "http://mock/sap/opu/odata/sap", fetch: mockFetch(() => world, () => new Response("Invalid API key", { status: 401 })) };
    await expect(runSync("schedule", log, { db, sap })).rejects.toThrow(/every entity/);
  });
});

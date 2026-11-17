/**
 * Full sync against real PostgreSQL (docker compose up -d postgres) and the mock SAP world.
 * Skipped without DATABASE_URL. Uses its own database, recreated for every run.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeFixtures, type Fixtures } from "../mock-sap/generate.ts";
import { mockFetch } from "../mock-sap/handler.ts";
import { migrate } from "../src/core/db.ts";
import { overview, orders } from "../src/core/o2c.ts";
import { syncAll } from "../src/core/sync.ts";

const url = process.env.DATABASE_URL;
let db: pg.Pool;
let world: Fixtures;
const T0 = new Date("2026-11-17T12:00:00Z");
const sap = (onRequest?: (u: URL) => Response | undefined) => ({
  baseUrl: "http://mock/sap/opu/odata/sap",
  pageSize: 100,
  fetch: mockFetch(() => world, onRequest),
});
const count = async (table: string) => Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

describe.skipIf(!url)("sync SAP → PostgreSQL", () => {
  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: url });
    await admin.query("DROP DATABASE IF EXISTS orderloop_test WITH (FORCE)");
    await admin.query("CREATE DATABASE orderloop_test");
    await admin.end();
    const testUrl = new URL(url!);
    testUrl.pathname = "/orderloop_test";
    db = new pg.Pool({ connectionString: testUrl.href });
    expect(await migrate(db)).toEqual(["001_tables.sql", "002_o2c_views.sql"]);
    expect(await migrate(db)).toEqual([]); // idempotent
    world = makeFixtures(T0);
  });

  afterAll(async () => db?.end());

  it("first sync mirrors every document and skips supplier-only partners", async () => {
    const results = await syncAll(db, sap(), "test");
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(await count("customers")).toBe(30);
    expect(await count("sales_orders")).toBe(world.A_SalesOrder.length);
    expect(await count("deliveries")).toBe(world.A_OutbDeliveryHeader.length);
    expect(await count("billing_documents")).toBe(world.A_BillingDocument.length);
    expect(await count("receivables")).toBe(world.A_OperationalAcctgDocItemCube.length);
    expect(await count("delivery_links")).toBe(world.A_OutbDeliveryHeader.length);
    expect(await count("sync_runs WHERE status = 'ok'")).toBe(5);
  });

  it("derives an order-to-cash stage for every order", async () => {
    const rows = (await db.query<{ stage: string; n: number }>("SELECT stage, count(*)::int AS n FROM o2c_orders GROUP BY stage")).rows;
    const by = Object.fromEntries(rows.map((r) => [r.stage, r.n]));
    expect(Object.values(by).reduce((a, b) => a + b, 0)).toBe(world.A_SalesOrder.length);
    expect(by.paid).toBeGreaterThan(by.invoiced);
    expect(by.cancelled).toBe(world.A_SalesOrder.filter((o) => o.OverallSDDocumentRejectionSts === "C").length);
    // a cancelled invoice must not count: every invoiced order has a live invoice
    const orphan = await db.query(`
      SELECT 1 FROM o2c_orders o WHERE o.invoiced_on IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM billing_links bl JOIN billing_documents b USING (billing_document)
        WHERE bl.sales_order = o.sales_order AND NOT b.is_cancelled)`);
    expect(orphan.rowCount).toBe(0);
  });

  it("re-running is idempotent and only re-reads the boundary", async () => {
    const before = await count("sales_orders");
    const results = await syncAll(db, sap(), "test");
    expect(await count("sales_orders")).toBe(before);
    const orderRun = results.find((r) => r.entity === "sales_orders")!;
    expect(orderRun.fetched).toBeLessThan(5);
  });

  it("a month later, incremental sync picks up new orders, shipments and payments", async () => {
    const openBefore = await count("receivables WHERE clearing_date IS NULL");
    world = makeFixtures(new Date(T0.getTime() + 30 * 86_400_000));
    const results = await syncAll(db, sap(), "schedule");
    const orderRun = results.find((r) => r.entity === "sales_orders")!;
    expect(orderRun.fetched).toBeGreaterThan(0);
    expect(orderRun.fetched).toBeLessThan(world.A_SalesOrder.length / 3); // only what changed
    expect(await count("sales_orders")).toBe(world.A_SalesOrder.length);
    expect(await count("billing_documents")).toBe(world.A_BillingDocument.length);
    // receivables open at T0 have been paid since; the rolling window refreshed their clearing dates
    const stillOpenFromBefore = await count("receivables WHERE clearing_date IS NULL AND posting_date < '2026-11-17'");
    expect(stillOpenFromBefore).toBeLessThan(openBefore);
  });

  it("one failing entity does not stop the others, and is recorded", async () => {
    const results = await syncAll(db, sap((u) => (u.pathname.includes("A_BillingDocument") ? new Response("Invalid API key", { status: 401 }) : undefined)), "manual");
    expect(results.find((r) => r.entity === "billing_documents")).toMatchObject({ status: "failed" });
    expect(results.filter((r) => r.status === "ok")).toHaveLength(4);
    const run = await db.query("SELECT status, error FROM sync_runs WHERE entity = 'billing_documents' ORDER BY id DESC LIMIT 1");
    expect(run.rows[0]).toMatchObject({ status: "failed" });
    expect(run.rows[0].error).toContain("401");
  });

  it("dashboard read models", async () => {
    const o = await overview(db);
    expect(o.stages.map((s) => s.stage)).toContain("paid");
    expect(Number(o.cycle.days_to_deliver)).toBeGreaterThan(0);
    expect(o.aging.map((a) => a.bucket)).toContain("not due");
    expect(Number(o.dso[0].dso_days)).toBeGreaterThan(0);
    expect(o.runs).toHaveLength(5);
    const invoiced = await orders(db, { stage: "invoiced", limit: 5 });
    expect(invoiced.every((r) => r.stage === "invoiced")).toBe(true);
    const search = await orders(db, { q: "Atlas" });
    expect(search.length).toBeGreaterThan(0);
  });
});

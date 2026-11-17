import { describe, expect, it } from "vitest";

import { makeFixtures } from "../mock-sap/generate.ts";
import { handle, mockFetch } from "../mock-sap/handler.ts";
import { ENTITIES } from "../src/core/entities.ts";
import { buildUrl, decimal, literal, ODataError, pages, parseODataDate, pick } from "../src/core/odata.ts";
import { queryFor } from "../src/core/sync.ts";

const TODAY = new Date("2026-11-17T12:00:00Z");
const fixtures = makeFixtures(TODAY);
const BASE = "http://mock/sap/opu/odata/sap";

describe("OData V2 values", () => {
  it("parses /Date()/ with and without offset, and ISO", () => {
    expect(parseODataDate("/Date(1700000000000)/")?.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(parseODataDate("/Date(1700000000000+0000)/")?.getTime()).toBe(1700000000000);
    expect(parseODataDate("2026-01-02T03:04:05Z")?.getUTCHours()).toBe(3);
    expect(parseODataDate("")).toBeNull();
    expect(parseODataDate(null)).toBeNull();
  });

  it("keeps decimals as exact strings", () => {
    expect(decimal("1234.50")).toBe("1234.50");
    expect(decimal(12)).toBe("12");
    expect(decimal("12,50")).toBeNull();
  });

  it("formats filter literals", () => {
    const at = new Date("2026-03-04T05:06:07.890Z");
    expect(literal("datetimeoffset", at)).toBe("datetimeoffset'2026-03-04T05:06:07Z'");
    expect(literal("datetime", at)).toBe("datetime'2026-03-04T05:06:07'");
  });

  it("picks the first non-empty alternative", () => {
    expect(pick({ A: "", B: null, C: "x" }, ["A", "B", "C"])).toBe("x");
    expect(pick({}, ["A"])).toBeNull();
  });

  it("encodes spaces as %20, as SAP expects", () => {
    const url = buildUrl({ baseUrl: BASE }, "API_SALES_ORDER_SRV/A_SalesOrder", { filter: "A eq 'b'" }, 0, 10);
    expect(url).toBe("http://mock/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder?$format=json&$top=10&$skip=0&$filter=A%20eq%20'b'");
  });
});

describe("incremental queries", () => {
  const orders = ENTITIES.find((e) => e.name === "sales_orders")!;
  const deliveries = ENTITIES.find((e) => e.name === "deliveries")!;
  const receivables = ENTITIES.find((e) => e.name === "receivables")!;

  it("first run reads everything, later runs filter from the watermark", () => {
    expect(queryFor(orders, null).filter).toBeUndefined();
    expect(queryFor(orders, new Date("2026-11-01T10:20:30Z")).filter).toBe("LastChangeDateTime ge datetimeoffset'2026-11-01T10:20:30Z'");
  });

  it("date-only change fields re-read the whole watermark day", () => {
    expect(queryFor(deliveries, new Date("2026-11-01T10:20:30Z")).filter).toBe("LastChangeDate ge datetime'2026-11-01T00:00:00'");
  });

  it("receivables: full history first, then a rolling posting-date window", () => {
    expect(queryFor(receivables, null, TODAY).filter).toBe("FinancialAccountType eq 'D'");
    expect(queryFor(receivables, TODAY, TODAY).filter).toBe("FinancialAccountType eq 'D' and PostingDate ge datetime'2025-10-13T00:00:00'");
  });
});

describe("client", () => {
  it("pages with $top/$skip until a short page", async () => {
    const seen: string[] = [];
    const cfg = { baseUrl: BASE, pageSize: 100, fetch: mockFetch(() => fixtures, (u) => { seen.push(u.searchParams.get("$skip")!); return undefined; }) };
    let total = 0;
    for await (const page of pages(cfg, "API_SALES_ORDER_SRV/A_SalesOrder")) total += page.length;
    expect(total).toBe(fixtures.A_SalesOrder.length);
    expect(seen).toEqual(["0", "100", "200", "300"]);
  });

  it("retries 429 and 5xx with backoff, then succeeds", async () => {
    let calls = 0;
    const waits: number[] = [];
    const cfg = {
      baseUrl: BASE,
      sleep: async (ms: number) => { waits.push(ms); },
      fetch: mockFetch(() => fixtures, () => (++calls <= 2 ? new Response("busy", { status: calls === 1 ? 429 : 503 }) : undefined)),
    };
    const first = await pages(cfg, "API_BUSINESS_PARTNER/A_BusinessPartner").next();
    expect(first.value).toHaveLength(34);
    expect(waits).toEqual([500, 1000]);
  });

  it("fails fast on client errors with the SAP message", async () => {
    const cfg = { baseUrl: BASE, fetch: mockFetch(() => fixtures, () => new Response("Invalid API key", { status: 401 })) };
    await expect(pages(cfg, "API_SALES_ORDER_SRV/A_SalesOrder").next()).rejects.toMatchObject({ status: 401 });
    await expect(pages(cfg, "API_SALES_ORDER_SRV/A_SalesOrder").next()).rejects.toBeInstanceOf(ODataError);
  });
});

describe("mock SAP", () => {
  const get = (q: string) => handle(new URL(`${BASE}/API_BILLING_DOCUMENT_SRV/A_BillingDocument?$format=json&${q}`), fixtures).json() as Promise<{ d: { results: Record<string, unknown>[] } }>;

  it("defers navigation properties unless expanded", async () => {
    const plain = await get("$top=1");
    expect(plain.d.results[0].to_Item).toHaveProperty("__deferred");
    const exp = await get("$top=1&$expand=to_Item");
    expect(exp.d.results[0].to_Item).toHaveProperty("results");
  });

  it("filters on datetimeoffset", async () => {
    const res = await get("$filter=LastChangeDateTime ge datetimeoffset'2026-11-01T00:00:00Z'&$top=1000");
    expect(res.d.results.length).toBeGreaterThan(0);
    expect(res.d.results.length).toBeLessThan(fixtures.A_BillingDocument.length);
  });

  it("rejects filters it does not understand, like SAP would", async () => {
    const res = handle(new URL(`${BASE}/API_SALES_ORDER_SRV/A_SalesOrder?$filter=substringof('x',SalesOrder)`), fixtures);
    expect(res.status).toBe(400);
  });

  it("the simulated world only grows as time passes", () => {
    const later = makeFixtures(new Date("2026-12-17T12:00:00Z"));
    const early = new Set(fixtures.A_SalesOrder.map((o) => o.SalesOrder));
    expect(later.A_SalesOrder.length).toBeGreaterThan(fixtures.A_SalesOrder.length);
    expect(later.A_SalesOrder.filter((o) => early.has(o.SalesOrder)).length).toBe(early.size);
  });
});

/**
 * Serves fixtures the way SAP's OData V2 services do, for the subset OrderLoop uses:
 * $filter (`and` of eq/ge/gt/le/lt on strings, datetime'…' and datetimeoffset'…'), $orderby (asc),
 * $top, $skip, $expand (otherwise navigation properties come back as __deferred), $format=json.
 */
import type { Fixtures } from "./generate.ts";

const ROUTES: Record<string, string> = {
  "API_BUSINESS_PARTNER/A_BusinessPartner": "A_BusinessPartner",
  "API_SALES_ORDER_SRV/A_SalesOrder": "A_SalesOrder",
  "API_OUTBOUND_DELIVERY_SRV;v=0002/A_OutbDeliveryHeader": "A_OutbDeliveryHeader",
  "API_BILLING_DOCUMENT_SRV/A_BillingDocument": "A_BillingDocument",
  "API_OPLACCTGDOCITEMCUBE_SRV/A_OperationalAcctgDocItemCube": "A_OperationalAcctgDocItemCube",
};
const PREFIX = "/sap/opu/odata/sap/";
const CLAUSE = /^(\w+) (eq|ge|gt|le|lt) (?:(datetimeoffset|datetime)'([^']*)'|'([^']*)')$/;

const ms = (v: unknown): number | null => {
  const m = typeof v === "string" ? /\/Date\((-?\d+)/.exec(v) : null;
  return m ? Number(m[1]) : null;
};

function compare(a: number | string, op: string, b: number | string) {
  switch (op) {
    case "eq": return a === b;
    case "ge": return a >= b;
    case "gt": return a > b;
    case "le": return a <= b;
    default: return a < b;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function handle(url: URL, fixtures: Fixtures): Response {
  if (!url.pathname.startsWith(PREFIX)) return json(404, { error: { message: { value: "not found" } } });
  const route = decodeURIComponent(url.pathname.slice(PREFIX.length));
  const set = ROUTES[route];
  if (!set) return json(404, { error: { message: { value: `unknown entity set ${route}` } } });

  let rows = fixtures[set] ?? [];
  const filter = url.searchParams.get("$filter");
  if (filter) {
    for (const clause of filter.split(" and ")) {
      const m = CLAUSE.exec(clause.trim());
      if (!m) return json(400, { error: { message: { value: `unsupported $filter clause: ${clause}` } } });
      const [, field, op, kind, dateValue, stringValue] = m;
      if (kind) {
        const bound = Date.parse(kind === "datetime" ? `${dateValue}Z` : dateValue);
        rows = rows.filter((r) => {
          const v = ms(r[field]);
          return v !== null && compare(v, op, bound);
        });
      } else {
        rows = rows.filter((r) => compare(String(r[field] ?? ""), op, stringValue));
      }
    }
  }
  const orderby = url.searchParams.get("$orderby");
  if (orderby) {
    const field = orderby.split(" ")[0];
    rows = [...rows].sort((a, b) => (ms(a[field]) ?? 0) - (ms(b[field]) ?? 0) || String(a[field]).localeCompare(String(b[field])));
  }
  const skip = Number(url.searchParams.get("$skip") ?? 0);
  const top = Number(url.searchParams.get("$top") ?? 50);
  const expand = new Set((url.searchParams.get("$expand") ?? "").split(",").filter(Boolean));
  const results = rows.slice(skip, skip + top).map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] = k.startsWith("to_") && !expand.has(k) ? { __deferred: { uri: `${url.origin}${url.pathname}/${k}` } } : v;
    }
    return out;
  });
  return json(200, { d: { results } });
}

/** A `fetch` that answers from fixtures: lets tests run the real client and sync code with no network. */
export function mockFetch(fixtures: () => Fixtures, onRequest?: (url: URL) => Response | undefined): typeof fetch {
  return async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return onRequest?.(url) ?? handle(url, fixtures());
  };
}

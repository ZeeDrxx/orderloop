/**
 * Minimal OData V2 client for SAP S/4HANA Cloud APIs.
 *
 * Works against three backends with the same code:
 *  - SAP Business Accelerator Hub sandbox (header `APIKey`), read-only
 *  - a real S/4HANA Cloud tenant (communication user, HTTP Basic)
 *  - the local mock in mock-sap/ (tests, demos, CI)
 */

export type ODataConfig = {
  baseUrl: string; // e.g. https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap
  apiKey?: string;
  basicAuth?: { user: string; password: string };
  pageSize?: number;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type ODataRecord = Record<string, unknown>;

export class ODataError extends Error {
  constructor(message: string, readonly status?: number, readonly url?: string) {
    super(message);
  }
}

const DATE_RE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/** "/Date(1700000000000)/", "/Date(1700000000000+0000)/" or ISO → Date; anything else → null. */
export function parseODataDate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const m = DATE_RE.exec(value);
  if (m) return new Date(Number(m[1])); // the epoch value is already UTC; the offset is informational
  const iso = new Date(value);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

/** Edm.Decimal arrives as a string ("1234.50"). Keep it a string for NUMERIC columns: no float rounding. */
export function decimal(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

export function literal(kind: "datetimeoffset" | "datetime", d: Date): string {
  const iso = d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return kind === "datetimeoffset" ? `datetimeoffset'${iso}'` : `datetime'${iso.slice(0, 19)}'`;
}

function headers(cfg: ODataConfig): HeadersInit {
  const h: Record<string, string> = { Accept: "application/json" };
  if (cfg.apiKey) h.APIKey = cfg.apiKey;
  if (cfg.basicAuth) h.Authorization = "Basic " + Buffer.from(`${cfg.basicAuth.user}:${cfg.basicAuth.password}`).toString("base64");
  return h;
}

async function getJson(cfg: ODataConfig, url: string): Promise<{ d: { results?: ODataRecord[]; __next?: string } }> {
  const doFetch = cfg.fetch ?? fetch;
  const sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = cfg.maxRetries ?? 4;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 30_000);
    try {
      const res = await doFetch(url, { headers: headers(cfg), signal: ctrl.signal });
      if (res.ok) return (await res.json()) as { d: { results?: ODataRecord[]; __next?: string } };
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        const body = (await res.text()).slice(0, 300);
        throw new ODataError(`HTTP ${res.status} from SAP: ${body}`, res.status, url);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
    } catch (err) {
      if (err instanceof ODataError) throw err;
      if (attempt >= maxRetries) throw new ODataError(`request failed: ${(err as Error).message}`, undefined, url);
      await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
}

export type Query = { filter?: string; expand?: string; select?: string; orderby?: string };

// Keep OData's own syntax readable in URLs and logs: $ ' , : ( ) stay literal, spaces become %20.
const enc = (v: string) =>
  encodeURIComponent(v).replace(/%24/g, "$").replace(/%27/g, "'").replace(/%2C/g, ",").replace(/%3A/g, ":")
    .replace(/%28/g, "(").replace(/%29/g, ")");

export function buildUrl(cfg: ODataConfig, path: string, q: Query, skip: number, top: number): string {
  const params: [string, string | undefined][] = [
    ["$format", "json"], ["$top", String(top)], ["$skip", String(skip)],
    ["$filter", q.filter], ["$expand", q.expand], ["$select", q.select], ["$orderby", q.orderby],
  ];
  const qs = params.filter(([, v]) => v).map(([k, v]) => `${k}=${enc(v!)}`).join("&");
  return `${cfg.baseUrl.replace(/\/$/, "")}/${path}?${qs}`;
}

/** Yields one page of records at a time, until the server returns a short page. */
export async function* pages(cfg: ODataConfig, path: string, q: Query = {}): AsyncGenerator<ODataRecord[]> {
  const top = cfg.pageSize ?? 500;
  for (let skip = 0; ; skip += top) {
    const body = await getJson(cfg, buildUrl(cfg, path, q, skip, top));
    const rows = body.d?.results ?? [];
    if (rows.length) yield rows;
    if (rows.length < top) return;
  }
}

/** Expanded navigation property: { results: [...] } in V2 JSON, or { __deferred } when not expanded. */
export function expanded(record: ODataRecord, nav: string): ODataRecord[] {
  const v = record[nav] as { results?: ODataRecord[] } | undefined;
  return Array.isArray(v?.results) ? v.results : [];
}

/** First present, non-empty field among SAP's alternative names for the same thing. */
export function pick(record: ODataRecord, fields: string[]): string | null {
  for (const f of fields) {
    const v = record[f];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return null;
}

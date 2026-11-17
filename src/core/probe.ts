/**
 * `npm run sap:probe`: fetch one record of every entity from the configured SAP system and report
 * which fields the mappers rely on are present. Run it once with your sandbox API key: it tells you,
 * before any sync, whether your API versions match what OrderLoop expects.
 */
import { ENTITIES } from "./entities.ts";
import { buildUrl, type ODataConfig } from "./odata.ts";

const EXPECTED: Record<string, string[]> = {
  customers: ["BusinessPartner", "Customer", "BusinessPartnerFullName", "CreationDate", "LastChangeDate"],
  sales_orders: ["SalesOrder", "SoldToParty", "CreationDate", "TotalNetAmount", "TransactionCurrency", "LastChangeDateTime", "OverallSDProcessStatus"],
  deliveries: ["DeliveryDocument", "SoldToParty", "ActualGoodsMovementDate", "OverallGoodsMovementStatus", "LastChangeDate"],
  billing_documents: ["BillingDocument", "BillingDocumentDate", "TotalNetAmount", "TransactionCurrency", "BillingDocumentIsCancelled", "LastChangeDateTime"],
  receivables: ["CompanyCode", "FiscalYear", "AccountingDocument", "AccountingDocumentItem", "Customer", "NetDueDate", "ClearingDate", "AmountInTransactionCurrency"],
};

export async function probe(cfg: ODataConfig, log: (line: string) => void = console.log): Promise<boolean> {
  let allGood = true;
  for (const spec of ENTITIES) {
    const url = buildUrl(cfg, spec.path, { expand: spec.expand }, 0, 1);
    try {
      const res = await (cfg.fetch ?? fetch)(url, {
        headers: { Accept: "application/json", ...(cfg.apiKey ? { APIKey: cfg.apiKey } : {}) },
      });
      if (!res.ok) {
        allGood = false;
        log(`✗ ${spec.name}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
        continue;
      }
      const body = (await res.json()) as { d?: { results?: Record<string, unknown>[] } };
      const record = body.d?.results?.[0];
      if (!record) {
        log(`? ${spec.name}: reachable, but returned no records`);
        continue;
      }
      const missing = EXPECTED[spec.name].filter((f) => !(f in record));
      if (missing.length) allGood = false;
      log(`${missing.length ? "✗" : "✓"} ${spec.name}${missing.length ? `: missing ${missing.join(", ")}` : ""}`);
    } catch (err) {
      allGood = false;
      log(`✗ ${spec.name}: ${(err as Error).message}`);
    }
  }
  return allGood;
}

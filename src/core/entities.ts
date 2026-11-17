/**
 * What OrderLoop reads from SAP S/4HANA Cloud, and how each record becomes a row.
 *
 *   customer ─► sales order ─► outbound delivery ─► billing document (invoice) ─► receivable cleared (paid)
 *
 * Field names follow the SAP API reference for each service. Where SAP exposes the same fact under
 * different names across releases, mappers try the known alternatives (`pick`). Run
 * `npm run sap:probe` with your API key to compare against what your sandbox or tenant returns.
 */
import { decimal, expanded, parseODataDate, pick, type ODataRecord } from "./odata.ts";

export type Row = Record<string, string | number | boolean | Date | null>;

export type EntitySpec = {
  name: string; // sync_state / sync_runs key
  path: string; // service/EntitySet
  expand?: string;
  table: string;
  key: string[];
  /** Incremental sync on a change-timestamp field; omitted = rolling window on `window.field`. */
  incremental?: { field: string; kind: "datetimeoffset" | "datetime" };
  window?: { field: string; days: number; extraFilter?: string };
  map: (r: ODataRecord) => Row | null;
  /** Child link rows (e.g. delivery → sales order), replaced for each synced parent. */
  links?: { table: string; parentKey: string; map: (r: ODataRecord) => Row[] };
  changedAt?: (r: ODataRecord) => Date | null;
};

const date = (v: unknown) => parseODataDate(v);
const bool = (v: unknown) => v === true || v === "X" || v === "true";

export const ENTITIES: EntitySpec[] = [
  {
    name: "customers",
    path: "API_BUSINESS_PARTNER/A_BusinessPartner",
    expand: "to_BusinessPartnerAddress",
    table: "customers",
    key: ["customer"],
    incremental: { field: "LastChangeDate", kind: "datetime" },
    map: (r) => {
      const customer = pick(r, ["Customer"]);
      if (!customer) return null; // a partner that is only a supplier or a person contact
      const address = expanded(r, "to_BusinessPartnerAddress")[0] ?? {};
      return {
        customer,
        name: pick(r, ["BusinessPartnerFullName", "OrganizationBPName1", "BusinessPartnerName"]) ?? customer,
        country: pick(address, ["Country"]),
        city: pick(address, ["CityName"]),
        created_on: date(r.CreationDate),
      };
    },
    changedAt: (r) => date(r.LastChangeDate),
  },
  {
    name: "sales_orders",
    path: "API_SALES_ORDER_SRV/A_SalesOrder",
    table: "sales_orders",
    key: ["sales_order"],
    incremental: { field: "LastChangeDateTime", kind: "datetimeoffset" },
    map: (r) => ({
      sales_order: String(r.SalesOrder),
      order_type: pick(r, ["SalesOrderType"]),
      sold_to: pick(r, ["SoldToParty"]),
      customer_po: pick(r, ["PurchaseOrderByCustomer"]),
      created_on: date(r.CreationDate),
      requested_delivery: date(r.RequestedDeliveryDate),
      net_amount: decimal(r.TotalNetAmount),
      currency: pick(r, ["TransactionCurrency"]),
      payment_terms: pick(r, ["CustomerPaymentTerms"]),
      overall_status: pick(r, ["OverallSDProcessStatus"]),
      delivery_status: pick(r, ["OverallTotalDeliveryStatus", "OverallDeliveryStatus"]),
      rejection_status: pick(r, ["OverallSDDocumentRejectionSts"]),
      last_change: date(r.LastChangeDateTime),
    }),
    changedAt: (r) => date(r.LastChangeDateTime),
  },
  {
    name: "deliveries",
    path: "API_OUTBOUND_DELIVERY_SRV;v=0002/A_OutbDeliveryHeader",
    expand: "to_DeliveryDocumentItem",
    table: "deliveries",
    key: ["delivery"],
    incremental: { field: "LastChangeDate", kind: "datetime" },
    map: (r) => ({
      delivery: String(r.DeliveryDocument),
      sold_to: pick(r, ["SoldToParty"]),
      created_on: date(r.CreationDate),
      planned_goods_issue: date(r.PlannedGoodsIssueDate),
      goods_issue_date: date(r.ActualGoodsMovementDate),
      goods_movement_status: pick(r, ["OverallGoodsMovementStatus"]),
    }),
    links: {
      table: "delivery_links",
      parentKey: "delivery",
      map: (r) => uniqueLinks(expanded(r, "to_DeliveryDocumentItem").map((i) => ({
        delivery: String(r.DeliveryDocument),
        sales_order: pick(i, ["ReferenceSDDocument"]),
      }))),
    },
    changedAt: (r) => date(r.LastChangeDate),
  },
  {
    name: "billing_documents",
    path: "API_BILLING_DOCUMENT_SRV/A_BillingDocument",
    expand: "to_Item",
    table: "billing_documents",
    key: ["billing_document"],
    incremental: { field: "LastChangeDateTime", kind: "datetimeoffset" },
    map: (r) => ({
      billing_document: String(r.BillingDocument),
      billing_type: pick(r, ["BillingDocumentType"]),
      billing_date: date(r.BillingDocumentDate),
      sold_to: pick(r, ["SoldToParty"]),
      payer: pick(r, ["PayerParty"]),
      net_amount: decimal(r.TotalNetAmount),
      tax_amount: decimal(r.TotalTaxAmount),
      currency: pick(r, ["TransactionCurrency"]),
      payment_terms: pick(r, ["CustomerPaymentTerms"]),
      is_cancelled: bool(r.BillingDocumentIsCancelled),
      accounting_status: pick(r, ["AccountingPostingStatus"]),
      last_change: date(r.LastChangeDateTime),
    }),
    links: {
      table: "billing_links",
      parentKey: "billing_document",
      map: (r) => uniqueLinks(expanded(r, "to_Item").map((i) => ({
        billing_document: String(r.BillingDocument),
        sales_order: pick(i, ["SalesDocument"]),
        delivery: pick(i, ["ReferenceSDDocument"]),
      }))),
    },
    changedAt: (r) => date(r.LastChangeDateTime),
  },
  {
    // Customer line items in Financial Accounting: the receivable each invoice creates, and when it was cleared (paid).
    name: "receivables",
    path: "API_OPLACCTGDOCITEMCUBE_SRV/A_OperationalAcctgDocItemCube",
    table: "receivables",
    key: ["company_code", "fiscal_year", "accounting_document", "item"],
    window: { field: "PostingDate", days: 400, extraFilter: "FinancialAccountType eq 'D'" },
    map: (r) => ({
      company_code: String(r.CompanyCode),
      fiscal_year: String(r.FiscalYear),
      accounting_document: String(r.AccountingDocument),
      item: String(r.AccountingDocumentItem),
      customer: pick(r, ["Customer"]),
      billing_document: pick(r, ["OriginalReferenceDocument", "DocumentReferenceID", "AssignmentReference"]),
      posting_date: date(r.PostingDate),
      net_due_date: date(r.NetDueDate),
      clearing_date: date(r.ClearingDate),
      amount: decimal(r.AmountInTransactionCurrency),
      currency: pick(r, ["TransactionCurrency"]),
    }),
  },
];

function uniqueLinks(rows: Row[]): Row[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (Object.values(row).some((v) => v === null)) return false;
    const k = JSON.stringify(row);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

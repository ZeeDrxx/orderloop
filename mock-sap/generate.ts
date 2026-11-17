/**
 * A deterministic order-to-cash world in SAP OData V2 shape, for the mock server and tests.
 *
 * Every order's whole future (delivery, invoice, payment) is drawn once from a seeded RNG, so the
 * data at any "today" is a consistent snapshot, and moving "today" forward makes new events appear
 * with fresh change timestamps, exactly what an incremental sync has to pick up.
 * Company names are invented.
 */

type Rec = Record<string, unknown>;
export type Fixtures = Record<string, Rec[]>;

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 6);
const END = Date.UTC(2027, 11, 31);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const d = (ms: number) => `/Date(${ms})/`; // Edm.DateTime
const dto = (ms: number) => `/Date(${ms}+0000)/`; // Edm.DateTimeOffset
const dayStart = (ms: number) => ms - (ms % DAY);
const money = (n: number) => n.toFixed(2);

const PREFIX = ["Atlas", "Sahara", "Anfa", "Souss", "Oasis", "Medina", "Zagora", "Ifrane", "Tafilalet", "Draa", "Rif", "Majorelle", "Corniche", "Bouregreg", "Argana"];
const SUFFIX = ["Distribution SARL", "Trading", "Négoce", "Industries SA", "Logistique", "Agro SARL", "Equipements"];
const CITIES: [string, string][] = [["Casablanca", "MA"], ["Rabat", "MA"], ["Tanger", "MA"], ["Marrakech", "MA"], ["Agadir", "MA"], ["Fès", "MA"], ["Kénitra", "MA"], ["Lyon", "FR"], ["Sevilla", "ES"]];
const TERMS: [string, number][] = [["NT00", 0], ["NT30", 30], ["NT45", 45], ["NT60", 60]];

export function makeFixtures(today: Date, seed = 2026): Fixtures {
  const now = today.getTime();
  const r = rng(seed);
  const pickOne = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const between = (a: number, b: number) => a + r() * (b - a);

  // ---- customers (plus a few supplier-only partners the sync must skip)
  const customers = Array.from({ length: 34 }, (_, i) => {
    const [city, country] = pickOne(CITIES);
    const supplierOnly = i >= 30;
    return {
      id: String(1000100 + i),
      name: `${PREFIX[i % PREFIX.length]} ${SUFFIX[(i * 3) % SUFFIX.length]}`,
      city, country, supplierOnly,
      created: START - Math.floor(between(30, 900)) * DAY,
      terms: pickOne(TERMS),
      // how late this customer usually pays, in days after the due date (negative = early)
      payDelay: pickOne([-5, 0, 0, 3, 8, 15, 30, 55]),
      weight: 0.3 + r() * 2,
    };
  });
  const buyers = customers.filter((c) => !c.supplierOnly);
  const totalWeight = buyers.reduce((s, c) => s + c.weight, 0);
  const pickBuyer = () => {
    let x = r() * totalWeight;
    for (const c of buyers) if ((x -= c.weight) <= 0) return c;
    return buyers[buyers.length - 1];
  };

  const out: Fixtures = { A_BusinessPartner: [], A_SalesOrder: [], A_OutbDeliveryHeader: [], A_BillingDocument: [], A_OperationalAcctgDocItemCube: [] };

  for (const c of customers) {
    if (c.created > now) continue;
    out.A_BusinessPartner.push({
      BusinessPartner: c.id, Customer: c.supplierOnly ? "" : c.id, BusinessPartnerCategory: "2",
      BusinessPartnerFullName: c.name, OrganizationBPName1: c.name,
      CreationDate: d(dayStart(c.created)), LastChangeDate: d(dayStart(c.created)),
      to_BusinessPartnerAddress: { results: [{ AddressID: "1", CityName: c.city, Country: c.country }] },
    });
  }

  // Document numbers derive from the order, never from a running counter: the same number must mean
  // the same document in every snapshot, whatever "today" is.

  for (let i = 0, t = START; t < END; i++) {
    t += between(0.2, 3.2) * DAY; // ~ one order every 1.7 days
    const c = pickBuyer();
    const created = t + Math.floor(between(8, 18)) * 3_600_000;
    const amount = Math.round(between(2_000, 180_000));
    const requested = dayStart(created) + Math.floor(between(3, 15)) * DAY;
    const rejected = r() < 0.03;
    const deliverAt = dayStart(created) + Math.floor(between(1, 14)) * DAY + 15 * 3_600_000;
    const issued = r() < 0.97;
    const invoiceAt = dayStart(deliverAt) + Math.floor(between(0, 5)) * DAY;
    const cancelFirstInvoice = r() < 0.04;
    const due = dayStart(invoiceAt) + c.terms[1] * DAY;
    const paidAt = due + Math.round(c.payDelay + between(-4, 10)) * DAY;
    const so = String(1_000_000 + i);
    if (created > now) break;

    const events = [created];
    // delivery
    let delivery: string | null = null;
    if (!rejected) {
      delivery = String(80_000_000 + i);
      const shipped = issued && deliverAt <= now;
      const createdDelivery = dayStart(created) + DAY;
      if (createdDelivery <= now) {
        out.A_OutbDeliveryHeader.push({
          DeliveryDocument: delivery, SoldToParty: c.id, CreationDate: d(createdDelivery),
          PlannedGoodsIssueDate: d(dayStart(deliverAt)),
          ActualGoodsMovementDate: shipped ? d(dayStart(deliverAt)) : null,
          OverallGoodsMovementStatus: shipped ? "C" : "A",
          LastChangeDate: d(shipped ? dayStart(deliverAt) : createdDelivery),
          to_DeliveryDocumentItem: { results: [{ DeliveryDocument: delivery, DeliveryDocumentItem: "10", ReferenceSDDocument: so, ReferenceSDDocumentItem: "10" }] },
        });
        if (shipped) events.push(deliverAt);
      } else {
        delivery = null;
      }
      // invoices (+ an occasional cancelled first attempt, re-issued the next day).
      // A document only exists once its change timestamp is in the past: no future-dated records.
      const tax = Math.round(amount * 0.2 * 100) / 100;
      const invoice = (cancelled: boolean, at: number) => {
        const doc = String(90_000_000 + 2 * i + (cancelled ? 0 : 1));
        out.A_BillingDocument.push({
          BillingDocument: doc, BillingDocumentType: "F2", BillingDocumentDate: d(dayStart(at)),
          SoldToParty: c.id, PayerParty: c.id, TotalNetAmount: money(amount), TotalTaxAmount: money(tax),
          TransactionCurrency: "MAD", CustomerPaymentTerms: c.terms[0], BillingDocumentIsCancelled: cancelled,
          AccountingPostingStatus: "C", CreationDate: d(dayStart(at)), LastChangeDateTime: dto(at + 3_600_000),
          to_Item: { results: [{ BillingDocument: doc, BillingDocumentItem: "10", SalesDocument: so, SalesDocumentItem: "10", ReferenceSDDocument: delivery }] },
        });
        events.push(at + 3_600_000);
        return doc;
      };
      const firstAt = invoiceAt;
      const finalAt = invoiceAt + (cancelFirstInvoice ? DAY : 0);
      const exists = (at: number) => at + 3_600_000 <= now;
      if (delivery && shipped && cancelFirstInvoice && exists(firstAt)) invoice(true, firstAt);
      if (delivery && shipped && exists(finalAt)) {
        const doc = invoice(false, finalAt);
        const posted = dayStart(finalAt);
        const cleared = paidAt <= now ? dayStart(Math.max(paidAt, posted)) : null;
        out.A_OperationalAcctgDocItemCube.push({
          CompanyCode: "MA01", FiscalYear: String(new Date(posted).getUTCFullYear()), AccountingDocument: String(1_400_000_000 + i),
          AccountingDocumentItem: "1", FinancialAccountType: "D", Customer: c.id, OriginalReferenceDocument: doc,
          PostingDate: d(posted), NetDueDate: d(due), ClearingDate: cleared === null ? null : d(cleared),
          AmountInTransactionCurrency: money(amount + tax), TransactionCurrency: "MAD",
        });
        if (cleared) events.push(cleared);
      }
    }

    out.A_SalesOrder.push({
      SalesOrder: so, SalesOrderType: "OR", SoldToParty: c.id, PurchaseOrderByCustomer: `PO-${c.id.slice(-3)}-${i}`,
      CreationDate: d(dayStart(created)), RequestedDeliveryDate: d(requested),
      TotalNetAmount: money(amount), TransactionCurrency: "MAD", CustomerPaymentTerms: c.terms[0],
      OverallSDProcessStatus: rejected ? "C" : events.length > 1 ? "C" : "A",
      OverallTotalDeliveryStatus: events.length > 1 ? "C" : "A",
      OverallSDDocumentRejectionSts: rejected ? "C" : "A",
      LastChangeDateTime: dto(Math.max(...events)),
    });
  }
  return out;
}

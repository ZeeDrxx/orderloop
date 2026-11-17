# OrderLoop

**Order-to-cash tracking on top of SAP S/4HANA Cloud.** OrderLoop reads five kinds of documents from
SAP's OData APIs and mirrors them, incrementally, into PostgreSQL:
- sales orders
- outbound deliveries
- billing documents
- the receivables they create
- the customers behind them

It then answers the questions finance asks every week:
- Where is each order: delivered, invoiced, paid?
- How long does cash take to come in?
- Who is overdue, and by how much?

```
 SAP S/4HANA Cloud (OData V2)                Azure Functions (hourly timer)               PostgreSQL
 ┌──────────────────────────────┐  incremental  ┌──────────────────────────────┐  upsert  ┌───────────────────┐
 │ A_BusinessPartner            │ ────────────► │ src/core/sync.ts             │ ───────► │ mirrored tables   │
 │ A_SalesOrder                 │  watermarks,  │  OData client: paging,       │          │ o2c_orders        │──► Next.js dashboard
 │ A_OutbDeliveryHeader + items │  retries,     │  retries, /Date()/ parsing   │          │ o2c_open_receiv…  │──► Power BI
 │ A_BillingDocument + items    │  run log      └──────────────────────────────┘          │ o2c_dso           │
 │ A_OperationalAcctgDocItemCube│                                                         └───────────────────┘
 └──────────────────────────────┘
```

| | |
|---|---|
| **SAP** | S/4HANA Cloud OData V2: `API_SALES_ORDER_SRV`, `API_OUTBOUND_DELIVERY_SRV`, `API_BILLING_DOCUMENT_SRV`, `API_BUSINESS_PARTNER`, `API_OPLACCTGDOCITEMCUBE_SRV`, from the [SAP Business Accelerator Hub](https://api.sap.com) sandbox or a real tenant |
| **Azure** | Functions on the Flex Consumption plan, PostgreSQL Flexible Server, Key Vault, Application Insights, all with managed identity ([Bicep](infra/main.bicep)) |
| **App** | TypeScript, Next.js 16 dashboard, `pg` with plain SQL migrations and views |
| **BI** | Power BI on the same SQL views ([guide](powerbi/README.md)) |

## Quick start (no SAP account needed)

```bash
docker compose up --build
```

This starts PostgreSQL, a **mock SAP OData server**, and the dashboard on http://localhost:3000. On start,
the dashboard migrates the database and runs a first sync. Trigger another sync:

```bash
curl -X POST -H "Authorization: Bearer local-sync-token-change-me" localhost:3000/api/sync
```

The mock serves about 390 orders over two years, with deliveries, invoices (some cancelled and
re-issued) and payments from customers with different payment habits. Move its clock forward to watch
an incremental sync pick up only what changed:

```bash
curl -X POST "localhost:4004/mock/advance?days=14"
```

## Against the real SAP sandbox

1. Sign in at [api.sap.com](https://api.sap.com), open your profile → **Settings** → **Show API Key**.
2. Check the field mapping against your sandbox before syncing anything:

```bash
SAP_API_KEY=<your key> npm run sap:probe
```

```
✓ customers
✓ sales_orders
✓ deliveries
✓ billing_documents
✗ receivables: missing ClearingDate     ← what a mismatch would look like
```

3. Sync: `SAP_API_KEY=<key> DATABASE_URL=… npm run sync`. For a real tenant, set `SAP_BASE_URL` and
   `SAP_USER` / `SAP_PASSWORD` for a communication user instead of the key.

The sandbox is **read-only** and shared, so its data is whatever SAP puts there. OrderLoop only reads,
which is exactly what a reporting connector should do.

## How the sync works ([`src/core/sync.ts`](src/core/sync.ts))

- **Incremental:** each entity has a watermark, the latest change timestamp seen. The next run asks SAP for `LastChangeDateTime ge <watermark>`. Entities whose change field is a date (`LastChangeDate`) re-read the whole watermark day, so nothing slips between runs.
- **Receivables** have no change timestamp that moves when an invoice is paid. So after a full first load, they are re-read over a rolling 400-day posting window.
- **Idempotent:** rows are upserted (`INSERT … ON CONFLICT DO UPDATE`), and duplicates inside one page are collapsed first. Re-running a sync, or re-reading the boundary, changes nothing.
- **Resumable:** each page and its watermark are committed together. A crash re-reads at most one page.
- **Defensive:** the watermark never moves past the run's start time, so a source clock running ahead cannot make later runs skip changes.
- **Resilient:** 429 and 5xx responses are retried with exponential backoff (honouring `Retry-After`), and 4xx fails fast with SAP's message. One entity failing does not stop the others. Every run is logged in `sync_runs`, and the dashboard shows the latest status per entity.
- **Field names:** mappers try SAP's known alternative field names (`pick(record, ["OriginalReferenceDocument", "DocumentReferenceID", …])`), and the probe reports what your system actually returns.

## Order-to-cash logic ([`db/migrations/002_o2c_views.sql`](db/migrations/002_o2c_views.sql))

| Stage | Rule |
|---|---|
| cancelled | the sales order is fully rejected |
| paid | every receivable of the order's live invoices is cleared |
| invoiced | at least one non-cancelled billing document |
| delivered | goods issue posted on a delivery |
| ordered | none of the above |

The KPIs:
- **Cycle times:** order → delivery → invoice → payment.
- **On-time delivery:** goods issued no later than the requested date.
- **Receivables ageing:** not due, 1–30, 31–60, 61–90, 90+ days past due.
- **DSO** over 90 days: open receivables ÷ invoiced amount × 90, per currency.

## Deploy to Azure

```bash
az group create -n orderloop-rg -l francecentral
export OL_PG_PASSWORD=$(openssl rand -hex 20) OL_SAP_API_KEY=<key> OL_CLIENT_IP=$(curl -s ifconfig.me)
az deployment group create -g orderloop-rg -f infra/main.bicep -p infra/main.bicepparam

# schema, once (from your machine, allowed by OL_CLIENT_IP)
DATABASE_URL="postgres://oladmin:$OL_PG_PASSWORD@<postgresHost>:5432/orderloop" PGSSLMODE=require npm run db:migrate

# code
cd functions && npm ci && npm run build
func azure functionapp publish <functionAppName>
```

What the template sets up:
- **Function App** (Flex Consumption, Node 22) with a system-assigned identity.
- **Storage** access through that identity: shared keys are disabled on the account.
- **Secrets** (SAP key, database URL) in Key Vault, referenced from app settings, never stored in them.
- **Application Insights** with Entra ID authentication.

The timer runs hourly (`SYNC_SCHEDULE`). `POST /api/syncNow` with a function key runs a sync on demand.
If every entity fails, the invocation fails, so an Application Insights alert can catch an expired key.

## Tests

```bash
docker compose up -d postgres
DATABASE_URL=postgres://orderloop:orderloop@localhost:5432/orderloop npm test    # 24 tests
```

- **OData client:**
  - `/Date()/` and decimal parsing, filter literals
  - paging, retry with backoff, fail-fast on 4xx
- **Sync, against PostgreSQL and the mock:**
  - the first load mirrors every document and skips supplier-only partners
  - re-runs are idempotent
  - **30 simulated days later**, an incremental run fetches only what changed and picks up the new payments
  - one failing entity leaves the others intact and is recorded
- **Azure Functions handler:** partial failure warns, total failure throws.

CI also builds the dashboard and the Functions bundle, and smoke-tests the whole Docker stack.

## Layout

```
src/core/       odata.ts (client) · entities.ts (SAP → rows) · sync.ts · o2c.ts (read models) · probe.ts · cli.ts
db/migrations/  001 tables · 002 order-to-cash views
src/app/        Next.js dashboard: overview, orders, /api/sync, /api/health
functions/      Azure Functions: hourly timer + HTTP trigger, bundled with esbuild
mock-sap/       deterministic O2C world + OData V2 server (filters, paging, $expand)
infra/          Bicep for Azure
powerbi/        DAX measures, read-only role, report guide
```

## License

MIT

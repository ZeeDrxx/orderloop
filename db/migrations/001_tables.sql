-- Mirror of the SAP order-to-cash documents OrderLoop reads. SAP stays the system of record.

CREATE TABLE customers (
  customer      text PRIMARY KEY,
  name          text NOT NULL,
  country       text,
  city          text,
  created_on    timestamptz,
  synced_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sales_orders (
  sales_order        text PRIMARY KEY,
  order_type         text,
  sold_to            text,
  customer_po        text,
  created_on         timestamptz,
  requested_delivery timestamptz,
  net_amount         numeric(18, 2),
  currency           text,
  payment_terms      text,
  overall_status     text,   -- A open · B in process · C completed
  delivery_status    text,
  rejection_status   text,   -- C = fully rejected (cancelled order)
  last_change        timestamptz,
  synced_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_orders_sold_to ON sales_orders (sold_to);
CREATE INDEX sales_orders_created ON sales_orders (created_on);

CREATE TABLE deliveries (
  delivery              text PRIMARY KEY,
  sold_to               text,
  created_on            timestamptz,
  planned_goods_issue   timestamptz,
  goods_issue_date      timestamptz,
  goods_movement_status text,  -- C = goods issued
  synced_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE delivery_links (
  delivery    text NOT NULL REFERENCES deliveries ON DELETE CASCADE,
  sales_order text NOT NULL,
  PRIMARY KEY (delivery, sales_order)
);
CREATE INDEX delivery_links_order ON delivery_links (sales_order);

CREATE TABLE billing_documents (
  billing_document  text PRIMARY KEY,
  billing_type      text,
  billing_date      timestamptz,
  sold_to           text,
  payer             text,
  net_amount        numeric(18, 2),
  tax_amount        numeric(18, 2),
  currency          text,
  payment_terms     text,
  is_cancelled      boolean NOT NULL DEFAULT false,
  accounting_status text,
  last_change       timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_links (
  billing_document text NOT NULL REFERENCES billing_documents ON DELETE CASCADE,
  sales_order      text NOT NULL,
  delivery         text NOT NULL,
  PRIMARY KEY (billing_document, sales_order, delivery)
);
CREATE INDEX billing_links_order ON billing_links (sales_order);

CREATE TABLE receivables (
  company_code        text NOT NULL,
  fiscal_year         text NOT NULL,
  accounting_document text NOT NULL,
  item                text NOT NULL,
  customer            text,
  billing_document    text,
  posting_date        timestamptz,
  net_due_date        timestamptz,
  clearing_date       timestamptz,
  amount              numeric(18, 2),
  currency            text,
  synced_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_code, fiscal_year, accounting_document, item)
);
CREATE INDEX receivables_billing ON receivables (billing_document);

-- Incremental sync bookkeeping
CREATE TABLE sync_state (
  entity     text PRIMARY KEY,
  watermark  timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_runs (
  id          bigserial PRIMARY KEY,
  entity      text NOT NULL,
  trigger     text NOT NULL,          -- schedule · manual · cli
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  fetched     integer NOT NULL DEFAULT 0,
  upserted    integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'running',  -- running · ok · failed
  error       text
);
CREATE INDEX sync_runs_started ON sync_runs (started_at DESC);

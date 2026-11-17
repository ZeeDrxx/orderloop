-- Order-to-cash, computed from the mirrored documents. The dashboard and Power BI both read these views.

-- One row per sales order: when it was delivered, invoiced and paid, and where it is now.
CREATE VIEW o2c_orders AS
WITH delivered AS (
  SELECT dl.sales_order, min(d.goods_issue_date) AS delivered_on
  FROM delivery_links dl JOIN deliveries d USING (delivery)
  WHERE d.goods_issue_date IS NOT NULL
  GROUP BY dl.sales_order
),
invoiced AS (
  SELECT bl.sales_order,
         min(b.billing_date) AS invoiced_on,
         array_agg(DISTINCT b.billing_document) AS invoices
  FROM billing_links bl JOIN billing_documents b USING (billing_document)
  WHERE NOT b.is_cancelled
  GROUP BY bl.sales_order
),
paid AS (
  -- an order is paid when every receivable of its invoices is cleared
  SELECT i.sales_order,
         CASE WHEN count(r.*) > 0 AND bool_and(r.clearing_date IS NOT NULL) THEN max(r.clearing_date) END AS paid_on,
         min(r.net_due_date) FILTER (WHERE r.clearing_date IS NULL) AS open_due_date
  FROM invoiced i
  JOIN receivables r ON r.billing_document = ANY (i.invoices)
  GROUP BY i.sales_order
)
SELECT
  o.sales_order, o.sold_to, c.name AS customer_name, o.created_on, o.requested_delivery,
  o.net_amount, o.currency,
  d.delivered_on, i.invoiced_on, p.paid_on, p.open_due_date,
  CASE
    WHEN o.rejection_status = 'C' THEN 'cancelled'
    WHEN p.paid_on IS NOT NULL THEN 'paid'
    WHEN i.invoiced_on IS NOT NULL THEN 'invoiced'
    WHEN d.delivered_on IS NOT NULL THEN 'delivered'
    ELSE 'ordered'
  END AS stage,
  round(extract(epoch FROM d.delivered_on - o.created_on) / 86400, 1) AS days_to_deliver,
  round(extract(epoch FROM i.invoiced_on - d.delivered_on) / 86400, 1) AS days_to_invoice,
  round(extract(epoch FROM p.paid_on - i.invoiced_on) / 86400, 1) AS days_to_pay,
  (o.requested_delivery IS NOT NULL AND d.delivered_on IS NOT NULL AND d.delivered_on::date <= o.requested_delivery::date) AS on_time
FROM sales_orders o
LEFT JOIN customers c ON c.customer = o.sold_to
LEFT JOIN delivered d USING (sales_order)
LEFT JOIN invoiced i USING (sales_order)
LEFT JOIN paid p USING (sales_order);

-- Open receivables with their ageing bucket.
CREATE VIEW o2c_open_receivables AS
SELECT
  r.*, c.name AS customer_name,
  (current_date - r.net_due_date::date) AS days_overdue,
  CASE
    WHEN r.net_due_date IS NULL OR r.net_due_date::date >= current_date THEN 'not due'
    WHEN current_date - r.net_due_date::date <= 30 THEN '1-30'
    WHEN current_date - r.net_due_date::date <= 60 THEN '31-60'
    WHEN current_date - r.net_due_date::date <= 90 THEN '61-90'
    ELSE '90+'
  END AS bucket
FROM receivables r
LEFT JOIN customers c ON c.customer = r.customer
WHERE r.clearing_date IS NULL;

-- DSO over the last 90 days, per currency: open receivables / invoiced amount × 90.
CREATE VIEW o2c_dso AS
WITH ar AS (SELECT currency, sum(amount) AS open_amount FROM receivables WHERE clearing_date IS NULL GROUP BY currency),
     sales AS (
       SELECT currency, sum(net_amount + coalesce(tax_amount, 0)) AS invoiced_90d
       FROM billing_documents WHERE NOT is_cancelled AND billing_date >= now() - interval '90 days'
       GROUP BY currency)
SELECT ar.currency, ar.open_amount, sales.invoiced_90d,
       round(ar.open_amount / nullif(sales.invoiced_90d, 0) * 90, 1) AS dso_days
FROM ar LEFT JOIN sales USING (currency);

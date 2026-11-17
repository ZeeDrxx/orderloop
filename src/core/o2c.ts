/** Read models for the dashboard: everything comes from the o2c_* views. */
import type pg from "pg";

export type Stage = "ordered" | "delivered" | "invoiced" | "paid" | "cancelled";
export const STAGES: Stage[] = ["ordered", "delivered", "invoiced", "paid", "cancelled"];

export async function overview(db: pg.Pool) {
  const [stages, cycle, aging, dso, overdue, runs] = await Promise.all([
    db.query<{ stage: Stage; orders: number; amount: string; currency: string }>(`
      SELECT stage, count(*)::int AS orders, sum(net_amount)::text AS amount, currency
      FROM o2c_orders GROUP BY stage, currency ORDER BY currency, array_position($1::text[], stage)`, [STAGES]),
    db.query<{ days_to_deliver: string; days_to_invoice: string; days_to_pay: string; on_time_rate: string; orders: number }>(`
      SELECT round(avg(days_to_deliver), 1)::text AS days_to_deliver,
             round(avg(days_to_invoice), 1)::text AS days_to_invoice,
             round(avg(days_to_pay), 1)::text AS days_to_pay,
             round(avg(on_time::int) FILTER (WHERE delivered_on IS NOT NULL) * 100, 1)::text AS on_time_rate,
             count(*)::int AS orders
      FROM o2c_orders WHERE created_on >= now() - interval '180 days' AND stage <> 'cancelled'`),
    db.query<{ bucket: string; amount: string; items: number; currency: string }>(`
      SELECT bucket, sum(amount)::text AS amount, count(*)::int AS items, currency FROM o2c_open_receivables
      GROUP BY bucket, currency
      ORDER BY currency, array_position(ARRAY['not due','1-30','31-60','61-90','90+'], bucket)`),
    db.query<{ currency: string; open_amount: string; invoiced_90d: string | null; dso_days: string | null }>(
      "SELECT currency, open_amount::text, invoiced_90d::text, dso_days::text FROM o2c_dso ORDER BY currency"),
    db.query<{ customer: string | null; customer_name: string | null; amount: string; currency: string; max_days: number }>(`
      SELECT customer, max(customer_name) AS customer_name, sum(amount)::text AS amount, currency, max(days_overdue)::int AS max_days
      FROM o2c_open_receivables WHERE days_overdue > 0
      GROUP BY customer, currency ORDER BY sum(amount) DESC LIMIT 8`),
    db.query<{ entity: string; status: string; started_at: Date; fetched: number; upserted: number; error: string | null }>(`
      SELECT DISTINCT ON (entity) entity, status, started_at, fetched, upserted, error
      FROM sync_runs ORDER BY entity, started_at DESC`),
  ]);
  return { stages: stages.rows, cycle: cycle.rows[0], aging: aging.rows, dso: dso.rows, overdue: overdue.rows, runs: runs.rows };
}

export async function orders(db: pg.Pool, opts: { stage?: string; q?: string; limit?: number } = {}) {
  const where: string[] = [];
  const values: unknown[] = [];
  if (opts.stage && (STAGES as string[]).includes(opts.stage)) {
    values.push(opts.stage);
    where.push(`stage = $${values.length}`);
  }
  if (opts.q) {
    values.push(`%${opts.q}%`);
    where.push(`(sales_order ILIKE $${values.length} OR customer_name ILIKE $${values.length})`);
  }
  values.push(Math.min(opts.limit ?? 100, 500));
  const res = await db.query(`
    SELECT sales_order, customer_name, sold_to, created_on, net_amount::text, currency, stage,
           delivered_on, invoiced_on, paid_on, open_due_date, days_to_deliver::text, days_to_pay::text
    FROM o2c_orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_on DESC NULLS LAST LIMIT $${values.length}`, values);
  return res.rows;
}

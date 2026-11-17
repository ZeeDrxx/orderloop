import type { Metadata } from "next";

import { getPool } from "@/core/db.ts";
import { orders, STAGES } from "@/core/o2c.ts";

import { day, money } from "../format";

export const metadata: Metadata = { title: "Orders" };
export const dynamic = "force-dynamic";

export default async function Orders({ searchParams }: { searchParams: Promise<{ stage?: string; q?: string }> }) {
  const { stage = "", q = "" } = await searchParams;
  const rows = await orders(getPool(), { stage: stage || undefined, q: q || undefined, limit: 200 });

  return (
    <>
      <h1>Orders</h1>
      <p className="muted">Each sales order with its delivery, invoice and payment, newest first.</p>
      <form className="filters">
        <select name="stage" defaultValue={stage} aria-label="Stage">
          <option value="">All stages</option>
          {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input name="q" defaultValue={q} placeholder="Order number or customer" aria-label="Search" />
        <button type="submit">Filter</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Order</th><th>Customer</th><th>Created</th><th className="num">Net amount</th><th>Stage</th>
              <th>Delivered</th><th>Invoiced</th><th>Paid / due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const overdue = r.stage === "invoiced" && r.open_due_date && new Date(r.open_due_date) < new Date();
              return (
                <tr key={r.sales_order}>
                  <td>{r.sales_order}</td>
                  <td>{r.customer_name ?? r.sold_to}</td>
                  <td>{day(r.created_on)}</td>
                  <td className="num">{money(r.net_amount, r.currency ?? "MAD")}</td>
                  <td><span className={`pill ${r.stage}`}>{r.stage}</span></td>
                  <td>{day(r.delivered_on)}</td>
                  <td>{day(r.invoiced_on)}</td>
                  <td className={overdue ? "bad" : undefined}>
                    {r.paid_on ? day(r.paid_on) : r.open_due_date ? `due ${day(r.open_due_date)}` : "–"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="muted">No orders match.</p>}
    </>
  );
}

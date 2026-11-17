import Link from "next/link";

import { getPool } from "@/core/db.ts";
import { overview, STAGES } from "@/core/o2c.ts";

import { ago, money } from "./format";

export const dynamic = "force-dynamic";

const BUCKETS = ["not due", "1-30", "31-60", "61-90", "90+"];

export default async function Overview() {
  const o = await overview(getPool());
  const currency = o.stages[0]?.currency ?? o.dso[0]?.currency ?? "MAD";
  const stages = STAGES.map((s) => o.stages.find((x) => x.stage === s && x.currency === currency) ?? { stage: s, orders: 0, amount: "0" });
  const totalOrders = stages.reduce((n, s) => n + s.orders, 0);
  const dso = o.dso.find((x) => x.currency === currency);
  const aging = BUCKETS.map((b) => o.aging.find((a) => a.bucket === b && a.currency === currency) ?? { bucket: b, amount: "0", items: 0 });
  const overdueTotal = aging.slice(1).reduce((s, a) => s + Number(a.amount), 0);
  const lastSync = o.runs.reduce<Date | null>((m, r) => (!m || r.started_at > m ? r.started_at : m), null);
  const failed = o.runs.filter((r) => r.status === "failed");

  if (!totalOrders) {
    return (
      <>
        <h1>Order to cash</h1>
        <p className="card">No data yet. Run a sync: <code>npm run sync</code>, or wait for the scheduled Azure Function.</p>
      </>
    );
  }

  return (
    <>
      <h1>Order to cash</h1>
      <p className="muted">
        Last sync {lastSync ? ago(lastSync) : "never"}
        {failed.length > 0 && <span className="bad"> · {failed.map((f) => f.entity).join(", ")} failed: {failed[0].error}</span>}
      </p>

      <div className="grid">
        <div className="card"><div className="muted">Days sales outstanding (90 d)</div><div className="big">{dso?.dso_days ?? "–"}</div></div>
        <div className="card"><div className="muted">Open receivables</div><div className="big">{money(dso?.open_amount, currency)}</div></div>
        <div className="card"><div className="muted">Overdue</div><div className={`big ${overdueTotal > 0 ? "bad" : ""}`}>{money(overdueTotal, currency)}</div></div>
        <div className="card"><div className="muted">On-time delivery (180 d)</div><div className="big">{o.cycle?.on_time_rate ?? "–"}%</div></div>
      </div>

      <h2>Pipeline</h2>
      <div className="card">
        <div className="bar" role="img" aria-label="Orders by stage">
          {stages.map((s) => s.orders > 0 && (
            <span key={s.stage} style={{ width: `${(s.orders / totalOrders) * 100}%`, background: `var(--s-${s.stage})` }} title={`${s.stage}: ${s.orders}`} />
          ))}
        </div>
        <div className="legend">
          {stages.map((s) => (
            <Link key={s.stage} href={`/orders?stage=${s.stage}`}>
              <i style={{ background: `var(--s-${s.stage})` }} />{s.stage} {s.orders} · {money(s.amount, currency)}
            </Link>
          ))}
        </div>
      </div>

      <h2>Cycle time, last 180 days (average days)</h2>
      <div className="grid">
        <div className="card"><div className="muted">Order → delivery</div><div className="big">{o.cycle?.days_to_deliver ?? "–"}</div></div>
        <div className="card"><div className="muted">Delivery → invoice</div><div className="big">{o.cycle?.days_to_invoice ?? "–"}</div></div>
        <div className="card"><div className="muted">Invoice → payment</div><div className="big">{o.cycle?.days_to_pay ?? "–"}</div></div>
      </div>

      <h2>Receivables ageing</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Days past due</th><th className="num">Items</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {aging.map((a) => (
              <tr key={a.bucket}>
                <td className={a.bucket === "90+" && a.items ? "bad" : a.bucket !== "not due" && a.items ? "warn" : ""}>{a.bucket}</td>
                <td className="num">{a.items}</td>
                <td className="num">{money(a.amount, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {o.overdue.length > 0 && (
        <>
          <h2>Who to call</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Customer</th><th className="num">Overdue</th><th className="num">Oldest (days)</th></tr></thead>
              <tbody>
                {o.overdue.map((c) => (
                  <tr key={`${c.customer}-${c.currency}`}>
                    <td><Link href={`/orders?q=${encodeURIComponent(c.customer_name ?? c.customer ?? "")}`}>{c.customer_name ?? c.customer}</Link></td>
                    <td className="num bad">{money(c.amount, c.currency)}</td>
                    <td className="num">{c.max_days}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Sync</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Entity</th><th>Status</th><th>When</th><th className="num">Fetched</th><th className="num">Upserted</th></tr></thead>
          <tbody>
            {o.runs.map((r) => (
              <tr key={r.entity}>
                <td>{r.entity}</td>
                <td className={r.status === "ok" ? "ok" : r.status === "failed" ? "bad" : ""}>{r.status}</td>
                <td>{ago(r.started_at)}</td>
                <td className="num">{r.fetched}</td>
                <td className="num">{r.upserted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

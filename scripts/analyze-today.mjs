// Read-only analysis: today's sales (Africa/Kigali day) and how the profit was obtained.
// COGS/margins come from the REAL report endpoints (/reports/summary, /reports/profitability),
// so every number matches what the app's Reports and Profitability screens show.
// Usage: node scripts/analyze-today.mjs
import { readFileSync } from "node:fs";
import pg from "pg";

const API = process.env.API_URL ?? "http://localhost:3000";
const EMAIL = "owner@demo.local";
const PASSWORD = process.env.DEMO_PASSWORD ?? "dev-password-2026";

// Today on the shop's business calendar (UTC+2, no DST — Africa/Kigali).
const now = new Date();
const day = new Date(now.getTime() + 2 * 3600_000).toISOString().slice(0, 10);
const from = new Date(`${day}T00:00:00+02:00`).toISOString();
const to = new Date(Date.parse(from) + 86_400_000).toISOString();
console.log(`Analysis window: ${day} (Kigali)  ${from} .. ${to}`);

const post = async (path, body) => {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
const get = async (path, token) => {
  const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

const { token: accessToken } = await post("/auth/login", { email: EMAIL, password: PASSWORD });
const qs = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
const summary = await get(`/reports/summary?${qs}`, accessToken);
const profitability = await get(`/reports/profitability?${qs}`, accessToken);
const tx = await get(`/reports/transactions?${qs}&kind=sales`, accessToken);

// Raw context the report endpoints don't carry per row (expense split, seller, payment method).
const line = readFileSync("apps/api/.env", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/\r/g, "").trim();
const u = new URL(line);
const db = new pg.Client({ host: u.hostname, port: +u.port || 5432, user: u.username, password: u.password, database: u.pathname.slice(1) });
await db.connect();
const expenses = (await db.query(
  `SELECT category, SUM(amount)::bigint amt, bool_and(paid) AS all_paid FROM expenses
   WHERE incurred_at>=$1 AND incurred_at<$2 GROUP BY category ORDER BY amt DESC`, [from, to])).rows;
const seller = (await db.query(
  `SELECT us.full_name, s.payment_method FROM sales s JOIN users us ON us.id=s.user_id
   WHERE s.status='posted' AND s.sold_at>=$1 AND s.sold_at<$2`, [from, to])).rows;
const stock = (await db.query(
  `SELECT p.name, COALESCE(SUM(m.qty),0)::bigint on_hand, p.selling_price,
          (SELECT unit_cost FROM stock_movements m2 WHERE m2.product_id=p.id AND m2.unit_cost IS NOT NULL
           ORDER BY m2.occurred_at DESC, m2.id DESC LIMIT 1) AS last_cost
   FROM products p LEFT JOIN stock_movements m ON m.product_id=p.id
   WHERE p.id IN (SELECT product_id FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id
                  WHERE s.status='posted' AND s.sold_at>=$1 AND s.sold_at<$2)
   GROUP BY p.id, p.name, p.selling_price`, [from, to])).rows;
await db.end();

const rwf = n => `${Number(n).toLocaleString("en-US")} RWF`;
/** Quantities are stored in milli-units (x1000); show them the way the app does. */
const fmtUnits = m => { const v = m / 1000; return Number.isInteger(v) ? String(v) : String(v).replace(/0+$/, "").replace(/\.$/, ""); };
const cur = summary.current ?? summary;

console.log("\n=== TODAY'S P&L — exactly what the Reports screen shows ===");
const row = (k, v) => console.log(`${k.padEnd(30)} ${v}`);
row("Gross sales", rwf(cur.grossSales));
row("Discounts", `-${rwf(cur.discounts)}`);
row("Sales returns", `-${rwf(cur.salesReturns)}`);
row("Net sales", rwf(cur.netSales));
row("COGS", `-${rwf(cur.cogs)}`);
row("Gross profit", `${rwf(cur.grossProfit)}   (${cur.grossMarginBps !== null ? (cur.grossMarginBps / 100).toFixed(2) : "n/a"}% margin)`);
row("Operating expenses today", rwf(cur.operatingExpenses));
row("Operating profit", rwf(cur.operatingProfit));
row("Stock losses today", rwf(cur.stockLosses));
row("Result after stock losses", rwf(cur.operatingResultAfterStockLosses));
row("Cash collected today", rwf(cur.cashCollected));
row("Transactions", `${cur.transactions ?? tx.length} sales, ${cur.unitsSold ?? "?"} units (milli-units shown raw)`);

const items = profitability.items ?? [];
const targetPct = profitability.targetMarginBps ? profitability.targetMarginBps / 100 : null;

console.log("\n=== HOW THE PROFIT WAS OBTAINED — by product ===");
console.log("product              units  net revenue      COGS  gross profit  margin   price  avg cost");
for (const p of items.filter(x => x.units > 0 || x.revenue > 0)) {
  console.log(
    `${p.name.padEnd(20)} ${fmtUnits(p.units).padStart(4)} ${rwf(p.revenue).padStart(13)} ${rwf(p.cogs).padStart(11)} ${rwf(p.grossProfit).padStart(13)} ` +
    `${(p.grossMarginBps !== null ? (p.grossMarginBps / 100).toFixed(1) : "n/a").padStart(6)}% ${rwf(p.sellingPrice).padStart(8)} ${rwf(p.avgCost).padStart(9)}`);
}

console.log("\n=== THE TRANSACTIONS ===");
for (const s of tx) {
  const t = new Date(new Date(s.at ?? s.sold_at).getTime() + 2 * 3600_000).toISOString().slice(11, 16);
  console.log(`${t}  net ${rwf(Number(s.gross_amount ?? s.gross) - Number(s.discount ?? 0)).padStart(11)}  paid ${rwf(s.amount_paid).padStart(11)}  ${s.payment_method ?? "?"}  by ${s.by ?? "?"}  status ${s.status}${Number(s.discount) > 0 ? `  [disc ${rwf(s.discount)}]` : ""}`);
}

console.log("\n=== TODAY'S EXPENSES (vs gross profit) ===");
if (!expenses.length) console.log("none");
for (const e of expenses) console.log(`${e.category.padEnd(14)} ${rwf(e.amt).padStart(11)}${e.all_paid ? "" : "  (unpaid)"}`);

console.log("\n=== THE APP'S ADVICE ON TODAY'S MIX ===");
for (const r of (profitability.recommendations ?? []).slice(0, 8))
  console.log(`- [${r.severity}] ${r.code}${r.productName ? ` on ${r.productName}` : ""} ${JSON.stringify(r.params)}`);
if (targetPct !== null) console.log(`(shop target gross margin: ${targetPct}%)`);

console.log("\n=== STOCK AFTER TODAY'S SALES (the goods the profit was earned on) ===");
for (const s of stock) console.log(`${s.name.padEnd(24)} on hand ${String(Number(s.on_hand) / 1000).padStart(8)}  price ${rwf(s.selling_price).padStart(9)}  last known cost ${s.last_cost == null ? "unknown" : rwf(s.last_cost) + " /unit"}`);

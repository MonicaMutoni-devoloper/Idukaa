// Demo operating expenses for the dev shop "Demo Shop (dev only)", spread across the same 14 days
// as the demo sales (last 14 days including today), through the real /sync/push path as the owner.
// Uses only the four categories the app itself offers (rent, electricity, transport, other) and
// realistic small-shop amounts, so operating profit, per-category trends and the break-even report
// show believable numbers. Existing real entries (rent 200,000 / food 50,000) are never touched.
// Idempotent: operation ids are derived deterministically, a re-run reports "duplicate".
// Usage: node scripts/demo-expenses.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const API = process.env.API_URL ?? "http://localhost:3000";
const EMAIL = "owner@demo.local";
const PASSWORD = process.env.DEMO_PASSWORD ?? "dev-password-2026";
const DAYS = 14;

// dayOffset (0 = today, 1 = yesterday, ...), category, amount (RWF), paid, note
const EXPENSES = [
  [13, "transport", 5500, true, "Restock trip to the wholesale market"],
  [12, "transport", 4000, true, "Boda taxi for stock delivery"],
  [11, "other", 5400, true, "Packaging bags and boxes"],
  [11, "transport", 6200, true, "Restock trip to the wholesale market"],
  [10, "transport", 3500, true, "Boda taxi for stock delivery"],
  [9, "transport", 5000, true, "Restock trip to the wholesale market"],
  [9, "electricity", 14600, true, "Monthly electricity bill"],
  [8, "transport", 4800, true, "Boda taxi for stock delivery"],
  [7, "transport", 3900, true, "Restock trip to the wholesale market"],
  [6, "other", 2500, true, "Airtime for customer order calls"],
  [5, "transport", 6500, true, "Restock trip to the wholesale market"],
  [3, "transport", 4200, true, "Boda taxi for stock delivery"],
  [2, "electricity", 9000, true, "Prepaid electricity token"],
  [2, "other", 3200, true, "Cleaning supplies"],
  [1, "transport", 5800, true, "Restock trip to the wholesale market"],
  [0, "transport", 3500, true, "Boda taxi for stock delivery"],
];

const uuidFrom = (ns, key) => {
  const h = createHash("sha1").update(ns + key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const now = new Date();
const kigaliToday = new Date(now.getTime() + 2 * 3600_000); // Africa/Kigali = UTC+2
const ops = EXPENSES.map(([d, category, amount, paid, note]) => {
  const day = new Date(Date.UTC(kigaliToday.getUTCFullYear(), kigaliToday.getUTCMonth(), kigaliToday.getUTCDate() - d));
  const key = `${day.toISOString().slice(0, 10)}#${category}#${amount}`;
  // daytime in Kigali; today's entry is clamped into the past
  let incurredAt = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 9, 30));
  if (d === 0 && incurredAt.getTime() > now.getTime() - 30 * 60_000) incurredAt = new Date(now.getTime() - 60 * 60_000);
  return {
    opId: uuidFrom("op:", key), deviceId: "demo-expenses-script", createdAt: new Date().toISOString(),
    type: "expense.create",
    payload: { expenseId: uuidFrom("exp:", key), category, amount, paid, incurredAt: incurredAt.toISOString(), note },
  };
});

console.log(`pushing ${ops.length} expense operations (${EXPENSES.reduce((s, e) => s + e[2], 0)} RWF total) to ${API}`);
const lr = await fetch(`${API}/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!lr.ok) throw new Error(`login failed: ${lr.status} ${await lr.text()}`);
const { token } = await lr.json();

const r = await fetch(`${API}/sync/push`, {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ operations: ops }),
});
if (!r.ok) throw new Error(`push failed: ${r.status} ${await r.text()}`);
const { results } = await r.json();
const count = results.reduce((a, x) => { a[x.status] = (a[x.status] ?? 0) + 1; return a; }, {});
console.log("results:", JSON.stringify(count));
for (const x of results) if (x.status !== "applied" && x.status !== "duplicate") console.log("  !", x.status, x.message);

// verification
const s = await (await fetch(`${API}/reports/summary?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z`,
  { headers: { Authorization: `Bearer ${token}` } })).json();
const c = s.current;
console.log("\nOctober summary after expenses:");
console.log(`  net sales:            ${c.netSales}`);
console.log(`  COGS:                 ${c.cogs}`);
console.log(`  gross profit:         ${c.grossProfit} (${(c.grossMarginBps / 100).toFixed(2)}%)`);
console.log(`  operating expenses:   ${c.operatingExpenses} (paid ${c.expensesPaid})`);
console.log(`  operating profit:     ${c.operatingProfit}`);
console.log(`  transactions:         ${c.transactions}`);

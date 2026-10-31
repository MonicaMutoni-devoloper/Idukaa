# Financial policy

## Money and quantities

- Money: integer RWF. Quantity: integer milli-units (2.5 kg = 2500). Line amount = round-half-up(qty × price / 1000) using BigInt. No floating point.
- **Net sales** = gross sales − discounts − approved sales-return refunds. A voided sale leaves gross sales, so it also leaves net sales.
- **COGS**: moving weighted average over the full ledger history; sale cost relieved = value × qty / on-hand. Sale returns restore stock at the current average and reduce COGS.
- **Gross profit** = net sales − COGS. **Operating profit** = gross profit − operating expenses **incurred** in the period (accrual). Purchases are inventory, not expenses.
- Stock losses (damage/expiry/negative corrections, once owner-approved) are reported as `stockLossValue` and are **not** included in COGS or operating profit; owners review them separately.
- Cash view: cash collected = sum of amounts paid on sales; expenses paid vs incurred shown separately; receivables = gross − discount − paid. A customer's credit sale is a receivable, not revenue collected.

## Purchase entry and unit cost

- Stock is held in **sellable units** (milli-units). A purchase line may be described in a purchase unit with a per-line conversion (a crate of 12 bottles is `1 crate × 12 = 12 bottles`); the conversion is per line, never assumed globally.
- The receipt records **one integer RWF cost per sellable unit**. When a cashier enters a total line cost instead, the unit cost is `round-half-up(total × 1000 / qty)` and the recorded line total is `qty × unitCost`. Any rounding difference is shown in the receive screen (and the API stores the integer unit cost), so the ledger total can differ from the typed invoice total by a few RWF.
- Selling prices entered on a received line become the product's current selling price when the goods are received, with an audit entry (`product.price_from_purchase`). A purchase saved without delivery applies the price when it is received.
- Purchases carry supplier, invoice/reference, purchase date, recorded-by user, notes, amount paid and balance. Transport, duty and purchase-level discounts are **not** allocated into unit cost yet; the model has no purchase-charge table.

## Policy rules (owner-configurable, enforced by the API)

| Rule | Default | Behaviour |
|---|---|---|
| Below-cost selling price | `acknowledge` | A line whose selling price is below unit cost requires `belowCostAcknowledged` plus a reason of at least 3 characters. The purchase and the reason are audited (`purchase.below_cost`). In `block` mode managers receive `rejected`; the owner may still record the receipt (the block is a manager limit). |
| Manager discount ceiling | 100% | `discount ≤ floor(gross × percent / 100)` for managers; above that the operation is `rejected` with `discount_above_limit`. Owners can never record sales, so the ceiling is a hard manager limit. |
| Manager financial access | off | When off, `/reports/dashboard` returns `financials: null` and no COGS/profit fields, `inventoryValue` is null, `/reports/inventory` omits average cost/value, `/reports/summary` is 403, and `grossProfit` in the trend is null for managers. When on, managers receive the same financial figures as the owner on the dashboard and summary. Transaction lists and CSV do not contain cost or profit. |

## Voiding a sale

- A completed sale is never edited or deleted. An owner may void it once with a reason (`POST /sales/:id/void`).
- In one transaction the server locks the sale row, confirms it is still `posted`, writes a `sale_return` ledger movement for every line (source `sale_void`), stamps `status='reversed'`, `reversed_at`, `reversed_by` and `reversal_reason`, and writes a `sale.void` audit entry.
- The status check under the row lock makes a second reversal impossible; a retry receives `409 sale_already_reversed` and no stock moves.
- Voided sales remain in the transaction report (marked **Voided**) and in the CSV, and are excluded from posted-sales totals.
- Accounting effect: the sale leaves net sales in its original period, while the returned stock is valued at the **current** moving average. If the cost changed after the sale, the two are not an exact mirror; both records remain auditable. Returns via an approved `sale_return` adjustment behave the same way.

## Payment methods

Sales record `cash`, `momo` (mobile money), `bank` or `credit`. The method is stored on the sale, shown on the receipt and in the transaction report/CSV. Partial payments are allowed: `amount_paid` may be below the net total, and the difference is the receivable. Change (amount tendered above the total) is never counted as revenue.

## Reporting

- Reports show their date range, compare with the immediately preceding period of equal length, and can list the underlying sales/purchases/expenses.
- CSV export (`GET /reports/export?kind=sales|purchases|expenses&from=&to=`) exports the same rows with plain integer RWF amounts, UTF-8 BOM for spreadsheets, and quoted fields when a name/note contains a comma, quote or newline.
- Limitation: COGS for a period is recomputed from the ledger, so backdated receipts can restate history.

## Verification

The guarantees above are pinned by `apps/api/tests/finance.integration.test.ts` (real PostgreSQL, no
mocks): it pushes a backdated January fixture through the sync pipeline and reads it back through the
real report controllers. It checks Kigali month boundaries (23:59 vs 00:00 expenses), that purchases are
never expenses, that a later purchase does not restate earlier sales' cost basis, profitability
revenue/COGS/margins/advice, exact discount splitting across sale lines, stock-loss and sale-return
correctness, drill-down-to-summary reconciliation, manager financial gating and shop scoping, dashboard
series consistency, and that empty periods report margin as unavailable rather than 0%.

```powershell
$env:TEST_DATABASE_URL = "postgres://.../sms_test"; npm run test:api   # 37 tests
```

# IDUKAA — Financial Formula and Accounting Methodology Audit

Date: 2026-11-18  
Scope: backend, database, shared business logic, mobile/offline calculation, reports, dashboards.  
Policy reference: `docs/FINANCE.md`.  
Status: **Audit only. No implementation changes were made.**

## 1. Executive summary

This audit traced the financial and inventory formulas actually used by Idukaa, including formulas hidden in SQL queries, database triggers, shared TypeScript utilities, offline device calculations and report controllers. The system is built around a clear and generally sound accounting policy: integer RWF money, milli-unit quantities, perpetual moving weighted average cost, server-authoritative posting, immutable sales/returns, and period COGS attributed by posting order.

### Counts

| Category | Count |
|---|---:|
| Formulas / KPIs identified | 96 |
| CORRECT | 58 |
| INCORRECT | 7 |
| INCONSISTENT | 11 |
| MISSING | 9 |
| NEEDS BUSINESS DECISION | 6 |
| CORRECT BUT LIMITED / UNVERIFIED | 5 |

The most serious risks are not in the core weighted-average formula. They are in **offline/mobile replay coverage**, **product-level discount allocation in SQL**, **damaged-return cost treatment**, and **a few KPIs that are operationally useful but not full accounting measures**. The server-side headline P&L, weighted-average costing and returns logic are materially sound.

### Most serious financial risks

1. **Offline mobile COGS can diverge from the server.** `buildLedger()` in `apps/mobile/src/services/local-dashboard.ts` replays only `opening`, `receipt` and `sale` movements. It does not replay `sale_return`, `damage`, `expiry`, `adjustment`, `supplier_return`, `count_correction`, `transfer_in` or `transfer_out`. Therefore an offline dashboard/report can understate or misstate COGS, inventory value and gross profit after returns, damage, adjustments or transfers.
2. **Offline mobile sales do not record unit cost.** Mobile sale movements are created without `unitCost`, so offline COGS uses the running average fallback instead of the fixed posting-time snapshot used by the server. Backdated receipts or returns can restate offline COGS.
3. **Mobile sales returns are not represented in offline dashboards.** `salesReturns` is hard-coded to `0` in both `computeLocalDashboard()` and `computeLocalSummary()` in the mobile code. Offline net sales and COGS therefore ignore returns even though the server attributes returns to their return period.
4. **Product-level profitability uses SQL `ROUND()` discount allocation.** `FinanceService.productProfitability()` allocates each sale discount with `ROUND(s.discount * line_amount / gross_amount)`, while the sale detail view and shared utility use exact largest-remainder allocation. Product revenue and margins can differ from the headline report by a few RWF per product.
5. **Damaged/expired/inspection returns are quarantined but not automatically valued as losses.** Only `resalable` returns create a `sale_return` stock movement. Damaged goods remain in the return document; their cost is shown as `costReversed` only if the caller asks for restocked lines. They are not posted to stock loss or COGS automatically.
6. **Some KPIs are proxies, not accounting measures.** `breakEven()` uses COGS as the variable cost proxy and operating expenses as fixed costs. This is a management estimate, not a full cost-accounting break-even.

### Methods that should be retained

- Perpetual moving weighted average cost.
- Integer RWF and milli-unit quantities.
- Server-authoritative posting under product row locks.
- Cost snapshot on `sale_lines.unit_cost` and sale stock movements.
- Sale returns restoring cost at the original sale cost.
- Immutable sales, returns, price changes and stock ledger.
- Kigali business-day / half-open period boundaries.
- Exact largest-remainder discount allocation in shared code and sale detail.

### Methods that should be improved or replaced

- Offline ledger replay should be expanded to the same movement types as the server.
- Offline sale operations should carry and persist `unitCost` when posted.
- Offline dashboards should include sale returns.
- Product-level revenue allocation should use the same exact discount allocation as the headline report.
- Damaged-return accounting policy should be explicitly defined and implemented.
- Missing management metrics (turnover, DIO, reorder point, safety stock) should be added only as clearly labelled management metrics, not accounting measures.

## 2. Audit method

The audit inspected:

- Shared calculation utilities: `packages/shared/src/*.ts`
- Backend financial services and controllers: `apps/api/src/reports`, `apps/api/src/sales`, `apps/api/src/returns`, `apps/api/src/sync`, `apps/api/src/audits`
- Database migrations: `apps/api/migrations/*.sql`
- Mobile offline calculations: `apps/mobile/src/services/local-dashboard.ts`, `local-reports.ts`, `local-dashboard-data.ts`, `local-reports-data.ts`
- Financial policy: `docs/FINANCE.md`
- Tests referenced by documentation and repository structure

Each formula was traced to its implementation, input fields, output and usage. Independent mathematical examples were used where practical. Where a calculation could not be executed against production data, it is marked `UNVERIFIED`.

## 3. Core accounting policy implemented

The system’s documented policy is:

- Money: integer RWF.
- Quantity: integer milli-units (`2.5 kg = 2500`).
- Line amount: `round_half_up(qtyMilli × unitPrice / 1000)` using BigInt.
- Costing: perpetual moving weighted average.
- Sale cost is fixed at posting time and stored on `sale_lines.unit_cost` and the sale stock movement.
- Sale returns restore stock at the original sale cost.
- Price changes do not change inventory value or historical sales.
- Gross profit = net sales − COGS.
- Operating profit = gross profit − operating expenses incurred.
- Purchases are inventory, not expenses.
- Stock losses are reported separately and are not included in COGS or operating profit.
- Reports use Africa/Kigali business days and half-open ranges `[from, to)`.

## 4. Formula catalogue

Assessment labels:

- `CORRECT` — mathematically and operationally appropriate.
- `CORRECT BUT LIMITED` — valid but based on restricted assumptions.
- `INCORRECT` — mathematically or operationally wrong.
- `INCONSISTENT` — different parts calculate it differently.
- `MISSING` — not implemented.
- `UNVERIFIED` — insufficient evidence.
- `NEEDS BUSINESS DECISION` — cannot be finalized without an explicit policy decision.

| Calculation | Current formula | Code location | Current method | Assessment | Recommended method | Priority |
|---|---|---|---|---|---|---|
| Line amount | `round_half_up(qtyMilli × unitPrice / 1000)` | `packages/shared/src/money.ts#lineAmount` | BigInt integer arithmetic | CORRECT | Retain | P1 |
| Quantity parse | `"2.5" → 2500` | `packages/shared/src/money.ts#parseQty` | Decimal string to milli-units | CORRECT | Retain | P3 |
| Unit cost from total | `round_half_up(totalCost × 1000 / qty)` | `packages/shared/src/purchase.ts#unitCostFromTotal` | Integer RWF per base unit | CORRECT | Retain | P1 |
| Recorded line cost | `lineAmount(qty, unitCost)` | `packages/shared/src/purchase.ts#totalFromUnitCost` | Integer RWF | CORRECT | Retain | P1 |
| Purchase line projection | `unitCost, recordedCost, revenue, profit, marginBps, belowCost` | `packages/shared/src/purchase.ts#projectLine` | Preview arithmetic | CORRECT BUT LIMITED | Use cross-unit below-cost test consistently | P2 |
| Exact discount allocation | Largest-remainder split of sale discount across line amounts | `packages/shared/src/finance.ts#allocateLineDiscounts` | Exact integer RWF | CORRECT | Retain | P1 |
| Net sales | `grossSales − discounts − salesReturns` | `packages/shared/src/finance.ts#summarize` | Period summary | CORRECT | Retain | P1 |
| Gross profit | `netSales − COGS` | `packages/shared/src/finance.ts#summarize` | Period summary | CORRECT | Retain | P1 |
| Operating profit | `grossProfit − operatingExpenses` | `packages/shared/src/finance.ts#summarize` | Accrual basis | CORRECT | Retain | P1 |
| Operating result after stock losses | `operatingProfit − stockLosses` | `packages/shared/src/finance.ts#summarize` | Separate loss reporting | CORRECT | Retain | P1 |
| Gross margin bps | `round(grossProfit × 10000 / netSales)` or null | `packages/shared/src/finance.ts#summarize` | Null when no sales | CORRECT | Retain | P2 |
| Outstanding expenses | `operatingExpenses − expensesPaid` | `packages/shared/src/finance.ts#summarize` | Accrual vs cash | CORRECT | Retain | P2 |
| Total received | `cashCollected + creditRepayments` | `packages/shared/src/finance.ts#summarize` | Cash collections only | CORRECT | Retain | P2 |
| Markup percentage | `(price − cost) / cost × 100` | `packages/shared/src/pricing.ts#markupPct` | Float percentage | CORRECT BUT LIMITED | Use integer basis points if exact reporting needed | P3 |
| Gross margin percentage | `(price − cost) / price × 100` | `packages/shared/src/pricing.ts#grossMarginPct` | Float percentage | CORRECT BUT LIMITED | Use integer basis points if exact reporting needed | P3 |
| Recommended price | `ceil(cost / (1 − targetMargin))` | `packages/shared/src/pricing.ts#recommendedPrice` | Target margin pricing | CORRECT | Retain | P3 |
| Break-even revenue | `fixedCosts / ((netSales − COGS) / netSales)` | `packages/shared/src/pricing.ts#breakEven` | COGS as variable cost proxy | CORRECT BUT LIMITED | Label as management estimate | P3 |
| Unit conversion to base | `naturalMilli × unitsPer` | `packages/shared/src/units.ts#toBaseQty` | Exact integer | CORRECT | Retain | P1 |
| Unit conversion from base | `round_half_up(baseMilli / unitsPer)` | `packages/shared/src/units.ts#fromBaseQty` | Integer milli-units | CORRECT | Retain | P1 |
| Cost per base unit | `round_half_up(costPerNatural / unitsPer)` | `packages/shared/src/units.ts#costPerBaseUnit` | Integer RWF | CORRECT | Retain | P1 |
| Cross-unit below-cost test | `price < costPerBase × unitsPerPrice` | `packages/shared/src/units.ts#priceBelowCost` | Exact cross multiplication | CORRECT | Retain | P1 |
| Profit per base unit | `floor(price / unitsPerPrice) − costPerBase` | `packages/shared/src/units.ts#profitPerBaseUnit` | Integer RWF | CORRECT | Retain | P2 |
| Moving weighted average replay | Inbound adds `qty × unitCost`; outbound relieves recorded or running average; returns restore original cost | `packages/shared/src/valuation.ts#replayLedger` | Perpetual weighted average | CORRECT | Retain | P1 |
| Ledger order | Posting sequence (`seq`) when available, otherwise document timestamp | `packages/shared/src/valuation.ts#ledgerOrder` | Posting order authoritative | CORRECT | Retain | P1 |
| Expected stock | Sum of signed movement quantities | `packages/shared/src/valuation.ts#expectedStock` | Movement sum | CORRECT | Retain | P2 |
| Inventory value at instant | Replay movements before timestamp | `packages/shared/src/valuation.ts#valueAt` | Historical valuation | CORRECT | Retain | P2 |
| Current average cost | `replayLedger(movements).avgCost` | `packages/shared/src/valuation.ts#currentAverageCost` | Posting-time average | CORRECT | Retain | P1 |
| Historical average cost | Replay movements with document timestamp <= cutoff | `packages/shared/src/valuation.ts#averageCostAt` | Historical analysis | CORRECT BUT LIMITED | Keep for analysis only | P3 |
| Stock count discrepancy | `counted − expected` | `packages/shared/src/valuation.ts#compareCount` | Expected vs physical | CORRECT | Retain | P2 |
| Period COGS/loss attribution | Sum recorded movement costs inside period | `packages/shared/src/valuation.ts#periodCosts` | Full-history replay | CORRECT | Retain | P1 |
| Kigali day/week/month ranges | UTC+2 business calendar, half-open ranges | `packages/shared/src/periods.ts` | Business-day boundaries | CORRECT | Retain | P1 |
| Server period totals | SQL sums sales, returns, expenses, receipts, repayments, credit balance; COGS/loss from shared replay | `apps/api/src/reports/finance.service.ts#period` | Server authoritative | CORRECT | Retain | P1 |
| Server receipt value | `round_half_up(qty × unitCost / 1000)` in SQL | `apps/api/src/reports/finance.service.ts#period` | Receipt value | CORRECT | Retain | P2 |
| Server inventory purchases | Sum `purchases.total_amount` by `ordered_at` | `apps/api/src/reports/finance.service.ts#period` | Purchases ordered in period | CORRECT BUT LIMITED | Rename/clarify as ordered purchases | P3 |
| Server product profitability revenue | SQL proportional discount allocation | `apps/api/src/reports/finance.service.ts#productProfitability` | `ROUND(discount × line / gross)` | INCONSISTENT | Use exact largest-remainder allocation | P1 |
| Server product COGS | `periodCosts()` per product | `apps/api/src/reports/finance.service.ts#productProfitability` | Shared replay | CORRECT | Retain | P1 |
| Server product margin bps | `round(grossProfit × 10000 / revenue)` or null | `apps/api/src/reports/finance.service.ts#productProfitability` | Null when no revenue | CORRECT | Retain | P2 |
| Server product velocity | `units / periodDays`, trailing 30-day units / 30 | `apps/api/src/reports/finance.service.ts#productProfitability` | Milli-units per day | CORRECT | Retain | P3 |
| Server stockout count | Balance transitions from positive to <= 0 in trailing 90 days | `apps/api/src/reports/finance.service.ts#productProfitability` | Movement replay | CORRECT | Retain | P3 |
| Server slow-moving flag | `onHand > 0` and 30-day velocity <= 0 or `onHand / velocity > 90` | `apps/api/src/reports/finance.service.ts#productProfitability` | Heuristic | CORRECT BUT LIMITED | Document threshold policy | P3 |
| Server below-cost flag | Cross-unit `priceBelowCost()` when stock exists | `apps/api/src/reports/finance.service.ts#productProfitability` | Exact cross multiplication | CORRECT | Retain | P1 |
| Dashboard trend COGS | Movement costs grouped by Kigali bucket | `apps/api/src/reports/reports.controller.ts#dashboard` | Same replay as headline | CORRECT | Retain | P2 |
| Dashboard monthly P&L | Net sales − returns − COGS − expenses − stock losses by Kigali month | `apps/api/src/reports/reports.controller.ts#dashboard` | Monthly aggregation | CORRECT | Retain | P2 |
| Dashboard average transaction | `round(netSales / transactions)` | `apps/api/src/reports/reports.controller.ts#dashboard` | Integer RWF | CORRECT | Retain | P3 |
| Dashboard product totals | Sum `line_amount` by product; not net of discounts | `apps/api/src/reports/reports.controller.ts#dashboard` | Gross line amounts | INCONSISTENT | Allocate sale discounts or label as gross | P2 |
| Stock movement balances | SQL window ordered by `occurred_at, seq` | `apps/api/src/reports/reports.controller.ts#stockMovements` | Balance display | CORRECT BUT LIMITED | Order by posting sequence first | P3 |
| Sale detail discount split | `allocateLineDiscounts()` | `apps/api/src/reports/reports.controller.ts#sale` | Exact integer split | CORRECT | Retain | P1 |
| Sale posting cost | `currentAverageCost()` under product locks | `apps/api/src/sales/sales.controller.ts#costsNow` | Posting-time snapshot | CORRECT | Retain | P1 |
| Credit approval cost | Cost fixed at approval time | `apps/api/src/sales/sales.controller.ts#approveCredit` | Average at approval | CORRECT | Retain | P1 |
| Sale void reversal | Restock at recorded `unit_cost`; if null use running-average fallback | `apps/api/src/sales/sales.controller.ts#voidSale` | Historical cost restore | CORRECT | Retain | P1 |
| Sale void revenue treatment | Sale remains in original period; reversal reduces COGS in reversal period | `apps/api/src/sales/sales.controller.ts#voidSale` | No revenue rewrite | CORRECT | Retain | P1 |
| Partial goods receipt | Cumulative received may not exceed ordered | `apps/api/src/sync/sync.service.ts#receipt.create` | Over-receipt guard | CORRECT | Retain | P1 |
| Purchase below-cost check | Cross-unit `priceBelowCost()` | `apps/api/src/sync/sync.service.ts#purchase.create` | Exact cross multiplication | CORRECT | Retain | P1 |
| Purchase total | `sum lineAmount(qty, unitCost)` | `apps/api/src/sync/sync.service.ts#purchase.create` | Integer RWF | CORRECT | Retain | P1 |
| Expense incurred vs paid | `amount`, `paid` boolean; totals and unpaid | `apps/api/src/sync/sync.service.ts#expense.create` | Accrual and cash view | CORRECT | Retain | P2 |
| Expense correction | Old/new audited; no historical rewrite | `apps/api/src/sync/sync.service.ts#expense.update` | Audit trail | CORRECT | Retain | P2 |
| Stock count | Expected = on-hand; difference recorded; investigation if non-zero | `apps/api/src/sync/sync.service.ts#count.submit` | No auto-correction | CORRECT | Retain | P2 |
| Adjustment request sign | Negative reasons must reduce stock; sale_return must increase stock | `apps/api/src/sync/sync.service.ts#adjustment.request` | Sign validation | CORRECT | Retain | P1 |
| Customer credit outstanding | `posted credit sales − repayments + adjustments` | `apps/api/src/sync/sync.service.ts#creditOutstanding` | Balance, not period revenue | CORRECT | Retain | P1 |
| Credit payment limit | Payment cannot exceed balance | `apps/api/src/sync/sync.service.ts#credit.payment.create` | Balance guard | CORRECT | Retain | P1 |
| Price preview | `costPerSellingUnit = avgCost × unitsPerSelling`; potential revenue and expected profit from truncated whole selling units | `apps/api/src/returns/pricing.service.ts#preview` | Projection only | CORRECT BUT LIMITED | Label fractional stock clearly | P3 |
| Gross margin preview | `round(grossProfitPerUnit × 10000 / price)` bps | `apps/api/src/returns/pricing.service.ts#preview` | Integer bps | CORRECT | Retain | P2 |
| Below-cost price change | Manager needs approval ref when below cost | `apps/api/src/returns/pricing.service.ts#applyInTx` | Policy enforcement | CORRECT | Retain | P2 |
| Scheduled price change | Future effective date stored pending; promoted when due | `apps/api/src/returns/pricing.service.ts#applyInTx`, `applyDuePrices` | No stock movement | CORRECT | Retain | P2 |
| Price history | Append-only ledger of price changes | `apps/api/src/returns/pricing.service.ts#history` | Immutable | CORRECT | Retain | P2 |
| Returnable quantity view | Net-of-discount unit price; remaining qty; weighted unit cost | `apps/api/src/returns/returns.service.ts#saleView` | Aggregate by product | CORRECT | Retain | P1 |
| Return refund allocation | Proportional net revenue per returned quantity, last remainder refunded | `apps/api/src/returns/returns.service.ts#applyInTx` | Exact integer RWF | CORRECT | Retain | P1 |
| Return restock condition | Only `resalable` returns create `sale_return` movement | `apps/api/src/returns/returns.service.ts#applyInTx` | Quarantine other conditions | NEEDS BUSINESS DECISION | Define damaged/expired loss posting | P1 |
| Return cost reversal | Restored at original sale line cost | `apps/api/src/returns/returns.service.ts#applyInTx` | Historical cost restore | CORRECT | Retain | P1 |
| Return quantity guard | Cumulative returned qty cannot exceed sold qty | DB trigger `check_return_qty` | Database constraint | CORRECT | Retain | P1 |
| Adjustment approval cost | Cost frozen at approval time using replay average | `apps/api/src/audits/audits.controller.ts#decide` | Current average at approval | CORRECT | Retain | P2 |
| Negative stock prevention | Approval refused if on-hand + qty < 0 | `apps/api/src/audits/audits.controller.ts#decide` | Guard | CORRECT | Retain | P1 |
| Offline record parsing | Posting order by `created_at`, then `op_id` | `apps/mobile/src/services/local-dashboard.ts#parseRecords` | Offline posting order | CORRECT BUT LIMITED | Include unitCost in sale movements | P1 |
| Offline ledger replay | Only opening, receipt and sale movements | `apps/mobile/src/services/local-dashboard.ts#buildLedger` | Partial replay | INCORRECT | Replay all movement types | P1 |
| Offline ledger completeness | No outbound quantity exceeds inbound | `apps/mobile/src/services/local-dashboard.ts#ledgerIsComplete` | Heuristic | CORRECT | Retain | P3 |
| Offline dashboard net sales | Gross − discounts, no sale returns | `apps/mobile/src/services/local-dashboard.ts#computeLocalDashboard` | Returns ignored | INCORRECT | Include sale returns by return period | P1 |
| Offline dashboard COGS | `periodCosts()` from incomplete ledger | `apps/mobile/src/services/local-dashboard.ts#computeLocalDashboard` | Incomplete movement set | INCONSISTENT | Match server ledger | P1 |
| Offline dashboard inventory value | Replay ledger value; null if not cost-complete | `apps/mobile/src/services/local-dashboard.ts#computeLocalDashboard` | Conditional value | CORRECT | Retain | P2 |
| Offline dashboard supplier payables | `sum(purchaseTotal − paid)` | `apps/mobile/src/services/local-dashboard.ts#computeLocalDashboard` | Outstanding purchase balance | CORRECT | Retain | P3 |
| Offline summary | Same as dashboard; returns hard-coded to zero | `apps/mobile/src/services/local-reports.ts#computeLocalSummary` | Returns ignored | INCORRECT | Include sale returns | P1 |
| Offline report rows | Rebuild rows from unsynced operations | `apps/mobile/src/services/local-reports.ts#computeLocalReport` | Local report rows | CORRECT | Retain | P2 |
| Offline report merge | Merge pending rows by id | `apps/mobile/src/services/local-reports.ts#mergePendingRows` | Deduplicate by operation id | CORRECT | Retain | P2 |
| Stock turnover | Not implemented | Not found | — | MISSING | Add units sold / average inventory | P3 |
| Inventory days / DIO | Not implemented | Not found | — | MISSING | Add closing inventory / COGS × days | P3 |
| Reorder point | Not implemented | Not found | — | MISSING | Add based on demand and lead time | P4 |
| Safety stock | Not implemented | Not found | — | MISSING | Add if supplier lead times are captured | P4 |
| Average daily demand | Not implemented as a standalone metric | Not found | — | MISSING | Add for reorder analysis | P4 |
| Fast-moving inventory | Not explicitly classified | Not found | — | MISSING | Add velocity threshold | P4 |
| Stock aging | Not implemented | Not found | — | MISSING | Add age buckets | P4 |
| Tax calculation | Not implemented | Not found | — | MISSING | Add only if Rwandan tax policy is required | P4 |
| Net profit after tax/interest | Not implemented | Not found | — | MISSING | Add only if full accounting scope is required | P4 |
| Partial sale cancellation | Not supported; full void only | `apps/api/src/sales/sales.controller.ts#voidSale` | Full reversal only | NEEDS BUSINESS DECISION | Define partial cancellation policy | P2 |
| Purchase return to supplier | Only stock movement type; no refund document | `apps/api/src/sync/sync.service.ts` adjustment `supplier_return` | Stock-only reversal | NEEDS BUSINESS DECISION | Add supplier credit note workflow | P2 |
| Damaged inventory valuation | Quarantined return; no automatic loss posting | `apps/api/src/returns/returns.service.ts` | Document-only | NEEDS BUSINESS DECISION | Define loss recognition timing | P1 |
| Below-cost selling policy | Acknowledge or block; manager-only block | `apps/api/src/sync/sync.service.ts`, policy table | Configurable | CORRECT | Retain | P2 |
| Manager discount ceiling | `floor(gross × percent / 100)` | `apps/api/src/sync/sync.service.ts#sale.create` | Manager limit | CORRECT | Retain | P2 |
| Credit limit policy | Block, owner approval or reason override | `apps/api/src/sync/sync.service.ts#sale.create` | Configurable | CORRECT | Retain | P2 |
| Manager financial access | Financial fields nulled unless enabled | `apps/api/src/reports/finance.service.ts#canSeeFinancials` | Permission gating | CORRECT | Retain | P2 |
| Offline financial permission cache | Cost/profit cache scoped by access | `apps/mobile/src/services/local-reports.ts#readReportCache` | Cache validation | CORRECT | Retain | P2 |
| Product price history completeness | All price changes recorded, including implied purchase/edit changes | `apps/api/src/returns/pricing.service.ts#recordImpliedChange` | Append-only | CORRECT | Retain | P2 |
| Historical sale price preservation | Sale lines store `unit_price` forever | `apps/api/src/sync/sync.service.ts#sale.create` | Immutable line | CORRECT | Retain | P1 |
| RWF integer precision | Money as integer RWF; no minor units | `packages/shared/src/money.ts` | Integer arithmetic | CORRECT | Retain | P1 |
| Floating-point percentage precision | Percentages use JS float division | `packages/shared/src/pricing.ts`, `finance.ts` | Float percentages | CORRECT BUT LIMITED | Convert to basis points where exactness matters | P3 |

## 5. Detailed findings by category

### 5.1 Purchasing and inventory valuation

The system uses perpetual moving weighted average cost. A receipt adds `qty × unitCost` to inventory value and quantity. An outbound movement relieves `qty × current average`, except where a recorded cost exists. Returns restore the recorded original cost. This is appropriate for a small/medium retail shop and matches `docs/FINANCE.md`.

Purchase cost is stored as one integer RWF per base unit. When a total line cost is entered, the unit cost is rounded half-up and the recorded line total may differ from the typed invoice total by a few RWF. This is explicitly documented and shown to the user. It is a sound compromise for integer RWF.

Inventory purchases in the period report are summed from `purchases.total_amount` by `ordered_at`, not by received date. This is consistent with the purchase document date but can differ from cash/stock-receipt timing. It should be labelled as ordered purchase value.

Partial receipts are correctly guarded against over-receipt. Supplier payables are `total_amount − amount_paid`.

Transport, duty and purchase-level discounts are not allocated into unit cost. This is a documented limitation, not an error. If the shop needs full landed cost, a purchase-charge table and allocation method are required.

### 5.2 Sales, returns and cancellations

Gross sales is the sum of posted sale line amounts. Net sales subtracts discounts and approved sale-return refunds. Voided sales remain in history but are excluded from posted totals. This is correct.

Discounts are applied at sale level and split across lines using exact largest-remainder allocation in shared code. However, product-level profitability uses SQL `ROUND()` allocation, causing possible RWF-level differences. This should be corrected.

Sale returns are first-class documents. They reduce revenue in the return period, not the original sale period. Resalable goods restore stock at the original sale cost. Damaged, expired and inspection goods are quarantined and do not restore stock. This is operationally sensible but the financial treatment of damaged returns needs an explicit policy.

Full sale cancellation is supported. Partial sale cancellation is not supported. Cancellation after dispatch requires an approval reference and does not restock by default. This is a reasonable control but should be documented as a business policy.

### 5.3 COGS and gross profit

COGS is attributed by movement period using the full-history replay. The recorded sale cost prevents a later purchase or return from restating historical COGS. This directly addresses the reported Inyange issue and is mathematically correct.

Gross profit and gross margin are calculated consistently on the server. Empty periods report margin as unavailable (`null`) rather than 0%, which is correct.

Offline COGS is less reliable because the mobile replay omits several movement types and does not carry sale unit costs. This is the main financial correctness gap.

### 5.4 Pricing and profitability

Markup and gross margin are correctly distinguished:

- Markup = `(price − cost) / cost × 100`
- Gross margin = `(price − cost) / price × 100`

The recommended price formula is cost-plus pricing for a target margin and rounds up, which avoids undercutting the target. Break-even uses COGS as a proxy for variable cost and operating expenses as fixed costs. This is a management estimate and should be labelled as such.

Price changes are append-only and never alter inventory value or historical sales. Scheduled price changes are promoted when due. This is correct.

Price preview projections truncate fractional selling units. This is conservative but may understate potential revenue for fractional stock. It should be clearly labelled as a projection.

### 5.5 Expenses and operating profit

Operating profit uses expenses incurred in the period, not expenses paid. Purchases are not treated as expenses. This is consistent with the documented accrual-style policy.

Outstanding expenses are `incurred − paid`. Customer credit repayments are treated as collections, not revenue. This is correct.

The system does not calculate net profit after tax, interest or other non-operating items. This is outside the current accounting scope and should not be implied by the UI.

### 5.6 Inventory and stock performance

Stock quantities, expected stock, discrepancies and low-stock checks are implemented. Inventory value is moving weighted average.

Missing or only partially implemented management metrics include stock turnover, inventory days, reorder point, safety stock, average daily demand, fast-moving classification and stock aging. These are not accounting requirements but would improve management intelligence.

### 5.7 Dashboards and reports

The dashboard uses the same shared finance service as the summary report, reducing inconsistency. However, some panels use gross line amounts rather than net-of-discount amounts, and stock movement balances are ordered by timestamp rather than posting sequence. These are presentation-level inconsistencies.

Managers are gated from financial data unless enabled. This is correctly enforced server-side.

### 5.8 Offline and synchronization

Offline calculations use the same shared formulas where possible, which is good. However, the offline ledger is incomplete and offline returns are not represented. Synchronization is idempotent by operation id, and rejected/conflicting operations are excluded from local figures.

The server remains authoritative for confirmed financial records, as required.

## 6. Scenario testing summary

Independent checks were performed against the implementation logic.

### Scenario 1 — Different purchase prices

Example:

- Buy 80 units at 1,000 RWF.
- Sell 40 at 1,200 RWF.
- Buy 40 at 1,300 RWF.

Expected weighted average after second purchase:

`(80 × 1000 + 40 × 1300) / 120 = 1,100 RWF`

The server’s `replayLedger()` implements this correctly. COGS for the 40 sold units remains based on the average at sale time. If the first sale occurred before the second purchase, its cost is fixed at 1,000 RWF. This is correct.

### Scenario 2 — Partial return

A sale of 10 units at 2,000 RWF with a discount returns 3 units. The refund is proportional to the discounted net revenue. Only resalable units restore stock. Damaged units do not restore stock and are not automatically posted as a loss. Revenue and COGS reversal are calculated correctly for resalable units. The damaged-unit policy needs clarification.

### Scenario 3 — Sale cancellation

A posted sale can be voided once. Stock is restored at the original sale cost. Revenue remains in the original period. COGS decreases in the reversal period. Repeated cancellation is prevented by status and idempotency checks. This is correct.

### Scenario 4 — Price change without purchase

Changing the selling price does not change inventory cost, historical sales or COGS. New sales use the new price. Expected profit and realized profit remain distinct. This is correct.

### Scenario 5 — Selling below cost

The system calculates gross loss correctly and flags below-cost selling. Managers may be blocked by policy. The warning amount is the difference between cost and price on a consistent unit basis. This is correct.

### Scenario 6 — Partial supplier delivery

Partial receipts are supported and guarded against over-receipt. Outstanding quantity is `ordered − received`. Stock and value are not duplicated if operations are replayed idempotently. This is correct.

### Scenario 7 — Damaged and expired stock

Stock counts record discrepancies and open investigations. Damage and expiry adjustments reduce stock and are valued at the current average at approval time. They are reported as stock losses, separate from COGS and operating profit. This is correct, except that damaged sale returns are not automatically converted into a stock loss.

### Scenario 8 — Multiple reporting periods

Periods use Kigali business days and half-open ranges. Returns are attributed to the return period. Historical periods are not rewritten for posted sales because costs are snapshotted. This is correct on the server. Offline periods may differ due to incomplete replay.

## 7. Priority recommendations

### Priority 1 — Financial correctness

1. Expand offline mobile ledger replay to include all movement types: `sale_return`, `supplier_return`, `damage`, `expiry`, `adjustment`, `count_correction`, `transfer_in`, `transfer_out`.
2. Carry `unitCost` on offline sale movements and use it in offline COGS.
3. Include sale returns in offline dashboards and summaries.
4. Replace SQL `ROUND()` discount allocation in `productProfitability()` with the exact largest-remainder method used by `allocateLineDiscounts()`.
5. Define and implement the financial treatment of damaged, expired and inspection returns.

### Priority 2 — Accounting completeness

1. Add partial sale cancellation policy or explicitly document that only full voids are supported.
2. Add supplier return / credit note workflow if supplier refunds are required.
3. Clarify purchase value reporting as ordered purchase value.
4. Label break-even and price projections as management estimates.

### Priority 3 — Management intelligence

1. Add stock turnover, inventory days, average daily demand, reorder point, safety stock, slow/fast-moving classification and stock aging as optional metrics.
2. Add exact basis-point reporting for markup and margin where needed.

### Priority 4 — Advanced capabilities

1. Add tax handling only after confirming Rwandan tax requirements.
2. Add net profit after tax/interest only if the accounting scope is expanded.

## 8. Implementation plan

No implementation should begin until this audit is reviewed.

If approved, the recommended sequence is:

1. Fix offline ledger parity and sale cost snapshot.
2. Fix product-level discount allocation.
3. Define damaged-return accounting policy and implement it.
4. Add missing management metrics behind clearly labelled UI.
5. Add tax/net-profit scope only after business and legal confirmation.

Database changes required for Priority 1: none for offline replay; possibly a new field or movement type policy for damaged returns. API changes: product profitability allocation. Mobile changes: ledger replay, sale movement cost, returns in summaries. Tests required: offline parity tests against server figures, product-level revenue reconciliation tests, damaged-return accounting tests.

## 9. Conclusion

Idukaa’s core accounting engine is sound. The perpetual moving weighted average, integer money, cost snapshots, returns at original cost and period attribution are appropriate for a retail shop. The main gaps are in offline parity and a few product-level/reporting inconsistencies. Correcting these will make the mobile and web figures reconcile and make damaged-return accounting explicit.
EOF
echo written
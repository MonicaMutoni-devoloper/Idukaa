# Idukaa Pilot Readiness Report — 19 November 2026

**Scope:** first real shop pilot  
**Assessment date:** 19 November 2026  
**Repository state:** local working tree on `main`; no commit, deploy, migration, or production-data change was made in this phase.

---

## 1. Executive summary

**Pilot recommendation: CONDITIONAL GO for a controlled pilot, with server reports treated as the only official accounting record.**

The core server-side accounting model is sound and should be retained: integer RWF, milli-unit quantities, perpetual moving weighted-average cost, server-authoritative posting under product locks, sale cost snapshots, returns at original cost, immutable history, and Kigali half-open periods.

The audit identified five Priority 1 financial-correctness defects. This phase fixed three in code, mitigated one, and left one requiring an explicit business decision:

| Priority 1 defect | Result |
|---|---|
| Offline ledger omitted returns, damage, expiry, adjustments and supplier returns | **Fixed provisionally** — local adjustments now replay into the offline ledger. |
| Offline sale movements had no unit-cost snapshot | **Still open / mitigated** — offline COGS remains provisional and may differ from the server. |
| Offline returns were hard-coded to zero | **Fixed provisionally** — sale returns now reduce offline net sales and COGS. |
| Product profitability used SQL `ROUND()` discount allocation | **Fixed in code** — now uses the shared exact largest-remainder allocator. Database-backed verification is still required. |
| Damaged/expired/inspection return accounting policy was undefined | **Open business decision** — quarantine behaviour is retained; no automatic loss posting was invented. |

The pilot is **not** ready for unattended reliance on offline profit figures, partial sale cancellation, supplier credit notes, tax, or a signed production release. Those limitations are listed in the readiness matrix and operator instructions.

---

## 2. Defect register

Severity: **P0** = can produce a wrong financial or stock result in the pilot; **P1** = material operational limitation; **P2** = presentation or management-information limitation.

| ID | Severity | Defect | Action taken / required | Status |
|---|---|---|---|---|
| P0-01 | P0 | Offline `buildLedger()` replayed only openings, receipts and sales. Returns, damage, expiry and adjustments were invisible to offline COGS and inventory value. | Offline adjustments now map to `sale_return`, `damage`, `expiry`, `supplier_return` or `adjustment` and replay in save order. | **Fixed provisionally** |
| P0-02 | P0 | Offline sale movements did not carry `unitCost`, so COGS used the running-average fallback rather than a fixed posting-time snapshot. | Not fully fixed. The fallback is still used offline; offline figures remain provisional. Server cost snapshots remain authoritative. | **Open / mitigated** |
| P0-03 | P0 | `salesReturns` was hard-coded to `0` in offline dashboard and summary calculations. | Sale-return adjustments now reduce net sales in their return period, including the trend series. | **Fixed provisionally** |
| P0-04 | P0 | `FinanceService.productProfitability()` allocated sale discounts with SQL `ROUND()`, so product revenue could differ from headline net sales by a few RWF. | The API now loads the period's sale lines and applies shared `allocateLineDiscounts()` per sale, matching the sale detail and offline reports. | **Fixed in code; DB verification pending** |
| P0-05 | P0 | Damaged, expired and inspection returns are quarantined but have no automatic stock-loss or valuation posting. | Quarantine retained. No loss policy was invented. A documented business policy is still required. | **Open — business decision** |
| P1-01 | P1 | Partial sale cancellation is not supported. | Operators must void the whole sale, or use an approved return for part of it. | **Restricted** |
| P1-02 | P1 | Supplier return / credit-note workflow is not implemented. | Do not represent supplier refunds as customer returns. Escalate to the owner. | **Not ready** |
| P1-03 | P1 | Break-even, turnover, DIO, reorder point, safety stock and price projections are management estimates, not accounting results. | Keep labelled as estimates. Do not reconcile them to the P&L. | **Restricted** |
| P2-01 | P2 | Some dashboard panels use gross line amounts or timestamp ordering rather than net-of-discount/posting-sequence values. | Presentation-only; server report remains authoritative. | **Open / low risk** |

---

## 3. Accounting integrity assessment

### 3.1 Retained accounting principles

The following were not changed and remain the correct basis for the pilot:

- Money is integer RWF; quantities are milli-units.
- Inventory is valued at perpetual moving weighted average.
- Stock is posted server-side under product row locks.
- Sales store a cost snapshot on `sale_lines.unit_cost` and on sale stock movements.
- Resalable returns restore stock at the original sale cost.
- Sales, returns, price changes and stock movements are append-only.
- Reporting periods are half-open and use Africa/Kigali business days.
- Discounts are allocated exactly by largest remainder in shared code.

### 3.2 Inyange cost verification

The reported Inyange case was checked earlier in this pilot preparation:

- Recorded unit cost: **943 RWF**
- Selling price: **1,400 RWF**
- Gross margin: **32.64%**
- Markup: **48.46%**

The cost is therefore **not** inappropriately above the selling price. The earlier concern is consistent with a historical offline-cost presentation problem, not with the current server cost snapshot.

### 3.3 Discount allocation

Product profitability previously calculated each product's discount share independently in SQL:

`ROUND(sale_discount × line_amount ÷ gross_amount)`

That can lose or duplicate a few RWF per sale. The API now:

1. Reads the period's posted sale lines.
2. Groups them by sale.
3. Applies shared `allocateLineDiscounts()` to the lines of that one sale.
4. Subtracts each exact share from that line's revenue.

The sum of product net sales should now equal headline net sales for the same period and shop, subject to the database-backed check listed in section 7.

### 3.4 Returns and damaged stock

- Resalable sale returns reduce revenue in the return period and restore stock at original cost.
- Damaged, expired and inspection returns remain quarantined and do **not** restore stock.
- No automatic stock-loss or write-down entry was added, because the correct accounting treatment depends on business policy (for example, whether the supplier carries the loss, whether it is written off immediately, or whether it is held for inspection).
- The pilot must keep damaged goods physically segregated and must not sell them.

### 3.5 Offline versus server

Offline records now give a more complete provisional picture:

- Sale returns reduce offline net sales and COGS.
- Damage and expiry appear as stock losses, not cost of sales.
- Adjustments replay in local save order.
- Rejected and conflicting operations remain excluded.

However, offline figures are still **not equivalent** to server accounts:

- The server may post a different sale unit cost after synchronization.
- Pending adjustments are included before approval; a rejected adjustment will later disappear from the provisional figures.
- Offline transfers and server-side count corrections cannot be fully reconstructed from the device's current record set.
- The device does not pull the full server stock ledger.

**Rule for the pilot: offline profit is an operational estimate. The server report is the accounting record.**

### 3.6 Audit history preserved

No production migration, deployment, data edit or deletion was performed in this phase. The changes are source-code edits plus tests and this report. Historical records remain immutable.

---

## 4. Changes made in this phase

| File | Change |
|---|---|
| `apps/api/src/reports/finance.service.ts` | Product profitability now allocates each sale's discount with shared `allocateLineDiscounts()` instead of SQL `ROUND()`. |
| `apps/mobile/src/services/local-dashboard.ts` | Offline ledger now replays adjustment reasons (`sale_return`, `damage`, `expiry`, `supplier_return`, other adjustments). Sale returns reduce offline net sales, COGS and the trend series. Adjustment refund amount and sequence are parsed. |
| `apps/mobile/src/services/local-reports.ts` | Offline summary now reports sale-return refunds instead of hard-coding `salesReturns` to zero. |
| `apps/mobile/tests/local-dashboard.test.mts` | Added regression tests for an offline sale return and an offline damage adjustment. |
| `docs/PILOT_READINESS_REPORT_2026-11-19.md` | This report. |

No database migration was required for these changes. No dependency was added.

### Performance note

Product profitability now loads the period's sale lines into API memory to perform exact allocation. For a small shop this is acceptable. If the pilot period or shop grows substantially, the query should be bounded or moved to a set-based exact allocator. This was not changed further because correctness was the priority.

---

## 5. Test results

### 5.1 Executed successfully

| Check | Command | Result |
|---|---|---|
| Workspace typecheck | `npm run typecheck` | **Pass** — API, mobile and shared |
| Shared test suite | `npm run test:shared` | **49 passed, 0 failed** |
| Full mobile test suite | `npm run test:mobile` | **169 passed, 0 failed** across all 15 mobile suites |
| Dashboard suite (targeted) | `npm run test:dashboard -w @sms/mobile` | **38 passed, 0 failed** — includes the two new offline return/damage tests |
| Reports suite (targeted) | `npm run test:reports -w @sms/mobile` | **41 passed, 0 failed** |

The new tests verify that:

- A sale return reduces offline net sales by the refund and reverses the returned unit's cost.
- A damage adjustment appears as a stock loss, not as cost of sales.
- Inventory value remains consistent after both movements.
- Existing discount allocation, provisional-cost and pending-to-synced tests still pass.

### 5.2 Not executed

| Check | Reason |
|---|---|
| API integration suite | No `TEST_DATABASE_URL` dedicated throwaway PostgreSQL database is configured. The suite drops and recreates the `public` schema, so it was not pointed at production or development data. |
| Product profitability against real sale rows | Blocked by the same database requirement. The SQL/TypeScript path compiles, but the exact-allocation change has not been exercised against PostgreSQL in this phase. |
| Signed release build | Previously blocked by missing release keystore and Windows native build path issues. No new release artifact was produced in this phase. |
| Web/Android bundle rebuild | Not produced in this phase. The source typechecks and tests pass; a fresh bundle should be built before the pilot. |

**Interpretation:** passing tests demonstrate the offline calculation rules and shared formulas. They do **not** prove the API report change against production-shaped data, and they are not a substitute for a staging/production-read-only reconciliation.

---

## 6. Workflow readiness matrix

| Workflow | Status | Basis and restriction |
|---|---|---|
| Server sale — cash | **READY** | Core posting, cost snapshot and balance logic are unchanged and code-audited. Use server records. |
| Server sale — credit | **READY** | Receivables and repayments are treated as balances, not revenue. |
| Server sale — discount | **READY** | Exact shared allocation now used by product profitability as well as sale detail. Reconcile once before pilot. |
| Server sale return — resalable | **READY** | Restores stock at original sale cost and reduces revenue in the return period. |
| Sale return — damaged / expired / inspection | **READY WITH RESTRICTIONS** | Quarantined and not restocked. No automatic loss posting. Keep goods segregated and escalate the write-off decision. |
| Offline sale capture and sync | **READY WITH RESTRICTIONS** | Idempotent outbox and durable local records. Offline cost/profit is provisional. Sync before daily close. |
| Offline dashboard and reports | **READY WITH RESTRICTIONS** | Returns, damage and adjustments now appear provisionally. Do not use for official P&L. |
| Product profitability report | **READY WITH RESTRICTIONS** | Code fix applied; database-backed reconciliation still required. Verify that product net sales sum to headline net sales. |
| Purchases and receiving | **READY** | Server-authoritative receiving, over-receipt guards and weighted-average update. Purchase value is ordered value, not necessarily cash paid. |
| Expenses and operating profit | **READY** | Accrual-style expenses, paid/unpaid split, no purchase double-count. |
| Price changes | **READY** | Append-only; historical sales and inventory value are not restated. |
| Stock adjustments and approvals | **READY WITH RESTRICTIONS** | Server approval workflow. Offline adjustments are provisional until approved. |
| Stock counts | **READY WITH RESTRICTIONS** | Discrepancy investigation exists. Count corrections are server-side; offline reconstruction is limited. |
| Partial sale cancellation | **NOT READY** | Not supported. Void the whole sale or use an approved return. |
| Supplier returns / credit notes | **NOT READY** | No supplier-return workflow. Do not improvise with customer returns. |
| Tax, interest and net profit after tax | **NOT READY / OUT OF SCOPE** | Not implemented; do not imply these figures exist. |
| Break-even, turnover, DIO, reorder point, safety stock | **READY WITH RESTRICTIONS** | Management estimates only. Clearly label and never reconcile to the P&L as accounting results. |
| Signed production release | **NOT READY** | Release keystore and Windows build blockers remain. A debug-signed build is not a production release. |

---

## 7. Risks and required controls

| Risk | Impact | Control required for pilot |
|---|---|---|
| Offline COGS can differ from server COGS after synchronization. | Offline gross profit may be wrong by the cost difference. | Use server reports for official figures. Compare offline and server after every sync. |
| Product profitability change has not run against PostgreSQL. | A SQL/runtime issue could break or misstate the report. | Run a read-only staging/production check before opening: sum product net sales must equal headline net sales; investigate any difference. |
| Pending offline adjustments are included before approval. | Provisional returns/losses may reverse later. | Review pending and rejected adjustments at daily close. Do not treat offline figures as final. |
| Damaged/expired/inspection goods have no automatic loss value. | Inventory and loss classification may be incomplete; physical stock may be lost. | Segregate quarantined goods, record the return, and escalate the write-off decision to the owner. |
| No partial cancellation or supplier credit note. | Operators may use the wrong document to fix a mistake. | Train operators to void the whole sale or use a return; escalate supplier refunds. |
| Quarantined stock has no dedicated location ledger. | Goods could be sold or lost. | Physical quarantine area and a daily count sign-off. |
| No signed release build. | Pilot build is not production-grade. | Accept only as a controlled pilot; produce a signed build before wider rollout. |
| API integration suite not run. | Server regressions may be missed. | Run it against a dedicated throwaway PostgreSQL database before wider rollout. |
| Report loads period sale lines into memory. | Large periods may be slow. | Keep pilot periods short; monitor report response time. |

---

## 8. Operator instructions for the pilot

### Before opening

1. Confirm the API and web app are reachable and the correct shop is selected.
2. Confirm every active product has a known cost. Do not sell a product with an unknown cost as if its profit were confirmed.
3. Verify the Inyange example: 943 RWF cost, 1,400 RWF selling price.
4. Reconcile opening stock and print or export a baseline stock/value report.
5. Confirm all devices have synced before the first sale.

### During trading

1. Record sales normally. Use the server-confirmed report for official sales and profit.
2. If the device is offline, continue recording. Do not clear app data, uninstall, or manually edit local records.
3. For a customer return:
   - Resalable: use the return workflow so stock and cost are restored.
   - Damaged, expired or inspection: keep the goods quarantined; do not return them to the selling shelf.
4. Do not use a customer return to record a supplier refund. Escalate supplier credit notes to the owner.
5. Do not attempt a partial cancellation. Void the entire sale, or return the affected quantity through the return workflow.

### Daily close

1. Sync every device and resolve rejected or conflicting operations.
2. Review pending adjustments and approvals.
3. Reconcile cash, mobile money and credit repayments.
4. Compare the offline dashboard with the server report after sync. Investigate any difference; do not overwrite either record.
5. Confirm quarantined damaged goods physically match the recorded returns.

### Weekly review

1. Review stock losses separately from cost of sales.
2. Review returns and their effect on net sales.
3. Check that the sum of product net sales reconciles to headline net sales.
4. Review negative stock, missing costs and low-stock items.
5. Treat break-even, turnover, DIO, reorder point and safety stock as estimates, not audited results.

### Stop and escalate if

- A sale, return or adjustment is duplicated.
- Stock goes negative without an investigated count difference.
- Offline and server profit differ materially after a full sync.
- A product has no cost but is being sold.
- Damaged goods are missing from quarantine.
- The API report fails or product revenue does not reconcile.

---

## 9. Pilot go/no-go conditions

The pilot may proceed as a **controlled pilot** only if the owner accepts these conditions:

- Server reports are the official accounting record.
- Offline profit is explicitly treated as provisional.
- Damaged/expired/inspection stock is physically quarantined.
- No partial cancellation and no supplier credit-note improvisation.
- Daily sync and reconciliation are completed.
- A signed release build is produced before wider rollout.

Before declaring the pilot fully ready, complete these outstanding checks:

1. Run the API integration suite against a dedicated throwaway PostgreSQL database.
2. Run a read-only product-profitability reconciliation on staging or production:
   - Sum of product net sales = headline net sales.
   - Sum of product COGS = headline COGS.
3. Execute one live sale, one resalable return and one damaged return; verify stock, revenue, COGS and quarantine.
4. Produce and install a signed release build.
5. Obtain owner sign-off on the damaged-return and write-off policy.

Until items 1–3 are complete, **product profitability and all offline profit figures remain READY WITH RESTRICTIONS, not READY.**

---

## 10. Conclusion

The server-side accounting engine is materially sound. The most serious pilot risks are now narrowed to offline cost confirmation, the untested-in-database product profitability change, and the absence of an explicit damaged-return loss policy.

The code changes in this phase remove the known offline return/damage blind spot and the SQL discount-allocation inconsistency. They do not make offline accounting authoritative, and they do not resolve the business policy for damaged goods.

**Final classification: CONDITIONAL GO for a controlled pilot with server-authoritative reporting; NOT READY for unattended accounting, partial cancellation, supplier credit notes, tax reporting, or a signed production release.**

# Transaction correction workflow

Idukaa never edits a posted sale. A correction is a separate, owner-authorised document that links:

```
original posted sale → immutable reversal → separately posted corrected sale
```

The original sale, its lines, prices, discount, cost snapshot, cashier and timestamps stay in place. The original remains visible in transaction history and is marked `reversed`.

## 1. Scope

Supported:

- full-sale correction of a posted sale;
- discount, selling-price, quantity and product corrections;
- goods still in the shop (reversal restores stock, corrected sale deducts once);
- goods already handed over, but only when products and base quantities are unchanged (price/discount correction);
- requests created by a manager or owner;
- approval, rejection and information requests by the owner;
- explicit refund settlement after approval;
- linkage to an unusual-discount / business-alert investigation.

Not supported (see §9):

- partial line-level reversal of a multi-line sale;
- changing the product mix or quantity after goods were handed over;
- correcting a sale that already has a sale return;
- correcting a corrected sale;
- file attachments;
- manual cash-drawer movement;
- changing the customer, payment method or credit due date through a correction.

## 2. Lifecycle

### Device-only states

| State | Meaning |
|---|---|
| form draft | Not persisted. Closing the form loses it. |
| `pending_sync` | The request is durably in the local outbox but has not been accepted by the server. It has no financial effect. |
| `sync_error` | The outbox item was rejected or conflicted. It is shown with the server message and cannot be approved. |

### Server states

Only implemented states are stored:

| Status | Meaning |
|---|---|
| `pending_approval` | Request frozen; original sale unchanged; waiting for the owner. |
| `rejected` | Owner refused the request. Original sale unchanged. |
| `completed` | Approval posted the reversal and corrected sale, and stock and money are reconciled (or the corrected sale has a named customer receivable). |
| `reconciliation_required` | Approval posted both documents, but a refund is still owed and has not been recorded. |

The approval transaction performs `approved → reversed → corrected → stock_reconciled → money_reconciled` as **timeline events**, not as separate persisted statuses. This avoids a half-approved document that looks reversible when only two of the three financial records exist.

A rejected request cannot be revived. A manager submits a new request. A sale has at most one open request and at most one closed correction, enforced by partial unique indexes.

### Timeline

Every stage appends an immutable `sale_correction_events` row:

1. `requested`
2. optional `information_requested`
3. `approved` or `rejected`
4. `reversed`
5. `corrected`
6. `stock_reconciled`
7. `money_reconciled` or `money_reconciliation_required`
8. `completed` when no refund remains
9. `refund_partial` / `refund_reconciled` after settlement

The original sale's own audit entry (`sale.correction.reversal`) is separate and preserves its old header and line values.

## 3. Permissions

| Capability | Owner | Manager | System administrator |
|---|---:|---:|---:|
| View correction list/detail for own shop | yes | yes | no |
| Start request | yes | yes | no |
| Approve / reject | yes | no | no |
| Request more information | yes | no | no |
| Record a refund | yes | no | no |
| See shop financial data through this workflow | yes | shop-scoped | no |

- `@Roles("owner", "manager")` guards the whole controller.
- Approval, rejection, information requests and settlement additionally require `owner`.
- The owner check uses the active shop membership role, so a stale cached account role cannot demote a real owner or promote a manager.
- Approval is an online API call, not a sync operation. A device can queue a request but can never approve it locally.
- The server derives the shop from the authenticated session. It ignores any shop ID, owner ID or approval reference supplied by the client.
- A manager can request a correction for their own shop; the owner approval route is the only path to financial effect.
- The owner may approve a request they created. The explicit prohibition in the requirements is against a **manager** approving their own request; the owner is the authorising role.

## 4. Database records

Migration: `apps/api/migrations/015_transaction_corrections.sql`

### `sale_corrections`

Key fields:

- `id` — correction ID / idempotency key from the device.
- `shop_id`, `sale_id`, `request_op_id`, `requested_by`, `requested_at`.
- `reason`, `evidence`.
- `original_snapshot` (JSONB) and `original_fingerprint` (SHA-256).
- `original_gross`, `original_discount`, `original_net`, `original_collected`.
- `proposed` (JSONB), `proposed_gross`, `proposed_discount`, `proposed_net`, `proposed_collected`.
- `fulfillment` — `not_handed_over` or `handed_over`.
- `expected_refund`, `expected_additional`.
- `status`, `owner_id`, `decided_at`, `decision_note`.
- `reversal_id`, `corrected_sale_id`.
- `stock_status`, `money_status`.
- `amount_refunded`, `amount_collected`, `settled_by`, `settled_at`, `settlement_note`.
- `alert_id`.

Constraints and indexes:

- composite foreign keys `(sale_id, shop_id)` and `(alert_id, shop_id)` prevent cross-shop references;
- one open request per sale and one closed correction per sale;
- one corrected sale per correction (`corrected_sale_id UNIQUE`);
- request operation (`request_op_id`) is unique;
- status, discount arithmetic and refund arithmetic checks;
- a delete trigger refuses deletion;
- an immutable-evidence trigger refuses changes to the snapshot, proposal, reason, evidence, requester, fulfillment and alert link.

### Sale links

`sales` gains:

- `reversal_id` — stable reversal document ID;
- `correction_id` — the correction that produced this sale;
- `corrects_sale_id` — the original sale.

The corrected sale has `corrects_sale_id` set. The original sale is stamped `status='reversed'`, `reversed_at`, `reversed_by`, `reversal_reason`, and `reversal_id`. Its lines are untouched.

### `sale_correction_events`

Append-only financial timeline. Update and delete are refused by trigger. `details` carries the reversal/corrected references, stock movement totals, money status, and correction/alert link data.

### Alert recurrence fields

`business_alerts` gains `evidence_signature` and `occurrences`. Detection hashes the evidence it used. If a resolved alert is seen again with the same evidence, only `last_seen_at` and `occurrences` change; it stays resolved. Changed evidence reopens it once and records a `reopened` event. Detection itself is not disabled.

## 5. Stock reconciliation

The same `SalesReversalService` used by normal sale cancellation performs the reversal. The corrected sale uses the same `SalePostingService` used by ordinary sales: product locks, unit conversion checks, stock sufficiency, moving weighted-average cost snapshot and ledger movements.

### Goods not handed over

- Original sale had already deducted `originalQty`.
- Reversal adds back `originalQty` at the original cost snapshot (`sale_return` movement).
- Corrected sale deducts `correctedQty` once at the current moving weighted average.
- Net stock change is `correctedQty − originalQty`, which is the physically correct position.

### Goods already handed over

- The customer has the goods, so the correction must not change the physical position.
- Only price/discount corrections are accepted. The server compares product IDs and total base quantities and refuses any difference with `physical_stock_change_requires_return`.
- The reversal restores and the corrected sale re-deducts the same quantities at the **original sale's cost snapshot**, inside one database transaction. Both stock quantity and inventory value net to zero change; a later purchase cannot revalue goods that never came back.
- A sale with a recorded dispatch cannot be relabelled as “still in the shop”. The server refuses `not_handed_over` for such a sale (`dispatched_sale_must_be_handed_over`), and refuses at approval if the sale was dispatched after the request.
- Quantity/product changes require the physical return or stock-adjustment workflow first; they are not forced through a financial reversal.

### Sale already has returns

Refused with `sale_has_returns`. A physical return and a financial correction are different workflows. Combining them without a line-level return design would double-count stock.

### Partial correction

Not supported. A full-sale reversal would reverse lines the user did not intend to change. The UI and API require a full proposed line set, and there is no “reverse one line” operation. A dedicated line-level correction workflow is required before this can be supported safely.

## 6. Money reconciliation

`original_collected` is the sale's recorded `amount_paid`. The server never accepts a client-supplied collected amount as authoritative; the request field is accepted for compatibility but replaced from the posted sale.

At approval:

- corrected gross and discount come from the frozen proposal, re-quoted under locks;
- corrected net is `gross − discount`;
- `expected_refund = original_collected − corrected_net` when positive;
- `expected_additional = corrected_net − original_collected` when positive;
- the corrected sale can apply at most its own net as paid. Any excess stays a refund liability on the correction; it does not become a negative customer receivable;
- an additional amount requires a named active customer, because the corrected sale creates a normal credit sale and receivable;
- no cash movement is fabricated.

If a refund is due, the correction is `reconciliation_required` and `money_status='refund_due'`. The owner records the actual amount through `POST /corrections/:id/settle-refund`. Partial refunds are allowed. The correction becomes `completed` only when the full expected refund is recorded; otherwise it stays `reconciliation_required`.

If an additional amount is due, `money_status='balance_due'` and the sale's normal customer balance/receivable carries it. The correction can be `completed` because no refund is outstanding.

Credit-sale rules:

- existing credit-payment history is not deleted;
- the reversal refuses a credit sale whose debt has already been settled by repayments (`credit_payment_exists`);
- the corrected sale creates a new credit amount only for the corrected net;
- repayments are not counted as new revenue.

## 7. Reporting

Existing conventions are reused:

- Kigali business day, half-open periods `[from, to)`;
- integer RWF;
- milli-unit quantities;
- largest-remainder discount allocation;
- moving weighted-average cost.

Reports count sales with `status='posted'` exactly once. Therefore:

- the original reversed sale is excluded from revenue, COGS, discounts and units in every period, but remains visible in transaction history with `reversed` status and its original values;
- the original sale's COGS movement and the correction's stock-return leg are also excluded from period COGS, so the corrected sale is the single transaction that owns the corrected revenue and cost;
- the reversal is not a positive sale;
- the corrected sale is the one posted sale counted;
- the corrected sale is dated when the owner approved it (event time `now`), not backdated to the original sale;
- the original event timestamps and immutable snapshot remain available on the correction and in the original sale;
- stock effects are dated by the ledger movements: reversal and corrected sale at approval time, with source IDs linking back to the correction/reversal;
- a refund is a liability/reconciliation item, not revenue and not a fabricated cash receipt;
- receivable reporting uses the corrected sale's actual credit, not a negative overpayment.

This is a **current-period correction**. Period reports before the approval date are historical records of the original event; later periods show the reversal/corrected pair. Backdating a correction would rewrite an already-issued period and is intentionally not done.

## 8. API

All routes require an authenticated owner or manager and are shop-scoped.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/corrections` | List up to 200 corrections for the session shop. |
| `GET` | `/corrections/sale/:saleId` | Original sale, lines, eligibility and fulfillment default. |
| `POST` | `/corrections` | Optional online create. `correctionId` is the idempotency key. |
| `GET` | `/corrections/:id` | Detail, immutable events and corrected-sale summary. |
| `POST` | `/corrections/:id/approve` | Owner only. Validates, reverses and posts one corrected sale atomically. |
| `POST` | `/corrections/:id/reject` | Owner only. Requires a note. |
| `POST` | `/corrections/:id/request-info` | Owner only. Requires a note; status stays pending. |
| `POST` | `/corrections/:id/settle-refund` | Owner only. Requires amount and note. |

Offline create uses `POST /sync/push` with type `correction.request`. The op ID and correction ID are both idempotency keys.

Validation highlights:

- reason 3–1000 characters;
- evidence at most 4000 characters;
- 1–100 lines;
- positive base quantities and selling quantities;
- nonnegative integer RWF prices/discount;
- product IDs must belong to the shop;
- every read/write uses the authenticated shop;
- original fingerprint must still match at approval;
- sale must still be `posted`, unreversed, and have no returns;
- exactly one reversal and one corrected sale can exist.

## 9. Offline behaviour and limits

- A manager can open a posted sale while offline if its context was cached, and can queue a request.
- The outbox row is written before success is reported. It has a stable `correctionId` and op ID.
- No stock, money, report or sale status changes locally. The UI labels it `pending_sync`.
- The owner cannot approve or settle offline; those routes are online-only.
- On sync, the server revalidates the original sale and proposal. Stale/changed originals are rejected (`original_sale_changed`, `sale_not_posted`, `sale_has_returns`, etc.).
- Replaying the same op ID returns the original outcome. Replaying a new op ID with the same `correctionId` returns a duplicate request rather than creating a second document.
- Two concurrent requests for the same sale are serialised by row locks and the partial unique index; one becomes a conflict/rejection.
- Two concurrent approvals are serialised by the correction and sale row locks; the second sees the already-closed correction and posts nothing.
- Network interruption after a committed approval is safe: retry is idempotent.

## 10. Unsupported cases / unresolved business decisions

These are documented rather than silently invented:

1. **Partial line-level correction** — not implemented. Use a full-sale correction only when every line is being re-posted accurately.
2. **Goods already handed over with quantity/product changes** — refused. The physical return workflow must run first.
3. **Sale with returns** — refused. Combining return stock and reversal stock needs a dedicated design.
4. **Refund payment method / cash drawer** — the app has no cash-drawer ledger. `settle-refund` records the owner's actual refund amount and note/reference; it does not create a payment-method-specific cash movement.
5. **Additional collection** — the corrected sale records the receivable; there is no correction-specific cash collection record. The normal credit-payment workflow remains the place to record repayment.
6. **Changing customer, payment method, due date, tax or cashier** — not part of this workflow.
7. **Correcting a corrected sale** — refused. A new correction must start from the corrected sale only after an explicit future policy is designed.
8. **File attachments** — not supported by the existing app. Evidence is text.
9. **Native iOS** — not built or tested in this environment.
10. **Production migration** — not run. Migration 015 is development/test only.

## 11. Recovery and rollback

- Approval runs in one PostgreSQL transaction. A failure before commit leaves no correction effect, no reversal, no corrected sale and no stock movement.
- The correction evidence and events are immutable. Do not “fix” a bad correction by editing rows; reject it before approval, or design a new correction/reversal after the fact.
- There is no down migration. Rolling back the schema would drop financial links and timeline data. Restore from a verified backup if a deployment must be reverted.
- If an approval failed after an external alert notification, the alert link is part of the same transaction and will not be half-written.
- If an owner discovers an incorrect approval, do not delete records. Record a new, separately authorised correction or use the existing return/adjustment workflow, with a documented policy decision.

## 12. Verification notes

The repository’s API integration suite requires a dedicated `TEST_DATABASE_URL`. If it is unset, those tests must be reported as skipped, not passed. This workspace did not have a PostgreSQL test database available, so database-backed tests were not executed here.

Type checking and non-database tests can still be run:

```bash
npm run build -w @sms/shared
npm run typecheck -w @sms/api
npm run typecheck -w @sms/mobile
npm run test:shared
npm run test:api        # refuses/skips DB tests without TEST_DATABASE_URL
npm run test:mobile
```

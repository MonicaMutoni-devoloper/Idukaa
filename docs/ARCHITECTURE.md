# Architecture
- **Single write path**: all business mutations are *operations* pushed via `/sync/push` by both phone and PC, so mobile and PC cannot diverge in rules or permissions. Reads: `/sync/pull` (incremental, checkpointed by `(updated_at,id)`), `/reports/*` (dashboard, summary, inventory, transactions, items, sale detail, CSV), `/audit/*`, `/shop/settings`, `/shop/profile`, `/auth/me`, and `/purchases/open` (purchases with undelivered lines, used by the later-receiving screen).
- **Server transaction per operation**: insert into `operations` (idempotency) → SAVEPOINT → apply domain change + ledger rows + audit row → commit. A business failure rolls back to the savepoint but still records the operation (status conflict/rejected) so nothing is lost or silently dropped.
- **Concurrency**: products touched by an operation are locked `FOR UPDATE` in id order before stock is read, so two devices selling the last unit cannot both succeed; the loser becomes a conflict.
- **Ledger**: `stock_movements` append-only; `stock_on_hand` view and the shared `replayLedger()` derive quantity and value.
- **Roles**: `AuthGuard` verifies JWT, re-reads the user (active, token_version) each request, enforces `@Roles`. Shop isolation: every query is scoped by `user.shopId` from the DB, never from the client. Allowed op types per role are in `sync.service.ts` (`ALLOWED`): managers record sales, counts and adjustments; **both managers and the owner receive stock** (`purchase.create`, `receipt.create`) and edit products; expenses and products/suppliers are open to both; only the owner reviews approvals, voids sales, renames the shop and edits the shop policy. Owner-only REST actions (sale void, shop policy, approvals, audit log) are separate from the sync path so they are always online and audited.
- **Shop policy**: `shops.below_cost_policy`, `shops.max_discount_percent` and `shops.manager_financial_access` are read inside the same transaction as the operation that depends on them, so a policy change and a purchase/sale cannot race. `/reports/*` checks financial access per request; hidden UI controls are never the enforcement point.
- **Reversals**: a void locks the sale row, writes reversing `sale_return` movements and stamps `reversed_at` in one transaction. The ledger and audit log remain append-only; no sale, movement or audit row is deleted.
- **Client**: SQLite `outbox` + `products/suppliers` cache on native; IndexedDB with the same interface on web. `pending_delta` shows optimistic stock until the server verdict arrives.
- **Role surfaces**: shop roles see the operations/oversight navigation; `system_admin` sees only `/admin/*` (shops, users, health). The client redirects across that boundary and the API enforces it with `@Roles`.
- **Auth stack**: `AuthService` owns sessions, refresh rotation, password reset and TOTP 2FA; `security.ts` owns token hashing, AES-256-GCM secret encryption, password policy and recovery codes; `common/http.ts` owns cookie/CSRF handling. The login response is either a session or a 2FA challenge; only the challenge completion issues tokens. `AuthGuard` is unchanged in spirit: JWT + DB re-check on every request. Details in `AUTH.md`.
- **Refresh sessions**: `refresh_sessions` stores one row per issued refresh token (hash, family, device, expiry, revocation). Rotation claims the old row with a conditional `UPDATE … WHERE revoked_at IS NULL`, so concurrent refreshes cannot both succeed; a replayed token revokes the family. Password change/reset and logout-all bump `users.token_version` and revoke rows.
- **Notifications**: `NotificationService` stores per-user preferences and generates optional alerts on read (low/out-of-stock from the ledger view, other users' sales/purchases), de-duplicated per entity per 12 hours. Security notifications are inserted directly by the auth flows and never gated by a preference; delivery is in-app only.
- **Migrations**: `001_init` (schema, ledger, audit), `002_purchase_metadata`, `003_purchase_policy_and_sale_void`, `004_auth_security_and_notifications` (refresh sessions, reset tokens, notification preferences/inbox, 2FA secrets/recovery codes/challenges). Every migration is additive and tracked in `schema_migrations`.
- **PWA**: `public/manifest.json` + `public/sw.js`. The service worker caches only same-origin static assets and the shell; it skips authorized requests and all API prefixes.

## Real-time updates

**Transport:** a WebSocket at `/realtime` (`apps/api/src/realtime/hub.ts`), authenticated by the same JWT rules as HTTP (signature, `token_version`, active account, shop not suspended) and joined to a room derived from the **database** `shop_id`, never from the client. It is a notification channel only: frames carry a shop id, a timestamp and the operation types that changed — no rows, no totals.

**Why a nudge instead of a data stream:** the pull endpoint is already incremental (checkpoint per shop) and already re-authorized per request. Sending data over the socket would create a second, weaker copy of that authorization and a second merge path for offline operations. One `change` frame simply runs the existing sync pass (push outbox, then pull from checkpoint), so:

- shop isolation, role checks and suspension are enforced where they already were;
- a dropped frame costs one 30 s poll interval at worst, never a lost record;
- reconnection is self-healing: every successful (re)connect runs a pass, which is exactly the "recover missed events" rule.

**Lifecycle:** connect when a session exists, re-authenticate with a fresh access token when the socket closes after the 15-minute token expiry, exponential backoff with ±25 % jitter capped at 30 s, reconnect on foreground and on network return, drop on sign-out. Heartbeat: server `ping` every 25 s, a socket that misses one round is terminated.

**Emitters:** successful `/sync/push` batches (after commit), adjustment decisions, sale voids, shop profile/policy updates.

**Client status:** `useSync.live` drives a subtle "Live updates" label next to the existing online/pending indicator; nothing blocks the screen, nothing announces each record.

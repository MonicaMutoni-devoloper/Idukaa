# Offline & synchronization
Flow: validate locally → one SQLite transaction (outbox row + optimistic delta) → UI shows "saved on device / waiting to sync" → engine pushes when online (NetInfo, app foreground, every 30 s without a live socket, every 5 minutes as a safety poll with one, manual) → server verdict stored per op → pull changes → the dashboard reconciles only when the pull's business revision changes; a no-op pull does not reload it.

| Situation | Behaviour |
|---|---|
| App killed / phone restarted | Outbox is on disk; engine resumes on next start |
| Upload interrupted | Server may or may not have committed; resend uses same `opId` → returns original verdict (`duplicate` shown as synced) |
| Server down / timeout | Ops → `retry`, exponential backoff 10 s … 15 min with jitter; nothing is dropped |
| Access token expired | The client rotates the refresh token once and retries the request; the queue is untouched |
| Refresh failed / account revoked (401) | Queue kept, banner "sign in again"; ops are bound to `user_id` and only sync under that user |
| Reload while offline (web) | The shell and cached data render; there is no access token until a refresh succeeds, and the UI never presents cached data as server-confirmed |
| Conflict (oversell, over-receipt) | Not applied; visible in the Sync screen and the owner's Approvals; owner records a resolution; re-entry is a *new* operation |
| Rejected / conflicting operation | Kept on the device for review, but excluded from local revenue, cost, stock and report rows; it is shown in the Sync screen with its server message |
| Account or shop switch | The catalogue and checkpoints are reset for the new shop. `records` and `outbox` are **not deleted**: each row carries `shop_id`, so another shop can never read or sync it and the original account recovers it on sign-in |
| Realtime socket outlives its access token | The server closes it (`4001 token_expired`); the client rotates the refresh token and reconnects. If rotation fails, normal jittered backoff applies |
| Successful pull with no business change | Sync counters and `lastSync` update, but the dashboard/report figures are not invalidated and no dashboard request is made |
| Irrelevant realtime event (e.g. a supplier edit) | It wakes the sync engine; the pull's business revision is unchanged, so no dashboard request or loading state follows |
| Burst of relevant realtime events | Coalesced into at most one additional sync pass; the dashboard reconciles once, after sync is idle |
| Logout | Never deletes the outbox |

## Reports
Reports read this device first and the API second.

- Every operation (sale, expense, delivery, correction, adjustment request) is written to `records`
  in the same SQLite transaction as its outbox row, so it is reportable the moment it is saved —
  no connection and no sync required.
- Rows are calculated by `src/services/local-reports.ts` with the same shared functions the API uses
  (`summarize`, `periodCosts`, `valueAt`), so an offline net sale, COGS, gross profit and operating
  result agree with what the server will report once the work synchronizes.
- A successful API answer is cached per shop, view, **exact** period and permission scope under
  `report:v2:<shop>:<view>:<from>:<to>:<financial|operational>` with its `savedAt` time. The cache
  is validated on read (shop, view, period, access, timestamp) and is never rendered for another
  shop, range or role scope — an owner's cost-bearing copy cannot satisfy a manager without
  financial access.
- Offline, no request is made: the saved report renders with its synchronization time and a "may be
  out of date" label, and the still-queued local rows are merged on top of it, so a device that
  worked offline shows the shop's history as well as its own new work. Only when the device has no
  saved copy at all are its own records shown, labelled as device-only. An empty substitution is
  never made: if a saved copy exists, it is part of every offline figure.
- The dashboard follows the same rule in both directions: a queued operation never replaces the
  saved server snapshot with device-only totals, and the snapshot never freezes either. The
  snapshot stays the basis (the whole shop) and the operations still in the outbox are folded on top
  of it (`src/services/pending-dashboard.ts`), always starting from the pristine payload, so a sale
  rung up with no network moves today's net sales, transactions, cash, credit and the day's trend bar
  immediately and can never be counted twice. Cost is added only when this device's own stock
  history can price the sale (moving average from openings, receipts and the queued sales); when it
  cannot, revenue is still shown and profit is flagged provisional instead of guessed. The pending
  note now says the queued records ARE counted in these figures.
- A failed request never replaces a cached report with an empty one; the previous rows stay visible.
- Reconciliation: server rows are authoritative, and unsynchronized local rows (pending / retry /
  pending_approval) are merged **by operation id**, so a sale that pushes successfully can never be
  counted twice. While anything is still queued the summary stays server-derived and says how many
  operations are not in it yet.
- Rejected and conflicting operations are retained for recovery but are not posted rows and never
  enter revenue, COGS, expenses, purchases, stock or profit; the report's `counts.failed` and
  `counts.conflicts` say they exist.
- Not available offline, shown as "—" instead of guessed: supplier and cashier names, approved
  adjustment cost, stock-loss cost and void state (all server-side).
- Transaction and movement endpoints are paginated (`limit`/`offset`); the client walks every page
  instead of stopping at the first 500 transactions or 1,000 movements, so a large period is not
  silently truncated. Sale and purchase rows include their `lines`, which lets a saved sales report
  open a sale's items offline without one request per sale.
- Tests: `apps/mobile/tests/local-reports.test.mts` (`npm run test:reports -w @sms/mobile`).

## Dashboard
- `/sync/pull` also returns a per-shop business revision (the latest dashboard-visible audit row), so an expense or approval recorded by another device is detected even though the incremental `changes` array only carries products and suppliers. The client compares it; it never interprets it.
- The dashboard cache is `dashboard:v3:<shop>:<user>:<role>:<from>:<to>`. The role is part of the key, so a demoted/promoted account cannot reuse another permission scope.
- A saved copy is reused without a request only when its payload version is current and its saved revision equals the shop's last successful business revision. A new revision, saved local work or an account/shop/role change revalidates.
- Local records recalculate in place on every local save/verdict. A background server reconciliation never clears the visible payload, never shows a full-page skeleton, and a failed request keeps the last figures with a subtle refresh warning.
- Access-token rotation is authentication only and is not a dashboard dependency; it cannot trigger a loading cycle.

## PC / PWA
- The manifest identifies the app as **Idukaa** with 192/512/maskable icons, `standalone` display,
  `/` start URL and scope, and the `#0F5C4D` theme colour. The shell cache is `idukaa-shell-v7`;
  bumping the name removes the previous branded shell on activation.
- **Installing the shell:** during `install` the worker saves the shell files, the hashed launch
  bundle named by `index.html`, and then every other file the export produced — listed in
  `/sw-assets.json`, which `scripts/write-sw-manifest.mjs` generates after `expo export` — one asset
  at a time, so a single online visit is enough for the installed app to cold-start with the network
  off. That list matters because the web build emits one script per screen: a worker that saved only
  the launch bundles could open the start screen and nothing else, so Sell or Reports stayed blank
  on a phone that had never opened them online. Saving held response bodies concurrently stalls
  Chromium's install event indefinitely, which is why the downloads are sequential, and why
  `tests/pwa.test.mts` pins that shape. Asset lookups ignore `Vary` so a proxy header difference (for
  example Safari's `Accept-Encoding`) cannot miss the saved copy, and a failed asset request falls
  back to the shell cache instead of failing the launch.
- **Install:** Settings shows an install card. When Chrome fires `beforeinstallprompt` the button
  opens the native prompt; otherwise the card explains the real Chrome/Edge menu path and the iOS
  Share → Add to Home Screen path. The `beforeinstallprompt` listener starts at the app root, so an
  event fired before Settings is opened is not lost. An installed window is detected with
  `display-mode: standalone` (and `navigator.standalone` on iOS).
- **Offline download:** Settings → *Download for offline* fetches the current month and year for the
  dashboard, inventory, stock movements, sales and (for users allowed financials) the financial
  report. Each payload is written with the same shop/user/period/permission cache key the screens
  use, and the durable `offline.data:<shop>` status is written only after the modules finish. Partial
  downloads are labelled partial; repeat taps share one in-flight download.
- Service worker caches only the app shell (page, manifest, icons, launch bundle and every exported screen chunk). Business data lives in the local database, never in the HTTP cache. API calls are never cached.
- **Web storage is IndexedDB** (`sms-local`), not SQLite. The web build has no SQLite backend, so `src/database/local.web.ts` implements the same interface over IndexedDB. One record holds the whole local state, so an outbox row and its optimistic stock delta are committed together.
- The first web load imports any state left by the older `localStorage` adapter (`sms.localdb.v1`) and keeps that key as a recovery copy.
- Writes are serialized with the Web Locks API where available and re-read the latest state under the lock, so two tabs cannot silently lose each other's queued operations. Other tabs are notified through `BroadcastChannel` and drop their read cache.
- **Clearing browser data, using private windows, or switching browsers/devices loses any operations that were not yet synced.** Synced data is safe on the server and re-downloaded on next login. Tell PC users to sync before clearing data; the Sync screen and Settings show the unsynced count.
- **Web authentication:** the access token lives in memory only; the refresh token is an HttpOnly cookie. After a reload the app performs one refresh to get a new access token. When the browser does not send that cookie at all (iOS Safari blocks third-party cookies), the client repeats the refresh with the token it stored at sign-in, so a reload or relaunch never leaves the outbox stranded. The service worker never caches API responses, so an offline reload shows the cached shell and local data, not a stale authenticated API response.
- The adapter is exercised by `apps/mobile/tests/e2e-web.mjs`: it saves a sale with the API blocked, reloads the page, confirms the queue survived in IndexedDB, and syncs after reconnecting. `apps/mobile/tests/e2e-pwa.mjs` additionally checks the manifest/installability, install instructions, the offline download and a cached report with every API request blocked.
- IndexedDB quotas are browser-managed and much larger than localStorage; the single-record design is intended for a shop-sized catalogue, not tens of thousands of products.

## Checkpoints
`/sync/pull` returns an opaque cursor per entity (`updated_at,id`), page size 200, `hasMore` loops until caught up, and a monotonic `revision` used only for dashboard invalidation.

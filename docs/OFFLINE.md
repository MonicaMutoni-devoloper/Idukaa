# Offline & synchronization
Flow: validate locally → one SQLite transaction (outbox row + optimistic delta) → UI shows "saved on device / waiting to sync" → engine pushes when online (NetInfo, app foreground, every 30 s, manual) → server verdict stored per op → pull changes.

| Situation | Behaviour |
|---|---|
| App killed / phone restarted | Outbox is on disk; engine resumes on next start |
| Upload interrupted | Server may or may not have committed; resend uses same `opId` → returns original verdict (`duplicate` shown as synced) |
| Server down / timeout | Ops → `retry`, exponential backoff 10 s … 15 min with jitter; nothing is dropped |
| Access token expired | The client rotates the refresh token once and retries the request; the queue is untouched |
| Refresh failed / account revoked (401) | Queue kept, banner "sign in again"; ops are bound to `user_id` and only sync under that user |
| Reload while offline (web) | The shell and cached data render; there is no access token until a refresh succeeds, and the UI never presents cached data as server-confirmed |
| Conflict (oversell, over-receipt) | Not applied; visible in the Sync screen and the owner's Approvals; owner records a resolution; re-entry is a *new* operation |
| Logout | Never deletes the outbox |

## Reports
Reports read this device first and the API second.

- Every operation (sale, expense, delivery, correction, adjustment request) is written to `records`
  in the same SQLite transaction as its outbox row, so it is reportable the moment it is saved —
  no connection and no sync required.
- Rows are calculated by `src/services/local-reports.ts` with the same shared functions the API uses
  (`summarize`, `periodCosts`, `valueAt`), so an offline net sale, COGS, gross profit and operating
  result agree with what the server will report once the work synchronizes.
- A successful API answer is cached per shop, view and **exact** period under
  `report:v1:<shop>:<view>:<from>:<to>` with its `savedAt` time. The cache is validated on read
  (shop, view, period, timestamp) and is never rendered for another shop or range.
- Offline, no request is made: the saved report renders with its synchronization time and a "may be
  out of date" label. With no saved copy yet, the device's own records are shown and labelled
  accordingly, rather than an error or a list of zeros.
- A failed request never replaces a cached report with an empty one; the previous rows stay visible.
- Reconciliation: server rows are authoritative, and unsynchronized local rows (pending / retry /
  pending_approval) are merged **by operation id**, so a sale that pushes successfully can never be
  counted twice. While anything is still queued the summary stays server-derived and says how many
  operations are not in it yet.
- Not available offline, shown as "—" instead of guessed: supplier and cashier names, approved
  adjustment cost, stock-loss cost and void state (all server-side).
- Tests: `apps/mobile/tests/local-reports.test.mts` (`npm run test:reports -w @sms/mobile`).

## PC / PWA
- Service worker caches only the app shell. Business data lives in the local database, never in the HTTP cache. API calls are never cached.
- **Web storage is IndexedDB** (`sms-local`), not SQLite. The web build has no SQLite backend, so `src/database/local.web.ts` implements the same interface over IndexedDB. One record holds the whole local state, so an outbox row and its optimistic stock delta are committed together.
- The first web load imports any state left by the older `localStorage` adapter (`sms.localdb.v1`) and keeps that key as a recovery copy.
- Writes are serialized with the Web Locks API where available and re-read the latest state under the lock, so two tabs cannot silently lose each other's queued operations. Other tabs are notified through `BroadcastChannel` and drop their read cache.
- **Clearing browser data, using private windows, or switching browsers/devices loses any operations that were not yet synced.** Synced data is safe on the server and re-downloaded on next login. Tell PC users to sync before clearing data; the Sync screen and Settings show the unsynced count.
- **Web authentication:** the access token lives in memory only; the refresh token is an HttpOnly cookie. After a reload the app performs one refresh to get a new access token. The service worker never caches API responses, so an offline reload shows the cached shell and local data, not a stale authenticated API response.
- The adapter is exercised by `apps/mobile/tests/e2e-web.mjs`: it saves a sale with the API blocked, reloads the page, confirms the queue survived in IndexedDB, and syncs after reconnecting.
- IndexedDB quotas are browser-managed and much larger than localStorage; the single-record design is intended for a shop-sized catalogue, not tens of thousands of products.

## Checkpoints
`/sync/pull` returns an opaque cursor per entity (`updated_at,id`), page size 200, `hasMore` loops until caught up.

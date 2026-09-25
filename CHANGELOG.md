# Changelog

## 1.2.2 — Shared-database migration safety

- The auth migration moves only the 17 known `etsy_worker_*` functions.
  A `LIKE` pattern is escaped and still intersected with that list, so a
  lookalike name in `public` stays where it is.
- The first two migrations abort if `etsy_worker.operators` already exists.
  The auth migration is safe to run again and does not drop its own checks.
  Each migration file is one transaction.
  `supabase/preflight-etsy-worker.sql` is read-only.
  `supabase/apply-etsy-worker.sql` applies all three and does nothing when
  they are already in place.
- Lane users are bound to `operators.lane_name`. Claim, heartbeat, upload,
  complete, and fail reject a different lane. Complete, fail, and upload
  still require the job's current lease. There is no `etsy_worker.authed`
  session bypass. `upload_results` refuses a call with more than 500 rows.
- The options Health button calls `etsy_worker_lane_whoami`. Access and
  refresh tokens stay in `chrome.storage.session` (`TRUSTED_CONTEXTS`) and
  are removed from `chrome.storage.local`. The hourly cap counter stays in
  local storage. Realtime sends a new access token when the session
  refreshes. A shop or listing page with no cards is not treated as a
  blocked search. The between-jobs pause releases the worker busy flag.
  `npm run test:e2e` is the Chrome smoke test; `npm test` does not download
  Chrome.

## 1.2.1 — Worker review fixes

- Content scripts are classic scripts again. Shared parsers ship as committed
  IIFE bundles on `globalThis.IscaleEtsy`. The manifest test rejects
  `content_scripts.type` and top-level `import` / `export`.
- Block detection fails closed when the content script does not answer, and
  a search with zero listings and no empty-state marker stops instead of
  completing.
- Operator auth replaces anon RPC access. Migration
  `20260925160000_etsy_worker_auth.sql` grants the public RPCs only to
  `authenticated` operators. The extension and CLI sign in with email and
  password, send the publishable or anon key as `apikey`, and send the user
  access token as the bearer. `service_role` and `sb_secret_` keys are
  rejected. Content scripts do not receive worker credentials.
- A lane waits a random 20–60 seconds between jobs and stops claiming past
  30 jobs in an hour. The poll alarm repeats, so a service-worker restart
  does not drop the lane. Local runs and worker jobs cannot overlap.
- Navigation errors fail the job as retryable. Turning worker mode off
  mid-job releases it without burning an attempt. Transient upload errors
  retry; batches over 300 rows are split; one bad row is skipped.
- Total result counts keep the number and the raw text (`1,000+ results`,
  `Over 50,000 results`). Heartbeats use `workerHeartbeatSeconds`. A saved
  worker tab is reused only when it is still an etsy.com tab.
- `npm test` loads the unpacked extension in Chrome for Testing and checks
  that the content script answers on a static fixture page.

## 1.2.0 — Worker command channel

- Generalize the optional worker queue into typed jobs: `search`,
  `scrape-listings`, `scrape-shop`, `export`, and `collection-stats`.
- A visible lane runs the matching extension feature and uploads status plus
  results. Listing visits reuse the existing listing extract. Shop jobs read
  listing cards from the shop page. Export and stats read the lane's local
  collection and do not open Etsy.
- Add CLI commands for those types, plus `status` / `results` by job id or
  shop. The runbook lists every exposed feature and the ones left local.
- Apply `20260925140000_etsy_worker_commands.sql` after the original worker
  migration. Worker mode stays off by default.

## 1.1.0 — Optional backend worker lane

- Add an opt-in worker mode. It is off by default and has no baked-in backend
  URL or key. A visible Chrome window claims Etsy searches, types them into
  the search box, and uploads each results page as it finishes, including the
  search's total result count.
- Ship Postgres migrations and RPCs for a priority queue with claim leases,
  heartbeats, idempotent completion, and re-queue of expired leases.
- Add `scripts/etsy-worker.mjs` (`add-terms`, `search-now`, `status`,
  `results --json`, `health`, `requeue`) and a worker runbook.
- `storage` is used for lane state in `chrome.storage.session`. Backend host
  access is an optional permission granted from the options page.

## 1.0.2 — Durable runner-tab reuse

- Persist the hidden Etsy runner tab id and reuse it after MV3 service-worker
  eviction or an unpacked-extension reload instead of accumulating orphan tabs.
- Add regression coverage for restored, duplicated, and invalid tab ids.
- Live reload verification reused the same tab, resumed the interrupted job,
  paginated real Etsy review modals, and advanced to subsequent listings.

## 1.0.1 — Runner and extraction stabilization

- Preserve auto-run countdowns across MV3 service-worker restarts and use a
  dedicated alarm for accurate between-term pauses.
- Stop the service-worker heartbeat whenever a one-listing tick yields.
- Parse review dates from ISO datetimes, abbreviated or full English month
  names, and day-first formats through one tested content-script helper.
- Restrict Etsy content scripts to their three legitimate background actions.
- Prune terminal queue/job history after 30 days and avoid full queue scans when
  deciding whether requested terms still have work.
- Correct the public source-install and side-panel instructions.

## 1.0.0 — First public release

iScale Etsy goes open source. Highlights of what ships in this
first public version (1.0.0):

- Local-first Chrome MV3 extension: batch scrape jobs, manual collection,
  automatic search-results capture, a local Shop View, and CSV import/export.
- Durable, eviction-resilient job runner: jobs survive Chrome MV3 service-worker
  restarts, with pause/resume/stop, a consecutive-failure circuit breaker, and
  conservative randomized pacing.
- 270+ behavioral unit tests over the pure core modules (including real
  IndexedDB semantics via fake-indexeddb).
- Least-privilege manifest: `alarms`, `downloads`, `sidePanel` only;
  https-only etsy.com host permissions; strict extension-pages CSP.
- No runtime dependencies, no telemetry, no backend — see PRIVACY.md.

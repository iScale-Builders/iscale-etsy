# Changelog

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

# Changelog

## 1.0.0 — First public release

iScale Etsy goes open source. Highlights of what ships in this
first public version (1.0.0):

- Local-first Chrome MV3 extension: batch scrape jobs, manual collection,
  automatic search-results capture, a local Shop View, and CSV import/export.
- Durable, eviction-proof job runner: jobs survive Chrome MV3 service-worker
  restarts, with pause/resume/stop, a consecutive-failure circuit breaker, and
  conservative randomized pacing.
- 270+ behavioral unit tests over the pure core modules (including real
  IndexedDB semantics via fake-indexeddb).
- Least-privilege manifest: `alarms`, `downloads`, `sidePanel` only;
  https-only etsy.com host permissions; strict extension-pages CSP.
- No runtime dependencies, no telemetry, no backend — see PRIVACY.md.

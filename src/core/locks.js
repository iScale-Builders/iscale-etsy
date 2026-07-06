// Cross-context mutual exclusion for the `listings` store via the Web Locks API. The
// service worker and the Shop View page each open their OWN IndexedDB connection, so the
// SW's in-process saveQueue does NOT serialize against the page. Without a shared lock, the
// Shop View CSV import (read-all snapshot → merge → bulkPut of every row) can silently
// overwrite a listing save the SW committed in between — losing demand/history/favorites.
//
// Saves take the lock SHARED (they stay concurrent with each other — different ids); a bulk
// writer (the import) takes it EXCLUSIVE, which waits for in-flight saves and blocks new
// ones for the duration of its read→merge→write. Falls back to running directly if Web
// Locks is unavailable (older context), preserving today's behavior. (audit deep-pass High #16)
export function withListingsLock(mode, fn) {
  try {
    if (typeof navigator !== "undefined" && navigator.locks && navigator.locks.request) {
      return navigator.locks.request("etsy-listings-write", { mode }, fn);
    }
  } catch {
    // Web Locks unavailable / threw — fall through to running directly.
  }
  return fn();
}

const DB_NAME = "etsy_research_scraper";
const DB_VERSION = 5;

const STORES = ["jobs", "search_terms", "listing_urls", "listings", "settings", "search_results"];

// One cached connection per context (the service worker, or a page like the Shop
// View). Re-opening the DB on every read/write — the old behavior — meant a CSV
// import of ~180k rows did ~180k `indexedDB.open` calls. The cache is dropped if
// another context triggers a version change or the connection closes, so the
// next call reopens cleanly.
let dbPromise = null;

export function openScraperDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;
      for (const storeName of STORES) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: "id" });
        }
      }
      const listings = tx.objectStore("listings");
      // normalizedUrl must be NON-unique: passive/batch/import paths can produce
      // the same (or empty) value for distinct rows, and a unique index would
      // throw ConstraintError on write — and abort the upgrade if existing rows
      // already collide. Recreate it non-unique on upgrade.
      if (listings.indexNames.contains("normalizedUrl")) {
        listings.deleteIndex("normalizedUrl");
      }
      listings.createIndex("normalizedUrl", "normalizedUrl", { unique: false });
      if (!listings.indexNames.contains("source")) {
        listings.createIndex("source", "source", { unique: false });
      }
      // listing_urls accumulates one row per discovered URL across ALL jobs ever
      // run and is never pruned. Querying a single job's queue by full-store scan
      // ran on every job start/resume AND every 30s keep-alive wake. Index by
      // jobId so those become an index lookup instead of a full scan (v4).
      const listingUrls = tx.objectStore("listing_urls");
      if (!listingUrls.indexNames.contains("jobId")) {
        listingUrls.createIndex("jobId", "jobId", { unique: false });
      }
      // v5: the URL-keyed queue stores one row per URL with a `terms` array of the
      // search terms that surfaced it. A multiEntry index lets the runner fetch
      // "pending URLs for term T" by index instead of a full-store scan.
      if (!listingUrls.indexNames.contains("terms")) {
        listingUrls.createIndex("terms", "terms", { unique: false, multiEntry: true });
      }
    };

    request.onblocked = () => {
      // Another open connection (e.g. a second tab on an older version) is holding
      // the upgrade. Don't hang forever — surface it and clear the cache so a
      // retry can succeed once the other connection closes.
      dbPromise = null;
      reject(new Error("IndexedDB upgrade blocked by another open connection"));
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        // A newer version wants to upgrade in another context — close so we don't
        // block it, and drop the cache so our next call reopens at the new version.
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
  });
  return dbPromise;
}

export async function putRecord(storeName, record) {
  const db = await openScraperDb();
  return withStore(db, storeName, "readwrite", (store) => store.put(record));
}

// Write many records in a SINGLE transaction. Used by the CSV import (~180k rows)
// and bulk discovery — one transaction instead of one-per-row, and resolves only
// after the whole batch commits.
export async function bulkPut(storeName, records) {
  if (!Array.isArray(records) || records.length === 0) return 0;
  const db = await openScraperDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const record of records) store.put(record);
    tx.oncomplete = () => resolve(records.length);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("bulkPut transaction aborted"));
  });
}

export async function bulkDelete(storeName, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const db = await openScraperDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve(ids.length);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("bulkDelete transaction aborted"));
  });
}

export async function getAllRecords(storeName) {
  const db = await openScraperDb();
  return withStore(db, storeName, "readonly", (store) => store.getAll());
}

export async function getRecord(storeName, id) {
  const db = await openScraperDb();
  return withStore(db, storeName, "readonly", (store) => store.get(id));
}

// Fold over every record via a cursor — one record in memory at a time. Lets
// callers tally derived stats (e.g. how many listings have demand) without
// materializing the whole ~180k-row store into an array on every panel open.
export async function reduceRecords(storeName, reducer, initial) {
  const db = await openScraperDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).openCursor();
    let acc = initial;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      acc = reducer(acc, cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(acc);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("reduceRecords aborted"));
  });
}

// O(1)-ish count via the store's B-tree — avoids loading every record to size it.
export async function countRecords(storeName) {
  const db = await openScraperDb();
  return withStore(db, storeName, "readonly", (store) => store.count());
}

// All records whose indexed field equals key (e.g. every listing_url for a jobId).
export async function getAllByIndex(storeName, indexName, key) {
  const db = await openScraperDb();
  return withStore(db, storeName, "readonly", (store) => store.index(indexName).getAll(key));
}

export async function deleteRecord(storeName, id) {
  const db = await openScraperDb();
  return withStore(db, storeName, "readwrite", (store) => store.delete(id));
}

export async function clearStore(storeName) {
  const db = await openScraperDb();
  return withStore(db, storeName, "readwrite", (store) => store.clear());
}

// Resolve on tx.oncomplete (not request.onsuccess): a write isn't durable until
// the transaction commits, and a commit can still abort (quota, a sibling op).
// Resolving on request.onsuccess reported "saved" before commit and swallowed
// aborts. onabort/onerror now reject so callers see the failure.
function withStore(db, storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeName, mode);
    } catch (error) {
      reject(error);
      return;
    }
    let result;
    const request = operation(tx.objectStore(storeName));
    if (request) {
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error);
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
}

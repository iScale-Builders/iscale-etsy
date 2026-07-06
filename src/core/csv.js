export const DEFAULT_EXPORT_COLUMNS = [
  "url",
  "listingId",
  "title",
  "imageUrl",
  "shopName",
  "price",
  "currency",
  "favorites",
  "reviewCount",
  "firstReview",
  "lastReview",
  "demandText",
  "demandType",
  "demandValue",
  "demandHistory",
  "isDigital",
  "deleted",
  "deletedAt",
  "source",
  "searchTerm",
  "searchTerms",
  "firstSeenAt",
  "lastSeenAt",
  "scrapedAt",
  "lastScrapedAt",
];

export function escapeCsvCell(value) {
  if (value == null) return "";
  // A flat array of primitives (e.g. searchTerms, sources) is joined with "; " so
  // it reads cleanly in a cell and round-trips via splitCsvList on import. Arrays
  // of objects (e.g. demandHistory) and plain objects stay JSON. (audit-safe)
  let raw;
  if (Array.isArray(value)) {
    raw = value.some((v) => v !== null && typeof v === "object")
      ? JSON.stringify(value)
      : value.filter((v) => v !== null && v !== undefined && v !== "").join("; ");
  } else {
    raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  let text = raw.replace(/"/g, '""');
  // Neutralize spreadsheet formula/DDE injection from scraped marketplace text:
  // a cell starting with = + - @ (or tab/CR) executes when opened in Excel/Sheets. Also
  // catch a payload hidden behind LEADING WHITESPACE (" =cmd"), which some apps trim
  // before evaluating — checking only the first char would miss it. (audit LOW-27)
  if (/^[=+\-@\t\r]/.test(text) || /^[=+\-@]/.test(text.trimStart())) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text}"` : text;
}

// Inverse of escapeCsvCell's formula guard: escapeCsvCell prepends a single '
// ONLY when a value starts with a formula lead (= + - @ tab CR). Strip that '
// on import so an exported-then-reimported cell round-trips. Guarded by the
// next char so a legitimate leading apostrophe (e.g. "'tis") is left alone.
// (A real value that is itself a ' followed by a formula lead is irreducibly
// ambiguous under the spreadsheet ' convention — vanishingly rare in Etsy data.)
export function unescapeCsvCell(value) {
  if (typeof value === "string" && value.length >= 2 && value[0] === "'" && /[=+\-@\t\r]/.test(value[1])) {
    return value.slice(1);
  }
  return value;
}

// Inverse of escapeCsvCell's "; " join for flat primitive arrays (searchTerms,
// sources). Accepts a value already split as an array (passthrough), a "; "- or
// comma-joined string, or empty → []. Also tolerates a legacy JSON array string.
export function splitCsvList(value) {
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined && v !== "");
  const text = String(value ?? "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.filter((v) => v !== null && v !== undefined && v !== "");
    } catch {
      // fall through to delimiter split
    }
  }
  return text.split(/\s*[;,]\s*/).map((v) => v.trim()).filter(Boolean);
}

// Single-line builders so a large store can be exported one row at a time via a
// cursor (see background maybeAutoExport) without materializing every row. (M-4)
export function csvHeaderLine(columns = DEFAULT_EXPORT_COLUMNS) {
  return columns.map(escapeCsvCell).join(",");
}
export function csvRowLine(row, columns = DEFAULT_EXPORT_COLUMNS) {
  return columns.map((column) => escapeCsvCell(row[column])).join(",");
}

export function rowsToCsv(rows, columns = DEFAULT_EXPORT_COLUMNS) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const body = safeRows.map((row) => csvRowLine(row, columns));
  return [csvHeaderLine(columns), ...body].join("\n");
}

// Untrusted CSV headers must not write dangerous keys (prototype pollution), and
// a cell can't be unbounded (storage bloat / UI stall). (audit M-6 / SEC)
const DANGEROUS_CSV_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_CSV_CELL_LEN = 100_000;

export function csvToRows(text) {
  const records = parseCsvRecords(text);
  if (records.length === 0) return [];
  // Keep original column positions so cells stay aligned; skip empty/dangerous
  // headers during assignment rather than filtering the array (which would shift
  // indices).
  const headers = records[0].map((header) => header.trim());
  if (headers.filter(Boolean).length === 0) return [];

  return records.slice(1).flatMap((record) => {
    if (record.every((cell) => cell === "")) return [];
    const row = {};
    headers.forEach((header, index) => {
      if (!header || DANGEROUS_CSV_KEYS.has(header)) return;
      const cell = unescapeCsvCell(record[index] ?? "");
      row[header] = typeof cell === "string" && cell.length > MAX_CSV_CELL_LEN ? cell.slice(0, MAX_CSV_CELL_LEN) : cell;
    });
    return row;
  });
}

export function makeExportFilename(prefix = "etsy-scrape", date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${prefix}-${stamp}.csv`;
}

// Sanitize a user-chosen download subfolder into a safe relative path for
// chrome.downloads (no traversal, no absolute paths, no illegal chars). Returns
// "" when nothing usable remains. Nested "a/b" is allowed; ".." segments are
// dropped; Windows-illegal chars and trailing dots/spaces are stripped.
export function sanitizeSubfolder(name) {
  return String(name || "")
    .split(/[/\\]+/)
    .map((seg) =>
      seg
        // eslint-disable-next-line no-control-regex
        .replace(/[<>:"|?*\u0000-\u001f]/g, "") // strip illegal + control chars (keep spaces/dashes)
        .replace(/^\.+/, "")
        .replace(/[. ]+$/, "")
        .trim(),
    )
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
}

// Prefix a download filename with the sanitized subfolder, e.g.
// Sanitize a download base filename: no path separators or traversal, no control/illegal
// chars, no leading dots. Belt-and-suspenders — chrome.downloads also rejects traversal,
// but we never want a caller-supplied filename to escape the Downloads dir.
export function sanitizeFilename(name) {
  const cleaned = String(name || "")
    .split(/[/\\]+/)
    .pop() // drop any directory portion — keep only the final segment
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "download";
}

// withSubfolder("etsy-2026.csv", "My Research") -> "My Research/etsy-2026.csv".
export function withSubfolder(filename, subfolder) {
  const folder = sanitizeSubfolder(subfolder);
  const base = sanitizeFilename(filename);
  return folder ? `${folder}/${base}` : base;
}

function parseCsvRecords(text) {
  const records = [];
  let record = [];
  let cell = "";
  let inQuotes = false;
  const input = String(text || "");

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const next = input[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      record.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index++;
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  record.push(cell);
  records.push(record);
  return records;
}

// Small deterministic string hash (djb-ish *31 rolling hash, base-36). Used to derive
// stable IDs (queue rows, job listing items, import keys). Coerces to String so a
// non-string input can't throw. Output is stable across runs for the same input — IDs
// depend on it, so do NOT change the algorithm.
export function hashText(value) {
  let hash = 0;
  const s = String(value || "");
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

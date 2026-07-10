// Build release artifacts into dist/ with explicit allowlists, so what ships
// is decided by this script — not by hand-copying discipline.
//
//   node scripts/package.mjs
//
// Produces:
//   dist/public-repo/   everything that belongs in the public git repository
//                       (excludes internal working docs, installs, coverage)
//   dist/extension/     the runtime-only unpacked extension for Chrome
//                       "Load unpacked" and the Web Store zip (per
//                       RELEASE_CHECKLIST.md: no node_modules/, tests/,
//                       configs, or package manifests)
//
// Also writes dist/extension.zip / dist/public-repo.zip when a zip-capable
// tar (bsdtar — bundled with Windows 10+ and macOS) is available.

import { cpSync, rmSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

// --- public repo copy: everything EXCEPT the internal/dev exclusions --------
const PUBLIC_REPO_EXCLUDE = new Set([
  "AUDIT.md", // internal audit working document
  "RELEASE_CHECKLIST.md", // internal release process
  "node_modules",
  "coverage",
  "dist",
  ".git",
]);

// --- extension package: runtime files ONLY (explicit allowlist) -------------
const EXTENSION_ALLOW = [
  "manifest.json",
  "background.js",
  "content.js",
  "passive.js",
  "review-date-utils.js",
  "dashboard.js",
  "dashboard.html",
  "shop.js",
  "shop.html",
  "icons",
  "src/core", // ES modules imported by the background service worker
  "LICENSE",
  "PRIVACY.md",
];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// public repo
const repoOut = join(dist, "public-repo");
mkdirSync(repoOut, { recursive: true });
for (const entry of readdirSync(root)) {
  if (PUBLIC_REPO_EXCLUDE.has(entry)) continue;
  cpSync(join(root, entry), join(repoOut, entry), { recursive: true });
}

// extension
const extOut = join(dist, "extension");
mkdirSync(extOut, { recursive: true });
for (const entry of EXTENSION_ALLOW) {
  const src = join(root, entry);
  if (!existsSync(src)) {
    console.error(`MISSING runtime file: ${entry} — refusing to build a broken package.`);
    process.exit(1);
  }
  cpSync(src, join(extOut, entry), { recursive: true });
}

// zips (best-effort). Needs bsdtar: its -a flag infers zip format from the
// file extension. On Windows the bundled System32 tar IS bsdtar, but a Git
// Bash GNU tar earlier on PATH would silently write a plain tar instead —
// so prefer the system one explicitly. Paths stay relative (GNU tar misreads
// absolute Windows paths as remote hosts).
const tarCandidates =
  process.platform === "win32"
    ? [join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), "tar"]
    : ["tar"];
let zipped = false;
for (const tarBin of tarCandidates) {
  try {
    execFileSync(tarBin, ["-a", "-cf", "extension.zip", "-C", "extension", "."], { cwd: dist });
    execFileSync(tarBin, ["-a", "-cf", "public-repo.zip", "-C", "public-repo", "."], { cwd: dist });
    zipped = true;
    break;
  } catch {
    // try the next candidate; folders are complete either way
  }
}

const count = (dir) => {
  let n = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    n += statSync(p).isDirectory() ? count(p) : 1;
  }
  return n;
};

console.log(`dist/public-repo  ${count(repoOut)} files`);
console.log(`dist/extension    ${count(extOut)} files`);
console.log(zipped ? "zips written: dist/extension.zip, dist/public-repo.zip" : "zip skipped (no bsdtar) — use the folders");

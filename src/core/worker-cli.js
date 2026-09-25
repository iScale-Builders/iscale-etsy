// Agent-facing commands for the optional Etsy worker queue.
// Reads the backend URL, publishable or anon key, and an Auth user from the
// environment. Never prints the key, password, or access token.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { classifyApiKey, ensureWorkerSession } from "./worker-auth.js";
import { createWorkerClient } from "./worker-client.js";
import { collectListingUrls, normalizeExportParams } from "./worker-commands.js";
import { parseShopTarget } from "./shop-page.js";

export const CLI_HELP = `etsy-worker — queue extension commands for a visible worker lane

Environment (required, never commit these):
  ETSY_WORKER_URL        https://YOUR_PROJECT.supabase.co
  ETSY_WORKER_ANON_KEY   publishable (sb_publishable_...) or legacy anon key
  ETSY_WORKER_EMAIL      Auth user email (agent or admin)
  ETSY_WORKER_PASSWORD   Auth user password
  ETSY_WORKER_TOKEN_CACHE  optional token file outside this repo
                         (default: ~/.config/iscale-etsy/worker-token.json)

Commands:
  add-terms "<term>" ["<term>" ...] --priority <n> [--pages <n>] [--sort <order>]
  search-now "<term>" [--pages <n>] [--sort <order>]
  scrape-listings --url <listing-url> [--url <listing-url> ...] [--priority <n>]
  scrape-shop --shop <name> | --url <shop-url> [--pages <n>] [--visit] [--priority <n>]
  export --source listings|search|shop --format csv|json [--q <text>] [--chip <chip>] [--sort <key>] [--dir asc|desc]
  stats
  enqueue --type <type> [type-specific flags]
  status [--term "<term>" | --shop <name> | --job <uuid>] [--json]
  results (--term "<term>" | --shop <name> | --job <uuid>) [--json] [--limit <n>] [--offset <n>]
  health [--json]
  requeue

search stays one open job per term. scrape-shop is one open job per shop.
scrape-listings is one open job per set of listing ids (40 max).
export and stats read the lane's local collection and upload a snapshot.
--visit on scrape-shop also opens up to 15 listing pages.
status --term prints state, lane, pages done, rows, total result count, and last error.
results --json prints listings plus any payload snapshots, including partial progress.
`;

function takeValue(argv, index, flag) {
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return { value: next, index: index + 1 };
}

export function parseWorkerArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "help";
  const flags = { json: false };
  const positionals = [];
  const rest = command === args[0] ? args.slice(1) : args;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--json") flags.json = true;
    else if (token === "--help" || token === "-h") flags.help = true;
    else if (token.startsWith("--priority=")) flags.priority = token.slice("--priority=".length);
    else if (token.startsWith("--pages=")) flags.pages = token.slice("--pages=".length);
    else if (token.startsWith("--sort=")) flags.sort = token.slice("--sort=".length);
    else if (token.startsWith("--term=")) flags.term = token.slice("--term=".length);
    else if (token.startsWith("--limit=")) flags.limit = token.slice("--limit=".length);
    else if (token.startsWith("--offset=")) flags.offset = token.slice("--offset=".length);
    else if (token.startsWith("--type=")) flags.type = token.slice("--type=".length);
    else if (token.startsWith("--shop=")) flags.shop = token.slice("--shop=".length);
    else if (token.startsWith("--source=")) flags.source = token.slice("--source=".length);
    else if (token.startsWith("--format=")) flags.format = token.slice("--format=".length);
    else if (token.startsWith("--q=")) flags.q = token.slice("--q=".length);
    else if (token.startsWith("--chip=")) flags.chip = token.slice("--chip=".length);
    else if (token.startsWith("--dir=")) flags.dir = token.slice("--dir=".length);
    else if (token.startsWith("--demand=")) flags.demand = token.slice("--demand=".length);
    else if (token.startsWith("--job=")) flags.job = token.slice("--job=".length);
    else if (token.startsWith("--url=")) {
      flags.urls = flags.urls || [];
      flags.urls.push(token.slice("--url=".length));
    } else if (token === "--visit") flags.visit = true;
    else if (token === "--url") {
      const got = takeValue(rest, i, token);
      flags.urls = flags.urls || [];
      flags.urls.push(got.value);
      i = got.index;
    } else if (token === "--priority" || token === "--pages" || token === "--sort" || token === "--term" || token === "--limit" || token === "--offset" || token === "--type" || token === "--shop" || token === "--source" || token === "--format" || token === "--q" || token === "--chip" || token === "--dir" || token === "--demand" || token === "--job") {
      const got = takeValue(rest, i, token);
      flags[token.slice(2)] = got.value;
      i = got.index;
    } else if (token.startsWith("--")) {
      throw new Error(`unknown flag ${token}`);
    } else {
      positionals.push(token);
    }
  }
  return { command, flags, positionals };
}

function intFlag(value, fallback) {
  if (value == null || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) throw new Error(`expected an integer, got ${value}`);
  return n;
}

function termList(parsed) {
  const terms = [...parsed.positionals];
  if (parsed.flags.term) terms.push(parsed.flags.term);
  return terms.map((term) => String(term).trim()).filter(Boolean);
}

export function defaultTokenCachePath() {
  return resolve(homedir(), ".config", "iscale-etsy", "worker-token.json");
}

export function tokenCachePath(env = {}, cwd = process.cwd()) {
  const requested = String(env.ETSY_WORKER_TOKEN_CACHE || "").trim();
  const file = requested ? (isAbsolute(requested) ? requested : resolve(cwd, requested)) : defaultTokenCachePath();
  const root = resolve(cwd);
  const rel = relative(root, file);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    throw new Error("ETSY_WORKER_TOKEN_CACHE must point outside the repository.");
  }
  return file;
}

async function readTokenCache(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeTokenCache(file, session) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
  })}\n`, { mode: 0o600 });
}

async function clientFromEnv(env, fetchImpl) {
  const backendUrl = String(env.ETSY_WORKER_URL || "").trim();
  const anonKey = String(env.ETSY_WORKER_ANON_KEY || "").trim();
  const email = String(env.ETSY_WORKER_EMAIL || "").trim();
  const password = String(env.ETSY_WORKER_PASSWORD || "");
  if (!backendUrl || !anonKey) {
    throw new Error("Set ETSY_WORKER_URL and ETSY_WORKER_ANON_KEY. Do not commit them.");
  }
  const key = classifyApiKey(anonKey);
  if (!key.ok) {
    throw new Error(key.error === "service_role_rejected" || key.error === "secret_key_rejected"
      ? "Refusing a service_role or sb_secret_ key. Use the publishable or anon key."
      : key.error);
  }
  const cacheFile = tokenCachePath(env);
  const stored = await readTokenCache(cacheFile);
  const session = await ensureWorkerSession({
    fetchImpl,
    backendUrl,
    apiKey: anonKey,
    email,
    password,
    stored,
  });
  if (!session.ok) {
    if (!email || !password) {
      throw new Error("Set ETSY_WORKER_EMAIL and ETSY_WORKER_PASSWORD, or a token cache from an earlier sign-in.");
    }
    throw new Error(session.error || "sign_in_failed");
  }
  if (session.refreshed) await writeTokenCache(cacheFile, session);
  return createWorkerClient({ fetchImpl, backendUrl, anonKey, accessToken: session.accessToken });
}

const ENQUEUE_COMMANDS = new Set(["enqueue", "scrape-listings", "scrape-shop", "export", "stats"]);

export function buildEnqueue(parsed) {
  const requested = parsed.command === "enqueue" ? String(parsed.flags.type || "").trim() : parsed.command;
  const type = requested === "stats" ? "collection-stats" : requested;
  const priority = intFlag(parsed.flags.priority, 0);
  if (!type) return { error: "usage: enqueue --type <search|scrape-listings|scrape-shop|export|collection-stats>" };
  if (type === "search") {
    const terms = termList(parsed);
    if (terms.length !== 1) return { error: 'usage: enqueue --type search --term "<term>"' };
    return {
      type,
      priority,
      params: { term: terms[0], pages: intFlag(parsed.flags.pages, 1), sort: parsed.flags.sort || "most_relevant" },
    };
  }
  if (type === "scrape-listings") {
    const collected = collectListingUrls([...(parsed.flags.urls || []), ...parsed.positionals]);
    if (collected.error) return { error: collected.error === "too_many_urls" ? "too_many_urls (max 40)" : "invalid_listing_url" };
    return { type, priority, params: { urls: collected.urls } };
  }
  if (type === "scrape-shop") {
    const raw = parsed.flags.shop || parsed.flags.url || (parsed.flags.urls || [])[0] || parsed.positionals[0];
    const target = parseShopTarget(raw);
    if (!target) return { error: "invalid_shop" };
    const pages = Math.max(1, Math.min(10, intFlag(parsed.flags.pages, target.page || 1)));
    return {
      type,
      priority,
      params: { shop: target.shop, pages, visitListings: parsed.flags.visit === true },
    };
  }
  if (type === "export") {
    const params = normalizeExportParams({
      source: parsed.flags.source,
      format: parsed.flags.format,
      q: parsed.flags.q,
      demand: parsed.flags.demand,
      chip: parsed.flags.chip,
      sort: parsed.flags.sort,
      dir: parsed.flags.dir,
    });
    if (params.error) return { error: params.error };
    return { type, priority, params };
  }
  if (type === "collection-stats") return { type, priority, params: {} };
  return { error: `unknown_job_type: ${type}` };
}

function printStatus(data, out) {
  out.log(`type: ${data.type ?? "search"}`);
  out.log(`term: ${data.term ?? data.subject ?? ""}`);
  out.log(`state: ${data.state ?? ""}`);
  out.log(`lane: ${data.lane ?? ""}`);
  out.log(`pages_done: ${data.pages_done ?? 0}`);
  out.log(`pages: ${data.pages ?? ""}`);
  out.log(`rows: ${data.rows ?? 0}`);
  out.log(`total_results: ${data.total_results ?? ""}`);
  out.log(`last_error: ${data.last_error ?? ""}`);
  out.log(`priority: ${data.priority ?? ""}`);
  out.log(`attempt: ${data.attempt ?? ""}`);
  if (data.search_path) out.log(`search_path: ${data.search_path}`);
}

function printJson(data, out) {
  out.log(JSON.stringify(data, null, 2));
}

export async function runWorkerCli(argv, env = {}, fetchImpl = globalThis.fetch, out = { log: () => {}, error: () => {} }) {
  let parsed;
  try {
    parsed = parseWorkerArgs(argv);
  } catch (error) {
    out.error(error.message);
    return 2;
  }
  if (parsed.flags.help || parsed.command === "help") {
    out.log(CLI_HELP.trimEnd());
    return parsed.command === "help" || parsed.flags.help ? 0 : 2;
  }

  try {
    if (parsed.command === "add-terms" && termList(parsed).length === 0) {
      out.error('usage: add-terms "<term>" --priority <n>');
      return 2;
    }
    if (parsed.command === "search-now" && termList(parsed).length !== 1) {
      out.error('usage: search-now "<term>" [--pages <n>]');
      return 2;
    }
    let enqueueRequest = null;
    if (ENQUEUE_COMMANDS.has(parsed.command)) {
      enqueueRequest = buildEnqueue(parsed);
      if (enqueueRequest.error) {
        out.error(enqueueRequest.error);
        return 2;
      }
    }

    let client;
    try {
      client = await clientFromEnv(env, fetchImpl);
    } catch (error) {
      out.error(error.message);
      return 1;
    }

    if (parsed.command === "add-terms") {
      const terms = termList(parsed);
      const priority = intFlag(parsed.flags.priority, 0);
      const pages = intFlag(parsed.flags.pages, 1);
      const sort = parsed.flags.sort || "most_relevant";
      const data = await client.addTerms(terms, priority, pages, sort);
      if (data?.ok === false) {
        out.error(data.error || "add_terms_failed");
        return 1;
      }
      if (parsed.flags.json) printJson(data, out);
      else {
        for (const job of data.jobs || []) {
          out.log(`${job.action}: ${job.term} priority=${job.priority ?? ""} id=${job.id ?? ""}`);
        }
      }
      return 0;
    }

    if (parsed.command === "search-now") {
      const terms = termList(parsed);
      const data = await client.searchNow(terms[0], intFlag(parsed.flags.pages, 1), parsed.flags.sort || "most_relevant");
      if (data?.ok === false) {
        out.error(data.error || "search_now_failed");
        return 1;
      }
      if (parsed.flags.json) printJson(data, out);
      else out.log(`${data.action}: ${data.term} priority=${data.priority} id=${data.id}`);
      return 0;
    }

    if (ENQUEUE_COMMANDS.has(parsed.command)) {
      const data = await client.enqueue(enqueueRequest.type, enqueueRequest.params, enqueueRequest.priority);
      if (data?.ok === false) {
        out.error(data.error || "enqueue_failed");
        return 1;
      }
      if (parsed.flags.json) printJson(data, out);
      else out.log(`${data.action}: ${data.type} ${data.subject} priority=${data.priority ?? ""} id=${data.id ?? ""}`);
      return 0;
    }

    if (parsed.command === "status") {
      const terms = termList(parsed);
      const data = parsed.flags.job
        ? await client.jobStatus(parsed.flags.job)
        : parsed.flags.shop
          ? await client.lookup("scrape-shop", parsed.flags.shop)
          : terms.length
            ? await client.termStatus(terms[0])
            : await client.fleetStatus();
      if (data?.ok === false) {
        out.error(data.error || "status_failed");
        return 1;
      }
      if (parsed.flags.json || !(parsed.flags.job || parsed.flags.shop || terms.length)) printJson(data, out);
      else printStatus(data, out);
      return 0;
    }

    if (parsed.command === "results") {
      const terms = termList(parsed);
      const limit = intFlag(parsed.flags.limit, 500);
      const offset = intFlag(parsed.flags.offset, 0);
      let data;
      if (parsed.flags.job) data = await client.jobResults(parsed.flags.job, limit, offset);
      else if (parsed.flags.shop) {
        const found = await client.lookup("scrape-shop", parsed.flags.shop);
        if (found?.ok === false) {
          out.error(found.error || "not_found");
          return 1;
        }
        data = await client.jobResults(found.id, limit, offset);
      } else if (terms.length === 1) data = await client.results(terms[0], limit, offset);
      else {
        out.error('usage: results --term "<term>" | --shop <name> | --job <uuid> --json');
        return 2;
      }
      if (data?.ok === false) {
        out.error(data.error || "results_failed");
        return 1;
      }
      if (parsed.flags.json) printJson(data, out);
      else {
        out.log(`term: ${data.job?.term ?? terms[0]}`);
        out.log(`state: ${data.job?.state ?? ""}`);
        out.log(`rows: ${data.job?.rows ?? data.listing_count ?? 0}`);
        out.log(`total_results: ${data.job?.total_results ?? ""}`);
        for (const row of data.listings || []) {
          out.log(`${row.page}:${row.position} ${row.listing_id} ${row.title || ""}`);
        }
      }
      return 0;
    }

    if (parsed.command === "health") {
      const data = await client.health();
      if (data?.ok === false) {
        out.error(data.error || "health_failed");
        return 1;
      }
      printJson(data, out);
      return 0;
    }

    if (parsed.command === "requeue") {
      const data = await client.requeueExpired();
      if (data?.ok === false) {
        out.error(data.error || "requeue_failed");
        return 1;
      }
      if (parsed.flags.json) printJson(data, out);
      else out.log(`requeued: ${data.requeued ?? 0} failed: ${data.failed ?? 0}`);
      return 0;
    }

    out.error(CLI_HELP.trimEnd());
    return 2;
  } catch (error) {
    out.error(error?.message || "command_failed");
    return 1;
  }
}

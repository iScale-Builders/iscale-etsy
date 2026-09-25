# Etsy worker runbook

Worker mode lets a chat agent run the extension's research commands and read
the results back, without anyone clicking inside the extension. The queue is a
command channel: each job has a `type` and params, and one visible lane runs
it. Local-only use is unchanged when worker mode is off. The browser stays
headed and visible.

There is no project URL or key in this repository. You create the backend and
paste its publishable key into the options page and into your shell.

## What you deploy

1. Create a Postgres database. Supabase is the shape these RPCs target
   (PostgREST plus optional Realtime). Any Postgres that can expose the
   `public.etsy_worker_*` functions over HTTP will also work with the CLI if
   you put a compatible `/rest/v1/rpc` endpoint in `ETSY_WORKER_URL`.
2. Read the preflight, then apply the three migrations. Do not commit the
   project URL or keys. The second file is the command channel (`type`,
   params, and payload snapshots). The third file is authorization: it
   revokes the public RPCs from `anon` and `public`, grants them only to
   `authenticated`, and requires a row in `etsy_worker.operators`.

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/preflight-etsy-worker.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/apply-etsy-worker.sql
   ```

   ```powershell
   psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/preflight-etsy-worker.sql
   psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/apply-etsy-worker.sql
   ```

   The apply script runs
   [supabase/migrations/20260925120000_etsy_worker.sql](../supabase/migrations/20260925120000_etsy_worker.sql),
   then [supabase/migrations/20260925140000_etsy_worker_commands.sql](../supabase/migrations/20260925140000_etsy_worker_commands.sql),
   then [supabase/migrations/20260925160000_etsy_worker_auth.sql](../supabase/migrations/20260925160000_etsy_worker_auth.sql).
   Each file is one transaction. Running the apply script again after that
   is a no-op. The SQL editor does not accept the apply script's `\ir`
   lines; paste the three migration files there, in that order. Do not
   re-run the first or second file after the third has created
   `etsy_worker.operators`; those two files abort if that table exists.
   The third file is safe to run again.
3. If you are on Supabase, the first migration adds `etsy_worker.jobs` to the
   `supabase_realtime` publication when that publication exists. That lets an
   idle lane wake as soon as a term is inserted. Polling still picks the term
   up within about two minutes when Realtime is unavailable.
4. The operators table is the access gate. This project can keep public
   signups enabled, because other apps share the same Auth project. A user
   who can sign up still cannot call these RPCs until they have an operator
   row. Create one Auth user per lane and one more user for the agents that
   enqueue work. In the SQL editor, insert an operator row for each user
   (replace the UUIDs with the ids from Authentication → Users). `lane_name`
   is required for a lane and must be null for an agent or admin:

   ```sql
   insert into etsy_worker.operators (user_id, role, lane_name) values
     ('<lane-user-uuid>', 'lane', 'lane-1'),
     ('<agent-user-uuid>', 'agent', null);
   ```

   `lane` can claim, heartbeat, upload, complete, and fail, and only for the
   `lane_name` on that row. `agent` can enqueue, add terms, search now, and
   read results and health. `admin` can do both and is not tied to one lane.
   A user with no operator row cannot call the RPCs. The options-page Health
   button calls `etsy_worker_lane_whoami`, which a lane user can run. The
   CLI `health` command calls `etsy_worker_health` and needs an agent or
   admin.
5. Copy the project URL (`https://YOUR_PROJECT.supabase.co`) and the
   publishable key (`sb_publishable_...`) or the legacy anon JWT. That value
   is the `apikey` header only. It is not a bearer token. Do not paste a
   `service_role` JWT or an `sb_secret_` key into the extension or the CLI;
   both reject those. The bearer token is the access token from an email and
   password sign-in.

## Extension options

On each machine that will scrape:

1. Load this folder as an unpacked extension (`chrome://extensions`, Developer
   mode, Load unpacked). Use a normal Chrome window. Do not use a headless
   browser.
2. Open the extension options (Worker options on the dashboard, or the
   extension's Options page).
3. Set the backend URL, the publishable or anon key, the lane email and
   password, and a lane name unique to that window (`lane-1`, `lane-2`, …).
   The password is sent once to sign in and is not stored. The access token
   and the refresh token stay in `chrome.storage.session`, with
   `setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })`. Content scripts
   cannot read that store. They can read `chrome.storage.local`, so the
   tokens are not kept there. Closing Chrome clears the session; open the
   options page and save the password again to sign in. The hourly job
   counter stays in `chrome.storage.local` under `etsyWorkerClaimTimes` and
   survives a restart. The publishable key in extension settings is redacted
   before a content script can read settings.
4. Leave the defaults unless you need to change them: poll 20 seconds, claim
   lease 180 seconds, 4–9 seconds between results pages, 20–60 seconds
   between jobs, 30 jobs per hour, a heartbeat every 30 seconds, 40–140 ms
   between keystrokes, 30 minutes of backoff after a captcha. Realtime wake
   is on.
5. Enable worker mode and save. Chrome asks for permission to call that
   backend origin. Grant it. Saving with a password signs that lane user in.
6. Leave the Chrome window open and visible. The lane focuses that window
   when it starts a search.

Repeat in more Chrome profiles for more lanes. One lane per profile, each
with its own lane name. Do not also press Run all in a profile that is
working a lane; the lane waits while a local batch is running so the two do
not share a scrape.

## What a lane does

1. Claim the oldest pending job with the highest priority, whatever its type.
   Claiming sets a lease. A heartbeat and every upload renew it.
2. Run that type in the visible Etsy tab when the command needs Etsy.
   `export` and `collection-stats` only read this browser's local collection.
3. Upload rows as each page or listing finishes, then mark the job completed.
   A captcha or block marks it `blocked` and the lane pauses for the backoff
   interval instead of starting another Etsy command.

A `search` job still opens `https://www.etsy.com/`, focuses the search box,
types the term, and presses Search. The service worker console and
`chrome.storage.session` key `etsyWorkerLane` record
`search path: search_box`. If the box is not there, the lane opens the search
URL and logs `search path: url_navigation`. It reads the total result count,
uploads that page, then follows the next-page link (`pagination_click`) or
the search URL.

`scrape-listings` and `scrape-shop` use the same visible tab. Between shop
pages and between listing visits the lane waits the configured pace (default
4–9 seconds). A captcha stops the job immediately. Pages already uploaded
stay readable.

## Feature and job-type map

| Extension feature | Job type | What the lane returns |
| --- | --- | --- |
| Search queue and search-results capture (keyword, page, position, price, rating, badges, ads) | `search` | Listing cards plus Etsy's total result count. `add-terms` and `search-now` are this type. |
| Batch visit of listing URLs (the same listing extract the local Run uses, including demand, reviews, and digital/physical) | `scrape-listings` | One card row per listing, plus a `listing` payload with the full extract. Up to 40 URLs. One open job per set of listing ids. |
| Etsy shop pages (`etsy.com/shop/Name`) | `scrape-shop` | Listing cards from up to 10 shop pages. `--visit` also opens up to 15 of those listings and uploads full extracts. One open job per shop. |
| Shop View filter, sort, and demand chips | `export` with `source=shop` | The same query as Shop View (`q`, `demand`, `chip`, `sort`, `dir`), as CSV or JSON. |
| Dashboard / Shop View CSV export of collected listings | `export` with `source=listings` | CSV or JSON of the local listings store. |
| Export search CSV | `export` with `source=search` | CSV or JSON of captured search results. |
| Collection counts (collected, digital, with demand, search-result rows) | `collection-stats` | A small JSON snapshot. No Etsy navigation. |

`export` and `collection-stats` describe the Chrome profile that is running
the lane, not every previous backend upload. Each export is its own job.
Results are capped at 500 rows; `truncated` is true when the local store had
more. Search-results capture also runs as a side effect of `search` and
`scrape-shop`, into that profile's local store.

## Features left on the machine

These stay local. A queued command cannot do them.

| Feature | Why it is not a job |
| --- | --- |
| Popup vs side panel, collapse, live-feed clear, confirm dialogs, badge, version | Presentation only. Clearing the feed does not delete collected rows. |
| Worker options and other settings | A remote job must not change the backend key, lane name, or pace. |
| Pause, stop, and resume of the local runner | That would interrupt a person using the same profile. The lane already waits while a local batch is running. |
| Auto-run interval, randomize, between-terms pause, auto CSV download, clear-after-export, download subfolder | Local runner schedule, not a remote command. |
| Retry failed, remove URL, remaining URLs | Maintenance for the hidden local runner. |
| Add to the local term pills | The remote equivalent is a `search` job on the visible lane. |
| Open Shop View | Opens a local page. The data is `export` with `source=shop`. |
| Import CSV | The file is on the person's computer. Accepting CSV text from the queue would write untrusted rows into the local store. |
| Clear collection, clear listings, clear terms | Destructive, and not reversible from the queue. |
| Image download | Writes a file on the lane machine. It is not a result an agent can read back. |
| Manual first-review toggle | A preference for passive browsing. `scrape-listings` already uses the full listing extract, including review dates. |

An idle lane checks the queue on the poll interval. Chrome may not wake a
sleeping extension faster than every 30 seconds. That is still inside the
two-minute budget for a newly added term. Realtime, when the publication is
active, wakes the lane sooner. The first batch of rows is the first results
page, not the finished scan.

## Agent commands

```bash
export ETSY_WORKER_URL="https://YOUR_PROJECT.supabase.co"
export ETSY_WORKER_ANON_KEY="your-publishable-or-anon-key"
export ETSY_WORKER_EMAIL="agent@example.com"
export ETSY_WORKER_PASSWORD="the-agent-password"

node scripts/etsy-worker.mjs add-terms "linen apron" --priority 10 --pages 2
node scripts/etsy-worker.mjs search-now "rush term" --pages 1
node scripts/etsy-worker.mjs scrape-listings --url "https://www.etsy.com/listing/1234567890"
node scripts/etsy-worker.mjs scrape-shop --shop CoolShop --pages 1
node scripts/etsy-worker.mjs export --source shop --format csv --q "apron" --chip in_carts
node scripts/etsy-worker.mjs stats
node scripts/etsy-worker.mjs status --term "linen apron"
node scripts/etsy-worker.mjs status --shop CoolShop
node scripts/etsy-worker.mjs results --job "<uuid>" --json
node scripts/etsy-worker.mjs health
node scripts/etsy-worker.mjs requeue
```

PowerShell:

```powershell
$env:ETSY_WORKER_URL = "https://YOUR_PROJECT.supabase.co"
$env:ETSY_WORKER_ANON_KEY = "your-publishable-or-anon-key"
$env:ETSY_WORKER_EMAIL = "agent@example.com"
$env:ETSY_WORKER_PASSWORD = "the-agent-password"

node scripts/etsy-worker.mjs add-terms "linen apron" --priority 10 --pages 2
node scripts/etsy-worker.mjs search-now "rush term" --pages 1
node scripts/etsy-worker.mjs scrape-listings --url "https://www.etsy.com/listing/1234567890"
node scripts/etsy-worker.mjs scrape-shop --shop CoolShop --pages 1
node scripts/etsy-worker.mjs export --source shop --format csv --q "apron" --chip in_carts
node scripts/etsy-worker.mjs stats
node scripts/etsy-worker.mjs status --term "linen apron"
node scripts/etsy-worker.mjs status --shop CoolShop
node scripts/etsy-worker.mjs results --job "<uuid>" --json
node scripts/etsy-worker.mjs health
node scripts/etsy-worker.mjs requeue
```

`ETSY_WORKER_ANON_KEY` is the publishable key or the legacy anon JWT. The CLI
sends it as `apikey` and signs in with the email and password
(`POST /auth/v1/token?grant_type=password`). It refreshes the access token
before expiry. The refresh token is cached outside the repo at
`~/.config/iscale-etsy/worker-token.json` (mode `0600`). Override that path
with `ETSY_WORKER_TOKEN_CACHE` set to an absolute path that is not inside
this checkout (`$env:ETSY_WORKER_TOKEN_CACHE` in PowerShell). A
`service_role` JWT or an `sb_secret_` key is rejected before any request.

`enqueue --type <type>` accepts the same flags as the matching command.

`status --term` prints the type, job state, the lane that claimed it, pages
done, rows landed, the total result count, and the last error. `status --job`
and `status --shop` use the same lines. `results --json` prints listing rows
and any payload snapshots, including pages already uploaded while the job is
still `processing`. `results --term` is the search shortcut. Listing and
export jobs are read with `results --job`. Shop jobs also accept
`results --shop`.

`search-now` inserts the term at a priority above every other open job so the
next claim takes it. It does not cancel a search a lane is already typing.

Higher `--priority` is claimed first. Adding a term that is already pending
raises its priority and page count instead of creating a second open job.

## Health and stuck jobs

`health` shows counts by status, how many processing jobs have an expired
lease, and each lane's last heartbeat. A lane appears in that list only after
its first claim, including an idle claim that finds no job. A lane is `stale`
when its heartbeat is older than 90 seconds.

A lane that dies mid-search leaves the job `processing` until the lease
expires (default 180 seconds, renewed while the lane is uploading). The next
claim, or `requeue`, moves that job back to `pending` if attempts remain
(default 3). After the last attempt it is `failed` with `last_error`
`lease_expired` and is not picked up again. Calling `requeue` twice is safe.

`blocked` jobs are captchas or other stops. They are not returned to the
queue. Add the term again after the block has cleared if you want another
try. The lane itself waits out the captcha backoff before it claims anything
else.

Inspect the live lane without the database: in DevTools on the extension's
service worker, `chrome.storage.session` key `etsyWorkerLane` has the term,
page, search path, rows uploaded, total result count, and last error. The
console line is `[etsy-worker] search path: ...`.

## End-to-end smoke test

The commands below need a real backend and a visible Chrome window. They are
not part of CI. `npm test` does not download Chrome. The unpacked-extension
check is opt-in: `npm run test:e2e` sets `ETSY_E2E_CHROME=1` and runs
`tests/extension-smoke.test.js` in Chrome for Testing against a static
fixture page. It checks that the content script answers `worker.detectBlock`
and `search.scrollAndExtract`. Branded Chrome 137 and later ignores
`--load-extension`, so that test uses Chrome for Testing.

1. Run the preflight and apply commands above. Create the lane user and the
   agent user, and insert their `etsy_worker.operators` rows, including
   `lane_name` for the lane. In the
   extension options, set the backend URL, the publishable or anon key, the
   lane email and password, and the lane name, then enable worker mode and
   save. That save signs the lane in. Leave the window visible. In the shell,
   export `ETSY_WORKER_URL`, `ETSY_WORKER_ANON_KEY`, `ETSY_WORKER_EMAIL`, and
   `ETSY_WORKER_PASSWORD` (PowerShell: `$env:ETSY_WORKER_URL` and the same
   names). The first CLI command signs the agent in. `health` lists the lane
   only after that lane's first claim, so confirm the lane with:

   ```bash
   node scripts/etsy-worker.mjs health
   ```

   ```powershell
   node scripts/etsy-worker.mjs health
   ```

2. Enqueue a small search:

   ```bash
   node scripts/etsy-worker.mjs add-terms "linen cross back apron" --priority 50 --pages 1
   ```

   ```powershell
   node scripts/etsy-worker.mjs add-terms "linen cross back apron" --priority 50 --pages 1
   ```

3. Within about two minutes on an idle lane, status shows `state: processing`
   (then `completed`) and `lane:` set to that window's lane name. The Chrome
   window comes forward. The service worker log says `search path: search_box`
   when the search box was used.

   ```bash
   node scripts/etsy-worker.mjs status --term "linen cross back apron"
   ```

   ```powershell
   node scripts/etsy-worker.mjs status --term "linen cross back apron"
   ```

4. Results return `total_results` and a `listings` array. Rows from page 1
   are present as soon as that page finishes, before a multi-page job is
   `completed`.

   ```bash
   node scripts/etsy-worker.mjs results --term "linen cross back apron" --json
   ```

   ```powershell
   node scripts/etsy-worker.mjs results --term "linen cross back apron" --json
   ```

5. Optional immediate pickup while the lane is idle:

   ```bash
   node scripts/etsy-worker.mjs search-now "wool dryer balls" --pages 1
   ```

   ```powershell
   node scripts/etsy-worker.mjs search-now "wool dryer balls" --pages 1
   ```

   The next claim should be that term.

6. Optional command-channel checks on the same lane:

   ```bash
   node scripts/etsy-worker.mjs stats
   node scripts/etsy-worker.mjs export --source listings --format json
   node scripts/etsy-worker.mjs scrape-shop --shop SomeShopName --pages 1
   node scripts/etsy-worker.mjs results --job "<uuid>" --json
   ```

   ```powershell
   node scripts/etsy-worker.mjs stats
   node scripts/etsy-worker.mjs export --source listings --format json
   node scripts/etsy-worker.mjs scrape-shop --shop SomeShopName --pages 1
   node scripts/etsy-worker.mjs results --job "<uuid>" --json
   ```

   `stats` and `export` do not open Etsy. `results --job <id> --json` returns
   the payload. `scrape-shop` should bring the window forward and stop if a
   captcha appears (`state: blocked`).

If status stays `pending` past two minutes, check that worker mode is enabled,
the options save granted host permission, the lane name is set, and the
window was not closed. `health` shows whether the lane's heartbeat is fresh.

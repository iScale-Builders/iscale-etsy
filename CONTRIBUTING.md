# Contributing

Thanks for helping improve iScale Etsy. The project is open
source, but it is maintainer-led: contributions are welcome when they fit the
product direction, quality bar, license obligations, and public-repo safety
rules.

## Project Goals

- Keep the public edition local-first.
- Keep setup simple for non-technical users.
- Keep scraping behavior conservative by default.
- Keep private infrastructure and credentials out of the public package.
- Make CSV import/export and the Shop View genuinely useful.

## Before You Start

Open an issue before starting work when the change is large, changes product
direction, changes the extension's permissions or data handling, affects
scraping pace, affects licensing/branding, or adds a dependency.

Small fixes can go straight to a pull request.

## Contribution Terms

By contributing, you confirm that:

- you have the right to submit the contribution;
- your contribution is submitted under this repository's license (MIT);
- your contribution does not include secrets, private data, or code copied
  from a source that cannot be redistributed here;
- you understand that maintainers may edit, reject, or close contributions
  that do not fit the project.

We use Developer Certificate of Origin style sign-off. Please sign commits
with:

```bash
git commit -s -m "Describe the change"
```

## Development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm test
npm run lint
```

Load the extension folder from `chrome://extensions` with Developer mode
enabled (Load unpacked).

## Required Checks

Before opening a pull request, run:

```bash
npm test
npm run lint
```

If shipped files changed, bump the version in **both** `manifest.json` and
`package.json` (CI fails if they differ) and add a `CHANGELOG.md` entry. Do not
claim a check passed unless it actually did.

## Product Standards

- Keep the extension local-first, with no backend.
- Do not add accounts, third-party authentication, a remote backend,
  telemetry, ingest, or new permissions.
- Keep user data local unless the user explicitly exports it.
- Keep the default scraping pace conservative.
- Do not present mock or fake data as real.

## Safety Rules

Do not commit:

- `.env` files, tokens, credentials, or real secrets;
- local runtime state, logs, or machine-specific config;
- `AGENTS.md`, `CLAUDE.md`, `ROUTER.md`, `memory/`, `tasks/`, or private
  workspace/agent bridge files;
- private planning docs, production data, screenshots with private data, or
  internal operating process.

## License And Attribution

This project is distributed under the MIT License. iScaleLabs names, logos,
icons, and brand assets are not licensed for reuse just because the code is
public. See `NOTICE.md` and `TRADEMARKS.md`.

## Good First Areas

- Shop View sorting and column controls.
- Selected-row export.
- Safer resume behavior for interrupted jobs.
- Better CSV schema compatibility.
- Documentation screenshots and short tutorial assets.

## Reporting Bugs And Security Issues

Use GitHub issues for normal bugs and feature requests.

Report security issues privately by following `SECURITY.md`.

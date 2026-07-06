## Summary

<!-- What changed? Keep this concise. -->

## Why

<!-- What problem does this solve? Link the issue if one exists. -->

## Screenshots / Video

<!-- Required for UI changes. Remove if not applicable. -->

## Verification

<!-- Check only what you actually ran. -->

- [ ] `npm test`
- [ ] `npm run lint`
- [ ] Bumped `manifest.json` + `package.json` versions together and added a
      `CHANGELOG.md` entry, if shipped files changed

## Safety Checklist

- [ ] No secrets, `.env` files, private data, or local runtime state
- [ ] No private workspace/agent bridge files (`AGENTS.md`, `memory/`, `tasks/`, etc.)
- [ ] No mock data presented as real
- [ ] No new permissions, network egress, or telemetry (this extension stays local-first)
- [ ] Signed off with `git commit -s` (DCO)
- [ ] iScaleLabs brand rules respected (`TRADEMARKS.md`)

## Notes For Maintainers

<!-- Risks, follow-ups, or review areas. -->

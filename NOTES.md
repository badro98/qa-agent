# qa-agent Notes

## Current Status
Re-run on failure shipped and deployed (2026-04-09). Agent now auto-retries failing tests once in-process (scoped to failing files/specs), and if failures persist, the PR comment includes a pre-filled JSON block for triggering the `qa-rerun.yml` workflow with only the failing tests. Fully deployed to both pointd.fyi and BIP. No known bugs.

## Known Bugs
_(none)_

## In Progress
_(nothing — pick from Up Next)_

## Up Next
- [ ] Scope vitest scoping in PR mode by file (currently runs full unit path) — `buildScopedVitestCmd` in `5-test-execution.js` has a TODO comment
- [ ] Test the full pipeline end-to-end on a real pointd.fyi PR with failures
- [ ] Add `@smoke` tagging guidance to both project READMEs so Playwright scoping works
- [ ] Consider caching Playwright browsers in CI to speed up runs

## GitHub Issues
_(none open)_

## Session Log
- 2026-04-09 — Designed and shipped re-run on failure: in-process retry logic with failure extraction helpers (7 unit tests), `MODE=rerun` path in index.js, re-run instructions block in PR comment, and `qa-rerun.yml` workflow. Deployed to both pointd.fyi and BIP. Also fixed PROJECT_ROOT resolution bug across config.js, coverage-gap, and test-execution.

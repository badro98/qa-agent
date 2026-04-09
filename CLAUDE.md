# qa-agent

Config-driven QA agent that runs on every PR and on-demand regression. Analyzes diffs, scores risk, identifies coverage gaps, proposes tests, executes existing tests, and posts a structured report as a PR comment + GitHub issue.

**Targets:** pointd.fyi and BIP — same agent, different `qa-agent.config.json` per repo.

## Commands

```bash
node src/index.js   # Run locally (requires env vars set)
```

Normally triggered via GitHub Actions, not run directly.

## Stack

- Node.js, ESM (`"type": "module"`), no external dependencies
- Anthropic API (`claude-sonnet-4-20250514`) via native `fetch`
- GitHub API via native `fetch`

## Pipeline (6 steps)

| Step | File | What it does |
|------|------|--------------|
| 1 | `src/steps/1-diff-analysis.js` | Fetch PR diff → change map |
| 2 | `src/steps/2-risk-scoring.js` | Score each surface by risk |
| 3 | `src/steps/3-coverage-gap.js` | Cross-ref change map vs existing tests |
| 4 | `src/steps/4-test-proposals.js` | Generate proposed test cases per gap |
| 5 | `src/steps/5-test-execution.js` | Run scoped Vitest + Playwright |
| 6 | `src/steps/6-synthesis.js` | Combine into final report |

System prompts live in `prompts/*.md` — edit prompts there, not in JS files.

## Modes

- `pr` — triggered on PR open/update, scoped diff analysis, `@smoke` Playwright only
- `regression` — manual trigger, full Vitest + Playwright suite

## Required env vars

```
ANTHROPIC_API_KEY   # Anthropic API key (GitHub secret)
GITHUB_TOKEN        # Auto-provided by GitHub Actions
PR_NUMBER           # PR number (pr mode only)
REPO                # e.g. badro98/BIP
MODE                # pr | regression
```

## Config schema (`qa-agent.config.json`)

Each target repo gets its own copy at root. Key fields:
- `critical_flows` — flows that must be covered
- `high_risk_surfaces` — surface types that auto-score as high risk
- `test_paths.unit` / `test_paths.e2e` — where tests live
- `test_output_mode: "propose"` — agent drafts, you promote (never auto-commits)

## Key gotchas

- Test proposals are always propose-only — agent never auto-commits test files
- Tag Playwright smoke tests with `@smoke` in the test name for scoped PR runs
- In PR mode, only `@smoke` Playwright tests run to keep CI under 3 min
- All Claude calls cap output via `maxTokens` per step — see each step file

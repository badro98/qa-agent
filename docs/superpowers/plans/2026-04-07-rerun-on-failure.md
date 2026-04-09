# Re-run on Failure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the QA agent reports test failures, automatically retry once in-process (to catch flakiness), and if failures persist, post a PR comment with a one-click re-run workflow trigger so you can re-run only the failing tests.

**Architecture:** Two layers — (1) in-process retry in `5-test-execution.js` re-runs only the failed test files/specs before surfacing results; (2) a new `MODE=rerun` path in `index.js` that skips steps 1–4 and runs only the tests specified in a `FAILED_TESTS` env var. The PR comment gains a re-run instructions block when failures remain after retries. A new `qa-rerun.yml` workflow exposes this as a manual dispatch.

**Tech Stack:** Node.js ESM, `execSync`, GitHub Actions `workflow_dispatch`, existing Vitest JSON and Playwright JSON reporter output shapes.

---

## File Map

| File | Change |
|------|--------|
| `qa-agent.config.json` | Add `"test_retry_count": 1` |
| `src/steps/5-test-execution.js` | Add retry loop, failure extraction, rerun-scoped commands |
| `src/index.js` | Add `MODE=rerun` early-exit path |
| `src/output/pr-comment.js` | Add re-run instructions block when failures remain |
| `.github/workflows/qa-rerun.yml` | New workflow for targeted re-runs |

---

## Task 1: Add `test_retry_count` to config

**Files:**
- Modify: `qa-agent.config.json`

- [ ] **Step 1: Add the field**

Open `qa-agent.config.json` and add `"test_retry_count": 1` after `"test_output_mode"`:

```json
{
  "project": "pointd.fyi",
  "platform": ["web"],
  "test_runners": {
    "unit": "vitest",
    "e2e": "playwright"
  },
  "test_paths": {
    "unit": "./src/__tests__",
    "e2e": "./tests/e2e"
  },
  "critical_flows": [
    "award search",
    "program comparison",
    "trip save",
    "airport pill detection"
  ],
  "high_risk_surfaces": [
    "auth",
    "api_calls",
    "state_mutations",
    "zustand_store",
    "supabase_queries"
  ],
  "performance_thresholds": {},
  "test_output_mode": "propose",
  "test_retry_count": 1,
  "mobile": false
}
```

- [ ] **Step 2: Commit**

```bash
git add qa-agent.config.json
git commit -m "config: add test_retry_count field (default 1)"
```

---

## Task 2: Extract failure lists from test output

**Files:**
- Modify: `src/steps/5-test-execution.js`

This is the core change. We need two helpers that parse vitest/playwright JSON output and return structured failure lists — not just error strings, but actual file paths and test names that can be used to scope a re-run command.

- [ ] **Step 1: Write tests for the extraction helpers**

Create `src/steps/__tests__/test-execution.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { extractVitestFailures, extractPlaywrightFailures } from '../5-test-execution.js';

describe('extractVitestFailures', () => {
  it('returns empty array when output is null', () => {
    expect(extractVitestFailures(null)).toEqual([]);
  });

  it('returns empty array when output has error field', () => {
    expect(extractVitestFailures({ error: 'timeout' })).toEqual([]);
  });

  it('returns empty array when all tests pass', () => {
    const output = {
      testResults: [{
        testFilePath: '/app/src/__tests__/foo.test.js',
        assertionResults: [{ status: 'passed', ancestorTitles: ['suite'], title: 'passes' }]
      }]
    };
    expect(extractVitestFailures(output)).toEqual([]);
  });

  it('extracts failing test file paths', () => {
    const output = {
      testResults: [{
        testFilePath: '/app/src/__tests__/auth.test.js',
        assertionResults: [
          { status: 'failed', ancestorTitles: ['AuthStore'], title: 'logs in user' },
          { status: 'passed', ancestorTitles: ['AuthStore'], title: 'logs out user' }
        ]
      }]
    };
    const result = extractVitestFailures(output);
    expect(result).toEqual([{ file: '/app/src/__tests__/auth.test.js', tests: ['AuthStore > logs in user'] }]);
  });
});

describe('extractPlaywrightFailures', () => {
  it('returns empty array when output is null', () => {
    expect(extractPlaywrightFailures(null)).toEqual([]);
  });

  it('returns empty array when output has error field', () => {
    expect(extractPlaywrightFailures({ error: 'timeout' })).toEqual([]);
  });

  it('extracts failing spec titles and files', () => {
    const output = {
      suites: [{
        file: 'tests/e2e/login.spec.ts',
        specs: [{
          title: 'user can log in',
          tests: [{ results: [{ status: 'failed' }] }]
        }, {
          title: 'user can log out',
          tests: [{ results: [{ status: 'passed' }] }]
        }],
        suites: []
      }]
    };
    const result = extractPlaywrightFailures(output);
    expect(result).toEqual([{ file: 'tests/e2e/login.spec.ts', test: 'user can log in' }]);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/osamabadr/Desktop/qa-agent
npx vitest run src/steps/__tests__/test-execution.test.js --reporter=verbose
```

Expected: FAIL — `extractVitestFailures` and `extractPlaywrightFailures` are not yet exported.

- [ ] **Step 3: Add the extraction helpers to `5-test-execution.js`**

Replace the full contents of `src/steps/5-test-execution.js`:

```js
import { execSync } from 'child_process';

export async function executeTests({ changeMap, mode, failedTests, config }) {
  const results = { vitest: null, playwright: null, failures: { vitest: [], playwright: [] } };
  const cwd = process.env.PROJECT_ROOT || process.cwd();
  const maxRetries = config.test_retry_count ?? 0;

  // --- Vitest ---
  let vitestCmd = buildVitestCmd(mode, changeMap, failedTests, config);
  let vitestAttempts = 0;

  while (vitestAttempts <= maxRetries) {
    try {
      const out = execSync(vitestCmd, { encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'], cwd });
      results.vitest = JSON.parse(out);
      results.failures.vitest = []; // all passed
      break;
    } catch (err) {
      const parsed = tryParseJson(err.stdout);
      results.vitest = parsed || { error: err.stdout || err.stderr || err.message };
      results.failures.vitest = parsed ? extractVitestFailures(parsed) : [];

      if (vitestAttempts < maxRetries && results.failures.vitest.length > 0) {
        console.log(`Vitest: ${results.failures.vitest.length} failure(s). Retrying (attempt ${vitestAttempts + 2}/${maxRetries + 1})...`);
        // Scope next attempt to only failing files
        const failingFiles = results.failures.vitest.map(f => f.file).join(' ');
        vitestCmd = `npx vitest run ${failingFiles} --reporter=json`;
      } else {
        break;
      }
    }
    vitestAttempts++;
  }

  // --- Playwright ---
  let playwrightCmd = buildPlaywrightCmd(mode, changeMap, failedTests);
  let playwrightAttempts = 0;

  while (playwrightAttempts <= maxRetries) {
    try {
      const out = execSync(playwrightCmd, { encoding: 'utf8', timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'], cwd });
      results.playwright = JSON.parse(out);
      results.failures.playwright = [];
      break;
    } catch (err) {
      const parsed = tryParseJson(err.stdout);
      results.playwright = parsed || { error: err.stdout || err.stderr || err.message };
      results.failures.playwright = parsed ? extractPlaywrightFailures(parsed) : [];

      if (playwrightAttempts < maxRetries && results.failures.playwright.length > 0) {
        console.log(`Playwright: ${results.failures.playwright.length} failure(s). Retrying (attempt ${playwrightAttempts + 2}/${maxRetries + 1})...`);
        // Scope retry to failing specs by grep on title
        const grepPattern = results.failures.playwright.map(f => f.test).join('|');
        playwrightCmd = `npx playwright test --reporter=json --grep "${grepPattern}"`;
      } else {
        break;
      }
    }
    playwrightAttempts++;
  }

  return results;
}

// --- Command builders ---

function buildVitestCmd(mode, changeMap, failedTests, config) {
  if (mode === 'rerun' && failedTests?.vitest?.length > 0) {
    return `npx vitest run ${failedTests.vitest.join(' ')} --reporter=json`;
  }
  if (mode === 'regression') return 'npx vitest run --reporter=json';
  const unitPath = config.test_paths.unit;
  return `npx vitest run ${unitPath} --reporter=json`;
}

function buildPlaywrightCmd(mode, changeMap, failedTests) {
  if (mode === 'rerun' && failedTests?.playwright?.length > 0) {
    return `npx playwright test --reporter=json --grep "${failedTests.playwright.join('|')}"`;
  }
  if (mode === 'regression') return 'npx playwright test --reporter=json';
  return 'npx playwright test --grep @smoke --reporter=json';
}

// --- Failure extraction (also exported for tests) ---

export function extractVitestFailures(vitestOutput) {
  if (!vitestOutput || vitestOutput.error) return [];
  const failures = [];
  for (const result of vitestOutput.testResults || []) {
    const failedTests = (result.assertionResults || [])
      .filter(a => a.status === 'failed')
      .map(a => [...(a.ancestorTitles || []), a.title].join(' > '));
    if (failedTests.length > 0) {
      failures.push({ file: result.testFilePath, tests: failedTests });
    }
  }
  return failures;
}

export function extractPlaywrightFailures(playwrightOutput) {
  if (!playwrightOutput || playwrightOutput.error) return [];
  const failures = [];

  function walkSuites(suites, inheritedFile) {
    for (const suite of suites || []) {
      const file = suite.file || inheritedFile;
      for (const spec of suite.specs || []) {
        const failed = (spec.tests || []).some(t => (t.results || []).some(r => r.status === 'failed'));
        if (failed) failures.push({ file, test: spec.title });
      }
      walkSuites(suite.suites, file);
    }
  }

  walkSuites(playwrightOutput.suites, null);
  return failures;
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/steps/__tests__/test-execution.test.js --reporter=verbose
```

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/steps/5-test-execution.js src/steps/__tests__/test-execution.test.js
git commit -m "feat: add retry logic and failure extraction to test execution"
```

---

## Task 3: Add `MODE=rerun` path to `index.js`

**Files:**
- Modify: `src/index.js`

In rerun mode, skip steps 1–4. Just re-execute the failing tests and post an updated PR comment.

- [ ] **Step 1: Replace `src/index.js`**

```js
import { loadConfig } from './utils/config.js';
import { analyzeDiff } from './steps/1-diff-analysis.js';
import { scoreRisk } from './steps/2-risk-scoring.js';
import { analyzeCoverage } from './steps/3-coverage-gap.js';
import { proposeTests } from './steps/4-test-proposals.js';
import { executeTests } from './steps/5-test-execution.js';
import { synthesize } from './steps/6-synthesis.js';
import { postPRComment } from './output/pr-comment.js';
import { openGitHubIssue } from './output/github-issue.js';

const MODE = process.env.MODE; // 'pr', 'regression', or 'rerun'
const PR_NUMBER = process.env.PR_NUMBER;
const REPO = process.env.REPO;

async function run() {
  console.log(`Running QA Agent in ${MODE} mode...`);
  const config = loadConfig();

  // Rerun mode: skip analysis steps, re-execute only the specified failing tests
  if (MODE === 'rerun') {
    let failedTests = { vitest: [], playwright: [] };
    try {
      failedTests = JSON.parse(process.env.FAILED_TESTS || '{}');
    } catch {
      console.error('FAILED_TESTS env var is not valid JSON. Running full suite fallback.');
    }

    const testResults = await executeTests({ changeMap: null, mode: 'rerun', failedTests, config });

    const report = await synthesize({
      changeMap: null,
      riskScores: null,
      coverageGaps: null,
      testProposals: null,
      testResults,
      mode: 'rerun',
      config
    });

    if (PR_NUMBER) {
      await postPRComment({ report, prNumber: PR_NUMBER, repo: REPO });
    }

    console.log(`QA Agent re-run complete. Verdict: ${report.verdict}`);
    return;
  }

  // Step 1: Analyze the diff (PR mode) or skip (regression runs full suite)
  const changeMap = MODE === 'pr'
    ? await analyzeDiff({ prNumber: PR_NUMBER, repo: REPO, config })
    : null;

  // Step 2: Score risk of changed surfaces
  const riskScores = changeMap
    ? await scoreRisk({ changeMap, config })
    : null;

  // Step 3: Identify coverage gaps
  const coverageGaps = changeMap
    ? await analyzeCoverage({ changeMap, config })
    : null;

  // Step 4: Propose new test cases for gaps
  const testProposals = coverageGaps
    ? await proposeTests({ coverageGaps, changeMap, config })
    : null;

  // Step 5: Execute existing tests (scoped in PR mode, full suite in regression)
  const testResults = await executeTests({ changeMap, mode: MODE, failedTests: null, config });

  // Step 6: Synthesize everything into a report
  const report = await synthesize({
    changeMap,
    riskScores,
    coverageGaps,
    testProposals,
    testResults,
    mode: MODE,
    config
  });

  // Output
  if (PR_NUMBER) {
    await postPRComment({ report, prNumber: PR_NUMBER, repo: REPO });
  }

  const needsIssue =
    report.verdict === 'fail' ||
    report.verdict === 'warn' ||
    (coverageGaps && coverageGaps.length > 0);

  if (needsIssue) {
    await openGitHubIssue({ report, repo: REPO, prNumber: PR_NUMBER });
  }

  console.log(`QA Agent complete. Verdict: ${report.verdict}`);
}

run().catch(err => {
  console.error('QA Agent failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add src/index.js
git commit -m "feat: add MODE=rerun path that skips analysis and re-executes failing tests only"
```

---

## Task 4: Add re-run instructions to the PR comment

**Files:**
- Modify: `src/output/pr-comment.js`

When failures remain after retries, the PR comment should include a block telling you exactly what to paste into the re-run workflow dispatch.

- [ ] **Step 1: Replace `src/output/pr-comment.js`**

```js
import { postComment } from '../utils/github.js';

const VERDICT_EMOJI = { pass: '✅', warn: '⚠️', fail: '❌' };

export async function postPRComment({ report, prNumber, repo }) {
  const emoji = VERDICT_EMOJI[report.verdict];

  let body = `## ${emoji} QA Agent Report — ${report.verdict.toUpperCase()}\n\n`;
  body += `${report.summary}\n\n`;

  body += `### Test Results\n`;
  body += `| Suite | Passed | Failed |\n|---|---|---|\n`;
  body += `| Vitest | ${report.test_results_summary.vitest_passed} | ${report.test_results_summary.vitest_failed} |\n`;
  body += `| Playwright | ${report.test_results_summary.playwright_passed} | ${report.test_results_summary.playwright_failed} |\n\n`;

  if (report.failures?.length > 0) {
    body += `### Failures\n`;
    report.failures.forEach(f => { body += `- ${f}\n`; });
    body += '\n';
  }

  // Re-run instructions block — only shown when there are structured failures
  if (report.failedTests && (report.failedTests.vitest?.length > 0 || report.failedTests.playwright?.length > 0)) {
    const failedTestsJson = JSON.stringify(report.failedTests);
    body += `### Re-run Failed Tests\n`;
    body += `Trigger the [QA Agent Re-run](../../actions/workflows/qa-rerun.yml) workflow with:\n\n`;
    body += `| Field | Value |\n|---|---|\n`;
    body += `| \`failed_tests\` | \`${failedTestsJson}\` |\n`;
    body += `| \`pr_number\` | \`${prNumber}\` |\n\n`;
  }

  if (report.gaps_summary?.length > 0) {
    body += `### Coverage Gaps\n`;
    report.gaps_summary.forEach(g => { body += `- ${g}\n`; });
    body += '\n';
  }

  if (report.testProposals?.proposals?.length > 0) {
    body += `### Proposed Tests\n`;
    body += `${report.proposed_tests_summary}\n\n`;
    body += `> Proposed test cases have been logged in a GitHub issue. Review and promote what's worth keeping.\n`;
  }

  body += `\n---\n*QA Agent · ${report.risk_summary}*`;

  await postComment({ repo, prNumber, body });
}
```

- [ ] **Step 2: Thread `failedTests` through `synthesize` → `report`**

Open `src/steps/6-synthesis.js`. After the `report = JSON.parse(clean)` line, add:

```js
  // Attach structured failure lists so pr-comment.js can build the re-run block
  report.failedTests = {
    vitest: (testResults.failures?.vitest || []).map(f => f.file),
    playwright: (testResults.failures?.playwright || []).map(f => f.test),
  };
```

The full updated `synthesize` function body (only the end changes):

```js
  // (existing Claude call and JSON parse unchanged above)

  // Attach proposals to report for use in PR comment
  report.testProposals = testProposals;

  // Attach structured failure lists so pr-comment.js can build the re-run block
  report.failedTests = {
    vitest: (testResults.failures?.vitest || []).map(f => f.file),
    playwright: (testResults.failures?.playwright || []).map(f => f.test),
  };

  return report;
```

- [ ] **Step 3: Commit**

```bash
git add src/output/pr-comment.js src/steps/6-synthesis.js
git commit -m "feat: add re-run instructions to PR comment when failures remain"
```

---

## Task 5: Add `qa-rerun.yml` workflow

**Files:**
- Create: `.github/workflows/qa-rerun.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: QA Agent — Re-run Failed Tests

on:
  workflow_dispatch:
    inputs:
      failed_tests:
        description: 'JSON object of failing tests, e.g. {"vitest":["src/__tests__/foo.test.js"],"playwright":["user can log in"]}'
        required: true
      pr_number:
        description: 'PR number to post the updated comment on (leave blank for regression re-runs)'
        required: false
        default: ''

jobs:
  rerun:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout target project
        uses: actions/checkout@v4

      - name: Checkout QA Agent
        uses: actions/checkout@v4
        with:
          repository: ${{ github.repository_owner }}/qa-agent
          path: .qa-agent

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Re-run Failed Tests
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.inputs.pr_number }}
          REPO: ${{ github.repository }}
          MODE: rerun
          FAILED_TESTS: ${{ github.event.inputs.failed_tests }}
        run: node .qa-agent/src/index.js
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/qa-rerun.yml
git commit -m "feat: add qa-rerun workflow for targeted re-runs via workflow_dispatch"
```

---

## Self-Review

**Spec coverage:**
- Auto-retry flaky failures in-process: Task 2 (retry loop in `executeTests`)
- User gets option to re-run: Task 4 (PR comment re-run block) + Task 5 (workflow)
- Re-run runs only failing tests, not the full pipeline: Task 3 (`MODE=rerun` skips steps 1–4)
- Config-driven retry count: Task 1 (`test_retry_count`)

**Placeholder scan:** None found. All code blocks are complete.

**Type consistency:**
- `testResults.failures.vitest` is set in Task 2 and consumed in Task 4 (via `synthesize`) — consistent
- `failedTests` passed to `executeTests` in Task 3 matches signature added in Task 2 — consistent
- `report.failedTests` set in Task 4 (`6-synthesis.js`) and consumed in `pr-comment.js` — consistent

No gaps found.

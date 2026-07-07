import { HAIKU } from '../utils/anthropic.js';
import { callClaudeJson } from '../utils/json.js';

// Per-block character budget for the synthesis prompt. Raw runner output on a
// test-heavy PR overflowed the 200k-token context (issue #6) — at ~4 chars per
// token, three 40k-char blocks keep the whole prompt around 30k tokens worst case.
const BLOCK_BUDGET = 40000;
const MAX_FAILURES_IN_PROMPT = 20;

// Stringify for the prompt, hard-capped with an explicit note so the model
// knows it is looking at a truncated block rather than malformed data.
export function budgetJson(value, maxChars = BLOCK_BUDGET) {
  const json = JSON.stringify(value, null, 2);
  if (json.length <= maxChars) return json;
  return `${json.slice(0, maxChars)}\n... [truncated: showing ${maxChars} of ${json.length} chars]`;
}

// Collapse raw runner output to counts + capped failure lists for the prompt.
// The verdict only needs pass/fail shape; full results stay on testResults for
// pr-comment.js.
export function summarizeTestResults(testResults) {
  if (!testResults) return testResults;
  const summary = { failures: {} };
  for (const runner of ['vitest', 'playwright']) {
    summary[runner] = summarizeRunner(testResults[runner]);
    const failures = testResults.failures?.[runner] || [];
    summary.failures[runner] = failures.slice(0, MAX_FAILURES_IN_PROMPT);
    if (failures.length > MAX_FAILURES_IN_PROMPT) {
      summary.failures[`${runner}_omitted`] = failures.length - MAX_FAILURES_IN_PROMPT;
    }
  }
  return summary;
}

function summarizeRunner(result) {
  if (!result) return null;
  if (result.skipped || result.error) return result; // small by construction (step 5 caps errors)
  // Vitest JSON reporter: keep counts, drop per-assertion detail
  if (result.numTotalTests !== undefined) {
    const { numTotalTests, numPassedTests, numFailedTests, numPendingTests, success } = result;
    return { numTotalTests, numPassedTests, numFailedTests, numPendingTests, success };
  }
  // Playwright JSON reporter: stats block carries the counts
  if (result.stats) return { stats: result.stats };
  return result; // unknown shape — budgetJson caps it as a fallback
}

export async function synthesize({ changeMap, riskScores, coverageGaps, testProposals, testResults, mode, config }) {
  const userMessage = `
You are writing a QA report for a ${mode === 'pr' ? 'pull request' : 'regression run'}.

Project: ${config.project}
${changeMap ? `PR Summary: ${changeMap.summary}` : 'Mode: Full regression'}

Risk assessment:
${budgetJson(riskScores)}

Coverage gaps:
${budgetJson(coverageGaps)}

Test results:
${budgetJson(summarizeTestResults(testResults))}

Test proposals count: ${testProposals?.proposals?.length ?? 0} files with proposed tests

Determine the verdict:
- "pass" = tests pass AND no high-risk gaps
- "warn" = tests pass BUT coverage gaps exist OR medium risk surfaces untested
- "fail" = any test failure OR high-risk surface with zero coverage

Output JSON:
{
  "verdict": "pass | warn | fail",
  "summary": "2-3 sentence plain English summary",
  "test_results_summary": {
    "vitest_passed": number,
    "vitest_failed": number,
    "playwright_passed": number,
    "playwright_failed": number
  },
  "failures": ["list of specific test failures if any"],
  "gaps_summary": ["list of key coverage gaps"],
  "risk_summary": "one sentence on overall risk level",
  "proposed_tests_summary": "one sentence on what test proposals were generated"
}
  `;

  const report = await callClaudeJson({ label: 'synthesize', systemPrompt: 'You are a senior QA engineer writing a structured test report. Output only valid JSON.', userMessage, maxTokens: 1500, model: HAIKU });

  // Attach proposals to report for use in PR comment
  report.testProposals = testProposals;

  // Attach structured failure lists so pr-comment.js can build the re-run block
  report.failedTests = {
    vitest: (testResults.failures?.vitest || []).map(f => f.file),
    playwright: (testResults.failures?.playwright || []).map(f => f.test),
  };

  return report;
}

import { HAIKU } from '../utils/anthropic.js';
import { callClaudeJson } from '../utils/json.js';

export async function synthesize({ changeMap, riskScores, coverageGaps, testProposals, testResults, mode, config }) {
  const userMessage = `
You are writing a QA report for a ${mode === 'pr' ? 'pull request' : 'regression run'}.

Project: ${config.project}
${changeMap ? `PR Summary: ${changeMap.summary}` : 'Mode: Full regression'}

Risk assessment:
${JSON.stringify(riskScores, null, 2)}

Coverage gaps:
${JSON.stringify(coverageGaps, null, 2)}

Test results:
${JSON.stringify(testResults, null, 2)}

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

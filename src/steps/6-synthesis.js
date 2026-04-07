import { callClaude } from '../utils/anthropic.js';

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

  const raw = await callClaude({ systemPrompt: 'You are a senior QA engineer writing a structured test report. Output only valid JSON.', userMessage, maxTokens: 1500 });
  const clean = raw.replace(/```json|```/g, '').trim();
  let report;
  try {
    report = JSON.parse(clean);
  } catch (e) {
    console.error('synthesize: failed to parse Claude response:\n', raw.slice(0, 500));
    throw e;
  }

  // Attach proposals to report for use in PR comment
  report.testProposals = testProposals;

  return report;
}

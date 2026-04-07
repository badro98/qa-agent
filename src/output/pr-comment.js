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

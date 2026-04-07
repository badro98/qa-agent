import { createIssue } from '../utils/github.js';

export async function openGitHubIssue({ report, repo, prNumber }) {
  const title = prNumber
    ? `[QA] Coverage gaps and proposals — PR #${prNumber}`
    : `[QA] Regression report — ${new Date().toISOString().split('T')[0]}`;

  let body = `## QA Report — ${report.verdict.toUpperCase()}\n\n`;
  body += `${report.summary}\n\n`;

  if (report.failures?.length > 0) {
    body += `## Test Failures\n`;
    report.failures.forEach(f => { body += `- ${f}\n`; });
    body += '\n';
  }

  if (report.testProposals?.proposals?.length > 0) {
    body += `## Proposed Test Cases\n\n`;
    body += `Review these and promote what's worth keeping into your test suite.\n\n`;

    for (const proposal of report.testProposals.proposals) {
      body += `### ${proposal.gap_file}\n`;
      body += `**Test file:** \`${proposal.test_file_path}\`  \n`;
      body += `**Runner:** ${proposal.test_runner}\n\n`;

      for (const test of proposal.tests) {
        body += `#### ${test.name} (${test.type})\n`;
        body += `\`\`\`${proposal.test_runner === 'playwright' ? 'typescript' : 'javascript'}\n`;
        body += `${test.code}\n`;
        body += `\`\`\`\n\n`;
      }
    }
  }

  if (prNumber) body += `\nLinked PR: #${prNumber}`;

  await createIssue({
    repo,
    title,
    body,
    labels: ['qa', 'automated']
  });
}

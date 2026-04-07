import { loadConfig } from './utils/config.js';
import { analyzeDiff } from './steps/1-diff-analysis.js';
import { scoreRisk } from './steps/2-risk-scoring.js';
import { analyzeCoverage } from './steps/3-coverage-gap.js';
import { proposeTests } from './steps/4-test-proposals.js';
import { executeTests } from './steps/5-test-execution.js';
import { synthesize } from './steps/6-synthesis.js';
import { postPRComment } from './output/pr-comment.js';
import { openGitHubIssue } from './output/github-issue.js';

const MODE = process.env.MODE; // 'pr' or 'regression'
const PR_NUMBER = process.env.PR_NUMBER;
const REPO = process.env.REPO;

async function run() {
  console.log(`Running QA Agent in ${MODE} mode...`);
  const config = loadConfig();

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
  const testResults = await executeTests({ changeMap, mode: MODE, config });

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

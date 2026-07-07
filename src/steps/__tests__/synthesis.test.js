import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/json.js', () => ({ callClaudeJson: vi.fn(async () => ({ verdict: 'pass' })) }));

import { synthesize, budgetJson, summarizeTestResults } from '../6-synthesis.js';
import { callClaudeJson } from '../../utils/json.js';

describe('budgetJson', () => {
  it('returns full pretty-printed JSON when under budget', () => {
    const value = { a: 1, b: 'two' };
    expect(budgetJson(value)).toBe(JSON.stringify(value, null, 2));
  });

  it('truncates over-budget JSON with an explicit note', () => {
    const value = { blob: 'x'.repeat(500) };
    const out = budgetJson(value, 100);
    expect(out.length).toBeLessThan(200);
    expect(out).toContain('[truncated: showing 100 of');
  });
});

describe('summarizeTestResults', () => {
  it('passes through null results', () => {
    expect(summarizeTestResults(null)).toBeNull();
    const summary = summarizeTestResults({ vitest: null, playwright: null, failures: {} });
    expect(summary.vitest).toBeNull();
    expect(summary.playwright).toBeNull();
  });

  it('reduces vitest reporter output to counts, dropping per-assertion detail', () => {
    const vitest = {
      numTotalTests: 1148, numPassedTests: 1148, numFailedTests: 0, numPendingTests: 0, success: true,
      testResults: Array.from({ length: 1148 }, (_, i) => ({ testFilePath: `t${i}.js`, assertionResults: [] })),
    };
    const summary = summarizeTestResults({ vitest, playwright: null, failures: {} });
    expect(summary.vitest).toEqual({ numTotalTests: 1148, numPassedTests: 1148, numFailedTests: 0, numPendingTests: 0, success: true });
    expect(summary.vitest.testResults).toBeUndefined();
  });

  it('reduces playwright reporter output to its stats block', () => {
    const playwright = { stats: { expected: 24, unexpected: 0 }, suites: [{ big: 'tree' }] };
    const summary = summarizeTestResults({ vitest: null, playwright, failures: {} });
    expect(summary.playwright).toEqual({ stats: { expected: 24, unexpected: 0 } });
  });

  it('keeps skipped and error shapes as-is', () => {
    const results = {
      vitest: { error: 'command failed' },
      playwright: { skipped: true, reason: 'no e2e runner configured in qa-agent.config.json' },
      failures: {},
    };
    const summary = summarizeTestResults(results);
    expect(summary.vitest).toEqual({ error: 'command failed' });
    expect(summary.playwright).toEqual(results.playwright);
  });

  it('caps failure lists at 20 and records the omitted count', () => {
    const failures = Array.from({ length: 55 }, (_, i) => ({ file: `f${i}.test.js`, tests: ['t'] }));
    const summary = summarizeTestResults({ vitest: null, playwright: null, failures: { vitest: failures, playwright: [] } });
    expect(summary.failures.vitest).toHaveLength(20);
    expect(summary.failures.vitest_omitted).toBe(35);
    expect(summary.failures.playwright).toEqual([]);
    expect(summary.failures.playwright_omitted).toBeUndefined();
  });
});

describe('synthesize prompt budget', () => {
  beforeEach(() => callClaudeJson.mockClear());

  const config = { project: 'pointd.fyi' };

  it('keeps the prompt bounded even with massive runner output (issue #6)', async () => {
    const hugeVitest = {
      numTotalTests: 1148, numPassedTests: 1100, numFailedTests: 48, numPendingTests: 0, success: false,
      testResults: Array.from({ length: 1148 }, (_, i) => ({
        testFilePath: `tests/unit/file${i}.test.jsx`,
        assertionResults: Array.from({ length: 10 }, (_, j) => ({ status: 'passed', title: `case ${j}`, failureMessages: ['x'.repeat(200)] })),
      })),
    };
    const testResults = { vitest: hugeVitest, playwright: { error: 'y'.repeat(300000) }, failures: { vitest: [], playwright: [] } };

    await synthesize({ changeMap: null, riskScores: [], coverageGaps: [], testProposals: null, testResults, mode: 'pr', config });

    const { userMessage } = callClaudeJson.mock.calls[0][0];
    // ~50k chars ≈ 12k tokens — far under the 200k-token context that overflowed before
    expect(userMessage.length).toBeLessThan(50000);
  });

  it('still attaches full failure lists to the report for pr-comment.js', async () => {
    const testResults = {
      vitest: { error: 'boom' },
      playwright: null,
      failures: {
        vitest: Array.from({ length: 30 }, (_, i) => ({ file: `f${i}.test.js`, tests: ['t'] })),
        playwright: [{ file: 'e.spec.js', test: 'flow works' }],
      },
    };

    const report = await synthesize({ changeMap: null, riskScores: [], coverageGaps: [], testProposals: null, testResults, mode: 'pr', config });

    expect(report.failedTests.vitest).toHaveLength(30);
    expect(report.failedTests.playwright).toEqual(['flow works']);
  });
});

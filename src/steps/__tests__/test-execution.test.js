import { describe, it, expect } from 'vitest';
import { executeTests, extractVitestFailures, extractPlaywrightFailures, deriveScopedTestFiles, deriveScopedPlaywrightGrep } from '../5-test-execution.js';

describe('executeTests e2e runner gate', () => {
  const passingVitestJson = JSON.stringify({ testResults: [] });

  function makeExecFn() {
    const calls = [];
    const execFn = (cmd) => {
      calls.push(cmd);
      return passingVitestJson;
    };
    return { execFn, calls };
  }

  it('skips Playwright when config has no e2e runner', async () => {
    const { execFn, calls } = makeExecFn();
    const config = { test_runners: { unit: 'vitest' }, test_paths: { unit: './src' }, test_retry_count: 0 };

    const results = await executeTests({ changeMap: null, mode: 'regression', failedTests: null, config, execFn });

    expect(results.playwright).toEqual({ skipped: true, reason: 'no e2e runner configured in qa-agent.config.json' });
    expect(results.failures.playwright).toEqual([]);
    expect(calls.some(c => c.includes('playwright'))).toBe(false);
    expect(calls.some(c => c.includes('vitest'))).toBe(true);
  });

  it('runs Playwright when config declares an e2e runner', async () => {
    const { execFn, calls } = makeExecFn();
    const config = { test_runners: { unit: 'vitest', e2e: 'playwright' }, test_paths: { unit: './src' }, test_retry_count: 0 };

    await executeTests({ changeMap: null, mode: 'regression', failedTests: null, config, execFn });

    expect(calls.some(c => c.includes('playwright'))).toBe(true);
  });
});

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

describe('deriveScopedTestFiles', () => {
  // Helpers to simulate different filesystem layouts without touching disk
  const existsNone = () => false;
  const existsAll = () => true;
  const existsTestsDir = (p) => p.includes('/__tests__/');
  const existsFlat = (p) => !p.includes('/__tests__/');

  it('returns empty array when changeMap is null', () => {
    expect(deriveScopedTestFiles(null)).toEqual([]);
  });

  it('returns empty array when surfaces is empty', () => {
    expect(deriveScopedTestFiles({ surfaces: [] })).toEqual([]);
  });

  it('skips surfaces with type "test"', () => {
    const changeMap = {
      surfaces: [{ file: 'src/steps/__tests__/foo.test.js', type: 'test' }]
    };
    expect(deriveScopedTestFiles(changeMap, { existsFn: existsAll })).toEqual([]);
  });

  it('returns empty array when no test files exist on disk', () => {
    const changeMap = { surfaces: [{ file: 'src/utils/rewards.js', type: 'util' }] };
    expect(deriveScopedTestFiles(changeMap, { existsFn: existsNone })).toEqual([]);
  });

  it('finds .js test file in __tests__ subdirectory', () => {
    const changeMap = { surfaces: [{ file: 'src/utils/rewards.js', type: 'util' }] };
    expect(deriveScopedTestFiles(changeMap, { existsFn: existsTestsDir }))
      .toEqual(['src/utils/__tests__/rewards.test.js']);
  });

  it('finds .ts test file in __tests__ subdirectory', () => {
    const existsTs = (p) => p.endsWith('.test.ts');
    const changeMap = { surfaces: [{ file: 'src/utils/rewards.js', type: 'util' }] };
    expect(deriveScopedTestFiles(changeMap, { existsFn: existsTs }))
      .toEqual(['src/utils/__tests__/rewards.test.ts']);
  });

  it('falls back to flat layout when __tests__/ file does not exist', () => {
    const changeMap = { surfaces: [{ file: 'src/utils/rewards.js', type: 'util' }] };
    expect(deriveScopedTestFiles(changeMap, { existsFn: existsFlat }))
      .toEqual(['src/utils/rewards.test.js']);
  });

  it('prefers __tests__/ layout over flat when both exist', () => {
    const changeMap = { surfaces: [{ file: 'src/utils/rewards.js', type: 'util' }] };
    expect(deriveScopedTestFiles(changeMap, { existsFn: existsAll }))
      .toEqual(['src/utils/__tests__/rewards.test.js']);
  });

  it('strips numeric prefix from source filename', () => {
    const changeMap = { surfaces: [{ file: 'src/steps/5-test-execution.js', type: 'util' }] };
    expect(deriveScopedTestFiles(changeMap, { existsFn: existsTestsDir }))
      .toEqual(['src/steps/__tests__/test-execution.test.js']);
  });

  it('deduplicates when multiple surfaces map to the same test file', () => {
    const changeMap = {
      surfaces: [
        { file: 'src/utils/rewards.js', type: 'util' },
        { file: 'src/utils/rewards.js', type: 'util' }
      ]
    };
    expect(deriveScopedTestFiles(changeMap, { existsFn: existsTestsDir }))
      .toEqual(['src/utils/__tests__/rewards.test.js']);
  });

  it('returns one entry per unique source file', () => {
    const changeMap = {
      surfaces: [
        { file: 'src/utils/rewards.js', type: 'util' },
        { file: 'src/hooks/useAuth.js', type: 'hook' }
      ]
    };
    expect(deriveScopedTestFiles(changeMap, { existsFn: existsTestsDir }))
      .toEqual([
        'src/utils/__tests__/rewards.test.js',
        'src/hooks/__tests__/useAuth.test.js'
      ]);
  });
});

describe('deriveScopedPlaywrightGrep', () => {
  it('returns null when changeMap is null', () => {
    expect(deriveScopedPlaywrightGrep(null)).toBeNull();
  });

  it('returns null when no surfaces affect any flows', () => {
    const changeMap = {
      surfaces: [{ file: 'src/utils/foo.js', type: 'util', affects_flows: [] }]
    };
    expect(deriveScopedPlaywrightGrep(changeMap)).toBeNull();
  });

  it('returns pipe-joined flow names from a single surface', () => {
    const changeMap = {
      surfaces: [{ file: 'src/utils/foo.js', type: 'util', affects_flows: ['award search', 'trip save'] }]
    };
    expect(deriveScopedPlaywrightGrep(changeMap)).toBe('award search|trip save');
  });

  it('deduplicates flows across multiple surfaces', () => {
    const changeMap = {
      surfaces: [
        { file: 'src/a.js', type: 'util', affects_flows: ['award search'] },
        { file: 'src/b.js', type: 'hook', affects_flows: ['award search', 'trip save'] }
      ]
    };
    expect(deriveScopedPlaywrightGrep(changeMap)).toBe('award search|trip save');
  });

  it('handles surfaces with no affects_flows field', () => {
    const changeMap = {
      surfaces: [
        { file: 'src/a.js', type: 'config' },
        { file: 'src/b.js', type: 'util', affects_flows: ['program comparison'] }
      ]
    };
    expect(deriveScopedPlaywrightGrep(changeMap)).toBe('program comparison');
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

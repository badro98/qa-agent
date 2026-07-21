import { describe, it, expect } from 'vitest';
import { executeTests, extractVitestFailures, extractPlaywrightFailures, deriveScopedTestFiles, deriveScopedPlaywrightGrep, capOutput } from '../5-test-execution.js';

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

describe('executeTests runner exec options', () => {
  const passingVitestJson = JSON.stringify({ testResults: [] });
  const passingPlaywrightJson = JSON.stringify({ suites: [] });

  function makeCapturingExecFn() {
    const calls = [];
    const execFn = (cmd, opts) => {
      calls.push({ cmd, opts });
      return cmd.includes('playwright') ? passingPlaywrightJson : passingVitestJson;
    };
    return { execFn, calls };
  }

  it('defaults runner timeouts to 10 minutes (issues pointd#500/#507: 87-file suite exceeded 120s on CI)', async () => {
    const { execFn, calls } = makeCapturingExecFn();
    const config = { test_runners: { unit: 'vitest', e2e: 'playwright' }, test_paths: { unit: './tests' }, test_retry_count: 0 };

    await executeTests({ changeMap: null, mode: 'regression', failedTests: null, config, execFn });

    const vitestCall = calls.find(c => c.cmd.includes('vitest'));
    const playwrightCall = calls.find(c => c.cmd.includes('playwright'));
    expect(vitestCall.opts.timeout).toBe(600000);
    expect(playwrightCall.opts.timeout).toBe(600000);
  });

  it('honors per-runner timeout overrides from config.test_timeouts', async () => {
    const { execFn, calls } = makeCapturingExecFn();
    const config = {
      test_runners: { unit: 'vitest', e2e: 'playwright' },
      test_paths: { unit: './tests' },
      test_retry_count: 0,
      test_timeouts: { unit: 240000, e2e: 480000 },
    };

    await executeTests({ changeMap: null, mode: 'regression', failedTests: null, config, execFn });

    const vitestCall = calls.find(c => c.cmd.includes('vitest'));
    const playwrightCall = calls.find(c => c.cmd.includes('playwright'));
    expect(vitestCall.opts.timeout).toBe(240000);
    expect(playwrightCall.opts.timeout).toBe(480000);
  });

  it('raises maxBuffer above the 1MB node default so full-suite JSON output is not truncated', async () => {
    const { execFn, calls } = makeCapturingExecFn();
    const config = { test_runners: { unit: 'vitest' }, test_paths: { unit: './tests' }, test_retry_count: 0 };

    await executeTests({ changeMap: null, mode: 'regression', failedTests: null, config, execFn });

    const vitestCall = calls.find(c => c.cmd.includes('vitest'));
    expect(vitestCall.opts.maxBuffer).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });
});

describe('executeTests vitest output file', () => {
  // Capturing full-suite JSON via the stdout pipe was ~10x slower than the same run
  // redirected to a file (300s vs 23s locally) — the cause of pointd#500/#507 timeouts.
  // Vitest results must flow through --outputFile, not the pipe.
  const passingJson = JSON.stringify({ testResults: [] });
  const failingJson = JSON.stringify({
    testResults: [{
      name: 'tests/unit/foo.test.js',
      assertionResults: [{ status: 'failed', ancestorTitles: ['suite'], title: 'breaks' }]
    }]
  });

  it('appends --outputFile to the vitest command and parses results from that file', async () => {
    const calls = [];
    const execFn = (cmd) => { calls.push(cmd); return ''; };
    const readFileFn = (path) => {
      const match = calls[0].match(/--outputFile=(\S+)/);
      expect(path).toBe(match[1].replace(/"/g, ''));
      return passingJson;
    };
    const config = { test_runners: { unit: 'vitest' }, test_paths: { unit: './tests' }, test_retry_count: 0 };

    const results = await executeTests({ changeMap: null, mode: 'regression', failedTests: null, config, execFn, readFileFn });

    expect(calls[0]).toContain('--outputFile=');
    expect(results.vitest).toEqual({ testResults: [] });
    expect(results.failures.vitest).toEqual([]);
  });

  it('extracts failures from the output file when vitest exits nonzero, and scopes the retry', async () => {
    const calls = [];
    const execFn = (cmd) => {
      calls.push(cmd);
      if (calls.length === 1) throw Object.assign(new Error('exit 1'), { status: 1 });
      return '';
    };
    const readFileFn = () => (calls.length === 1 ? failingJson : passingJson);
    const config = { test_runners: { unit: 'vitest' }, test_paths: { unit: './tests' }, test_retry_count: 1 };

    const results = await executeTests({ changeMap: null, mode: 'regression', failedTests: null, config, execFn, readFileFn });

    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('tests/unit/foo.test.js');
    expect(calls[1]).toContain('--outputFile=');
    expect(results.failures.vitest).toEqual([]);
  });

  it('falls back to a capped error blob when the runner dies without writing the output file', async () => {
    const execFn = () => { throw Object.assign(new Error('spawnSync /bin/sh ETIMEDOUT'), { code: 'ETIMEDOUT' }); };
    const readFileFn = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    const config = { test_runners: { unit: 'vitest' }, test_paths: { unit: './tests' }, test_retry_count: 1 };

    const results = await executeTests({ changeMap: null, mode: 'regression', failedTests: null, config, execFn, readFileFn });

    expect(results.vitest.error).toContain('ETIMEDOUT');
    expect(results.failures.vitest).toEqual([]);
  });
});

describe('capOutput', () => {
  it('returns short strings unchanged', () => {
    expect(capOutput('brief error')).toBe('brief error');
  });

  it('passes through non-string values', () => {
    expect(capOutput(undefined)).toBeUndefined();
    expect(capOutput(null)).toBeNull();
  });

  it('keeps head and tail of oversized output with a truncation note', () => {
    const str = 'H'.repeat(3000) + 'T'.repeat(3000);
    const out = capOutput(str);
    expect(out.length).toBeLessThan(4100);
    expect(out.startsWith('H'.repeat(2000))).toBe(true);
    expect(out.endsWith('T'.repeat(2000))).toBe(true);
    expect(out).toContain('[truncated 2000 chars]');
  });
});

describe('executeTests error capping', () => {
  it('caps unparseable runner output before storing it in results (issue #6)', async () => {
    const hugeDump = 'FAIL '.repeat(50000); // ~250k chars, not JSON
    const execFn = () => { throw Object.assign(new Error('exit 1'), { stdout: hugeDump }); };
    const config = { test_runners: { unit: 'vitest' }, test_paths: { unit: './src' }, test_retry_count: 0 };

    const results = await executeTests({ changeMap: null, mode: 'regression', failedTests: null, config, execFn });

    expect(results.vitest.error.length).toBeLessThan(5000);
    expect(results.vitest.error).toContain('[truncated');
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

  it('extracts failing test file paths from vitest v4 output (file path lives in "name")', () => {
    const output = {
      testResults: [{
        name: '/app/tests/unit/auth.test.js',
        assertionResults: [
          { status: 'failed', ancestorTitles: ['AuthStore'], title: 'logs in user' },
          { status: 'passed', ancestorTitles: ['AuthStore'], title: 'logs out user' }
        ]
      }]
    };
    const result = extractVitestFailures(output);
    expect(result).toEqual([{ file: '/app/tests/unit/auth.test.js', tests: ['AuthStore > logs in user'] }]);
  });

  it('falls back to legacy testFilePath key', () => {
    const output = {
      testResults: [{
        testFilePath: '/app/src/__tests__/auth.test.js',
        assertionResults: [
          { status: 'failed', ancestorTitles: ['AuthStore'], title: 'logs in user' }
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
  const existsFlat = (p) => !p.includes('/__tests__/') && !p.startsWith('tests/');

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
    expect(deriveScopedTestFiles(changeMap, {}, { existsFn: existsAll })).toEqual([]);
  });

  it('returns empty array when no test files exist on disk', () => {
    const changeMap = { surfaces: [{ file: 'src/utils/rewards.js', type: 'util' }] };
    expect(deriveScopedTestFiles(changeMap, {}, { existsFn: existsNone })).toEqual([]);
  });

  it('finds .js test file in __tests__ subdirectory', () => {
    const changeMap = { surfaces: [{ file: 'src/utils/rewards.js', type: 'util' }] };
    expect(deriveScopedTestFiles(changeMap, {}, { existsFn: existsTestsDir }))
      .toEqual(['src/utils/__tests__/rewards.test.js']);
  });

  it('finds .ts test file in __tests__ subdirectory', () => {
    const existsTs = (p) => p.endsWith('.test.ts') && p.includes('/__tests__/');
    const changeMap = { surfaces: [{ file: 'src/utils/rewards.js', type: 'util' }] };
    expect(deriveScopedTestFiles(changeMap, {}, { existsFn: existsTs }))
      .toEqual(['src/utils/__tests__/rewards.test.ts']);
  });

  it('falls back to flat layout when __tests__/ file does not exist', () => {
    const changeMap = { surfaces: [{ file: 'src/utils/rewards.js', type: 'util' }] };
    expect(deriveScopedTestFiles(changeMap, {}, { existsFn: existsFlat }))
      .toEqual(['src/utils/rewards.test.js']);
  });

  it('prefers __tests__/ layout over flat when both exist', () => {
    const changeMap = { surfaces: [{ file: 'src/utils/rewards.js', type: 'util' }] };
    expect(deriveScopedTestFiles(changeMap, {}, { existsFn: existsAll }))
      .toEqual(['src/utils/__tests__/rewards.test.js']);
  });

  it('strips numeric prefix from source filename', () => {
    const changeMap = { surfaces: [{ file: 'src/steps/5-test-execution.js', type: 'util' }] };
    expect(deriveScopedTestFiles(changeMap, {}, { existsFn: existsTestsDir }))
      .toEqual(['src/steps/__tests__/test-execution.test.js']);
  });

  it('deduplicates when multiple surfaces map to the same test file', () => {
    const changeMap = {
      surfaces: [
        { file: 'src/utils/rewards.js', type: 'util' },
        { file: 'src/utils/rewards.js', type: 'util' }
      ]
    };
    expect(deriveScopedTestFiles(changeMap, {}, { existsFn: existsTestsDir }))
      .toEqual(['src/utils/__tests__/rewards.test.js']);
  });

  it('returns one entry per unique source file', () => {
    const changeMap = {
      surfaces: [
        { file: 'src/utils/rewards.js', type: 'util' },
        { file: 'src/hooks/useAuth.js', type: 'hook' }
      ]
    };
    expect(deriveScopedTestFiles(changeMap, {}, { existsFn: existsTestsDir }))
      .toEqual([
        'src/utils/__tests__/rewards.test.js',
        'src/hooks/__tests__/useAuth.test.js'
      ]);
  });
});

describe('deriveScopedTestFiles mirror layout (pointd-style tests/unit + tests/integration)', () => {
  // pointd keeps tests in a mirror tree (tests/unit/DestinationPage.test.jsx), not
  // next to the source — the old colocated-only candidates never matched, so every
  // PR run fell back to the full suite (the trigger for pointd#500/#507 timeouts).
  const config = { test_paths: { unit: './tests' } };
  const readdirUnitIntegration = () => ['unit', 'integration'];

  it('finds mirror-layout test files under subdirectories of test_paths.unit', () => {
    const existsFn = (p) => p === 'tests/unit/DestinationPage.test.jsx';
    const changeMap = { surfaces: [{ file: 'src/components/DestinationPage.jsx', type: 'component' }] };
    expect(deriveScopedTestFiles(changeMap, config, { existsFn, readdirFn: readdirUnitIntegration }))
      .toEqual(['tests/unit/DestinationPage.test.jsx']);
  });

  it('returns both unit and integration mirror tests when both exist', () => {
    const existsFn = (p) => p === 'tests/unit/store.test.js' || p === 'tests/integration/store.test.js';
    const changeMap = { surfaces: [{ file: 'src/state/store.js', type: 'state' }] };
    expect(deriveScopedTestFiles(changeMap, config, { existsFn, readdirFn: readdirUnitIntegration }))
      .toEqual(['tests/unit/store.test.js', 'tests/integration/store.test.js']);
  });

  it('finds tests directly under test_paths.unit', () => {
    const existsFn = (p) => p === 'tests/rewards.test.js';
    const changeMap = { surfaces: [{ file: 'src/utils/rewards.js', type: 'util' }] };
    expect(deriveScopedTestFiles(changeMap, config, { existsFn, readdirFn: () => [] }))
      .toEqual(['tests/rewards.test.js']);
  });

  it('combines a colocated match with mirror matches without duplicates', () => {
    const existsFn = (p) => p === 'src/utils/rewards.test.js' || p === 'tests/unit/rewards.test.js';
    const changeMap = { surfaces: [{ file: 'src/utils/rewards.js', type: 'util' }] };
    expect(deriveScopedTestFiles(changeMap, config, { existsFn, readdirFn: readdirUnitIntegration }))
      .toEqual(['src/utils/rewards.test.js', 'tests/unit/rewards.test.js']);
  });

  it('checks existence against projectRoot but returns project-relative paths (CI runs from .qa-agent)', () => {
    const seen = [];
    const existsFn = (p) => { seen.push(p); return p === '/proj/tests/unit/DestinationPage.test.jsx'; };
    const changeMap = { surfaces: [{ file: 'src/components/DestinationPage.jsx', type: 'component' }] };
    const result = deriveScopedTestFiles(changeMap, config, {
      existsFn,
      readdirFn: readdirUnitIntegration,
      projectRoot: '/proj',
    });
    expect(result).toEqual(['tests/unit/DestinationPage.test.jsx']);
    expect(seen.every(p => p.startsWith('/proj/'))).toBe(true);
  });

  it('tolerates a missing test_paths.unit directory when listing subdirectories', () => {
    const changeMap = { surfaces: [{ file: 'src/utils/rewards.js', type: 'util' }] };
    // default readdirFn hits the real fs and ./tests does not exist in this repo
    expect(deriveScopedTestFiles(changeMap, config, { existsFn: () => false }))
      .toEqual([]);
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

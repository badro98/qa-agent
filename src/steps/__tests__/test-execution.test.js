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

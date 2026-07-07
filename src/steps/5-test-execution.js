import { execSync } from 'child_process';
import { dirname, basename, extname } from 'path';
import { existsSync } from 'fs';

export async function executeTests({ changeMap, mode, failedTests, config, execFn = execSync }) {
  const results = { vitest: null, playwright: null, failures: { vitest: [], playwright: [] } };
  const cwd = process.env.PROJECT_ROOT || process.cwd();
  const maxRetries = config.test_retry_count ?? 0;

  // --- Vitest ---
  let vitestCmd = buildVitestCmd(mode, changeMap, failedTests, config);
  let vitestAttempts = 0;

  while (vitestAttempts <= maxRetries) {
    try {
      const out = execFn(vitestCmd, { encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'], cwd });
      results.vitest = JSON.parse(out);
      results.failures.vitest = []; // all passed
      break;
    } catch (err) {
      const parsed = tryParseJson(err.stdout);
      results.vitest = parsed || { error: err.stdout || err.stderr || err.message };
      results.failures.vitest = parsed ? extractVitestFailures(parsed) : [];

      if (vitestAttempts < maxRetries && results.failures.vitest.length > 0) {
        console.log(`Vitest: ${results.failures.vitest.length} failure(s). Retrying (attempt ${vitestAttempts + 2}/${maxRetries + 1})...`);
        // Scope next attempt to only failing files
        const failingFiles = results.failures.vitest.map(f => f.file).join(' ');
        vitestCmd = `npx vitest run ${failingFiles} --reporter=json`;
      } else {
        break;
      }
    }
    vitestAttempts++;
  }

  // --- Playwright ---
  // Repos without an e2e runner in qa-agent.config.json skip Playwright entirely,
  // otherwise the error blob from a missing runner reads as a failure downstream.
  if (!config.test_runners?.e2e) {
    results.playwright = { skipped: true, reason: 'no e2e runner configured in qa-agent.config.json' };
    return results;
  }

  let playwrightCmd = buildPlaywrightCmd(mode, changeMap, failedTests);
  let playwrightAttempts = 0;

  while (playwrightAttempts <= maxRetries) {
    try {
      const out = execFn(playwrightCmd, { encoding: 'utf8', timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'], cwd });
      results.playwright = JSON.parse(out);
      results.failures.playwright = [];
      break;
    } catch (err) {
      const parsed = tryParseJson(err.stdout);
      results.playwright = parsed || { error: err.stdout || err.stderr || err.message };
      results.failures.playwright = parsed ? extractPlaywrightFailures(parsed) : [];

      if (playwrightAttempts < maxRetries && results.failures.playwright.length > 0) {
        console.log(`Playwright: ${results.failures.playwright.length} failure(s). Retrying (attempt ${playwrightAttempts + 2}/${maxRetries + 1})...`);
        // Scope retry to failing specs by grep on title
        const grepPattern = results.failures.playwright.map(f => f.test).join('|');
        playwrightCmd = `npx playwright test --reporter=json --grep "${grepPattern}"`;
      } else {
        break;
      }
    }
    playwrightAttempts++;
  }

  return results;
}

// --- Command builders ---

function buildVitestCmd(mode, changeMap, failedTests, config) {
  if (mode === 'rerun' && failedTests?.vitest?.length > 0) {
    return `npx vitest run ${failedTests.vitest.join(' ')} --reporter=json`;
  }
  if (mode === 'regression') return 'npx vitest run --reporter=json';

  // PR mode: scope to test files that correspond to changed source files
  const scopedFiles = deriveScopedTestFiles(changeMap);
  if (scopedFiles.length > 0) {
    return `npx vitest run ${scopedFiles.join(' ')} --reporter=json`;
  }

  // Fallback (no source files changed, e.g. docs/config only): run full unit suite
  const unitPath = config.test_paths.unit;
  return `npx vitest run ${unitPath} --reporter=json`;
}

// Derive test file paths from changed source files in the changeMap.
// Checks __tests__/ subdirectory layout first, then flat (alongside source) layout.
// Numeric prefixes like "5-" are stripped since test files don't carry them.
// Pass existsFn to override fs.existsSync (useful in tests).
export function deriveScopedTestFiles(changeMap, { existsFn = existsSync } = {}) {
  if (!changeMap?.surfaces?.length) return [];

  const extensions = ['.test.js', '.test.ts', '.test.tsx', '.test.jsx'];
  const seenSources = new Set();
  const testFiles = [];

  for (const surface of changeMap.surfaces) {
    if (surface.type === 'test') continue;

    const file = surface.file;
    const dir = dirname(file);
    const base = basename(file, extname(file)).replace(/^\d+-/, '');
    const sourceKey = `${dir}/${base}`;

    if (seenSources.has(sourceKey)) continue; // deduplicate by source file
    seenSources.add(sourceKey);

    // Check __tests__/ subdirectory first, then flat layout alongside source
    const candidates = [
      ...extensions.map(ext => `${dir}/__tests__/${base}${ext}`),
      ...extensions.map(ext => `${dir}/${base}${ext}`),
    ];

    for (const candidate of candidates) {
      if (existsFn(candidate)) {
        testFiles.push(candidate);
        break; // one test file per source file
      }
    }
  }

  return testFiles;
}

// Derive a Playwright --grep pattern from the flows affected by changed surfaces.
// Returns null when no flows are affected (caller falls back to @smoke only).
export function deriveScopedPlaywrightGrep(changeMap) {
  if (!changeMap?.surfaces?.length) return null;

  const flows = new Set();
  for (const surface of changeMap.surfaces) {
    for (const flow of surface.affects_flows || []) {
      if (flow) flows.add(flow);
    }
  }

  return flows.size > 0 ? [...flows].join('|') : null;
}

function buildPlaywrightCmd(mode, changeMap, failedTests) {
  if (mode === 'rerun' && failedTests?.playwright?.length > 0) {
    return `npx playwright test --reporter=json --grep "${failedTests.playwright.join('|')}"`;
  }
  if (mode === 'regression') return 'npx playwright test --reporter=json';

  // PR mode: always include @smoke, and add affected flow names when available
  const flowGrep = deriveScopedPlaywrightGrep(changeMap);
  const grepPattern = flowGrep ? `@smoke|${flowGrep}` : '@smoke';
  return `npx playwright test --grep "${grepPattern}" --reporter=json`;
}

// --- Failure extraction (also exported for tests) ---

export function extractVitestFailures(vitestOutput) {
  if (!vitestOutput || vitestOutput.error) return [];
  const failures = [];
  for (const result of vitestOutput.testResults || []) {
    const failedTests = (result.assertionResults || [])
      .filter(a => a.status === 'failed')
      .map(a => [...(a.ancestorTitles || []), a.title].join(' > '));
    if (failedTests.length > 0) {
      failures.push({ file: result.testFilePath, tests: failedTests });
    }
  }
  return failures;
}

export function extractPlaywrightFailures(playwrightOutput) {
  if (!playwrightOutput || playwrightOutput.error) return [];
  const failures = [];

  function walkSuites(suites, inheritedFile) {
    for (const suite of suites || []) {
      const file = suite.file || inheritedFile;
      for (const spec of suite.specs || []) {
        const failed = (spec.tests || []).some(t => (t.results || []).some(r => r.status === 'failed'));
        if (failed) failures.push({ file, test: spec.title });
      }
      walkSuites(suite.suites, file);
    }
  }

  walkSuites(playwrightOutput.suites, null);
  return failures;
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

import { execSync } from 'child_process';

export async function executeTests({ changeMap, mode, failedTests, config }) {
  const results = { vitest: null, playwright: null, failures: { vitest: [], playwright: [] } };
  const cwd = process.env.PROJECT_ROOT || process.cwd();
  const maxRetries = config.test_retry_count ?? 0;

  // --- Vitest ---
  let vitestCmd = buildVitestCmd(mode, changeMap, failedTests, config);
  let vitestAttempts = 0;

  while (vitestAttempts <= maxRetries) {
    try {
      const out = execSync(vitestCmd, { encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'], cwd });
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
  let playwrightCmd = buildPlaywrightCmd(mode, changeMap, failedTests);
  let playwrightAttempts = 0;

  while (playwrightAttempts <= maxRetries) {
    try {
      const out = execSync(playwrightCmd, { encoding: 'utf8', timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'], cwd });
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
  const unitPath = config.test_paths.unit;
  return `npx vitest run ${unitPath} --reporter=json`;
}

function buildPlaywrightCmd(mode, changeMap, failedTests) {
  if (mode === 'rerun' && failedTests?.playwright?.length > 0) {
    return `npx playwright test --reporter=json --grep "${failedTests.playwright.join('|')}"`;
  }
  if (mode === 'regression') return 'npx playwright test --reporter=json';
  return 'npx playwright test --grep @smoke --reporter=json';
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

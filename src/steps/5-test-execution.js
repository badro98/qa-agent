import { execSync } from 'child_process';

export async function executeTests({ changeMap, mode, config }) {
  const results = { vitest: null, playwright: null };

  // In regression mode, run the full suite
  // In PR mode, scope to affected test files only
  const vitestCmd = mode === 'regression'
    ? 'npx vitest run --reporter=json'
    : buildScopedVitestCmd(changeMap, config);

  const playwrightCmd = mode === 'regression'
    ? 'npx playwright test --reporter=json'
    : buildScopedPlaywrightCmd(changeMap, config);

  try {
    const vitestOutput = execSync(vitestCmd, {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    results.vitest = JSON.parse(vitestOutput);
  } catch (err) {
    // Vitest exits with non-zero on failure — capture output anyway
    results.vitest = { error: err.stdout || err.message };
  }

  try {
    const playwrightOutput = execSync(playwrightCmd, {
      encoding: 'utf8',
      timeout: 180000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    results.playwright = JSON.parse(playwrightOutput);
  } catch (err) {
    results.playwright = { error: err.stdout || err.message };
  }

  return results;
}

function buildScopedVitestCmd(changeMap, config) {
  if (!changeMap) return 'npx vitest run --reporter=json';
  const unitPath = config.test_paths.unit;
  // Run all unit tests for now — scoping by file requires more mapping logic
  return `npx vitest run ${unitPath} --reporter=json`;
}

function buildScopedPlaywrightCmd(changeMap, config) {
  if (!changeMap) return 'npx playwright test --reporter=json';
  // Run smoke suite for PR mode to keep it fast
  return `npx playwright test --grep @smoke --reporter=json`;
}

import { execSync } from 'child_process';
import { dirname, basename, extname, join } from 'path';
import { existsSync, readFileSync, unlinkSync, readdirSync } from 'fs';
import { tmpdir } from 'os';

export async function executeTests({ changeMap, mode, failedTests, config, execFn = execSync, readFileFn = readFileSync }) {
  const results = { vitest: null, playwright: null, failures: { vitest: [], playwright: [] } };
  const cwd = process.env.PROJECT_ROOT || process.cwd();
  const maxRetries = config.test_retry_count ?? 0;

  // 10-min default: pointd's 87-file suite needs ~135s of CPU, which blew the old
  // 120s cap on 4-vCPU CI runners (pointd#500, pointd#507 — spawnSync ETIMEDOUT).
  // Override per repo via config.test_timeouts.{unit,e2e} (ms).
  const timeouts = config.test_timeouts || {};
  const vitestTimeout = timeouts.unit ?? 600000;
  const playwrightTimeout = timeouts.e2e ?? 600000;
  // Full-suite --reporter=json output can approach node's 1MB maxBuffer default.
  const maxBuffer = 64 * 1024 * 1024;

  // --- Vitest ---
  // Results go through --outputFile, never the stdout pipe: capturing full-suite
  // JSON via the pipe ran ~10x slower than the identical run redirected to a file
  // (300s vs 23s locally), which is what blew the old 120s timeout in CI.
  const vitestOutputFile = join(tmpdir(), `qa-agent-vitest-${process.pid}.json`);
  let vitestCmd = withVitestOutputFile(buildVitestCmd(mode, changeMap, failedTests, config), vitestOutputFile);
  let vitestAttempts = 0;

  while (vitestAttempts <= maxRetries) {
    let execErr = null;
    try { unlinkSync(vitestOutputFile); } catch { /* nothing stale to clear */ }
    try {
      execFn(vitestCmd, { encoding: 'utf8', timeout: vitestTimeout, maxBuffer, stdio: ['pipe', 'pipe', 'pipe'], cwd });
    } catch (err) {
      execErr = err;
    }

    const parsed = tryReadJsonFile(vitestOutputFile, readFileFn);
    if (!execErr && parsed) {
      results.vitest = parsed;
      results.failures.vitest = []; // exit 0: all passed
      break;
    }

    results.vitest = parsed || { error: capOutput(execErr?.stdout || execErr?.stderr || execErr?.message || 'vitest wrote no JSON output') };
    results.failures.vitest = parsed ? extractVitestFailures(parsed) : [];

    if (vitestAttempts < maxRetries && results.failures.vitest.length > 0) {
      console.log(`Vitest: ${results.failures.vitest.length} failure(s). Retrying (attempt ${vitestAttempts + 2}/${maxRetries + 1})...`);
      // Scope next attempt to only failing files
      const failingFiles = results.failures.vitest.map(f => f.file).join(' ');
      vitestCmd = withVitestOutputFile(`npx vitest run ${failingFiles} --reporter=json`, vitestOutputFile);
    } else {
      break;
    }
    vitestAttempts++;
  }
  try { unlinkSync(vitestOutputFile); } catch { /* never written, or injected readFileFn */ }

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
      const out = execFn(playwrightCmd, { encoding: 'utf8', timeout: playwrightTimeout, maxBuffer, stdio: ['pipe', 'pipe', 'pipe'], cwd });
      results.playwright = JSON.parse(out);
      results.failures.playwright = [];
      break;
    } catch (err) {
      const parsed = tryParseJson(err.stdout);
      results.playwright = parsed || { error: capOutput(err.stdout || err.stderr || err.message) };
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
  const scopedFiles = deriveScopedTestFiles(changeMap, config);
  if (scopedFiles.length > 0) {
    return `npx vitest run ${scopedFiles.join(' ')} --reporter=json`;
  }

  // Fallback (no source files changed, e.g. docs/config only): run full unit suite
  const unitPath = config.test_paths.unit;
  return `npx vitest run ${unitPath} --reporter=json`;
}

// Derive test file paths from changed source files in the changeMap.
// Two layout families are checked:
//  - colocated: <dir>/__tests__/<base>.test.* preferred over <dir>/<base>.test.*
//    (first match wins — these are usually the same test in alternate spots)
//  - mirror: <test_paths.unit>[/<subdir>]/<base>.test.* (pointd keeps tests in
//    tests/unit + tests/integration; all matches are kept — they're distinct tests)
// Existence is checked against projectRoot because CI runs the agent from
// .qa-agent while the project lives at PROJECT_ROOT; returned paths stay
// project-relative since the vitest command executes with cwd=PROJECT_ROOT.
// Numeric prefixes like "5-" are stripped since test files don't carry them.
// Pass existsFn/readdirFn/projectRoot to override fs access (useful in tests).
export function deriveScopedTestFiles(changeMap, config, {
  existsFn = existsSync,
  readdirFn = listSubdirectories,
  projectRoot = process.env.PROJECT_ROOT || '.',
} = {}) {
  if (!changeMap?.surfaces?.length) return [];

  const extensions = ['.test.js', '.test.ts', '.test.tsx', '.test.jsx'];
  const seenSources = new Set();
  const testFiles = [];
  const addUnique = (file) => { if (!testFiles.includes(file)) testFiles.push(file); };

  const unitPath = config?.test_paths?.unit;
  const mirrorDirs = unitPath
    ? [unitPath, ...readdirFn(join(projectRoot, unitPath)).map(sub => join(unitPath, sub))]
    : [];

  for (const surface of changeMap.surfaces) {
    if (surface.type === 'test') continue;

    const file = surface.file;
    const dir = dirname(file);
    const base = basename(file, extname(file)).replace(/^\d+-/, '');
    const sourceKey = `${dir}/${base}`;

    if (seenSources.has(sourceKey)) continue; // deduplicate by source file
    seenSources.add(sourceKey);

    // Colocated: __tests__/ subdirectory first, then flat alongside source
    const colocated = [
      ...extensions.map(ext => `${dir}/__tests__/${base}${ext}`),
      ...extensions.map(ext => `${dir}/${base}${ext}`),
    ];
    for (const candidate of colocated) {
      if (existsFn(join(projectRoot, candidate))) {
        addUnique(candidate);
        break; // one colocated test file per source file
      }
    }

    // Mirror: keep every match — unit and integration tests are distinct
    for (const mirrorDir of mirrorDirs) {
      for (const ext of extensions) {
        const candidate = join(mirrorDir, `${base}${ext}`);
        if (existsFn(join(projectRoot, candidate))) addUnique(candidate);
      }
    }
  }

  return testFiles;
}

function listSubdirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return []; // test_paths.unit missing or unreadable: mirror layout just contributes nothing
  }
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
      // vitest v4 puts the file path in "name"; older jest-style output used "testFilePath"
      failures.push({ file: result.name ?? result.testFilePath, tests: failedTests });
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

function withVitestOutputFile(cmd, outputFile) {
  return `${cmd} --outputFile=${outputFile}`;
}

function tryReadJsonFile(path, readFileFn) {
  try { return JSON.parse(readFileFn(path, 'utf8')); } catch { return null; }
}

// Cap raw runner output before it enters results — an unparseable dump from a
// large suite can exceed the synthesis prompt's context limit (issue #6).
// Keeps the head (command/setup errors) and tail (final failure summary).
export function capOutput(str, head = 2000, tail = 2000) {
  if (typeof str !== 'string' || str.length <= head + tail) return str;
  return `${str.slice(0, head)}\n... [truncated ${str.length - head - tail} chars] ...\n${str.slice(-tail)}`;
}

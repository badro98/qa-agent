import { callClaude } from '../utils/anthropic.js';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readTestFiles(config) {
  const paths = [config.test_paths.unit, config.test_paths.e2e].filter(Boolean);
  const testFiles = [];

  for (const testPath of paths) {
    if (!existsSync(testPath)) continue;
    const files = readdirSync(testPath, { recursive: true })
      .filter(f => f.endsWith('.test.js') || f.endsWith('.test.ts') ||
                   f.endsWith('.spec.js') || f.endsWith('.spec.ts'));
    for (const file of files) {
      const content = readFileSync(join(testPath, file), 'utf8').slice(0, 1500);
      testFiles.push({ file: join(testPath, file), content });
    }
  }
  return testFiles;
}

export async function analyzeCoverage({ changeMap, config }) {
  const testFiles = readTestFiles(config);
  const systemPrompt = readFileSync(join(__dirname, '../../prompts/coverage-gap.md'), 'utf8');

  const userMessage = `
Change map:
${JSON.stringify(changeMap, null, 2)}

Existing test files:
${JSON.stringify(testFiles, null, 2)}

Identify which changed surfaces have NO test coverage.
Output JSON:
{
  "covered": ["list of files that have existing test coverage"],
  "gaps": [
    {
      "file": "string",
      "surface_type": "component | hook | store | api | flow",
      "missing_test_types": ["unit", "integration", "e2e"],
      "suggested_scenarios": ["list of specific scenarios that should be tested"]
    }
  ]
}
  `;

  const raw = await callClaude({ systemPrompt, userMessage, maxTokens: 2000 });
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

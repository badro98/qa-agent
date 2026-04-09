import { callClaude } from '../utils/anthropic.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function proposeTests({ coverageGaps, changeMap, config }) {
  const systemPrompt = readFileSync(join(__dirname, '../../prompts/test-proposals.md'), 'utf8');

  const userMessage = `
Project: ${config.project}
Platform: ${config.platform.join(', ')}
Test runners: Vitest (unit/integration), Playwright (e2e)

Coverage gaps:
${JSON.stringify(coverageGaps.gaps, null, 2)}

Change map context:
${JSON.stringify(changeMap, null, 2)}

For each gap, write concrete proposed test cases. Include:
- The test file path where this test should live
- The test runner to use (vitest or playwright)
- The full test code (not pseudocode — real, runnable test scaffolds)

Output JSON:
{
  "proposals": [
    {
      "gap_file": "string",
      "test_file_path": "string",
      "test_runner": "vitest | playwright",
      "tests": [
        {
          "name": "descriptive test name",
          "type": "unit | integration | e2e | smoke | regression",
          "code": "full test code as a string"
        }
      ]
    }
  ]
}
  `;

  const raw = await callClaude({ systemPrompt, userMessage, maxTokens: 16000 });
  const clean = raw.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error('proposeTests: failed to parse Claude response:\n', raw.slice(0, 500));
    throw e;
  }
}

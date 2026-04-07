import { callClaude } from '../utils/anthropic.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function scoreRisk({ changeMap, config }) {
  const systemPrompt = readFileSync(join(__dirname, '../../prompts/risk-scoring.md'), 'utf8');

  const userMessage = `
Change map:
${JSON.stringify(changeMap, null, 2)}

High risk surfaces for this project: ${config.high_risk_surfaces.join(', ')}
Critical flows: ${config.critical_flows.join(', ')}

Score each surface. Output JSON:
{
  "scores": [
    {
      "file": "string",
      "risk_level": "high | medium | low",
      "reason": "one sentence explanation",
      "test_priority": "must test | should test | optional"
    }
  ],
  "overall_risk": "high | medium | low"
}
  `;

  const raw = await callClaude({ systemPrompt, userMessage, maxTokens: 1500 });
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

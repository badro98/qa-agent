import { getPRDiff } from '../utils/github.js';
import { callClaude } from '../utils/anthropic.js';
import { readFileSync } from 'fs';

export async function analyzeDiff({ prNumber, repo, config }) {
  // Fetch changed files from GitHub
  const files = await getPRDiff({ repo, prNumber });

  // Build a condensed diff summary to send to Claude
  const diffSummary = files.map(f => ({
    filename: f.filename,
    status: f.status, // added, modified, removed
    changes: f.patch?.slice(0, 2000) ?? '' // cap patch size per file
  }));

  const systemPrompt = readFileSync('./prompts/diff-analysis.md', 'utf8');

  const userMessage = `
Project: ${config.project}
High risk surfaces: ${config.high_risk_surfaces.join(', ')}
Critical flows: ${config.critical_flows.join(', ')}

Changed files:
${JSON.stringify(diffSummary, null, 2)}

Produce a change map as JSON with this shape:
{
  "surfaces": [
    {
      "file": "string",
      "type": "component | hook | store | api | util | config | test",
      "description": "what this file does and what changed",
      "affects_flows": ["list of critical flows this touches, if any"],
      "is_high_risk": boolean
    }
  ],
  "summary": "one sentence summary of what this PR does"
}
  `;

  const raw = await callClaude({ systemPrompt, userMessage, maxTokens: 2000 });

  // Strip any markdown fences and parse JSON
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

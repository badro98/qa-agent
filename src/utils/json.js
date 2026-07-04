import { callClaude } from './anthropic.js';

// Scan from `start` for a balanced JSON object, tracking string/escape state
// so braces inside string values don't end the object early.
function balancedObjectAt(text, start) {
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unbalanced — truncated response
}

export function extractJson(raw) {
  const clean = raw.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {}

  // Fall back to the first brace that opens a balanced, parseable object.
  let idx = clean.indexOf('{');
  while (idx !== -1) {
    const candidate = balancedObjectAt(clean, idx);
    if (candidate) {
      try { return JSON.parse(candidate); } catch {}
    }
    idx = clean.indexOf('{', idx + 1);
  }
  throw new Error('extractJson: no valid JSON object found in response');
}

// Calls Claude and parses the response as JSON; retries the model call once
// on parse failure before failing with `${label}: ...` (CI greps this message).
export async function callClaudeJson({ label, ...params }, { callFn = callClaude } = {}) {
  let raw;
  for (let attempt = 1; attempt <= 2; attempt++) {
    raw = await callFn(params);
    try {
      return extractJson(raw);
    } catch {
      console.error(`${label}: attempt ${attempt} returned unparseable JSON:\n`, raw.slice(0, 500));
    }
  }
  throw new Error(`${label}: Claude response is not valid JSON`);
}

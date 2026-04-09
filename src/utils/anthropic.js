const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export const SONNET = 'claude-sonnet-4-6';
export const HAIKU  = 'claude-haiku-4-5-20251001';

export async function callClaude({ systemPrompt, userMessage, maxTokens = 1000, model = SONNET }) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  // Enable extended output for large token budgets
  if (maxTokens > 8192) {
    headers['anthropic-beta'] = 'output-128k-2025-02-19';
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

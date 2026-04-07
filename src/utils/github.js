const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const headers = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json'
};

export async function getPRDiff({ repo, prNumber }) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/pulls/${prNumber}/files`,
    { headers }
  );
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  return response.json(); // Array of changed files with patch/diff content
}

export async function postComment({ repo, prNumber, body }) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`,
    { method: 'POST', headers, body: JSON.stringify({ body }) }
  );
  if (!response.ok) throw new Error(`Failed to post comment: ${response.status}`);
  return response.json();
}

export async function createIssue({ repo, title, body, labels = [] }) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues`,
    { method: 'POST', headers, body: JSON.stringify({ title, body, labels }) }
  );
  if (!response.ok) throw new Error(`Failed to create issue: ${response.status}`);
  return response.json();
}

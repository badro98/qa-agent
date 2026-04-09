import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export function loadConfig() {
  const root = process.env.PROJECT_ROOT || '.';
  const configPath = join(root, 'qa-agent.config.json');
  if (!existsSync(configPath)) {
    throw new Error(`qa-agent.config.json not found at ${configPath}. Add one to the root of your repo.`);
  }
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

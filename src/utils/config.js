import { readFileSync, existsSync } from 'fs';

export function loadConfig() {
  const configPath = './qa-agent.config.json';
  if (!existsSync(configPath)) {
    throw new Error('qa-agent.config.json not found. Add one to the root of your repo.');
  }
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

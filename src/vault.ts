import { execFileSync } from 'node:child_process';
import type { LoginCredentials } from './client.ts';

export function readLogin(): LoginCredentials {
  let item: { fields: { id: string; value?: string }[] };
  try {
    const raw = execFileSync('op', ['item', 'get', 'park4night.com', '--vault', 'Agent', '--format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    item = JSON.parse(raw);
  } catch {
    throw new Error('The Park4night credential could not be read from 1Password.');
  }
  const username = item.fields.find(f => f.id === 'username')?.value;
  const password = item.fields.find(f => f.id === 'password')?.value;
  if (!username || !password) throw new Error('The Park4night login in the Agent vault is incomplete.');
  return { username, password };
}

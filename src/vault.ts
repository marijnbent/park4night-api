import { execFileSync } from 'node:child_process';
import type { LoginCredentials } from './client.ts';
import { Park4nightError } from './errors.ts';

export type VaultOptions = { vault?: string; item?: string; usernameField?: string; passwordField?: string; command?: string };

export function readLogin(options: VaultOptions = {}): LoginCredentials {
  const { vault = 'Agent', item = 'park4night.com', usernameField = 'username', passwordField = 'password', command = 'op' } = options;
  if ([vault, item, usernameField, passwordField, command].some(value => typeof value !== 'string' || !value.trim() || value.startsWith('-'))) throw new Park4nightError('INVALID_INPUT', 'Invalid 1Password configuration.');
  let fields: { id?: string; label?: string; value?: string }[];
  try {
    const raw = execFileSync(command, ['item', 'get', item, '--vault', vault, '--format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !('fields' in parsed) || !Array.isArray(parsed.fields) || parsed.fields.some(field => !field || typeof field !== 'object')) throw new Error();
    fields = parsed.fields;
  } catch {
    throw new Error('The Park4night credential could not be read from 1Password.');
  }
  const readField = (name: string): string | undefined => {
    const matches = fields.filter(field => field.id === name || field.label === name);
    return matches.length === 1 && typeof matches[0]?.value === 'string' ? matches[0].value : undefined;
  };
  const username = readField(usernameField), password = readField(passwordField);
  if (!username || !password) throw new Error('The Park4night login in 1Password is incomplete or has ambiguous fields.');
  return { username, password };
}

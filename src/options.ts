import { parseArgs } from 'node:util';
import { Park4nightError } from './errors.ts';
import { readLogin, type VaultOptions } from './vault.ts';
import type { LoginCredentials } from './client.ts';

export function parseOptions(args: string[]): { args: string[]; help: boolean; vault?: VaultOptions } {
  try {
    const parsed = parseArgs({ args, allowPositionals: true, options: {
      vault: { type: 'boolean' },
      'vault-name': { type: 'string' },
      item: { type: 'string' },
      'username-field': { type: 'string' },
      'password-field': { type: 'string' },
      'op-command': { type: 'string' },
      help: { type: 'boolean' }
    } });
    const v = parsed.values;
    return { args: parsed.positionals, help: v.help ?? false, ...(v.vault || v['vault-name'] || v.item || v['username-field'] || v['password-field'] || v['op-command'] ? { vault: { vault: v['vault-name'], item: v.item, usernameField: v['username-field'], passwordField: v['password-field'], command: v['op-command'] } } : {}) };
  } catch { throw new Park4nightError('INVALID_INPUT', 'Unknown option or missing option value. Run with --help.'); }
}

export function configuredLogin(vault?: VaultOptions): LoginCredentials | undefined {
  if (vault) return readLogin(vault);
  const username = process.env.PARK4NIGHT_USERNAME, password = process.env.PARK4NIGHT_PASSWORD;
  if (username === undefined && password === undefined) return undefined;
  if (!username || !password) throw new Park4nightError('INVALID_INPUT', 'Both PARK4NIGHT_USERNAME and PARK4NIGHT_PASSWORD are required.');
  return { username, password };
}

export const credentialHelp = '--vault [--vault-name NAME] [--item TITLE_OR_ID] [--username-field FIELD] [--password-field FIELD] [--op-command PATH]';

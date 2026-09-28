import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

function runVault(opSource: string, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'park4night-vault-test-'));
  try {
    writeFileSync(join(directory, 'op'), '#!' + process.execPath + '\n' + opSource, { mode: 0o700 });
    const source = `import { readLogin } from ${JSON.stringify(new URL('../src/vault.ts', import.meta.url).href)}; try { const login = readLogin(${JSON.stringify(options)}); console.log(JSON.stringify({ valid: login.username === 'fixture-user' && login.password === 'fixture-password' })); } catch (error) { console.error(error.message); process.exitCode = 1; }`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, PATH: directory + delimiter + (process.env.PATH ?? '') } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('1Password uses the documented item title and returns complete credentials', () => {
  const result = runVault(`const expected = ['item', 'get', 'park4night.com', '--vault', 'Agent', '--format', 'json']; if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(1); console.log(JSON.stringify({ fields: [{ id: 'username', value: 'fixture-user' }, { id: 'password', value: 'fixture-password' }] }));`);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { valid: true });
  assert.equal(result.stderr, '');
});

test('1Password command failure does not expose secret output', () => {
  const result = runVault("console.error('fixture-password'); console.log('fixture-user'); process.exit(1);");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes('fixture-'), false);
  assert.match(result.stderr, /could not be read/);
});

test('1Password rejects incomplete credentials', () => {
  const result = runVault("console.log(JSON.stringify({ fields: [{ id: 'username', value: 'fixture-user' }] }));");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /incomplete/);
  assert.equal(result.stderr.includes('fixture-user'), false);
});

test('1Password supports configured vault, item and field labels', () => {
  const result = runVault(`const expected = ['item', 'get', 'Travel login', '--vault', 'Trips', '--format', 'json']; if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(1); console.log(JSON.stringify({ fields: [{ id: 'custom1', label: 'email', value: 'fixture-user' }, { id: 'custom2', label: 'login password', value: 'fixture-password' }] }));`, { vault: 'Trips', item: 'Travel login', usernameField: 'email', passwordField: 'login password' });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { valid: true });
});

test('1Password rejects malformed field data with safe output', () => {
  for (const data of [{}, { fields: null }, { fields: [null] }]) {
    const result = runVault('console.log(' + JSON.stringify(JSON.stringify(data)) + ');');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not be read/);
  }
});

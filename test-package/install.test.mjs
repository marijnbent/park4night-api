import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve('.');
const npmEnv = { ...process.env };
for (const key of Object.keys(npmEnv)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete npmEnv[key];
const work = mkdtempSync(join(tmpdir(), 'park4night-install-'));
let archive;
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], { cwd: root, env: npmEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
  archive = packed;
  writeFileSync(join(work, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(work, packed.filename)], { cwd: work, env: npmEnv, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  rmSync(work, { recursive: true, force: true });
  throw error;
}

test.after(() => rmSync(work, { recursive: true, force: true }));

test('tarball contains compiled files and license without source, tests, or local data', () => {
  const paths = archive.files.map(file => file.path);
  assert.ok(paths.includes('dist/client.js'));
  assert.ok(paths.includes('dist/client.d.ts'));
  assert.ok(paths.includes('dist/mcp-cli.js'));
  assert.ok(paths.includes('LICENSE'));
  assert.ok(paths.every(path => path.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE'].includes(path)));
  const pkg = JSON.parse(readFileSync(join(work, 'node_modules/park4night-unofficial/package.json')));
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.private, undefined);
});

test('installed package imports in plain Node and exposes executable CLI help', () => {
  const source = "import { Park4nightClient, RequestScheduler } from 'park4night-unofficial'; import { readLogin } from 'park4night-unofficial/vault'; console.log(typeof Park4nightClient, typeof RequestScheduler, typeof readLogin);";
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: work, encoding: 'utf8' }).trim(), 'function function function');
  const help = execFileSync(join(work, 'node_modules/.bin/park4night'), ['--help'], { cwd: work, encoding: 'utf8' });
  assert.match(help, /public-places/);
  assert.match(help, /--vault-name/);
});

test('installed declaration files type-check for a consuming application', () => {
  writeFileSync(join(work, 'consumer.mts'), "import { Park4nightClient, RequestScheduler, type Review, type Photo } from 'park4night-unofficial'; const client = new Park4nightClient({ scheduler: new RequestScheduler() }); const reviews: Review[] = await client.reviews(1); const photos: Photo[] = (await client.place(1)).photos; const numeric: number | null = reviews[0]?.rating ?? null; void photos; void numeric;");
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', '--strict', 'consumer.mts'], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
});

test('installed MCP executable completes stdio handshake and tool calls', async () => {
  const preload = 'data:text/javascript,' + encodeURIComponent("globalThis.fetch = async () => new Response(JSON.stringify({status:'OK',lieux:[{id:'1',latitude:'0',longitude:'0',name:'Fixture'}]}));");
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', preload, join(work, 'node_modules/park4night-unofficial/dist/mcp-cli.js')], cwd: work, env: {}, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'package-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 8);
    const response = await client.callTool({ name: 'get_place', arguments: { id: 1 } });
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.result.id, 1);
    assert.equal(stderr, '');
  } finally { await client.close(); }
});

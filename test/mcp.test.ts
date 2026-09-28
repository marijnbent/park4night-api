import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Park4nightClient, type Transport } from '../src/client.ts';
import { createMcpServer } from '../src/mcp.ts';

async function connect(t: TestContext, transport: Transport) {
  const api = new Park4nightClient({ transport, rateLimit: { minIntervalMs: 0, maxRetries: 0 } });
  const server = createMcpServer(api);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, api };
}

test('MCP handshake lists only read tools with explicit schemas', async t => {
  const { client } = await connect(t, async () => { assert.fail('Listing tools must not send HTTP'); });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 8);
  assert.ok(tools.every(tool => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));
  assert.ok(tools.every(tool => !/login|password|delete|add|create_folder/.test(tool.name)));
  const search = tools.find(tool => tool.name === 'search_places')!;
  assert.equal(search.inputSchema.type, 'object');
  assert.equal(search.inputSchema.additionalProperties, false);
});

test('MCP validates input before sending requests and returns bounded search summaries', async t => {
  let calls = 0;
  const { client } = await connect(t, async () => {
    calls++;
    return new Response(JSON.stringify({ status: 'OK', lieux: Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), latitude: '0', longitude: '0', name: 'Place', description_en: 'Long text' })) }));
  });
  const invalid = await client.callTool({ name: 'search_places', arguments: { lat: 0, lng: 0, filter: { services: 'wifi' } } });
  assert.equal(invalid.isError, true);
  assert.equal(calls, 0);
  const valid = await client.callTool({ name: 'search_places', arguments: { lat: 0, lng: 0, limit: 3 } });
  assert.equal(valid.isError, undefined);
  const result = (valid.structuredContent as Record<string, unknown> | undefined)?.result as { places: unknown[]; limited: boolean; mayBeTruncated: boolean; returnedByUpstream: number };
  assert.equal(result.places.length, 3);
  assert.equal(result.limited, true);
  assert.equal(result.mayBeTruncated, true);
  assert.equal(result.returnedByUpstream, 100);
  assert.equal(JSON.stringify(result).includes('Long text'), false);
});

test('MCP returns safe authentication and rate-limit errors', async t => {
  const { client } = await connect(t, async () => new Response('private upstream body', { status: 429, headers: { 'Retry-After': '60' } }));
  const unauthenticated = await client.callTool({ name: 'get_bookmarks', arguments: {} });
  assert.equal(unauthenticated.isError, true);
  assert.equal((unauthenticated.structuredContent as Record<string, unknown> | undefined)?.error, 'AUTH_REQUIRED');
  const limited = await client.callTool({ name: 'get_place', arguments: { id: 1 } });
  assert.equal((limited.structuredContent as Record<string, unknown> | undefined)?.error, 'RATE_LIMITED');
  assert.equal((limited.structuredContent as Record<string, unknown> | undefined)?.retryAfterMs, 60000);
  assert.equal(JSON.stringify(limited).includes('private upstream'), false);
});

test('MCP account reads use startup-authenticated client without exposing credentials', async t => {
  const { client, api } = await connect(t, async url => new Response(JSON.stringify(url.includes('userGet')
    ? { status: 'OK', results: { id: '7', uuid: 'fixture', email: 'fixture@example.test', motdepasse: 'private', abo_annuel_date_fin: '0000-00-00', abo_mensuel_date_fin: '0000-00-00' } }
    : { status: 'OK', folders: [{ id: '0', name: 'selection', size_max: '200', id_lieux: '1,2' }], lieux: [] })));
  await api.login({ username: 'fixture', password: 'private' });
  const result = await client.callTool({ name: 'list_folders', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual((result.structuredContent as Record<string, unknown> | undefined)?.result, [{ id: 0, name: 'selection', icon: '', bookmarkCount: 2, capacity: 200 }]);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('MCP cancellation reaches the in-flight HTTP request', async t => {
  let aborted = false, started = false;
  const { client } = await connect(t, async (_url, init) => new Promise((_resolve, reject) => {
    started = true;
    init.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, { once: true });
  }));
  const controller = new AbortController();
  const request = assert.rejects(client.callTool({ name: 'get_place', arguments: { id: 1 } }, undefined, { signal: controller.signal }));
  await settle();
  assert.equal(started, true);
  controller.abort();
  await request;
  await settle();
  assert.equal(aborted, true);
});

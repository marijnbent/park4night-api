import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Park4nightClient, Park4nightError, type Transport } from '../src/client.ts';

const start = Date.UTC(2026, 8, 27, 12);
const ok = () => new Response(JSON.stringify({ status: 'OK', lieux: [{ id: '1', latitude: '0', longitude: '0' }] }));
const limited = (retryAfter?: string) => new Response('private upstream message', { status: 429, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } });
const user = { id: '7', uuid: 'name', email: '', abo_annuel_date_fin: '0000-00-00', abo_mensuel_date_fin: '0000-00-00' };

test('queues concurrent requests and spaces starts with default settings', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const starts: number[] = [];
  let finishFirst!: (response: Response) => void;
  const client = new Park4nightClient({ transport: async () => {
    starts.push(Date.now());
    return starts.length === 1 ? new Promise(resolve => { finishFirst = resolve; }) : ok();
  } });
  const requests = Promise.all([client.place(1), client.place(1), client.place(1)]);
  await settle();
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(starts.length, 1);
  finishFirst(ok());
  await settle();
  assert.deepEqual(starts, [start, start + 2000]);
  t.mock.timers.tick(999);
  await settle();
  assert.equal(starts.length, 2);
  t.mock.timers.tick(1);
  await requests;
  assert.deepEqual(starts, [start, start + 2000, start + 3000]);
});

test('honors Retry-After seconds and keeps queued requests behind the retry', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const starts: number[] = [];
  const client = new Park4nightClient({ transport: async () => { starts.push(Date.now()); return starts.length === 1 ? limited('2') : ok(); } });
  const requests = Promise.all([client.place(1), client.place(1)]);
  await settle();
  t.mock.timers.tick(1999);
  await settle();
  assert.deepEqual(starts, [start]);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(starts, [start, start + 2000]);
  t.mock.timers.tick(1000);
  await requests;
  assert.deepEqual(starts, [start, start + 2000, start + 3000]);
});

test('honors HTTP-date Retry-After values', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  let calls = 0;
  const client = new Park4nightClient({ transport: async () => ++calls === 1 ? limited(new Date(start + 5000).toUTCString()) : ok() });
  const request = client.place(1);
  await settle();
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await request;
  assert.equal(calls, 2);
});

test('uses bounded exponential retries for missing or invalid Retry-After', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  t.mock.method(Math, 'random', () => 0);
  const starts: number[] = [];
  const client = new Park4nightClient({ transport: async () => { starts.push(Date.now()); return limited(starts.length === 1 ? undefined : '0.5'); } });
  const rejected = assert.rejects(client.place(1), { code: 'RATE_LIMITED', status: 429, retryAfterMs: 4000 });
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  t.mock.timers.tick(2000);
  await rejected;
  assert.deepEqual(starts, [start, start + 1000, start + 3000]);
});

test('does not shorten long cooldowns or send more calls while paused', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  let calls = 0;
  const client = new Park4nightClient({ transport: async () => { calls++; return limited('3600'); } });
  await assert.rejects(client.place(1), { code: 'RATE_LIMITED', retryAfterMs: 3600000 });
  await assert.rejects(client.place(1), { code: 'RATE_LIMITED', retryAfterMs: 3600000 });
  assert.equal(calls, 1);
  t.mock.timers.tick(3600000);
  await assert.rejects(client.place(1), { code: 'RATE_LIMITED' });
  assert.equal(calls, 2);
});

test('never retries a write and applies its cooldown to later reads', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  let writes = 0, reads = 0;
  const transport: Transport = async (url, init) => {
    if (url.includes('userGet')) return new Response(JSON.stringify({ status: 'OK', results: user }));
    if (init.method === 'POST') { writes++; return limited('2'); }
    reads++;
    return ok();
  };
  const client = new Park4nightClient({ transport, rateLimit: { minIntervalMs: 0 } });
  await client.login({ username: 'name', password: 'secret' });
  await assert.rejects(client.addBookmark(1), { code: 'RATE_LIMITED', retryAfterMs: 2000 });
  const read = client.place(1);
  await settle();
  assert.equal(reads, 0);
  t.mock.timers.tick(2000);
  await read;
  assert.equal(writes, 1);
  assert.equal(reads, 1);
});

test('a failed request does not break the queue and network errors are not retried', async () => {
  let calls = 0;
  const client = new Park4nightClient({ rateLimit: { minIntervalMs: 0 }, transport: async () => {
    if (++calls === 1) throw new Error('secret URL');
    return ok();
  } });
  const results = await Promise.allSettled([client.place(1), client.place(1)]);
  assert.equal(calls, 2);
  assert.equal(results[0]?.status, 'rejected');
  assert.equal(results[1]?.status, 'fulfilled');
});

test('zero retries reports the delay and errors do not expose upstream text', async () => {
  const client = new Park4nightClient({ rateLimit: { maxRetries: 0 }, transport: async () => limited('0') });
  await assert.rejects(client.place(1), error => {
    assert.ok(error instanceof Park4nightError);
    assert.equal(error.retryAfterMs, 0);
    assert.equal(JSON.stringify(error).includes('private'), false);
    return true;
  });
});

test('rejects invalid rate-limit configuration', () => {
  for (const rateLimit of [{ minIntervalMs: -1 }, { minIntervalMs: Infinity }, { maxRetries: 1.5 }, { maxRetries: 6 }, { maxWaitMs: 60001 }]) {
    assert.throws(() => new Park4nightClient({ rateLimit }), { code: 'INVALID_INPUT' });
  }
});

test('CLI reports a safe retry delay as JSON', () => {
  const preload = 'data:text/javascript,' + encodeURIComponent("globalThis.fetch = async () => new Response('hidden credential', { status: 429, headers: { 'Retry-After': '3600' } });");
  const env = { ...process.env };
  delete env.PARK4NIGHT_USERNAME;
  delete env.PARK4NIGHT_PASSWORD;
  const result = spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'place', '1'], { encoding: 'utf8', env });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(error.error, 'RATE_LIMITED');
  assert.ok(error.retryAfterMs >= 3599000 && error.retryAfterMs <= 3600000);
  assert.equal(result.stderr.includes('hidden credential'), false);
});

test('zero and past Retry-After values still respect request spacing', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const starts: number[] = [];
  const client = new Park4nightClient({ transport: async () => {
    starts.push(Date.now());
    if (starts.length === 1) return limited('0');
    if (starts.length === 2) return limited(new Date(start - 60000).toUTCString());
    return ok();
  } });
  const result = client.place(1);
  await settle();
  for (let i = 1; i <= 2; i++) {
    t.mock.timers.tick(999);
    await settle();
    assert.equal(starts.length, i);
    t.mock.timers.tick(1);
    await settle();
  }
  await result;
  assert.deepEqual(starts, [start, start + 1000, start + 2000]);
});

test('waits at the configured cooldown boundary and resumes after exhausted retries', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  let calls = 0;
  const client = new Park4nightClient({ rateLimit: { maxRetries: 0, maxWaitMs: 2000 }, transport: async () => ++calls === 1 ? limited('3') : ok() });
  await assert.rejects(client.place(1), { code: 'RATE_LIMITED', retryAfterMs: 3000 });
  t.mock.timers.tick(999);
  await assert.rejects(client.place(1), { code: 'RATE_LIMITED', retryAfterMs: 2001 });
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  const result = client.place(1);
  await settle();
  t.mock.timers.tick(1999);
  await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await result;
  assert.equal(calls, 2);
});

test('huge numeric Retry-After cannot overflow into an immediate retry', async () => {
  let calls = 0;
  const client = new Park4nightClient({ transport: async () => { calls++; return limited('9'.repeat(400)); } });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(client.place(1), error => {
      assert.ok(error instanceof Park4nightError);
      assert.equal(error.code, 'RATE_LIMITED');
      assert.ok(Number.isSafeInteger(error.retryAfterMs));
      assert.ok(error.retryAfterMs! > 1e12);
      return true;
    });
  }
  assert.equal(calls, 1);
});

test('invalid dates use fallback delay including the upper jitter range', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  t.mock.method(Math, 'random', () => 0.9999);
  let calls = 0;
  const client = new Park4nightClient({ transport: async () => ++calls === 1 ? limited('Sun, not a date') : ok() });
  const result = client.place(1);
  await settle();
  t.mock.timers.tick(1248);
  await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await result;
  assert.equal(calls, 2);
});

test('does not release the queue before the response body is consumed', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let calls = 0;
  const client = new Park4nightClient({ transport: async () => ++calls === 1 ? new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } })) : ok() });
  const results = Promise.all([client.place(1), client.place(1)]);
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls, 1);
  stream.enqueue(new TextEncoder().encode(await ok().text()));
  stream.close();
  await results;
  assert.equal(calls, 2);
});

test('body read failure releases the queue without retrying or exposing its error', async () => {
  let calls = 0;
  const client = new Park4nightClient({ rateLimit: { minIntervalMs: 0 }, transport: async () => ++calls === 1 ? new Response(new ReadableStream({ start(controller) { controller.error(new Error('private response URL')); } })) : ok() });
  const rejected = assert.rejects(client.place(1), error => {
    assert.ok(error instanceof Park4nightError);
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.message.includes('private'), false);
    return true;
  });
  const success = client.place(1);
  await Promise.all([rejected, success]);
  assert.equal(calls, 2);
});

test('a rejected 429 response-body cancellation does not lose the cooldown', async () => {
  let cancelled = false;
  const client = new Park4nightClient({ rateLimit: { maxRetries: 0 }, transport: async () => new Response(new ReadableStream({ cancel() { cancelled = true; throw new Error('private cancellation error'); } }), { status: 429, headers: { 'Retry-After': '60' } }) });
  await assert.rejects(client.place(1), { code: 'RATE_LIMITED', status: 429 });
  assert.equal(cancelled, true);
  await assert.rejects(client.place(1), { code: 'RATE_LIMITED' });
});

test('login retries retain credentials and use a fresh timeout signal', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const requests: { url: string; signal: AbortSignal | null | undefined }[] = [];
  const client = new Park4nightClient({ transport: async (url, init) => {
    requests.push({ url, signal: init.signal });
    return requests.length === 1 ? limited('1') : new Response(JSON.stringify({ status: 'OK', results: user }));
  } });
  const login = client.login({ username: 'name', password: 'secret' });
  await settle();
  await assert.rejects(client.folders(), { code: 'AUTH_REQUIRED' });
  t.mock.timers.tick(1000);
  assert.equal((await login).id, 7);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, requests[1]?.url);
  assert.notEqual(requests[0]?.signal, requests[1]?.signal);
  assert.equal(requests[1]?.signal?.aborted, false);
});

test('HTTP 5xx and invalid JSON do not trigger retries or block later calls', async () => {
  let calls = 0;
  const client = new Park4nightClient({ rateLimit: { minIntervalMs: 0 }, transport: async () => {
    if (++calls === 1) return new Response('private error', { status: 503, headers: { 'Retry-After': '60' } });
    if (calls === 2) return new Response('invalid JSON');
    return ok();
  } });
  await Promise.all([
    assert.rejects(client.place(1), { code: 'UPSTREAM_ERROR', status: 503 }),
    assert.rejects(client.place(1), { code: 'INVALID_RESPONSE' }),
    client.place(1)
  ]);
  assert.equal(calls, 3);
});

test('a larger concurrent batch stays in order without bursts', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const starts: number[] = [], ids: number[] = [];
  const client = new Park4nightClient({ transport: async url => {
    const id = Number(new URL(url).searchParams.get('id'));
    starts.push(Date.now());
    ids.push(id);
    return new Response(JSON.stringify({ status: 'OK', lieux: [{ id, latitude: '0', longitude: '0' }] }));
  } });
  const result = Promise.all(Array.from({ length: 25 }, (_, i) => client.place(i + 1)));
  await settle();
  for (let i = 1; i < 25; i++) {
    assert.equal(starts.length, i);
    t.mock.timers.tick(1000);
    await settle();
  }
  await result;
  assert.deepEqual(ids, Array.from({ length: 25 }, (_, i) => i + 1));
  assert.deepEqual(starts, Array.from({ length: 25 }, (_, i) => start + i * 1000));
});

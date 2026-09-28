import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Park4nightClient, RequestScheduler, type SearchOptions, type LoginCredentials } from '../src/client.ts';

const json = (data: unknown) => new Response(JSON.stringify(data));
const user = { id: '7', uuid: 'fixture', email: 'fixture@example.test', abo_annuel_date_fin: '0000-00-00', abo_mensuel_date_fin: '0000-00-00' };
const place = { id: '1', latitude: '0', longitude: '0' };
const login = { username: 'fixture', password: 'fixture' };
const data = () => json({ status: 'OK', lieux: [place] });

test('all malformed search inputs fail before any request is sent', async () => {
  let calls = 0;
  const client = new Park4nightClient({ transport: async () => { calls++; return data(); } });
  const filters = [{ services: 'wifi' }, { type: 'PN' }, { type: [5] }, { activities: null }, { rating: 'not-a-rating' }, { rating: '6' }, { rating: 4 }, { rating: '-1' }, { maxHeight: '0' }, { maxHeight: 'Infinity' }, { all_year: true }, { booking_filter: '2' }, { typo: [] }, null, []];
  for (const filter of filters) await assert.rejects(client.search({ lat: 0, lng: 0, filter } as unknown as SearchOptions), { code: 'INVALID_INPUT' });
  for (const value of [null, {}, { lat: '0', lng: 0 }, { lat: 0, lng: Infinity }, { lat: 0, lng: 0, maxDistanceKm: NaN }]) await assert.rejects(client.search(value as SearchOptions), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
});

test('malformed credentials and folder values return structured errors', async () => {
  const client = new Park4nightClient({ transport: async () => { assert.fail('Unexpected request'); } });
  await assert.rejects(client.login(null as unknown as LoginCredentials), { code: 'INVALID_INPUT' });
  await assert.rejects(client.createFolder(null as unknown as string, 'x'), { code: 'INVALID_INPUT' });
  await assert.rejects(client.updateFolder(null as never), { code: 'INVALID_INPUT' });
});

test('logout prevents a pending login from restoring authentication', async () => {
  let release!: () => void;
  const client = new Park4nightClient({ rateLimit: { minIntervalMs: 0 }, transport: async () => new Promise(resolve => { release = () => resolve(json({ status: 'OK', results: user })); }) });
  const rejected = assert.rejects(client.login(login), { code: 'CANCELLED' });
  await settle();
  client.logout();
  release();
  await rejected;
  await assert.rejects(client.folders(), { code: 'AUTH_REQUIRED' });
});

test('a newer login supersedes an older login without mixing account state', async () => {
  let release!: () => void, calls = 0;
  const client = new Park4nightClient({ rateLimit: { minIntervalMs: 0 }, transport: async () => {
    if (++calls === 1) return new Promise(resolve => { release = () => resolve(json({ status: 'OK', results: user })); });
    return json({ status: 'OK', results: { ...user, id: '8', uuid: 'second' } });
  } });
  const oldLogin = assert.rejects(client.login(login), { code: 'CANCELLED' });
  await settle();
  const newLogin = client.login({ ...login, username: 'second' });
  release();
  await oldLogin;
  assert.equal((await newLogin).id, 8);
  assert.equal((await client.me()).username, 'second');
});

test('logout cancels an authenticated queued write before transmission', async () => {
  let release!: () => void, writes = 0;
  const client = new Park4nightClient({ rateLimit: { minIntervalMs: 0 }, transport: async (url, init) => {
    if (url.includes('userGet')) return json({ status: 'OK', results: user });
    if (init.method === 'POST') { writes++; return json({ status: 'OK' }); }
    return new Promise(resolve => { release = () => resolve(data()); });
  } });
  await client.login(login);
  const read = assert.rejects(client.place(1), { code: 'CANCELLED' });
  await settle();
  const write = assert.rejects(client.addBookmark(1), { code: 'CANCELLED' });
  client.logout();
  await write;
  release();
  await read;
  assert.equal(writes, 0);
});

test('cancellation removes a queued request and frees its queue slot immediately', async () => {
  let release!: () => void, calls = 0;
  const client = new Park4nightClient({ rateLimit: { minIntervalMs: 0, maxQueueSize: 1 }, transport: async () => {
    if (++calls === 1) return new Promise(resolve => { release = () => resolve(data()); });
    return data();
  } });
  const first = client.place(1);
  await settle();
  const controller = new AbortController();
  const second = assert.rejects(client.place(1, { signal: controller.signal }), { code: 'CANCELLED' });
  await assert.rejects(client.place(1), { code: 'QUEUE_FULL' });
  controller.abort('private reason');
  await second;
  const replacement = client.place(1);
  release();
  await Promise.all([first, replacement]);
  assert.equal(calls, 2);
});

test('active cancellation aborts transport without leaking the abort reason', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = new Park4nightClient({ rateLimit: { minIntervalMs: 0 }, transport: async (_url, init) => {
    if (++calls > 1) return data();
    return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('private transport reason')), { once: true }));
  } });
  const request = assert.rejects(client.place(1, { signal: controller.signal }), error => {
    assert.equal((error as { code: string }).code, 'CANCELLED');
    assert.equal(String(error).includes('private'), false);
    return true;
  });
  await settle();
  controller.abort('private reason');
  await request;
  await client.place(1);
  assert.equal(calls, 2);
});

test('cancels a cooldown wait without erasing the shared cooldown', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let calls = 0;
  const scheduler = new RequestScheduler();
  const transport = async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '5' } }) : data();
  const a = new Park4nightClient({ scheduler, transport }), b = new Park4nightClient({ scheduler, transport });
  const controller = new AbortController();
  const first = assert.rejects(a.place(1, { signal: controller.signal }), { code: 'CANCELLED' });
  await settle();
  controller.abort();
  await first;
  const next = b.place(1);
  await settle();
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await next;
  assert.equal(calls, 2);
});

test('two clients sharing a scheduler cannot bypass request spacing', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const scheduler = new RequestScheduler(), starts: number[] = [];
  const transport = async () => { starts.push(Date.now()); return data(); };
  const a = new Park4nightClient({ scheduler, transport }), b = new Park4nightClient({ scheduler, transport });
  const requests = Promise.all([a.place(1), b.place(1)]);
  await settle();
  t.mock.timers.tick(999);
  await settle();
  assert.equal(starts.length, 1);
  t.mock.timers.tick(1);
  await requests;
  assert.deepEqual(starts, [100000, 101000]);
});

test('public user reads use exact native parameters without login', async () => {
  const sent: URL[] = [];
  const client = new Park4nightClient({ rateLimit: { minIntervalMs: 0 }, transport: async url => { sent.push(new URL(url)); return data(); } });
  await client.publicPlaces({ kind: 'created', username: 'fixture' });
  await client.publicPlaces({ kind: 'visited', username: 'fixture' });
  await client.publicPlaces({ kind: 'commented', userId: 7 });
  assert.equal(sent[0]?.pathname, '/services/V4.1/lieuGetUser.php');
  assert.equal(sent[0]?.searchParams.get('uuid'), 'fixture');
  assert.equal(sent[1]?.searchParams.get('visites'), 'true');
  assert.equal(sent[2]?.pathname, '/services/V4.1/lieuGetCommUser.php');
  assert.equal(sent[2]?.searchParams.get('user_id'), '7');
  assert.equal(sent.some(url => url.searchParams.has('motdepasse')), false);
  await assert.rejects(client.publicPlaces({ kind: 'commented', username: 'fixture' } as never), { code: 'INVALID_INPUT' });
});

test('normalizes photos, services, ratings, and reviews while keeping native fields', async () => {
  const client = new Park4nightClient({ rateLimit: { minIntervalMs: 0 }, transport: async url => url.includes('commGet')
    ? json({ status: 'OK', commentaires: [{ id: '3', pn_lieu_id: '1', note: '4', commentaire: 'Quiet', uuid: 'fixture', date_creation: '2026-09-28', type_vehicule: 'V' }] })
    : json({ status: 'OK', lieux: [{ ...place, note_moyenne: '4.5', nb_commentaires: '12', wifi: '1', douche: '0', photos: [{ id: '2', link_large: 'https://example.test/large.jpg', link_thumb: 'https://example.test/small.jpg' }] }] }) });
  const p = await client.place(1);
  assert.equal(p.rating, 4.5);
  assert.equal(p.reviewCount, 12);
  assert.deepEqual(p.services, { douche: false, wifi: true });
  assert.equal(p.photos[0]?.id, 2);
  assert.equal(p.photos[0]?.largeUrl, 'https://example.test/large.jpg');
  assert.equal(p.note_moyenne, '4.5');
  const review = (await client.reviews(1))[0]!;
  assert.equal(review.rating, 4);
  assert.equal(review.text, 'Quiet');
  assert.equal(review.type_vehicule, 'V');
});

test('CLI rejects malformed filter JSON and invalid runtime types without network access', () => {
  const preload = 'data:text/javascript,' + encodeURIComponent("globalThis.fetch = async () => { throw new Error('Unexpected network request'); };");
  const env = { ...process.env };
  delete env.PARK4NIGHT_USERNAME;
  delete env.PARK4NIGHT_PASSWORD;
  for (const filter of ['{', '{"type":"PN"}', '{"services":"wifi"}']) {
    const result = spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'search', '0', '0', '10', filter], { encoding: 'utf8', env });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error, 'INVALID_INPUT');
  }
});

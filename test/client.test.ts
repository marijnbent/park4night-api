import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Park4nightClient, Park4nightError, type Transport } from '../src/client.ts';

const user = { id: '7', uuid: 'canonical', email: 'user@example.test', motdepasse: 'never-return-this', abo_annuel_date_fin: '2099-01-01', abo_mensuel_date_fin: '0000-00-00' };
const place = { id: '1', latitude: '52.37', longitude: '4.9', name: 'Évora' };
const folder = { id: '8', name: 'Trip', icon: '🚐', size_max: '500', id_lieux: '1,2' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const credentials = { username: ' input name ', password: ' private ' };
const hash = createHash('sha256').update('private').digest('hex');
function stub(handler: Transport) { return new Park4nightClient({ transport: handler, rateLimit: { minIntervalMs: 0, maxRetries: 0 } }); }
function signed(handler: Transport) { return stub(async (url, init) => new URL(url).pathname.endsWith('/userGet.php') ? json({ status: 'OK', results: user }) : handler(url, init)); }

test('logs in with native SHA256 and sends canonical identity without cookies', async () => {
  let calls = 0;
  const client = stub(async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://park4night.com');
    assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).get('cookie'), null);
    assert.equal(u.searchParams.get('motdepasse'), hash);
    if (calls++ === 0) {
      assert.equal(u.pathname, '/services/V4.1/userGet.php');
      assert.equal(u.searchParams.get('uuid'), 'inputname');
      return json({ status: 'OK', results: user });
    }
    assert.equal(u.searchParams.get('context_user'), 'canonical');
    assert.equal(u.searchParams.get('context_id_user'), '7');
    return json({ status: 'OK', folders: [folder], lieux: [] });
  });
  const account = await client.login(credentials);
  assert.equal(account.id, 7);
  assert.equal(account.isPremium, true);
  assert.equal(JSON.stringify(account).includes('never-return-this'), false);
  assert.equal(JSON.stringify(client).includes(hash), false);
  assert.equal((await client.folders())[0]?.id, 8);
  client.logout();
  await assert.rejects(client.folders(), { code: 'AUTH_REQUIRED' });
});

test('failed reauthentication clears old credentials and hides upstream secrets', async () => {
  let calls = 0;
  const client = stub(async () => calls++ === 0 ? json({ status: 'OK', results: user }) : json({ status: 'error_pwd_error', error: 'private' }));
  await client.login(credentials);
  await assert.rejects(client.login(credentials), error => {
    assert.ok(error instanceof Park4nightError);
    assert.equal(error.code, 'AUTH_REJECTED');
    assert.equal(error.message.includes('private'), false);
    return true;
  });
  await assert.rejects(client.bookmarks(), { code: 'AUTH_REQUIRED' });
});

test('requires validated account data before accepting login', async () => {
  await assert.rejects(stub(async () => json({ status: 'OK', results: {} })).login(credentials), { code: 'INVALID_RESPONSE' });
});

test('normalizes native place coordinates and applies a distance filter', async () => {
  const client = stub(async (url) => {
    const q = new URL(url).searchParams;
    assert.equal(q.get('latitude'), '52.37');
    assert.equal(q.get('types'), 'P-N');
    assert.equal(q.get('services'), 'wifi');
    assert.equal(q.get('activites'), 'rando');
    assert.equal(q.get('note'), '4');
    assert.equal(q.get('all_year'), '1');
    assert.equal(q.get('online_booking'), '1');
    assert.equal(q.get('hauteur_limite'), '3');
    return json({ status: 'OK', lieux: [place, { ...place, id: '2', latitude: '40' }] });
  });
  const result = await client.search({ lat: 52.37, lng: 4.9, maxDistanceKm: 5, filter: { type: ['P'], custom_type: ['N'], services: ['wifi'], activities: ['rando'], rating: '4', maxHeight: '3', all_year: '1', booking_filter: '1' } });
  assert.equal(result.places[0]?.name, 'Évora');
  assert.equal(result.places[0]?.lat, 52.37);
  assert.equal(result.places.length, 1);
  assert.equal(result.returnedByUpstream, 2);
});

test('marks capped search as possibly incomplete', async () => {
  const client = stub(async () => json({ status: 'OK', lieux: Array.from({ length: 100 }, (_, i) => ({ ...place, id: String(i + 1) })) }));
  assert.equal((await client.search({ lat: 0, lng: 0 })).mayBeTruncated, true);
});

test('retains missing bookmark references and accepts default folder zero', async () => {
  const client = signed(async (url) => {
    assert.equal(new URL(url).searchParams.get('folder_id'), '0');
    return json({ status: 'OK', folders: [{ ...folder, id: '0', icon: undefined }], lieux: [place] });
  });
  await client.login(credentials);
  assert.deepEqual((await client.folders())[0]?.bookmarks, [1, 2]);
  assert.equal((await client.bookmarks()).length, 1);
});

test('sends exact native multipart changes and only the selected bookmark diff', async () => {
  const sent: { endpoint: string; body: unknown }[] = [];
  const client = signed(async (url, init) => {
    const endpoint = new URL(url).pathname.split('/').pop()!;
    if (init.method === 'POST') {
      assert.ok(init.body instanceof FormData);
      sent.push({ endpoint, body: JSON.parse(String(init.body.get('json'))) });
    }
    return json({ status: 'OK', folders: [folder] });
  });
  await client.login(credentials);
  await client.createFolder('Trip', '🚐');
  await client.updateFolder({ id: 8, name: 'New trip', icon: '🚐' });
  await client.addBookmark(10);
  await client.removeBookmark(10, 8);
  await client.deleteFolder(8);
  assert.deepEqual(sent, [
    { endpoint: 'folderPut.php', body: { name: 'Trip', icon: '🚐' } },
    { endpoint: 'folderPatch.php', body: { id: 8, name: 'New trip', icon: '🚐' } },
    { endpoint: 'lieuPatchFolder.php', body: { '0': { id_lieux_add: '10', id_lieux_supp: '' } } },
    { endpoint: 'lieuPatchFolder.php', body: { '8': { id_lieux_add: '', id_lieux_supp: '10' } } },
    { endpoint: 'folderDelete.php', body: { id: 8, name: 'Trip', icon: '🚐' } }
  ]);
});

test('does not retry a failed write', async () => {
  let writes = 0;
  const client = signed(async () => { writes++; throw new Error('private request URL'); });
  await client.login(credentials);
  await assert.rejects(client.addBookmark(10), { code: 'NETWORK_ERROR' });
  assert.equal(writes, 1);
});

test('handles HTTP errors, redirects, malformed data and missing places', async () => {
  for (const [response, code] of [[json({}, 403), 'AUTH_REJECTED'], [json({}, 429), 'RATE_LIMITED'], [new Response(null, { status: 302 }), 'UPSTREAM_ERROR'], [new Response('<html>'), 'INVALID_RESPONSE'], [json({ status: 'OK', lieux: [] }), 'NOT_FOUND'], [json({ status: 'OK', lieux: [{ ...place, latitude: 'bad' }] }), 'INVALID_RESPONSE']] as const) {
    await assert.rejects(stub(async () => response).place(1), { code });
  }
});

test('rejects invalid input and protects the default folder before network access', async () => {
  const client = stub(async () => { assert.fail('Unexpected request'); });
  await assert.rejects(client.place(-1), { code: 'INVALID_INPUT' });
  await assert.rejects(client.search({ lat: NaN, lng: 2 }), { code: 'INVALID_INPUT' });
  await assert.rejects(client.deleteFolder(0), { code: 'INVALID_INPUT' });
  await assert.rejects(client.bookmarks(), { code: 'AUTH_REQUIRED' });
});

test('maps account place categories to their native queries', async () => {
  const calls: URL[] = [];
  const client = signed(async url => { calls.push(new URL(url)); return json({ status: 'OK', lieux: [] }); });
  await client.login(credentials);
  await client.myPlaces('created');
  await client.myPlaces('visited');
  await client.myPlaces('commented');
  assert.equal(calls[0]?.pathname, '/services/V4.1/lieuGetUser.php');
  assert.equal(calls[0]?.searchParams.get('uuid'), 'canonical');
  assert.equal(calls[0]?.searchParams.has('visites'), false);
  assert.equal(calls[1]?.searchParams.get('visites'), 'true');
  assert.equal(calls[2]?.pathname, '/services/V4.1/lieuGetCommUser.php');
  assert.equal(calls[2]?.searchParams.get('user_id'), '7');
});

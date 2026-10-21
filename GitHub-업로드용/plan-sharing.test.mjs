import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createLocalDatabase } from './local-db.mjs';
import { createAccountHandler } from './auth-store.mjs';
import { createAppServer } from './server.mjs';
import { createPagesWorker } from './cloudflare-worker.mjs';

const BASE = 'https://gil-sharing.example';
const SECRET = 'SYNTHETIC-SHARING-SECRET-FOR-TESTS-ONLY';
const document = () => ({ version: 8, itinerary: { cityId: 'seoul', startDate: '2026-10-21', dayCount: 1,
  dayAreaIds: ['tour-cluster-1'], selections: { 0: ['tourapi-1', 'tourapi-2', 'tourapi-3'] } } });
const snapshot = (title = '함께 보는 여행') => ({ version: 1, title, cityName: '서울', startDate: '2026-10-21', dayCount: 1,
  days: [{ date: '2026-10-21', provisional: false, events: [{ type: 'place', title: '산책', start: 540, end: 600, address: '', memo: '' }] }] });
async function hash(value) { return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('base64url'); }
async function seedOwner(db, label) {
  const user = { id: crypto.randomUUID(), username: `kakao_${label}` }, token = crypto.getRandomValues(new Uint8Array(32));
  const value = Buffer.from(token).toString('base64url');
  await db.batch([
    db.prepare('INSERT INTO gil_users(id,username,password_salt,password_hash,created_at) VALUES(?,?,?,?,?)').bind(user.id, user.username, 'synthetic', 'social-only-v1', 1),
    db.prepare('INSERT INTO gil_oauth_identities(provider,subject_hash,user_id,created_at) VALUES(?,?,?,?)').bind('kakao', `synthetic-${label}`, user.id, 1),
    db.prepare('INSERT INTO gil_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await hash(value), user.id, Date.UTC(2030, 0, 1), 1)
  ]);
  return { user, cookie: `gil_session=${value}` };
}
async function fixture(t, options = {}) {
  const db = createLocalDatabase(); t.after(() => db.close());
  let clock = Date.UTC(2026, 9, 21);
  const owner = await seedOwner(db, 'owner'), other = await seedOwner(db, 'other');
  const handle = createAccountHandler({ db, secret: SECRET, now: () => clock, ...options });
  async function call(path, { method = 'GET', body, cookie = owner.cookie, origin = BASE, headers = {} } = {}) {
    const response = await handle(new Request(BASE + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }));
    assert.ok(response); const text = await response.text();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(text.includes(SECRET), false);
    return { response, status: response.status, data: text ? JSON.parse(text) : null, text };
  }
  async function save(title = '함께 보는 여행') {
    const result = await call('/api/plans', { method: 'POST', body: { title, document: document() } });
    assert.equal(result.status, 201); return result.data.plan;
  }
  const publish = (plan, data = {}) => call(`/api/plans/${plan.id}/share`, { method: 'POST', body: { revision: plan.revision, document: document(), snapshot: snapshot(plan.title), ...data } });
  const read = token => call('/api/shared-plan', { method: 'POST', body: { token }, cookie: null });
  return { db, owner, other, call, save, publish, read, advance: value => { clock += value; } };
}

test('sharing is opt-in, stores only a token hash and returns a fixed text snapshot without owner metadata', async t => {
  const f = await fixture(t), plan = await f.save(), path = `/api/plans/${plan.id}/share`;
  assert.deepEqual((await f.call(path)).data, { shared: false });
  const published = await f.publish(plan); assert.equal(published.status, 201);
  assert.match(published.data.token, /^[A-Za-z0-9_-]{43}$/);
  const row = await f.db.prepare('SELECT * FROM gil_plan_shares').first();
  assert.equal(row.token_hash, await hash(published.data.token)); assert.notEqual(row.token_hash, published.data.token);
  assert.equal(JSON.stringify(row).includes(published.data.token), false);
  const status = await f.call(path); assert.deepEqual(status.data, { shared: true, revision: 1, createdAt: published.data.createdAt });
  assert.equal(status.text.includes('token'), false);
  const loaded = await f.read(published.data.token);
  assert.equal(loaded.status, 200); assert.deepEqual(loaded.data, { snapshot: snapshot(), sharedAt: published.data.createdAt });
  assert.equal(loaded.text.includes(f.owner.user.id), false); assert.equal(loaded.text.includes(plan.id), false);
  assert.equal(loaded.response.headers.get('referrer-policy'), 'no-referrer');
});

test('a saved real-planner arrival transfer respects all four departure and memo publication settings', async t => {
  const area = { id: 'tour-cluster-1', name: '합성 관광권역', places: [1, 2, 3].map(index => ({
    id: `tourapi-${index}`, name: `합성 관광지 ${index}`, areaId: 'tour-cluster-1', area: '합성 관광권역', areaName: '합성 관광권역',
    stayMinutes: 60, address: `합성 공개 관광주소 ${index}`, intro: '합성 공개 소개'
  })) };
  const city = { id: 'seoul', name: '서울', country: 'KR', supportedDays: 1, areas: [area] };
  const window = { TRAVEL_DATA: { countries: { KR: '대한민국' }, cities: { seoul: city } } };
  const context = vm.createContext({ window });
  for (const name of ['planner.js', 'note-snapshot.js']) vm.runInContext(readFileSync(new URL(name, import.meta.url), 'utf8'), context);
  const stop = (id, name, address) => ({ mode: 'train', id: `tago-train-${id}`, name, address, latitude: null, longitude: null,
    source: 'TAGO', service: 'train', providerId: id, sourceUrl: 'https://www.data.go.kr/data/15098552/openapi.do' });
  const departure = stop('SYNTHETIC_FROM', '합성 비공개 출발역', '합성 비공개 출발주소');
  const arrival = stop('SYNTHETIC_TO', '합성 비공개 도착역', '합성 비공개 도착주소');
  const itinerary = window.TravelPlanner.createItinerary({ city, ...document().itinerary, dayDepartures: { 0: departure }, dayArrivals: { 0: arrival },
    eventEdits: { 0: { departure: { duration: 60 }, 'arrival-transfer': { duration: 12 },
      'place-0': { description: '합성 개인 예약메모' }, 'transfer-0': { description: '합성 일반 이동메모' } } } });
  assert.equal(itinerary.ok, true, itinerary.reason);
  const title = '공개설정 회귀 여행', f = await fixture(t);
  const saved = await f.call('/api/plans', { method: 'POST', body: { title, document: { version: 8, itinerary } } });
  assert.equal(saved.status, 201);
  const loaded = await f.call(`/api/plans/${saved.data.plan.id}`); assert.equal(loaded.status, 200);
  const plan = loaded.data.plan, restored = window.TravelPlanner.createItinerary({ city, ...plan.document.itinerary });
  assert.equal(restored.ok, true, restored.reason);
  const arrivalTransferIndex = restored.days[0].events.findIndex(event => event.id === 'arrival-transfer');
  assert.ok(arrivalTransferIndex >= 0);
  assert.equal(restored.days[0].events[arrivalTransferIndex].type, 'transfer');
  assert.equal(restored.days[0].events[arrivalTransferIndex].arrival.address, arrival.address);
  for (const includeDeparture of [false, true]) for (const includeMemos of [false, true]) {
    await t.test(`departure=${includeDeparture}, memos=${includeMemos}`, async () => {
      const publicSnapshot = window.TravelNoteSnapshot.create(restored, { title, includeDeparture, includeMemos });
      const published = await f.publish(plan, { document: plan.document, snapshot: publicSnapshot }); assert.equal(published.status, 201);
      const shared = await f.read(published.data.token); assert.equal(shared.status, 200);
      const events = shared.data.snapshot.days[0].events, transfer = events[arrivalTransferIndex];
      assert.equal(transfer.type, 'transfer'); assert.equal(transfer.title, '첫 관광지로 이동');
      assert.equal(transfer.address, includeDeparture ? arrival.address : '');
      assert.equal(transfer.memo, includeDeparture && includeMemos ? `${arrival.name} → ${area.places[0].name}` : '');
      for (const value of [departure.name, departure.address, arrival.name, arrival.address]) {
        assert.equal(shared.text.includes(value), includeDeparture, `public response disclosure: ${value}`);
      }
      assert.equal(events.find(event => event.type === 'place').address, area.places[0].address);
      assert.equal(shared.text.includes('합성 개인 예약메모'), includeMemos);
      assert.equal(shared.text.includes('합성 일반 이동메모'), includeMemos);
      if (!includeMemos) assert.ok(events.every(event => event.memo === ''));
    });
  }
});

test('republishing atomically rotates the link and the owner can revoke even after a saved-plan edit', async t => {
  const f = await fixture(t), plan = await f.save(), first = await f.publish(plan); f.advance(1000);
  const second = await f.publish(plan); assert.equal(second.status, 201); assert.notEqual(second.data.token, first.data.token);
  assert.equal((await f.read(first.data.token)).status, 404); assert.equal((await f.read(second.data.token)).status, 200);
  await f.call(`/api/plans/${plan.id}`, { method: 'PUT', body: { title: '수정된 계획', document: document(), revision: 1 } });
  assert.deepEqual((await f.read(second.data.token)).data.snapshot, snapshot(), 'saved edits do not silently republish');
  assert.equal((await f.call(`/api/plans/${plan.id}/share`)).data.revision, 1);
  assert.equal((await f.call(`/api/plans/${plan.id}/share`, { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await f.read(second.data.token)).status, 404);
  assert.deepEqual((await f.call(`/api/plans/${plan.id}/share`)).data, { shared: false });
});

test('sharing and revocation enforce the cookie owner, expected-account guard and plan ownership', async t => {
  const f = await fixture(t), plan = await f.save(), path = `/api/plans/${plan.id}/share`, first = await f.publish(plan);
  for (const method of ['GET', 'HEAD', 'POST', 'DELETE']) {
    const body = method === 'POST' ? { revision: 1, document: document(), snapshot: snapshot() } : method === 'DELETE' ? {} : undefined;
    assert.equal((await f.call(path, { method, body, cookie: null })).status, 401);
    assert.equal((await f.call(path, { method, body, cookie: f.other.cookie })).status, 404);
    const mismatch = await f.call(path, { method, body, headers: { 'X-Gil-Expected-User': f.other.user.id } });
    assert.equal(mismatch.status, 409); if (method !== 'HEAD') assert.equal(mismatch.data.error.code, 'SESSION_CHANGED');
  }
  assert.equal((await f.read(first.data.token)).status, 200);
  assert.equal((await f.call(`/api/plans/${crypto.randomUUID()}/share`)).status, 404);
  assert.equal((await f.call('/api/plans/invalid/share')).status, 400);
});

test('only the latest saved canonical document and matching snapshot metadata can be published', async t => {
  const f = await fixture(t), plan = await f.save(), first = await f.publish(plan);
  const changed = document(); changed.itinerary.dayStarts = { 0: '10:00' };
  for (const body of [{ revision: 2 }, { document: changed }]) assert.equal((await f.publish(plan, body)).status, 409);
  for (const changedSnapshot of [{ ...snapshot(), title: '다른 계획' }, { ...snapshot(), startDate: '2026-10-22' }, { ...snapshot(), dayCount: 2 }]) {
    assert.equal((await f.publish(plan, { snapshot: changedSnapshot })).status, 400);
  }
  for (const revision of [0, 1.5, '1', Number.MAX_SAFE_INTEGER]) assert.equal((await f.publish(plan, { revision })).status, 400);
  assert.equal((await f.read(first.data.token)).status, 200, 'failed publication keeps the existing link');
});

test('raw routes, owner IDs and unrecognized properties cannot enter the published snapshot', async t => {
  const f = await fixture(t), plan = await f.save();
  for (const invalid of [{ ...snapshot(), ownerId: f.owner.user.id }, { ...snapshot(), routes: [] },
    { ...snapshot(), days: [{ ...snapshot().days[0], events: [{ ...snapshot().days[0].events[0], coordinates: [1, 2] }] }] }]) {
    assert.equal((await f.publish(plan, { snapshot: invalid })).status, 400);
  }
  const invalidDoc = { ...document(), routes: [{ duration: 53 }] };
  assert.equal((await f.publish(plan, { document: invalidDoc })).status, 400);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM gil_plan_shares').first()).count, 0);
});

test('same-origin JSON rules protect publication, revocation and anonymous token reads', async t => {
  const f = await fixture(t), plan = await f.save(), published = await f.publish(plan), path = `/api/plans/${plan.id}/share`;
  for (const [endpoint, method, body] of [[path, 'POST', { revision: 1, document: document(), snapshot: snapshot() }], [path, 'DELETE', {}], ['/api/shared-plan', 'POST', { token: published.data.token }]]) {
    assert.equal((await f.call(endpoint, { method, body, origin: 'https://other.example' })).status, 403);
    assert.equal((await f.call(endpoint, { method, body, headers: { Origin: '', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.call(endpoint, { method, body, headers: { 'Content-Type': 'text/plain' } })).status, 400);
  }
  assert.equal((await f.read(published.data.token)).status, 200);
});

test('token reads are body-only, canonical and indistinguishable for unknown, revoked and malformed tokens', async t => {
  const f = await fixture(t), plan = await f.save(), published = await f.publish(plan);
  const denied = [];
  for (const token of ['', 'x'.repeat(42), 'x'.repeat(44), '+'.repeat(43), 'A'.repeat(42) + 'B', 'A'.repeat(43), 123, null]) denied.push(await f.read(token));
  await f.call(`/api/plans/${plan.id}/share`, { method: 'DELETE', body: {} }); denied.push(await f.read(published.data.token));
  for (const result of denied) { assert.equal(result.status, 404); assert.deepEqual(result.data, denied[0].data); }
  assert.equal((await f.call(`/api/shared-plan?token=${published.data.token}`, { cookie: null })).status, 405);
  assert.equal((await f.call(`/api/shared-plan?token=${published.data.token}`, { method: 'POST', body: {}, cookie: null })).status, 400);
  assert.equal((await f.call('/api/shared-plan', { method: 'POST', body: { token: published.data.token, ownerId: f.owner.user.id } })).status, 400);
});

test('body limits, invalid JSON, unsupported methods and safe errors never expose DB internals', async t => {
  const f = await fixture(t), plan = await f.save(), path = `/api/plans/${plan.id}/share`;
  for (const body of ['not-json', '[]', 'null', '{"revision":1}']) assert.equal((await f.call(path, { method: 'POST', body })).status, 400);
  assert.equal((await f.call(path, { method: 'POST', body: 'x'.repeat(270001) })).status, 413);
  assert.equal((await f.call('/api/shared-plan', { method: 'POST', body: 'x'.repeat(2049), cookie: null })).status, 413);
  assert.equal((await f.call(path, { method: 'DELETE', body: { revision: 1 } })).status, 400);
  assert.equal((await f.call(path, { method: 'PUT', body: {} })).status, 405);
  const broken = createAccountHandler({ secret: SECRET, db: { prepare() { throw Error('PRIVATE SQL '+SECRET); }, batch() {} } });
  const result = await broken(new Request(BASE+'/api/shared-plan', { method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'A'.repeat(43) }) }));
  assert.equal(result.status, 500); assert.doesNotMatch(await result.text(), /PRIVATE|SQL|SYNTHETIC/);
});

test('deleting a saved plan cascades its publication and ordinary plan lists contain no share tokens', async t => {
  const f = await fixture(t), plan = await f.save(), published = await f.publish(plan);
  assert.equal((await f.call('/api/plans')).text.includes(published.data.token), false);
  assert.equal((await f.call(`/api/plans/${plan.id}`, { method: 'DELETE', body: { revision: 1 } })).status, 200);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM gil_plan_shares').first()).count, 0);
  assert.equal((await f.read(published.data.token)).status, 404);
});

test('a concurrent save between validation and publication cannot replace an existing link with stale contents', async t => {
  const f = await fixture(t), plan = await f.save(), first = await f.publish(plan);
  const db = { ...f.db, prepare(sql) {
    const statement = f.db.prepare(sql);
    if (!sql.startsWith('INSERT INTO gil_plan_shares')) return statement;
    return { bind(...values) { const bound = statement.bind(...values); return { async run() {
      await f.db.prepare('UPDATE gil_plans SET revision=revision+1 WHERE id=?').bind(plan.id).run(); return bound.run();
    } }; } };
  } };
  const handle = createAccountHandler({ db, secret: SECRET });
  const result = await handle(new Request(BASE+`/api/plans/${plan.id}/share`, { method: 'POST', headers: { Cookie: f.owner.cookie, Origin: BASE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: 1, document: document(), snapshot: snapshot() }) }));
  assert.equal(result.status, 409); assert.equal((await f.read(first.data.token)).status, 200);
});

test('simultaneous republication leaves exactly one active link', async t => {
  const f = await fixture(t), plan = await f.save();
  const results = await Promise.all(Array.from({ length: 6 }, () => f.publish(plan)));
  assert.ok(results.every(result => result.status === 201));
  const loaded = await Promise.all(results.map(result => f.read(result.data.token)));
  assert.equal(loaded.filter(result => result.status === 200).length, 1); assert.equal(loaded.filter(result => result.status === 404).length, 5);
});

async function integrationExercise(send, origin, owner) {
  const mutation = body => ({ method: 'POST', headers: { Cookie: owner.cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const saved = await send('/api/plans', mutation({ title: '함께 보는 여행', document: document() })); assert.equal(saved.status, 201);
  const { plan } = await saved.json();
  const publication = await send(`/api/plans/${plan.id}/share`, mutation({ revision: 1, document: document(), snapshot: snapshot() })); assert.equal(publication.status, 201);
  const { token } = await publication.json();
  const loaded = await send('/api/shared-plan', { ...mutation({ token }), headers: { Origin: origin, 'Content-Type': 'application/json' } });
  assert.equal(loaded.status, 200); assert.deepEqual((await loaded.json()).snapshot, snapshot());
  assert.equal(loaded.headers.get('cache-control'), 'no-store'); assert.equal(loaded.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await send('/plan-sharing.mjs')).status, 404); assert.equal((await send('/plan-sharing.test.mjs')).status, 404);
}

test('Node dispatches anonymous body-token reads through the authenticated sharing handler', async t => {
  const db = createLocalDatabase(), owner = await seedOwner(db, 'node');
  const server = createAppServer({ accountHandler: createAccountHandler({ db, secret: SECRET }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await integrationExercise((path, options) => fetch(origin+path, options), origin, owner);
});

test('Cloudflare dispatches anonymous body-token reads to its D1 binding', async t => {
  const db = createLocalDatabase(); t.after(() => db.close()); const owner = await seedOwner(db, 'worker'), worker = createPagesWorker();
  await integrationExercise((path, options) => worker.fetch(new Request(BASE+path, options), { DB: db, AUTH_SECRET: SECRET }), BASE, owner);
});

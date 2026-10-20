import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitRoutingClient, TransitRoutingError } from './transit-routing.mjs';

const KEY = 'synthetic-kakao-transit-secret';
const NOW = Date.parse('2026-10-20T03:00:00Z');
const POINTS = { originLatitude: 37.39477123, originLongitude: 127.11119217,
  destinationLatitude: 37.41993056, destinationLongitude: 127.12628814, mode: 'local-bus' };
const step = (type = 'BUS', overrides = {}) => ({ properties: { type, guidance: type === 'WALKING' ? '정류장으로 이동' : '마을 76 (판교역동편 > 성남시청전면)',
  time: 600, distance: 2000, stops: [{ name: '판교역동편' }, { name: '성남시청전면' }],
  vehicles: type === 'WALKING' ? [] : [{ name: type === 'BUS' ? '76' : '분당선', type: type === 'BUS' ? '마을' : '급행' }], ...overrides },
  path: { points: [[127.111, 37.394], [127.126, 37.419]] } });
const route = (type = 'BUS', overrides = {}) => ({ properties: { type, totalTime: 2115, totalDistance: 5013, transfers: type === 'BUS_AND_SUBWAY' ? 1 : 0, fare: { value: 1350 }, ...overrides },
  steps: type === 'BUS_AND_SUBWAY' ? [step('BUS'), step('WALKING'), step('SUBWAY')] : [step('WALKING'), step(type)] });
const envelope = (routes = [route()]) => ({ status: 'OK', properties: { total: routes.length, landingURL: `https://private.invalid/${KEY}` }, routes });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const client = (fetchImpl = async () => json(envelope()), options = {}) => createTransitRoutingClient({ apiKey: KEY, fetchImpl, now: () => NOW, ...options });
const rejects = (promise, code, status) => assert.rejects(promise, error => {
  assert.ok(error instanceof TransitRoutingError); assert.equal(error.code, code);
  if (status != null) assert.equal(error.status, status);
  assert.ok(!String(error.stack).includes(KEY)); assert.ok(!String(error.stack).includes('dapi.kakao.com'));
  return true;
});

test('transit lookup sends only fixed WGS84 coordinates with header authentication and no-store, returning a safe summary', async () => {
  const result = await client(async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://dapi.kakao.com'); assert.equal(url.pathname, '/v2/routing/publictraffic');
    assert.deepEqual(Object.fromEntries(url.searchParams), { start_x: '127.111192', start_y: '37.394771', end_x: '127.126288', end_y: '37.419931', input_coord: 'WGS84', output_coord: 'WGS84' });
    assert.ok(!url.href.includes(KEY)); assert.equal(init.headers.Authorization, `KakaoAK ${KEY}`);
    assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store'); assert.equal(init.method, 'GET');
    return json(envelope());
  }).getRoutes({ ...POINTS, url: 'https://ignored.invalid', date: '2030-01-01', startTime: '22:00' });
  assert.equal(result.provider, '카카오맵'); assert.equal(result.mode, 'local-bus'); assert.equal(result.fetchedAt, '2026-10-20T03:00:00.000Z');
  assert.deepEqual(result.origin, { latitude: 37.394771, longitude: 127.111192 });
  assert.deepEqual(result.destination, { latitude: 37.419931, longitude: 127.126288 });
  assert.equal(result.routes.length, 1);
  assert.deepEqual(result.routes[0], { id: 'transit-1', type: 'BUS', durationSeconds: 2115, durationMinutes: 36, distanceMeters: 5013, transfers: 0,
    steps: [{ type: 'WALKING', guidance: '정류장으로 이동', durationSeconds: 600, distanceMeters: 2000, stops: ['판교역동편', '성남시청전면'], vehicles: [] },
      { type: 'BUS', guidance: '마을 76 (판교역동편 > 성남시청전면)', durationSeconds: 600, distanceMeters: 2000, stops: ['판교역동편', '성남시청전면'], vehicles: [{ name: '76', type: '마을' }] }] });
  const serialized = JSON.stringify(result);
  for (const hidden of [KEY, 'landingURL', 'points', 'fare', 'waitingTime', 'arrivalAt']) assert.ok(!serialized.includes(hidden));
});

test('bus and subway filters include explicitly mixed routes, order by actual seconds and cap at five choices', async () => {
  const data = envelope([route('BUS', { totalTime: 800 }), route('SUBWAY', { totalTime: 300 }), route('BUS_AND_SUBWAY', { totalTime: 400 }),
    route('BUS', { totalTime: 700 }), route('BUS', { totalTime: 600 }), route('BUS', { totalTime: 500 }), route('BUS', { totalTime: 900 }), route('SUBWAY', { totalTime: 1000 })]);
  const api = client(async () => json(data));
  const bus = await api.getRoutes(POINTS), subway = await api.getRoutes({ ...POINTS, mode: 'subway' });
  assert.deepEqual(bus.routes.map(item => item.id), ['transit-3', 'transit-6', 'transit-5', 'transit-4', 'transit-1']);
  assert.deepEqual(subway.routes.map(item => item.id), ['transit-2', 'transit-3', 'transit-8']);
  assert.equal(subway.routes[1].type, 'BUS_AND_SUBWAY');
});

test('invalid modes, malformed or foreign coordinates and equal points never make an upstream request', async () => {
  let calls = 0; const api = client(async () => { calls++; return json(envelope()); });
  for (const mode of [undefined, null, '', 'bus', 'car', 'walk', 'SUBWAY', true, {}]) await rejects(api.getRoutes({ ...POINTS, mode }), 'INVALID_MODE', 400);
  for (const value of [null, undefined, '', true, [], {}, NaN, Infinity, 0, 90, '37&apiKey=bad']) await rejects(api.getRoutes({ ...POINTS, originLatitude: value }), 'INVALID_COORDINATES', 400);
  await rejects(api.getRoutes({ ...POINTS, destinationLongitude: 133 }), 'INVALID_COORDINATES');
  await rejects(api.getRoutes({ ...POINTS, destinationLatitude: POINTS.originLatitude, destinationLongitude: POINTS.originLongitude }), 'NO_ROUTE', 422);
  assert.equal(calls, 0);
  await api.getRoutes({ ...POINTS, originLatitude: String(POINTS.originLatitude), destinationLongitude: String(POINTS.destinationLongitude) });
  assert.equal(calls, 1);
});

test('missing or invalid keys fail safely before fetch', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return json(envelope()); };
  for (const apiKey of [undefined, '', ' ']) await rejects(createTransitRoutingClient({ apiKey, fetchImpl }).getRoutes(POINTS), 'KEY_MISSING', 503);
  for (const apiKey of ['test', 'demo', 'your_key', 'KakaoAK key', 'bad\r\nheader', '키값']) await rejects(createTransitRoutingClient({ apiKey, fetchImpl }).getRoutes(POINTS), 'AUTH_ERROR', 502);
  assert.equal(calls, 0);
});

test('documented missing-route statuses, empty results and absence of a requested transport return NO_ROUTE', async () => {
  for (const status of ['STARTNODES_NULL', 'ENDNODES_NULL', 'EQUAL_POINTS', 'NO_RESULTS']) await rejects(client(async () => json({ status })).getRoutes(POINTS), 'NO_ROUTE', 422);
  await rejects(client(async () => json(envelope([]))).getRoutes(POINTS), 'NO_ROUTE', 422);
  await rejects(client(async () => json(envelope([route('BUS')]))).getRoutes({ ...POINTS, mode: 'subway' }), 'NO_ROUTE', 422);
  await rejects(client(async () => json({ status: 'INVALID_REQUEST' })).getRoutes(POINTS), 'UPSTREAM_ERROR', 502);
});

test('all candidates require valid summaries and valid steps, with no partial success hiding malformed alternatives', async () => {
  for (const invalidRoute of [null, {}, route('TRAIN'), route('BUS', { totalTime: 0 }), route('BUS', { totalTime: '120' }),
    route('BUS', { totalTime: 86401 }), route('BUS', { totalDistance: 0 }), route('BUS', { totalDistance: 1500001 }),
    route('BUS', { transfers: -1 }), route('BUS', { transfers: 31 }), { ...route(), steps: [] },
    { ...route(), steps: [null] }, { ...route(), steps: [step('CAR')] },
    { ...route('BUS_AND_SUBWAY'), steps: [step('BUS')] }, { ...route('BUS'), steps: [step('SUBWAY')] },
    { ...route(), steps: [step('BUS', { guidance: undefined })] }, { ...route(), steps: [step('BUS', { time: -1 })] },
    { ...route(), steps: [step('BUS', { distance: 1.2 })] }, { ...route(), steps: [step('BUS', { stops: [{ name: '' }] })] },
    { ...route(), steps: [step('BUS', { vehicles: [{ name: '76' }] })] }]) {
    await rejects(client(async () => json(envelope([route(), invalidRoute]))).getRoutes(POINTS), 'INVALID_RESPONSE', 502);
  }
});

test('optional stop and vehicle lists normalize to empty arrays, while zero step metrics do not become invented times', async () => {
  const data = envelope([{ ...route('BUS', { totalTime: 61 }), steps: [step('BUS', { time: 0, distance: 0, stops: null, vehicles: undefined, guidance: '' })] }]);
  const result = await client(async () => json(data)).getRoutes(POINTS);
  assert.equal(result.routes[0].durationMinutes, 2);
  assert.deepEqual(result.routes[0].steps[0], { type: 'BUS', guidance: '', durationSeconds: 0, distanceMeters: 0, stops: [], vehicles: [] });
  assert.equal(Object.hasOwn(result.routes[0], 'waitSeconds'), false, 'a gap between total and step times is not labeled as waiting');
});

test('a mixed route retains every alternative bus line when a real step offers more than twenty vehicles', async () => {
  const vehicles = Array.from({ length: 24 }, (_, index) => ({ name: `버스 ${index + 1}`, type: index % 2 ? '마을' : '간선' }));
  const mixed = route('BUS_AND_SUBWAY');
  mixed.steps[0] = step('BUS', { vehicles });
  for (const mode of ['local-bus', 'subway']) {
    const result = await client(async () => json(envelope([mixed]))).getRoutes({ ...POINTS, mode });
    assert.equal(result.routes[0].type, 'BUS_AND_SUBWAY');
    assert.equal(result.routes[0].steps[0].vehicles.length, 24);
    assert.deepEqual(result.routes[0].steps[0].vehicles, vehicles, 'alternative lines are not truncated or mistaken for extra transfers');
    assert.equal(result.routes[0].transfers, 1);
  }
});

test('route, step, stop, vehicle and text limits reject oversized structures', async () => {
  const malformed = [envelope(Array.from({ length: 101 }, () => route())), envelope([{ ...route(), steps: Array.from({ length: 65 }, () => step()) }])];
  for (const overrides of [{ guidance: '가'.repeat(501) }, { stops: 'bad' }, { vehicles: {} },
    { stops: Array.from({ length: 201 }, () => ({ name: '정류장' })) }, { vehicles: Array.from({ length: 101 }, () => ({ name: '1', type: '일반' })) }]) malformed.push(envelope([{ ...route(), steps: [step('BUS', overrides)] }]));
  for (const data of malformed) await rejects(client(async () => json(data)).getRoutes(POINTS), 'INVALID_RESPONSE');
  for (const data of [null, [], {}, { status: 'UNKNOWN', routes: [] }, { status: 'OK', routes: {} }]) await rejects(client(async () => json(data)).getRoutes(POINTS), 'INVALID_RESPONSE');
});

test('HTTP and common Kakao errors are safe, including activation failures and quota failures', async () => {
  for (const [status, expected] of [[401, 'AUTH_ERROR'], [403, 'AUTH_ERROR'], [429, 'RATE_LIMIT'], [500, 'UPSTREAM_ERROR']]) await rejects(client(async () => json({ code: -1, msg: KEY }, status)).getRoutes(POINTS), expected);
  for (const [code, expected] of [[-3, 'AUTH_ERROR'], [-5, 'AUTH_ERROR'], [-401, 'AUTH_ERROR'], [-903, 'AUTH_ERROR'], [-10, 'RATE_LIMIT'], [-1, 'UPSTREAM_ERROR']]) {
    for (const status of [200, 400]) await rejects(client(async () => json({ code, msg: `${KEY} https://private.invalid` }, status)).getRoutes(POINTS), expected);
  }
  await rejects(client(async () => json(envelope([{ ...route(), steps: [step('BUS', { guidance: KEY })] }]))).getRoutes(POINTS), 'INVALID_RESPONSE');
});

test('redirects are not followed and raw network exceptions cannot disclose secrets', async () => {
  let calls = 0;
  await rejects(client(async (_url, init) => { calls++; assert.equal(init.redirect, 'manual'); return new Response(null, { status: 302, headers: { Location: 'https://private.invalid' } }); }).getRoutes(POINTS), 'UPSTREAM_ERROR');
  assert.equal(calls, 1);
  await rejects(client(async () => { throw new Error(KEY); }).getRoutes(POINTS), 'NETWORK_ERROR', 502);
});

test('fetch and body deadlines abort and never return late routes', async () => {
  let signal;
  await rejects(client(async (_url, options) => { signal = options.signal; return new Promise(() => {}); }, { timeoutMs: 5 }).getRoutes(POINTS), 'TIMEOUT', 504);
  assert.equal(signal.aborted, true);
  await rejects(client(async () => new Response(new ReadableStream({ start() {} })), { timeoutMs: 5 }).getRoutes(POINTS), 'TIMEOUT', 504);
});

test('oversized headers and streamed bodies are cancelled, and invalid UTF-8 or JSON is rejected', async () => {
  let cancelled = false;
  await rejects(client(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(1024 * 1024 + 1) } })).getRoutes(POINTS), 'INVALID_RESPONSE');
  assert.equal(cancelled, true); cancelled = false;
  await rejects(client(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } }))).getRoutes(POINTS), 'INVALID_RESPONSE');
  assert.equal(cancelled, true);
  for (const data of [new Uint8Array([0xff]), '<html>error</html>']) await rejects(client(async () => new Response(data)).getRoutes(POINTS), 'INVALID_RESPONSE');
});

test('split UTF-8 chunks and BOM preserve Korean guidance and stop names', async () => {
  const bytes = new TextEncoder().encode('\uFEFF' + JSON.stringify(envelope()));
  const result = await client(async () => new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7)); controller.close();
  } }))).getRoutes(POINTS);
  assert.equal(result.routes[0].steps[1].stops[0], '판교역동편');
});

test('repeated explicit lookups always fetch fresh results with no response cache', async () => {
  let calls = 0, time = NOW;
  const api = client(async () => { calls++; return json(envelope([route('BUS', { totalTime: 100 + calls })])); }, { now: () => time });
  const first = await api.getRoutes(POINTS); first.routes[0].durationSeconds = 9999;
  time += 1; const second = await api.getRoutes(POINTS);
  assert.equal(calls, 2); assert.equal(second.routes[0].durationSeconds, 102); assert.notEqual(first.fetchedAt, second.fetchedAt);
});

test('concurrent explicit lookups are separate live requests, bounded and retryable after failures', async () => {
  const finishes = []; let calls = 0;
  const api = client(async () => { calls++; return new Promise(resolve => finishes.push(resolve)); }, { maxPending: 2 });
  const first = api.getRoutes(POINTS), second = api.getRoutes(POINTS);
  assert.equal(calls, 2, 'identical concurrent requests are not coalesced into a temporary response cache');
  await rejects(api.getRoutes(POINTS), 'RATE_LIMIT', 429);
  finishes[0](json(envelope())); finishes[1](json(envelope())); await Promise.all([first, second]);
  const next = api.getRoutes(POINTS); assert.equal(calls, 3); finishes[2](json(envelope())); await next;
  let attempts = 0;
  const failing = client(async () => { if (++attempts === 1) throw new Error(KEY); return json(envelope()); }, { maxPending: 1 });
  await rejects(failing.getRoutes(POINTS), 'NETWORK_ERROR'); await failing.getRoutes(POINTS); assert.equal(attempts, 2);
});

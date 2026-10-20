import test from 'node:test';
import assert from 'node:assert/strict';
import { createCarRoutingClient, CarRoutingError } from './car-routing.mjs';

const KEY = 'synthetic-kakao-rest-key';
const NOW = Date.parse('2026-10-20T03:00:00Z');
const POINTS = { originLatitude: 37.5665, originLongitude: 126.978, destinationLatitude: 37.402465, destinationLongitude: 127.107642 };
const summary = overrides => ({ duration: 3494, distance: 19032, ...overrides });
const route = (summaryOverrides, routeOverrides) => ({ routes: [{ result_code: 0, result_msg: '길찾기 성공', summary: summary(summaryOverrides), ...routeOverrides }] });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const client = (fetchImpl = async () => json(route()), options = {}) => createCarRoutingClient({ apiKey: KEY, fetchImpl, now: () => NOW, ...options });
const rejects = (promise, code, status) => assert.rejects(promise, error => {
  assert.ok(error instanceof CarRoutingError); assert.equal(error.code, code);
  if (status != null) assert.equal(error.status, status);
  assert.ok(!String(error.stack).includes(KEY)); assert.ok(!String(error.stack).includes('apis-navi.kakaomobility.com'));
  return true;
});

test('recommended current car route uses fixed Kakao endpoint, longitude first and header-only secret', async () => {
  let calls = 0;
  const result = await client(async (input, init) => {
    calls++; const url = new URL(input);
    assert.equal(url.origin, 'https://apis-navi.kakaomobility.com'); assert.equal(url.pathname, '/v1/directions');
    assert.equal(url.searchParams.get('origin'), '126.978,37.5665'); assert.equal(url.searchParams.get('destination'), '127.107642,37.402465');
    assert.equal(url.searchParams.get('summary'), 'true'); assert.equal(url.searchParams.get('alternatives'), 'false');
    assert.equal(url.searchParams.get('priority'), 'RECOMMEND'); assert.equal(url.searchParams.size, 5);
    assert.ok(!url.href.includes(KEY)); assert.equal(init.headers.Authorization, `KakaoAK ${KEY}`);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.ok(init.signal instanceof AbortSignal);
    return json({ ...route(), trans_id: KEY, raw_route: { secret: KEY } });
  }).getRoute(POINTS);
  assert.equal(calls, 1);
  assert.deepEqual(result, { provider: '카카오모빌리티', fetchedAt: '2026-10-20T03:00:00.000Z',
    origin: { latitude: 37.5665, longitude: 126.978 }, destination: { latitude: 37.402465, longitude: 127.107642 },
    durationSeconds: 3494, durationMinutes: 59, distanceMeters: 19032, reference: '현재 교통 기준' });
  assert.ok(!JSON.stringify(result).includes(KEY)); assert.ok(!Object.hasOwn(result, 'sections'));
});

test('Korean coordinate strings are accepted, malformed and foreign coordinates never fetch', async () => {
  let calls = 0; const api = client(async () => { calls++; return json(route()); });
  await api.getRoute(Object.fromEntries(Object.entries(POINTS).map(([name, value]) => [name, String(value)])));
  for (const value of [undefined, '', true, [], {}, NaN, Infinity, 0, 90, '37&key=bad']) {
    await rejects(api.getRoute({ ...POINTS, originLatitude: value }), 'INVALID_COORDINATES', 400);
  }
  await rejects(api.getRoute({ ...POINTS, destinationLongitude: 133 }), 'INVALID_COORDINATES');
  assert.equal(calls, 1);
});

test('identical origin and destination are not replaced with a fake zero-minute route', async () => {
  let calls = 0;
  await rejects(client(async () => { calls++; return json(route()); }).getRoute({ ...POINTS,
    destinationLatitude: POINTS.originLatitude, destinationLongitude: POINTS.originLongitude }), 'NO_ROUTE', 422);
  assert.equal(calls, 0);
});

test('missing or invalid secret rejects before network access', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return json(route()); };
  for (const key of [undefined, '', '   ']) await rejects(createCarRoutingClient({ apiKey: key, fetchImpl }).getRoute(POINTS), 'KEY_MISSING', 503);
  for (const key of ['test', 'demo', 'your_key', 'KakaoAK value', 'bad\r\nheader', '한글키']) {
    await rejects(createCarRoutingClient({ apiKey: key, fetchImpl }).getRoute(POINTS), 'AUTH_ERROR', 502);
  }
  assert.equal(calls, 0);
});

test('seconds round up to minutes without rounding route distance or assuming a future departure', async () => {
  for (const [seconds, minutes] of [[1, 1], [60, 1], [61, 2], [86400, 1440]]) {
    const result = await client(async () => json(route({ duration: seconds, distance: 1 }))).getRoute(POINTS);
    assert.equal(result.durationSeconds, seconds); assert.equal(result.durationMinutes, minutes); assert.equal(result.distanceMeters, 1);
    assert.equal(result.reference, '현재 교통 기준'); assert.equal(Object.hasOwn(result, 'arrivalAt'), false);
  }
});

test('zero, negative, noninteger, nonnumeric and excessive summary measurements are invalid', async () => {
  for (const duration of [undefined, null, '', '60', false, -1, 0, 1.5, 86401, Infinity]) {
    await rejects(client(async () => json(route({ duration }))).getRoute(POINTS), 'INVALID_RESPONSE', 502);
  }
  for (const distance of [undefined, null, '', '100', false, -1, 0, 1.1, 1500001]) {
    await rejects(client(async () => json(route({ distance }))).getRoute(POINTS), 'INVALID_RESPONSE', 502);
  }
});

test('documented no-route codes and empty route arrays return NO_ROUTE without invented estimates', async () => {
  for (const code of [1, 101, 102, 103, 104, 105, 106, 107]) {
    await rejects(client(async () => json(route(undefined, { result_code: code, result_msg: KEY }))).getRoute(POINTS), 'NO_ROUTE', 422);
  }
  await rejects(client(async () => json({ routes: [] })).getRoute(POINTS), 'NO_ROUTE', 422);
  await rejects(client(async () => json(route(undefined, { result_code: 9999 }))).getRoute(POINTS), 'UPSTREAM_ERROR', 502);
});

test('first failed route cannot be bypassed by a later successful alternative', async () => {
  await rejects(client(async () => json({ routes: [{ result_code: 102 }, ...route().routes] })).getRoute(POINTS), 'NO_ROUTE');
});

test('malformed JSON and missing or incorrect route schemas are rejected', async () => {
  for (const body of [null, [], {}, { routes: {} }, { routes: [null] }, { routes: [{ summary: summary() }] },
    { routes: [{ result_code: '0', summary: summary() }] }, { routes: [{ result_code: 0 }] },
    { routes: Array.from({ length: 4 }, () => route().routes[0]) }]) {
    await rejects(client(async () => json(body)).getRoute(POINTS), 'INVALID_RESPONSE');
  }
  await rejects(client(async () => new Response('<html>upstream failure</html>')).getRoute(POINTS), 'INVALID_RESPONSE');
});

test('HTTP auth, activation, quota and generic failures never return private upstream messages', async () => {
  for (const [status, code] of [[401, 'AUTH_ERROR'], [403, 'AUTH_ERROR'], [429, 'RATE_LIMIT'], [500, 'UPSTREAM_ERROR'], [503, 'UPSTREAM_ERROR']]) {
    await rejects(client(async () => json({ msg: `${KEY} https://private.invalid`, code: -1 }, status)).getRoute(POINTS), code);
  }
  for (const [code, expected] of [[-3, 'AUTH_ERROR'], [-5, 'AUTH_ERROR'], [-8, 'AUTH_ERROR'], [-401, 'AUTH_ERROR'], [-903, 'AUTH_ERROR'],
    [-10, 'RATE_LIMIT'], [-1, 'UPSTREAM_ERROR']]) {
    await rejects(client(async () => json({ msg: KEY, code }, 400)).getRoute(POINTS), expected);
    await rejects(client(async () => json({ msg: KEY, code }, 200)).getRoute(POINTS), expected);
  }
});

test('redirects never forward the Authorization header to a different location', async () => {
  let calls = 0;
  await rejects(client(async (_url, init) => {
    calls++; assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://private.invalid' } });
  }).getRoute(POINTS), 'UPSTREAM_ERROR');
  assert.equal(calls, 1);
});

test('network failures and both fetch and body timeouts are sanitized', async () => {
  await rejects(client(async () => { throw new Error(`private ${KEY}`); }).getRoute(POINTS), 'NETWORK_ERROR', 502);
  let signal;
  await rejects(client(async (_url, init) => { signal = init.signal; return new Promise(() => {}); }, { timeoutMs: 5 }).getRoute(POINTS), 'TIMEOUT', 504);
  assert.equal(signal.aborted, true);
  await rejects(client(async () => new Response(new ReadableStream({ start() {} })), { timeoutMs: 5 }).getRoute(POINTS), 'TIMEOUT', 504);
});

test('oversized content-length or streamed body is cancelled; invalid UTF-8 is rejected', async () => {
  let cancelled = false;
  await rejects(client(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'content-length': String(1024 * 1024 + 1) }
  })).getRoute(POINTS), 'INVALID_RESPONSE'); assert.equal(cancelled, true);
  cancelled = false;
  await rejects(client(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; }
  }))).getRoute(POINTS), 'INVALID_RESPONSE'); assert.equal(cancelled, true);
  await rejects(client(async () => new Response(new Uint8Array([0xff, 0xfe]))).getRoute(POINTS), 'INVALID_RESPONSE');
});

test('BOM and split UTF-8 response chunks decode correctly', async () => {
  const bytes = new TextEncoder().encode('\uFEFF' + JSON.stringify(route()));
  const result = await client(async () => new Response(new ReadableStream({
    start(controller) { for (let index = 0; index < bytes.length; index += 5) controller.enqueue(bytes.slice(index, index + 5)); controller.close(); }
  }))).getRoute(POINTS);
  assert.equal(result.durationSeconds, 3494);
});

test('five-minute route cache is direction-sensitive, bounded, and isolated from caller mutations', async () => {
  let calls = 0, time = NOW;
  const api = client(async () => { calls++; return json(route()); }, { now: () => time, maxCacheEntries: 2 });
  const first = await api.getRoute(POINTS); first.origin.latitude = 0; first.durationMinutes = 9999;
  time += 299999; const cached = await api.getRoute(POINTS);
  assert.equal(calls, 1); assert.equal(cached.origin.latitude, POINTS.originLatitude); assert.equal(cached.durationMinutes, 59);
  const reverse = { originLatitude: POINTS.destinationLatitude, originLongitude: POINTS.destinationLongitude,
    destinationLatitude: POINTS.originLatitude, destinationLongitude: POINTS.originLongitude };
  await api.getRoute(reverse); assert.equal(calls, 2);
  time += 1; const refreshed = await api.getRoute(POINTS); assert.equal(calls, 3); assert.notEqual(refreshed.fetchedAt, cached.fetchedAt);
  const small = client(async () => { calls++; return json(route()); }, { maxCacheEntries: 1 });
  await small.getRoute(POINTS); await small.getRoute(reverse); await small.getRoute(POINTS); assert.equal(calls, 6);
});

test('matching inflight routes coalesce while excess distinct queries are limited; failures are retryable', async () => {
  let calls = 0, finish;
  const api = client(async () => { calls++; return new Promise(resolve => { finish = () => resolve(json(route())); }); }, { maxPending: 1 });
  const first = api.getRoute(POINTS), same = api.getRoute(POINTS);
  await rejects(api.getRoute({ ...POINTS, destinationLongitude: 127.2 }), 'RATE_LIMIT', 429);
  finish(); const [a, b] = await Promise.all([first, same]); assert.deepEqual(a, b); assert.notEqual(a, b); assert.equal(calls, 1);
  let attempts = 0;
  const retry = client(async () => { if (++attempts === 1) throw new Error(KEY); return json(route()); });
  await rejects(retry.getRoute(POINTS), 'NETWORK_ERROR'); await retry.getRoute(POINTS); assert.equal(attempts, 2);
});

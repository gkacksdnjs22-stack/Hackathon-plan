import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesWorker } from './cloudflare-worker.mjs';
import { PUBLIC_FILES } from './public-assets.mjs';
import { TourApiError } from './tour-client.mjs';
import { DepartureSearchError } from './departure-server.mjs';
import { TransportApiError } from './tago-server.mjs';
import { TourRestaurantError } from './tour-restaurants.mjs';
import { CarRoutingError } from './car-routing.mjs';

const key = 'SYNTHETIC-WORKER-KEY+/=';
const sensitive = 'SYNTHETIC-PRIVATE-RESPONSE-DO-NOT-EXPOSE';
const request = (path, options) => new Request(`https://travel.example${path}`, options);
const routes = [
  ['/api/tour/areas', 'tour.getAreas', []],
  ['/api/tour/places?areaCode=6&city=seoul', 'tour.getPlaces', ['6']],
  [`/api/departures/search?q=${encodeURIComponent('서울역')}`, 'departure.search', ['서울역']],
  [`/api/transport/stops?mode=bus&q=${encodeURIComponent('동서울')}&service=intercity`, 'transport.searchStops', [{ mode: 'bus', q: '동서울', service: 'intercity' }]],
  ['/api/transport/trips?service=train&from=NAT010000&to=NAT014445&date=2026-10-20', 'transport.getTrips', [{ service: 'train', from: 'NAT010000', to: 'NAT014445', date: '2026-10-20' }]],
  [`/api/restaurants?area=${encodeURIComponent('대전')}&district=${encodeURIComponent('유성구')}&category=${encodeURIComponent('한식')}&latitude=36.36&longitude=127.35`, 'restaurants.search', [{ area: '대전', district: '유성구', category: '전체', latitude: '36.36', longitude: '127.35' }]],
  ['/api/car-route?originLatitude=37.55&originLongitude=126.97&destinationLatitude=37.56&destinationLongitude=126.99', 'carRouting.getRoute', [{ originLatitude: '37.55', originLongitude: '126.97', destinationLatitude: '37.56', destinationLongitude: '126.99' }]]
];

function fixture({ failures = new Map(), assetStatus = 200 } = {}) {
  const calls = [], keys = [], assets = [];
  const worker = createPagesWorker({ createClients: ({ serviceKey }) => {
    keys.push(serviceKey);
    const clients = {};
    for (const name of ['tour.getAreas', 'tour.getPlaces', 'departure.search', 'transport.searchStops', 'transport.getTrips', 'restaurants.search', 'carRouting.getRoute']) {
      const [group, method] = name.split('.');
      clients[group] ||= {};
      clients[group][method] = async (...args) => {
        calls.push({ name, args });
        if (failures.has(name)) throw failures.get(name);
        return { items: [], provider: 'TEST', method: name };
      };
    }
    return clients;
  } });
  const env = { DATA_GO_KR_SERVICE_KEY: key, ASSETS: { fetch: async assetRequest => {
    assets.push(assetRequest);
    return new Response('STATIC ASSET', { status: assetStatus, headers: {
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=999', 'X-Asset-Test': 'preserved'
    } });
  } } };
  return { worker, env, calls, keys, assets };
}
function safetyHeaders(response) {
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
}
async function safeError(response, status, code) {
  assert.equal(response.status, status); safetyHeaders(response);
  const text = await response.text();
  assert.ok(!text.includes(key)); assert.ok(!text.includes(encodeURIComponent(key)));
  assert.ok(!text.includes(sensitive)); assert.ok(!text.includes('stack'));
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body), ['error']);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
  assert.equal(body.error.code, code); assert.ok(body.error.message.length > 0);
  return body.error;
}

test('Worker의7개 API가 해당 클라이언트에 쿼리값을 정확히 전달한다', async () => {
  const { worker, env, calls, keys, assets } = fixture();
  for (const [path, name, args] of routes) {
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 200); safetyHeaders(response);
    assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.deepEqual(await response.json(), { items: [], provider: 'TEST', method: name });
    assert.deepEqual(calls.at(-1), { name, args });
  }
  assert.deepEqual(keys, [key]); assert.equal(assets.length, 0);
});

test('이전city 별칭·기본지역과 생략된 선택 쿼리를 호환한다', async () => {
  const { worker, env, calls } = fixture();
  for (const [path, name, args] of [
    ['/api/tour/places?city=seoul', 'tour.getPlaces', ['seoul']],
    ['/api/tour/places', 'tour.getPlaces', ['1']],
    ['/api/departures/search', 'departure.search', [null]],
    ['/api/transport/stops?mode=train&q=station', 'transport.searchStops', [{ mode: 'train', q: 'station', service: undefined }]],
    [`/api/restaurants?area=${encodeURIComponent('서울')}`, 'restaurants.search', [{ area: '서울', district: undefined, category: '전체', latitude: undefined, longitude: undefined }]],
    ['/api/transport/trips', 'transport.getTrips', [{ service: null, from: null, to: null, date: null }]]
  ]) {
    assert.equal((await worker.fetch(request(path), env)).status, 200);
    assert.deepEqual(calls.at(-1), { name, args });
  }
});

test('HEAD는 API를 처리하되 정상·오류 모두 본문을 보내지 않는다', async () => {
  const { worker, env, calls } = fixture();
  for (const [path] of routes) {
    const response = await worker.fetch(request(path, { method: 'HEAD' }), env);
    assert.equal(response.status, 200); assert.equal(await response.text(), ''); safetyHeaders(response);
  }
  assert.equal(calls.length, routes.length);
  const failed = fixture({ failures: new Map([['tour.getAreas', new TourApiError('AUTH_ERROR')]]) });
  const response = await failed.worker.fetch(request('/api/tour/areas', { method: 'HEAD' }), failed.env);
  assert.equal(response.status, 502); assert.equal(await response.text(), '');
});

test('GET·HEAD 이외 요청은405와Allow를 반환하고 클라이언트·정적파일을 호출하지 않는다', async () => {
  const { worker, env, calls, keys, assets } = fixture();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await worker.fetch(request('/api/tour/areas', { method }), env);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD');
    await safeError(response, 405, 'METHOD_NOT_ALLOWED');
  }
  assert.equal(calls.length, 0); assert.equal(keys.length, 0); assert.equal(assets.length, 0);
});

test('비공개 파일·백엔드·알 수 없는 경로를ASSETS 바인딩에 넘기지 않는다', async () => {
  const { worker, env, keys, assets } = fixture();
  for (const path of ['/.env', '/%2eenv', '/.env.example', '/server.mjs', '/tour-client.mjs', '/departure-server.mjs',
    '/tago-server.mjs', '/tour-restaurants.mjs', '/its-traffic.mjs', '/car-routing.mjs', '/restaurant-server.mjs', '/package.json', '/cloudflare-worker.test.mjs',
    '/wrangler.jsonc', '/.git/config', '/backup.zip', '/api/tour/unknown', '/nested/index.html', '/unknown.css']) {
    await safeError(await worker.fetch(request(path), env), 404, 'NOT_FOUND');
  }
  assert.equal(keys.length, 0); assert.equal(assets.length, 0);
});

test('잘못된 인코딩과인코딩된슬래시·역슬래시·널·경로이탈을 차단한다', async () => {
  const { worker, env, keys, assets } = fixture();
  for (const path of ['/%', '/%GG', '/%E0%A4%A']) await safeError(await worker.fetch(request(path), env), 400, 'BAD_REQUEST');
  for (const path of ['/%2e%2e%2findex.html', '/folder%2f..%2findex.html', '/folder%5c..%5cindex.html',
    '/%00index.html', '/%252e%252e%252findex.html', '/%2findex.html']) {
    await safeError(await worker.fetch(request(path), env), 404, 'NOT_FOUND');
  }
  assert.equal(keys.length, 0); assert.equal(assets.length, 0);
});

test('공개목록만ASSETS로 제공하고 정규화한파일경로·미디어타입·안전헤더를 사용한다', async () => {
  const { worker, env, keys, assets } = fixture();
  for (const [filename, type] of PUBLIC_FILES) {
    const response = await worker.fetch(request(`/${filename}`), env);
    assert.equal(response.status, 200); assert.equal(await response.text(), 'STATIC ASSET');
    assert.equal(response.headers.get('Content-Type'), type); safetyHeaders(response);
    assert.equal(response.headers.get('X-Asset-Test'), 'preserved');
    const assetPath = filename === 'index.html' ? '/' : filename === 'sources.html' ? '/sources' : `/${filename}`;
    assert.equal(new URL(assets.at(-1).url).pathname, assetPath);
  }
  for (const path of ['/?v=1', '/%69ndex.html?v=1']) {
    const response = await worker.fetch(request(path, { headers: { 'X-Request-Test': 'forwarded' } }), env);
    assert.equal(response.status, 200);
    const forwarded = assets.at(-1), url = new URL(forwarded.url);
    assert.equal(url.pathname, '/'); assert.equal(url.search, '?v=1');
    assert.equal(forwarded.headers.get('X-Request-Test'), 'forwarded');
  }
  assert.equal(keys.length, 0);
});

test('정적HEAD와ASSETS 오류를 안전하게 처리하고없는 파일을index로 바꾸지 않는다', async () => {
  const head = fixture();
  const response = await head.worker.fetch(request('/%69ndex.html', { method: 'HEAD' }), head.env);
  assert.equal(response.status, 200); assert.equal(await response.text(), '');
  assert.equal(head.assets[0].method, 'HEAD'); assert.equal(new URL(head.assets[0].url).pathname, '/');
  const missing = fixture({ assetStatus: 404 });
  const notFound = await missing.worker.fetch(request('/styles.css'), missing.env);
  assert.equal(notFound.status, 404); assert.equal(await notFound.text(), 'STATIC ASSET'); safetyHeaders(notFound);
  assert.equal(missing.assets.length, 1); assert.equal(new URL(missing.assets[0].url).pathname, '/styles.css');
  await safeError(await head.worker.fetch(request('/index.html'), {}), 500, 'INTERNAL_ERROR');
  await safeError(await head.worker.fetch(request('/index.html'), { ASSETS: { fetch: async () => { throw new Error(sensitive); } } }), 500, 'INTERNAL_ERROR');
});

test('Cloudflare가.html을짧은주소로리다이렉트해도첫화면·출처페이지는반복없이200을반환한다', async () => {
  const assets = [];
  const worker = createPagesWorker({ createClients: () => { throw new Error('Static requests must not create API clients'); } });
  const env = { ASSETS: { fetch: async assetRequest => {
    const url = new URL(assetRequest.url);
    assets.push(url.pathname);
    if (url.pathname.endsWith('.html')) {
      url.pathname = url.pathname === '/index.html' ? '/' : url.pathname.slice(0, -5);
      return Response.redirect(url, 308);
    }
    if (url.pathname === '/' || url.pathname === '/sources') return new Response(`HTML ${url.pathname}`, { headers: { 'Content-Type': 'text/html' } });
    return new Response('Not found', { status: 404 });
  } } };
  for (const [path, expected] of [['/', '/'], ['/index.html', '/'], ['/%69ndex.html', '/'],
    ['/sources.html', '/sources'], ['/sources', '/sources'], ['/%73ources.html', '/sources']]) {
    const before = assets.length;
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 200, path); assert.equal(response.headers.get('Location'), null, path);
    assert.equal(await response.text(), `HTML ${expected}`); assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.equal(assets.length, before + 1); assert.equal(assets.at(-1), expected); safetyHeaders(response);
  }
});

test('기본클라이언트의 키미설정은외부호출없이안전한503 안내로 바뀐다', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error(sensitive); };
  try {
    const worker = createPagesWorker();
    for (const path of ['/api/tour/areas', '/api/tour/places?areaCode=1',
      '/api/transport/stops?mode=train&q=station',
      '/api/car-route?originLatitude=37.55&originLongitude=126.97&destinationLatitude=37.56&destinationLongitude=126.99', `/api/restaurants?area=${encodeURIComponent('서울')}`]) {
      const error = await safeError(await worker.fetch(request(path), {}), 503, 'KEY_MISSING');
      assert.equal(error.message, '서비스 설정이 아직 완료되지 않았어요. 관리자에게 문의해 주세요.');
      assert.ok(!error.message.includes('.env')); assert.ok(!error.message.includes('DATA_GO_KR_SERVICE_KEY'));
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('각클라이언트의정제오류는상태·코드를 유지하고 부가정보를 노출하지 않는다', async () => {
  const cases = [
    ['/api/tour/areas', 'tour.getAreas', new TourApiError('AUTH_ERROR')],
    ['/api/departures/search?q=station', 'departure.search', new DepartureSearchError('INVALID_QUERY')],
    ['/api/transport/trips', 'transport.getTrips', new TransportApiError('TODAY_ONLY')],
    ['/api/restaurants', 'restaurants.search', new TourRestaurantError('TIMEOUT')],
    ['/api/restaurants', 'restaurants.search', new TourRestaurantError('RATE_LIMIT')],
    ['/api/car-route', 'carRouting.getRoute', new CarRoutingError('NO_ROUTE')],
    ['/api/car-route', 'carRouting.getRoute', new CarRoutingError('AUTH_ERROR')]
  ];
  for (const [path, name, error] of cases) {
    error.details = `${sensitive} ${key}`;
    const { worker, env } = fixture({ failures: new Map([[name, error]]) });
    const actual = await safeError(await worker.fetch(request(path), env), error.status, error.code);
    assert.equal(actual.message, error.message);
  }
});

test('알수없는오류의메시지·스택·임의status/code를 응답에 포함하지 않는다', async () => {
  const error = Object.assign(new Error(`${sensitive} ${key}`), { code: 'KEY_MISSING', status: 418 });
  const { worker, env } = fixture({ failures: new Map([['tour.getAreas', error]]) });
  const actual = await safeError(await worker.fetch(request('/api/tour/areas'), env), 500, 'INTERNAL_ERROR');
  assert.equal(actual.message, new TourApiError('INTERNAL_ERROR').message);
  const broken = createPagesWorker({ createClients: () => { throw error; } });
  await safeError(await broken.fetch(request('/api/tour/areas'), env), 500, 'INTERNAL_ERROR');
});

test('공통키를우선하고빈값을건너뛰며이전TourAPI·TAGO 설정을호환한다', async () => {
  for (const [env, expected] of [
    [{ DATA_GO_KR_SERVICE_KEY: ' common ', TOURAPI_SERVICE_KEY: 'tour', TAGO_SERVICE_KEY: 'tago' }, 'common'],
    [{ DATA_GO_KR_SERVICE_KEY: ' ', TOURAPI_SERVICE_KEY: ' tour ', TAGO_SERVICE_KEY: 'tago' }, 'tour'],
    [{ DATA_GO_KR_SERVICE_KEY: null, TOURAPI_SERVICE_KEY: 42, TAGO_SERVICE_KEY: ' tago ' }, 'tago'],
    [{ TOURAPI_SERVICE_KEY: ' ', TAGO_SERVICE_KEY: 'tago' }, 'tago'],
    [{}, undefined]
  ]) {
    const { worker, keys } = fixture();
    assert.equal((await worker.fetch(request('/api/tour/areas'), env)).status, 200);
    assert.deepEqual(keys, [expected]);
  }
});

test('같은유효키는클라이언트를재사용하고키변경·삭제시재생성한다', async () => {
  const { worker, keys, env } = fixture();
  await worker.fetch(request('/api/tour/areas'), { DATA_GO_KR_SERVICE_KEY: ' alpha ', TOURAPI_SERVICE_KEY: 'unused' });
  await worker.fetch(request('/api/tour/places'), { DATA_GO_KR_SERVICE_KEY: 'alpha', TOURAPI_SERVICE_KEY: 'changed-unused' });
  await worker.fetch(request('/api/tour/areas'), { TOURAPI_SERVICE_KEY: 'alpha' });
  assert.deepEqual(keys, ['alpha']);
  await worker.fetch(request('/index.html'), { ...env, DATA_GO_KR_SERVICE_KEY: 'static-only' });
  assert.deepEqual(keys, ['alpha']);
  await worker.fetch(request('/api/tour/areas'), { DATA_GO_KR_SERVICE_KEY: 'beta' });
  await worker.fetch(request('/api/tour/areas'), {});
  await worker.fetch(request('/api/tour/areas'));
  assert.deepEqual(keys, ['alpha', 'beta', undefined]);
});

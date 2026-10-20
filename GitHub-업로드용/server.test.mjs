import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTourClient, createAppServer, normalizeAreas, normalizeItems, normalizeServiceKey, resolveServiceKey, loadEnvFile } from './server.mjs';
import { TransportApiError } from './tago-server.mjs';
import { RestaurantApiError } from './restaurant-server.mjs';
import { TourRestaurantError } from './tour-restaurants.mjs';

const secret = 'TEST-PRIVATE-KEY+/=';
const rawItem = (id = '101', type = '12') => ({ contentid: id, contenttypeid: type, areacode: '1', sigungucode: '23', title: '서울 관광지', addr1: '서울 종로구', addr2: '1층', mapy: '37.57', mapx: '126.98', firstimage: 'https://example.com/place.jpg', private: secret });
const success = (items = [rawItem()], totalCount = items.length) => new Response(JSON.stringify({ response: { header: { resultCode: '0000', resultMsg: 'OK' }, body: { items: { item: items }, totalCount } } }), { headers: { 'content-type': 'application/json' } });

async function removeTestDirectory(directory) {
  const root = path.resolve(tmpdir());
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), root, 'Only an immediate temporary test directory may be removed');
  assert.match(path.basename(target), /^travel-(?:env|public)-/);
  await rm(target, { recursive: true, force: true });
}

test('공통 인증키를 우선하고 런타임 및 이전 변수명을 일관된 순서로 지원한다', () => {
  const file = Object.freeze({ DATA_GO_KR_SERVICE_KEY: 'file-common', TOURAPI_SERVICE_KEY: 'file-tour', TAGO_SERVICE_KEY: 'file-tago' });
  const runtime = Object.freeze({ DATA_GO_KR_SERVICE_KEY: 'runtime-common', TOURAPI_SERVICE_KEY: 'runtime-tour', TAGO_SERVICE_KEY: 'runtime-tago' });
  assert.equal(resolveServiceKey(file, runtime), 'runtime-common');
  assert.equal(resolveServiceKey(file, { TOURAPI_SERVICE_KEY: 'runtime-tour', TAGO_SERVICE_KEY: 'runtime-tago' }), 'file-common');
  assert.equal(resolveServiceKey({ TOURAPI_SERVICE_KEY: 'file-tour', TAGO_SERVICE_KEY: 'file-tago' }, { TOURAPI_SERVICE_KEY: 'runtime-tour', TAGO_SERVICE_KEY: 'runtime-tago' }), 'runtime-tour');
  assert.equal(resolveServiceKey({ TOURAPI_SERVICE_KEY: 'file-tour' }, { TAGO_SERVICE_KEY: 'runtime-tago' }), 'runtime-tago');
  assert.equal(resolveServiceKey({ TOURAPI_SERVICE_KEY: 'file-tour', TAGO_SERVICE_KEY: 'file-tago' }, {}), 'file-tour');
  assert.equal(resolveServiceKey({ TAGO_SERVICE_KEY: 'file-tago' }, {}), 'file-tago');
  assert.equal(resolveServiceKey({}, { TAGO_SERVICE_KEY: 'runtime-tago' }), 'runtime-tago');
});

test('빈 인증키는 건너뛰고 키가 없으면 공통 변수명으로 안전하게 안내한다', async () => {
  assert.equal(resolveServiceKey({ DATA_GO_KR_SERVICE_KEY: '  file-common  ' }, { DATA_GO_KR_SERVICE_KEY: '   ' }), 'file-common');
  assert.equal(resolveServiceKey({ DATA_GO_KR_SERVICE_KEY: '', TAGO_SERVICE_KEY: '  file-tago  ' }, { DATA_GO_KR_SERVICE_KEY: null, TOURAPI_SERVICE_KEY: ' \t ' }), 'file-tago');
  assert.equal(resolveServiceKey({}, {}), undefined);
  assert.equal(resolveServiceKey({ DATA_GO_KR_SERVICE_KEY: null, TOURAPI_SERVICE_KEY: '' }, { TAGO_SERVICE_KEY: '  ' }), undefined);
  const encoded = encodeURIComponent(secret);
  assert.equal(normalizeServiceKey(resolveServiceKey({ DATA_GO_KR_SERVICE_KEY: encoded }, {})), secret);
  let calls = 0;
  const client = createTourClient({ serviceKey: resolveServiceKey({}, {}), fetchImpl: async () => { calls++; return success(); } });
  await assert.rejects(client.getAreas(), error => error.code === 'KEY_MISSING'
    && error.status === 503 && error.message.includes('DATA_GO_KR_SERVICE_KEY') && !error.message.includes(secret));
  assert.equal(calls, 0);
});

test('인코딩·디코딩 인증키를 한 번 인코딩하고 .env 인용부호를 읽는다', async () => {
  assert.equal(normalizeServiceKey(secret), secret);
  assert.equal(normalizeServiceKey(encodeURIComponent(secret)), secret);
  const directory = await mkdtemp(path.join(tmpdir(), 'travel-env-'));
  try {
    const filename = path.join(directory, '.env');
    await writeFile(filename, `\uFEFF# comment\nTOURAPI_SERVICE_KEY="${secret}"\nexport PORT=3000 # port\n`, 'utf8');
    assert.deepEqual(await loadEnvFile(filename), { TOURAPI_SERVICE_KEY: secret, PORT: '3000' });
  } finally { await removeTestDirectory(directory); }
  let requests = 0;
  const client = createTourClient({ serviceKey: encodeURIComponent(secret), fetchImpl: async url => {
    assert.equal(url.searchParams.get('serviceKey'), secret);
    assert.equal(url.pathname, '/B551011/KorService2/areaBasedList2');
    assert.equal(url.searchParams.get('areaCode'), '1');
    assert.equal(url.searchParams.get('_type'), 'json');
    requests++;
    return success([rawItem(String(requests), url.searchParams.get('contentTypeId'))]);
  } });
  const result = await client.getPlaces();
  assert.equal(result.items.length, 2);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('공개 필드만 정규화하고 잘못된 좌표·이미지·중복 항목을 정리한다', () => {
  const items = normalizeItems([rawItem(), { ...rawItem('102', '14'), mapx: 'NaN', mapy: 100, firstimage: 'javascript:alert(1)' }, { ...rawItem(), private: 'ignored' }, { title: '식별자 없음' }]);
  assert.equal(items.length, 2);
  assert.deepEqual(Object.keys(items[0]).sort(), ['address', 'areaCode', 'sigunguCode', 'category', 'contentId', 'contentTypeId', 'imageUrl', 'latitude', 'longitude', 'title'].sort());
  assert.equal(items[0].areaCode, '1');
  assert.equal(items[0].sigunguCode, '23');
  assert.equal(items[0].address, '서울 종로구 1층');
  assert.equal(items[0].latitude, 37.57);
  assert.equal(items[1].latitude, null);
  assert.equal(items[1].longitude, null);
  assert.equal(items[1].imageUrl, '');
  assert.equal(items[1].category, '문화시설');
  assert.equal(normalizeItems({ ...rawItem(), contenttypeid: '' }, '12').length, 1);
  assert.equal(normalizeItems({ ...rawItem(), areacode: '' }, '12', '6')[0].areaCode, '6');
  assert.deepEqual(normalizeAreas([{ code: '01', name: '서울', private: secret }, { code: '6', name: '부산' }, { code: '6', name: '부산' }, { code: '', name: '오류' }, { code: '99', name: '' }]), [{ code: '1', name: '서울' }, { code: '6', name: '부산' }]);
});

test('동시 조회를 합치고 1시간 캐시 만료 후에만 다시 조회한다', async () => {
  let current = 10000;
  let requests = 0;
  let active = 0;
  const client = createTourClient({ serviceKey: secret, now: () => current, fetchImpl: async url => {
    assert.equal(active, 0, '외부 요청은 순차 실행해야 함');
    active++;
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    requests++;
    return success([rawItem(String(requests), url.searchParams.get('contentTypeId'))]);
  } });
  const [first, second] = await Promise.all([client.getPlaces(), client.getPlaces()]);
  assert.strictEqual(first, second);
  assert.equal(requests, 2);
  assert.equal(first.totalCount, 2);
  assert.equal(first.provider, '한국관광공사 TourAPI');
  assert.equal(first.areaCode, '1');
  assert.strictEqual(await client.getPlaces('seoul'), first);
  current += 3599999;
  assert.strictEqual(await client.getPlaces(), first);
  assert.equal(requests, 2);
  current += 1;
  await client.getPlaces();
  assert.equal(requests, 4);
});

test('XML·JSON·네트워크 오류를 고정 문구로 바꾸고 실패는 캐시하지 않는다', async () => {
  const cases = [
    [() => new Response(`<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>${secret}</errMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>`), 'AUTH_ERROR'],
    [() => new Response(JSON.stringify({ response: { header: { resultCode: '22', resultMsg: secret } } })), 'RATE_LIMIT'],
    [() => new Response(secret, { status: 503 }), 'UPSTREAM_ERROR'],
    [() => new Response(`bad response ${secret}`), 'INVALID_RESPONSE'],
    [() => { throw new Error(secret); }, 'NETWORK_ERROR']
  ];
  for (const [response, code] of cases) {
    let requests = 0;
    const client = createTourClient({ serviceKey: secret, fetchImpl: async () => { requests++; return response(); } });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(client.getPlaces(), error => error.code === code && !error.message.includes(secret));
    }
    assert.equal(requests, 2);
  }
  await assert.rejects(createTourClient().getPlaces(), error => error.code === 'KEY_MISSING');
  await assert.rejects(createTourClient().getPlaces('tokyo'), error => error.code === 'UNSUPPORTED_CITY');
  for (const areaCode of ['', '0', '123', '../6', '6&serviceKey=other']) {
    await assert.rejects(createTourClient().getPlaces(areaCode), error => error.code === 'UNSUPPORTED_CITY');
  }
});

test('지연된 외부 요청을 취소한다', async () => {
  const client = createTourClient({ serviceKey: secret, timeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error(secret)), { once: true });
  }) });
  await assert.rejects(client.getPlaces(), error => error.code === 'TIMEOUT' && !error.message.includes(secret));
});

test('관광 API 인증키가 있는 요청의 외부 리다이렉트를 따라가지 않는다', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const client = createTourClient({ serviceKey: secret, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url.origin, 'https://apis.data.go.kr');
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status, headers: { Location: 'https://redirect.example/private' } });
    } });
    await assert.rejects(client.getAreas(), error => error.code === 'UPSTREAM_ERROR' && !error.message.includes(secret) && !error.message.includes('redirect.example'));
    assert.equal(calls, 1);
  }
});

test('필요한 경우 페이지를 순차 합치고 빈 목록도 처리한다', async () => {
  const queries = [];
  const client = createTourClient({ serviceKey: secret, rows: 1, maxPages: 2, fetchImpl: async url => {
    const type = url.searchParams.get('contentTypeId');
    const page = url.searchParams.get('pageNo');
    queries.push([type, page]);
    return success(type === '12' ? [rawItem(`10${page}`, type)] : [], type === '12' ? 2 : 0);
  } });
  const result = await client.getPlaces();
  assert.deepEqual(queries, [['12', '1'], ['12', '2'], ['14', '1']]);
  assert.equal(result.items.length, 2);
  assert.equal(result.totalCount, 2);
  assert.equal(result.truncated, false);
});

test('공공 API 지역 목록을 정규화하고 동시 조회와 캐시를 합친다', async () => {
  let current = 10000;
  let requests = 0;
  const client = createTourClient({ serviceKey: secret, now: () => current, fetchImpl: async url => {
    requests++;
    assert.equal(url.pathname, '/B551011/KorService2/areaCode2');
    assert.equal(url.searchParams.get('numOfRows'), '100');
    assert.equal(url.searchParams.has('areaCode'), false);
    return success([{ code: '1', name: '서울', private: secret }, { code: '6', name: '부산' }]);
  } });
  const [first, second] = await Promise.all([client.getAreas(), client.getAreas()]);
  assert.strictEqual(first, second);
  assert.equal(requests, 1);
  assert.deepEqual(first.items, [{ code: '1', name: '서울' }, { code: '6', name: '부산' }]);
  assert.equal(JSON.stringify(first).includes(secret), false);
  assert.strictEqual(await client.getAreas(), first);
  current += 3600000;
  await client.getAreas();
  assert.equal(requests, 2);
});

test('지역마다 조회·캐시가 분리되고 같은 지역의 요청만 합친다', async () => {
  const counts = { '1': 0, '6': 0 };
  const client = createTourClient({ serviceKey: secret, fetchImpl: async url => {
    const areaCode = url.searchParams.get('areaCode');
    const type = url.searchParams.get('contentTypeId');
    counts[areaCode]++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return success([{ ...rawItem(`${areaCode}${type}`, type), areacode: areaCode }]);
  } });
  const [seoul, busan, secondBusan] = await Promise.all([client.getPlaces('seoul'), client.getPlaces('6'), client.getPlaces(6)]);
  assert.equal(seoul.areaCode, '1');
  assert.equal(busan.areaCode, '6');
  assert.strictEqual(busan, secondBusan);
  assert.deepEqual(counts, { '1': 2, '6': 2 });
  assert.equal(busan.items.every(item => item.areaCode === '6'), true);
  assert.strictEqual(await client.getPlaces('1'), seoul);
  assert.strictEqual(await client.getPlaces('6'), busan);
  assert.deepEqual(counts, { '1': 2, '6': 2 });
});

test('페이지 제한에 걸린 목록은 truncated로 표시한다', async () => {
  const pages = [];
  const client = createTourClient({ serviceKey: secret, rows: 1, maxPages: 2, fetchImpl: async url => {
    const type = url.searchParams.get('contentTypeId');
    const page = url.searchParams.get('pageNo');
    pages.push([type, page]);
    return success(type === '12' ? [rawItem(`10${page}`, type)] : [], type === '12' ? 3 : 0);
  } });
  const result = await client.getPlaces('6');
  assert.deepEqual(pages, [['12', '1'], ['12', '2'], ['14', '1']]);
  assert.equal(result.truncated, true);
  assert.equal(result.totalCount, 3);
  assert.equal(result.items.length, 2);
});

test('정적 파일·API만 제공하고 키·백엔드·압축파일·경로 이탈을 막는다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'travel-public-'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>여행</title>');
  await writeFile(path.join(directory, '.env'), `TOURAPI_SERVICE_KEY=${secret}`);
  let fail = false;
  const stopQueries = [], tripQueries = [], restaurantQueries=[];
  const server = createAppServer({ root: directory, client: { getPlaces: async city => {
    if (fail) throw new Error(secret);
    return { provider: '한국관광공사 TourAPI', city, items: [] };
  }, getAreas: async () => ({ provider: '한국관광공사 TourAPI', items: [{ code: '6', name: '부산' }] }) }, departureClient: { search: async query => {
    if(query==='bad')throw new Error(secret);
    return {provider:'Photon / OpenStreetMap',query,items:[]};
  }}, transportClient: {
    searchStops: async query => {
      stopQueries.push(query);
      if (['AUTH_ERROR', 'TIMEOUT', 'RATE_LIMIT', 'INVALID_QUERY'].includes(query.q)) {
        const error = new TransportApiError(query.q);
        error.details = secret;
        throw error;
      }
      return { provider: '국토교통부 TAGO', items: [{ id: 'tago-train-NAT010000', name: '서울' }] };
    },
    getTrips: async query => {
      tripQueries.push(query);
      if (query.from === 'unsafe') throw new Error(secret);
      if (query.date === 'invalid') throw new TransportApiError('INVALID_DATE');
      return { provider: '국토교통부 TAGO', items: [{ id: 'trip-public-id', durationMinutes: 157 }] };
    }
  },restaurantClient:{search:async query=>{
    restaurantQueries.push(query);
    if(query.area==='unsafe')throw new Error(secret);
    if(query.area==='timeout')throw new RestaurantApiError('TIMEOUT');
    if(query.area==='tour-auth')throw new TourRestaurantError('AUTH_ERROR');
    return {provider:'한국문화정보원',items:[{id:'culture-public',name:'공개 식당'}]};
  }} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (pathname, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    assert.equal((await request('/')).status, 200);
    const head = await request('/index.html?v=1', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    for (const pathname of ['/.env', '/%2eenv', '/.env.example', '/server.mjs', '/departure-server.mjs', '/tago-server.mjs', '/tago-server.test.mjs', '/restaurant-server.mjs','/restaurant-server.test.mjs', '/tour-restaurants.mjs','/tour-restaurants.test.mjs', '/%74ago-server.mjs', '/package.json', '/places.zip', '/data/private.json', '/../.env', '/%2e%2e/index.html', '/%5c.env', '/C:/.env']) {
      const response = await request(pathname);
      assert.equal(response.status, 404, pathname);
      assert.equal(response.body.includes(secret), false);
    }
    assert.equal((await request('/%ZZ')).status, 400);
    const post = await request('/', 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    const api = await request('/api/tour/places?city=seoul');
    assert.equal(api.status, 200);
    assert.equal(JSON.parse(api.body).city, 'seoul');
    const areas = await request('/api/tour/areas');
    assert.equal(areas.status, 200);
    assert.deepEqual(JSON.parse(areas.body).items, [{ code: '6', name: '부산' }]);
    const busan = await request('/api/tour/places?areaCode=6&city=seoul');
    assert.equal(busan.status, 200);
    assert.equal(JSON.parse(busan.body).city, '6', '명시한 지역코드는 이전 city 파라미터보다 우선해야 함');
    const departure=await request(`/api/departures/search?q=${encodeURIComponent('서울역')}`);
    assert.equal(departure.status,200);
    assert.equal(JSON.parse(departure.body).query,'서울역');
    const departureError=await request('/api/departures/search?q=bad');
    assert.equal(departureError.status,500);
    assert.equal(departureError.body.includes(secret),false);
    const stops = await request(`/api/transport/stops?mode=train&q=${encodeURIComponent('서울역')}`);
    assert.equal(stops.status, 200);
    assert.equal(JSON.parse(stops.body).items[0].id, 'tago-train-NAT010000');
    assert.deepEqual(stopQueries.at(-1), { mode: 'train', q: '서울역', service: undefined });
    await request(`/api/transport/stops?mode=bus&service=intercity&q=${encodeURIComponent('동서울')}`);
    assert.deepEqual(stopQueries.at(-1), { mode: 'bus', q: '동서울', service: 'intercity' });
    const trips = await request('/api/transport/trips?service=train&from=NAT010000&to=NAT014445&date=2026-10-20');
    assert.equal(trips.status, 200);
    assert.equal(JSON.parse(trips.body).items[0].durationMinutes, 157);
    assert.deepEqual(tripQueries.at(-1), { service: 'train', from: 'NAT010000', to: 'NAT014445', date: '2026-10-20' });
    for (const [code, status] of [['AUTH_ERROR', 502], ['TIMEOUT', 504], ['RATE_LIMIT', 429], ['INVALID_QUERY', 400]]) {
      const response = await request(`/api/transport/stops?mode=train&q=${code}`);
      assert.equal(response.status, status);
      assert.equal(JSON.parse(response.body).error.code, code);
      assert.equal(JSON.parse(response.body).error.message, new TransportApiError(code).message);
      assert.equal(response.body.includes(secret), false);
      assert.equal(response.body.includes('details'), false);
      assert.equal(response.body.includes('stack'), false);
    }
    const badDate = await request('/api/transport/trips?service=train&from=NAT010000&to=NAT014445&date=invalid');
    assert.equal(badDate.status, 400);
    assert.equal(JSON.parse(badDate.body).error.code, 'INVALID_DATE');
    const transportFailure = await request('/api/transport/trips?service=train&from=unsafe&to=NAT014445&date=2026-10-20');
    assert.equal(transportFailure.status, 500);
    assert.deepEqual(JSON.parse(transportFailure.body), { error: { code: 'INTERNAL_ERROR', message: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' } });
    assert.equal(transportFailure.body.includes(secret), false);
    const restaurants=await request(`/api/restaurants?area=${encodeURIComponent('부산')}&district=${encodeURIComponent('해운대구')}&category=${encodeURIComponent('한식')}&latitude=35.16&longitude=129.06`);
    assert.equal(restaurants.status,200);
    assert.equal(JSON.parse(restaurants.body).items[0].name,'공개 식당');
    assert.deepEqual(restaurantQueries.at(-1),{area:'부산',district:'해운대구',category:'한식',latitude:'35.16',longitude:'129.06'});
    await request(`/api/restaurants?area=${encodeURIComponent('서울')}`);
    assert.deepEqual(restaurantQueries.at(-1),{area:'서울',district:undefined,category:'전체',latitude:undefined,longitude:undefined});
    const restaurantTimeout=await request('/api/restaurants?area=timeout');
    assert.equal(restaurantTimeout.status,504);
    assert.equal(JSON.parse(restaurantTimeout.body).error.code,'TIMEOUT');
    const tourRestaurantAuth=await request('/api/restaurants?area=tour-auth');
    assert.equal(tourRestaurantAuth.status,502);
    assert.equal(JSON.parse(tourRestaurantAuth.body).error.code,'AUTH_ERROR');
    assert.equal(tourRestaurantAuth.body.includes(secret),false);
    const restaurantFailure=await request('/api/restaurants?area=unsafe');
    assert.equal(restaurantFailure.status,500);
    assert.equal(restaurantFailure.body.includes(secret),false);
    fail = true;
    const error = await request('/api/tour/places');
    assert.equal(error.status, 500);
    assert.equal(JSON.parse(error.body).error.code, 'INTERNAL_ERROR');
    assert.equal(error.body.includes(secret), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await removeTestDirectory(directory);
  }
});

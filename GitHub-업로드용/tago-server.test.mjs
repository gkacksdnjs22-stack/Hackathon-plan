import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createTransportClient, TransportApiError } from './tago-server.mjs';

const key = 'SYNTHETIC-TAGO-KEY+/=';
const day = '2026-10-20';
const today = Date.UTC(2026, 9, 19, 15);
const json = (items = [], totalCount = items.length) => new Response(JSON.stringify({ response: {
  header: { resultCode: '00', resultMsg: 'OK' }, body: { items: { item: items }, totalCount }
} }));
const stations = {
  train: [{ nodeid: 'NAT010000', nodename: '서울' }, { nodeid: 'NAT014445', nodename: '부산' }],
  express: [{ terminalId: 'NAEK010', terminalNm: '서울경부' }, { terminalId: 'NAEK700', terminalNm: '부산' }],
  intercity: [{ terminalId: 'NAI0511601', terminalNm: '동서울', cityName: '서울특별시' }, { terminalId: 'NAI2551901', terminalNm: '강릉', cityName: '강원특별자치도' }],
  flight: [{ airportId: 'NAARKSS', airportNm: '김포국제공항' }, { airportId: 'NAARKPC', airportNm: '제주국제공항' }],
  ferry: [{ nodeId: 'SEA31010', nodeNm: '목포' }, { nodeId: 'SEA39010', nodeNm: '제주' }]
};
const rows = {
  train: { trainno: '00001', traingradename: 'KTX', depplacename: '서울', arrplacename: '부산', depplandtime: '20261020051300', arrplandtime: '20261020075000' },
  express: { routeId: 'NAEK010700', depPlaceNm: '서울경부', arrPlaceNm: '부산', depPlandTime: 202610200100, arrPlandTime: 202610200500, gradeNm: '우등' },
  intercity: { routeId: 'NAIRT201603150047306', depPlaceNm: '동서울', arrPlaceNm: '강릉', depPlandTime: 20261020071000, arrPlandTime: 20261020093000, gradeNm: '우등' },
  flight: { airlineNm: '항공사', vihicleId: 'OZ8901', depAirportNm: '김포국제공항', arrAirportNm: '제주국제공항', depPlandTime: 202610200630, arrPlandTime: 202610200745 },
  ferry: { vihicleNm: '여객선', depPlaceNm: '목포', arrPlaceNm: '제주', depPlandTime: 202610200530, arrPlandTime: 202610201530 }
};
const endpoints = {
  TrainInfo: ['train', 'GetCtyAcctoTrainSttnList'], ExpBusInfo: ['express', 'GetExpBusTrminlList'],
  SuburbsBusInfo: ['intercity', 'GetSuberbsBusTrminlList'], DmstcFlightNvgInfo: ['flight', 'GetArprtList'],
  DmstcShipNvgInfo: ['ferry', 'GetPortList']
};
function fixture(options = {}) {
  const calls = [];
  let current = today;
  const fetchImpl = async (url, request) => {
    calls.push({ path: url.pathname, params: new URLSearchParams(url.searchParams) });
    assert.equal(url.origin, 'https://apis.data.go.kr');
    assert.equal(url.searchParams.get('serviceKey'), key);
    assert.equal(url.searchParams.get('_type'), 'json');
    assert.equal(request.redirect, 'manual');
    const [, , base, operation] = url.pathname.split('/');
    const [service, listOperation] = endpoints[base] || [];
    if (!service) throw new Error('Unexpected endpoint');
    if (operation === 'GetCtyCodeList') return json([{ citycode: '11', cityname: '서울특별시' }]);
    const source = operation === listOperation ? stations[service] : options.tripRows?.[service] ?? [rows[service]];
    const page = Number(url.searchParams.get('pageNo')), count = Number(url.searchParams.get('numOfRows'));
    return json(source.slice((page - 1) * count, page * count), source.length);
  };
  return { client: createTransportClient({ serviceKey: encodeURIComponent(key), now: () => current, fetchImpl, ...options.clientOptions }),
    calls, advance: milliseconds => { current += milliseconds; } };
}

test('현재 공식 목록 경로와 기관ID로 5개 수단을 검색한다', async () => {
  const { client, calls } = fixture();
  for (const [mode, q, expected] of [['train', '서울역', 'tago-train-NAT010000'], ['bus', '서울', 'tago-intercity-NAI0511601'],
    ['flight', '김포', 'tago-flight-NAARKSS'], ['ferry', '목포', 'tago-ferry-SEA31010']]) {
    const result = await client.searchStops({ mode, q });
    assert.ok(result.items.some(item => item.id === expected));
    assert.ok(result.items.every(item => item.source === 'TAGO' && item.latitude === null && item.longitude === null));
    assert.ok(result.items.every(item => /^https:\/\/www\.data\.go\.kr\/data\/\d+\/openapi.do$/.test(item.sourceUrl)));
    assert.equal(JSON.stringify(result).includes(key), false);
  }
  assert.ok(calls.some(call => call.path === '/1613000/TrainInfo/GetCtyCodeList'));
  assert.ok(calls.some(call => call.path === '/1613000/TrainInfo/GetCtyAcctoTrainSttnList' && call.params.get('cityCode') === '11'));
  assert.ok(calls.some(call => call.path === '/1613000/DmstcShipNvgInfo/GetPortList'));
  assert.ok(calls.every(call => !call.path.includes('Service/')));
});

test('수단별 12·14자리 시각을 분 단위의 운행정보로 정규화한다', async () => {
  const { client, calls } = fixture();
  const cases = [
    ['train', 'NAT010000', 'NAT014445', 313, 470, '00001'],
    ['express', 'NAEK010', 'NAEK700', 60, 300, ''],
    ['intercity', 'NAI0511601', 'NAI2551901', 430, 570, ''],
    ['flight', 'NAARKSS', 'NAARKPC', 390, 465, 'OZ8901'],
    ['ferry', 'SEA31010', 'SEA39010', 330, 930, '여객선']
  ];
  for (const [service, from, to, departureMinutes, arrivalMinutes, tripNo] of cases) {
    const result = await client.getTrips({ service, from, to, date: day });
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.service, service); assert.equal(item.date, day);
    assert.equal(item.departureId, from); assert.equal(item.arrivalId, to);
    assert.equal(item.departureMinutes, departureMinutes); assert.equal(item.arrivalMinutes, arrivalMinutes);
    assert.equal(item.durationMinutes, arrivalMinutes - departureMinutes); assert.equal(item.tripNo, tripNo);
    assert.equal(item.source, 'TAGO'); assert.equal(result.truncated, false);
    assert.equal(Object.keys(item).length, 15);
    // Preserve the existing Node SHA-256 identifiers, including UTF-8 trip names.
    if (service === 'train') assert.equal(item.id, 'tago-trip-train-5c2fb5e81b5d76be8c050934');
    if (service === 'ferry') assert.equal(item.id, 'tago-trip-ferry-beca7edb1b6a0ec432279dd4');
  }
  const train = calls.find(call => call.path.endsWith('/GetStrtpntAlocFndTrainInfo'));
  assert.equal(train.params.get('depPlaceId'), 'NAT010000'); assert.equal(train.params.get('arrPlaceId'), 'NAT014445');
  assert.equal(train.params.get('depPlandTime'), '20261020');
  const ferry = calls.find(call => call.path.endsWith('/GetShipOpratInfoList'));
  assert.equal(ferry.params.get('depNodeId'), 'SEA31010');
  assert.equal(ferry.params.has('arrNodeId'), false);
});

test('익일 도착만 날짜대로 계산하고 0·음수·다른 날짜·잘못된 운행행을 제외한다', async () => {
  const overnight = { ...rows.express, depPlandTime: 202610202330, arrPlandTime: 202610210145 };
  const { client } = fixture({ tripRows: { express: [
    overnight, { ...overnight },
    { ...overnight, arrPlandTime: 202610202330 },
    { ...overnight, arrPlandTime: 202610202200 },
    { ...overnight, arrPlandTime: 202610240001 },
    { ...overnight, depPlandTime: 202610192330 },
    { ...overnight, depPlandTime: '202602300900' },
    { ...overnight, arrPlandTime: '202610212500' },
    { ...overnight, arrPlaceNm: '다른 터미널' }
  ] } });
  const result = await client.getTrips({ service: 'express', from: 'NAEK010', to: 'NAEK700', date: day });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].departureMinutes, 1410);
  assert.equal(result.items[0].arrivalMinutes, 1545);
  assert.equal(result.items[0].durationMinutes, 135);
});

test('선박은 출발항의 전체 운항정보에서 선택한 도착항만 연결한다', async () => {
  const { client } = fixture({ tripRows: { ferry: [{ ...rows.ferry, arrPlaceNm: '다른항' }, rows.ferry] } });
  const result = await client.getTrips({ service: 'ferry', from: 'SEA31010', to: 'SEA39010', date: day });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].arrivalName, '제주');
});

test('검증된 기관목록을 24시간 보관하고 같은 운행조회 요청을 합친다', async () => {
  const { client, calls, advance } = fixture();
  await Promise.all([client.searchStops({ mode: 'train', q: '서울역' }), client.searchStops({ mode: 'train', q: '부산' })]);
  assert.equal(calls.length, 2);
  advance(24 * 60 * 60 * 1000 - 1);
  await client.searchStops({ mode: 'train', q: '서울역' }); assert.equal(calls.length, 2);
  advance(1);
  await client.searchStops({ mode: 'train', q: '서울역' }); assert.equal(calls.length, 4);
  const query = { service: 'train', from: 'NAT010000', to: 'NAT014445', date: day };
  const [first, second] = await Promise.all([client.getTrips(query), client.getTrips(query)]);
  assert.strictEqual(first, second);
  assert.equal(calls.filter(call => call.path.endsWith('/GetStrtpntAlocFndTrainInfo')).length, 1);
  await client.getTrips(query);
  assert.equal(calls.filter(call => call.path.endsWith('/GetStrtpntAlocFndTrainInfo')).length, 1);
});

test('잘못된 입력과 시외버스의 한국시간 오늘 제한을 조회 전에 확인한다', async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.searchStops({ mode: 'train', q: '가' }), error => error.code === 'INVALID_QUERY');
  await assert.rejects(client.searchStops({ mode: 'car', q: '서울' }), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(client.searchStops({ mode: 'train', service: 'flight', q: '서울' }), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(client.getTrips({ service: 'train', from: 'bad/url', to: 'NAT014445', date: day }), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(client.getTrips({ service: 'train', from: 'NAT010000', to: 'NAT014445', date: '2026-02-30' }), error => error.code === 'INVALID_DATE');
  await assert.rejects(client.getTrips({ service: 'intercity', from: 'NAI0511601', to: 'NAI2551901', date: '2026-10-19' }), error => error.code === 'TODAY_ONLY' && error.message.includes('한국시간'));
  assert.equal(calls.length, 0);
  await assert.rejects(client.getTrips({ service: 'express', from: 'UNVERIFIED', to: 'NAEK700', date: day }), error => error.code === 'UNKNOWN_STOP');
  assert.equal(calls.some(call => call.path.endsWith('/GetStrtpntAlocFndExpbusInfo')), false);
});

test('페이지를 합치고 최대 행 제한과 중복 제거를 표시한다', async () => {
  const { client, calls } = fixture({ clientOptions: { pageSize: 1, maximumItems: 2 }, tripRows: { express: [
    rows.express, { ...rows.express, depPlandTime: 202610200600, arrPlandTime: 202610201000 },
    { ...rows.express, depPlandTime: 202610200700, arrPlandTime: 202610201100 }
  ] } });
  const result = await client.getTrips({ service: 'express', from: 'NAEK010', to: 'NAEK700', date: day });
  assert.equal(result.items.length, 2); assert.equal(result.truncated, true);
  assert.deepEqual(calls.filter(call => call.path.endsWith('/GetStrtpntAlocFndExpbusInfo')).map(call => call.params.get('pageNo')), ['1', '2']);
});

test('빈 운행목록은 정상 빈 결과로 반환한다', async () => {
  const { client } = fixture({ tripRows: { flight: [] } });
  const result = await client.getTrips({ service: 'flight', from: 'NAARKSS', to: 'NAARKPC', date: day });
  assert.deepEqual(result.items, []); assert.equal(result.truncated, false);
});

test('인증·호출제한·JSON·XML 오류를 정제하고 실패를 캐시하지 않는다', async () => {
  const cases = [
    [() => new Response(`<error><returnReasonCode>30</returnReasonCode><message>${key}</message></error>`), 'AUTH_ERROR', 502],
    [() => new Response(JSON.stringify({ response: { header: { resultCode: '20', resultMsg: key } } })), 'AUTH_ERROR', 502],
    [() => new Response(key, { status: 429 }), 'RATE_LIMIT', 429],
    [() => new Response(key, { status: 500 }), 'UPSTREAM_ERROR', 502],
    [() => new Response(key), 'INVALID_RESPONSE', 502],
    [() => new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: {} } })), 'INVALID_RESPONSE', 502],
    [() => { throw new Error(key); }, 'NETWORK_ERROR', 502]
  ];
  for (const [makeResponse, code, status] of cases) {
    let calls = 0;
    const client = createTransportClient({ serviceKey: key, fetchImpl: async () => { calls++; return makeResponse(); } });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(client.searchStops({ mode: 'flight', q: '공항' }), error => error instanceof TransportApiError
        && error.code === code && error.status === status && !error.message.includes(key));
    }
    assert.equal(calls, 2);
  }
});

test('미설정 인증키와 응답 지연은 별도 오류로 반환한다', async () => {
  let calls = 0;
  await assert.rejects(createTransportClient({ fetchImpl: async () => { calls++; return json(); } }).searchStops({ mode: 'flight', q: '공항' }),
    error => error.code === 'KEY_MISSING' && error.status === 503);
  assert.equal(calls, 0);
  const client = createTransportClient({ serviceKey: key, timeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error(key)), { once: true });
  }) });
  await assert.rejects(client.searchStops({ mode: 'ferry', q: '목포' }), error => error.code === 'TIMEOUT' && error.status === 504 && !error.message.includes(key));
});

test('TAGO 인증키가 있는 요청의 외부 리다이렉트를 따라가지 않는다', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const client = createTransportClient({ serviceKey: key, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url.origin, 'https://apis.data.go.kr');
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status, headers: { Location: 'https://redirect.example/private' } });
    } });
    await assert.rejects(client.searchStops({ mode: 'flight', q: '공항' }), error => error.code === 'UPSTREAM_ERROR' && !error.message.includes('redirect.example'));
    assert.equal(calls, 1);
  }
});

test('one unavailable bus service does not hide the other service and retry recovers without caching failure', async () => {
  let fail = true, intercityCalls = 0;
  const client = createTransportClient({ serviceKey: key, fetchImpl: async url => {
    if (url.pathname.includes('SuburbsBusInfo')) { intercityCalls++; if (fail) return new Response('', { status: 403 }); return json(stations.intercity); }
    return json(stations.express);
  } });
  const partial = await client.searchStops({ mode: 'bus', q: '서울' });
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.unavailableServices, [{ service: 'intercity', code: 'AUTH_ERROR' }]);
  assert.ok(partial.items.some(item => item.service === 'express'));
  assert.equal(partial.items.some(item => item.service === 'intercity'), false);
  fail = false;
  const complete = await client.searchStops({ mode: 'bus', q: '서울' });
  assert.equal(complete.partial, false);
  assert.ok(complete.items.some(item => item.service === 'intercity'));
  assert.equal(intercityCalls, 2);
});

test('train region catalogs load concurrently with at most four requests and stable region ordering', async () => {
  let active = 0, maximum = 0;
  const client = createTransportClient({ serviceKey: key, fetchImpl: async url => {
    if (url.pathname.endsWith('GetCtyCodeList')) return json(Array.from({ length: 8 }, (_, i) => ({ citycode: String(11+i), cityname: `지역${i}` })));
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return json([{ nodeid: `NAT${url.searchParams.get('cityCode')}`, nodename: `서울${url.searchParams.get('cityCode')}` }]);
  } });
  const result = await client.searchStops({ mode: 'train', q: '서울' });
  assert.equal(result.items.length, 8);
  assert.equal(maximum, 4);
});

test('TAGO deadline includes stalled response bodies and releases pending work even if fetch ignores abort', async () => {
  for (const stalledBody of [false, true]) {
    let calls = 0;
    const client = createTransportClient({ serviceKey: key, timeoutMs: 5, fetchImpl: async () => {
      calls++;
      if (calls > 1) return json(stations.flight);
      return stalledBody ? new Response(new ReadableStream({ start() {} })) : new Promise(() => {});
    } });
    await assert.rejects(client.searchStops({ mode: 'flight', q: '김포' }), error => error.code === 'TIMEOUT');
    const retry = await client.searchStops({ mode: 'flight', q: '김포' });
    assert.equal(retry.items.length, 1);
  }
});

test('a failed train region returns honest partial results and is retried rather than cached as complete', async () => {
  let failed = true;
  const client = createTransportClient({ serviceKey: key, fetchImpl: async url => {
    if (url.pathname.endsWith('GetCtyCodeList')) return json([{ citycode: '11', cityname: '서울' }, { citycode: '21', cityname: '부산' }]);
    if (url.searchParams.get('cityCode') === '21') { if (failed) return new Response('', { status: 500 }); return json([stations.train[1]]); }
    return json([stations.train[0]]);
  } });
  const first = await client.searchStops({ mode: 'train', q: '서울' });
  assert.equal(first.items.length, 1); assert.equal(first.partial, true);
  assert.equal(first.unavailableServices[0].code, 'CATALOG_INCOMPLETE');
  failed = false;
  const next = await client.searchStops({ mode: 'train', q: '부산' });
  assert.equal(next.items.length, 1); assert.equal(next.partial, false);
});

test('cold train catalog has a bounded total deadline and preserves completed regions', async () => {
  const client = createTransportClient({ serviceKey: key, catalogTimeoutMs: 5, timeoutMs: 20, fetchImpl: async url => {
    if (url.pathname.endsWith('GetCtyCodeList')) return json([{ citycode: '11', cityname: '서울' }, { citycode: '21', cityname: '부산' }]);
    if (url.searchParams.get('cityCode') === '21') return new Promise(() => {});
    return json([stations.train[0]]);
  } });
  const result = await client.searchStops({ mode: 'train', q: '서울' });
  assert.equal(result.items.length, 1); assert.equal(result.partial, true);
});

test('64 paginated train regions resume within 40 attempts, reach the last region and expire their cache', async () => {
  const cities = Array.from({ length: 64 }, (_, i) => ({ citycode: String(i + 1), cityname: `지역${i + 1}` }));
  const calls = []; let clock = 0;
  const client = createTransportClient({ serviceKey: key, pageSize: 8, catalogCacheMs: 100, now: () => clock, fetchImpl: async url => {
    calls.push(new URL(url));
    const city = url.searchParams.get('cityCode'), page = Number(url.searchParams.get('pageNo'));
    const source = city ? Array.from({ length: 9 }, (_, i) => ({ nodeid: `NAT${city}_${i}`, nodename: city === '64' ? `마지막역${i}` : `일반역${city}_${i}` })) : cities;
    return json(source.slice((page - 1) * 8, page * 8), source.length);
  } });
  let result;
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = calls.length;
    result = await client.searchStops({ mode: 'train', q: '마지막' });
    assert.ok(calls.length - before <= 40);
    if (attempt === 0) { assert.equal(result.partial, true); assert.deepEqual(result.items, []); }
    if (!result.partial) break;
  }
  assert.equal(result.partial, false);
  assert.equal(result.items.length, 9);
  assert.equal(calls.filter(url => url.pathname.endsWith('GetCtyCodeList')).length, 8);
  const beforeWarm = calls.length;
  await client.searchStops({ mode: 'train', q: '마지막' });
  assert.equal(calls.length, beforeWarm);
  clock = 100;
  const beforeExpired = calls.length;
  const expired = await client.searchStops({ mode: 'train', q: '마지막' });
  assert.ok(calls.length - beforeExpired <= 40);
  assert.equal(expired.partial, true);
  assert.equal(calls.filter(url => url.pathname.endsWith('GetCtyCodeList')).length, 16);
});

test('an oversized train city list is rejected without station fetches and is retried', async () => {
  let calls = 0;
  const client = createTransportClient({ serviceKey: key, fetchImpl: async url => {
    calls++; assert.ok(url.pathname.endsWith('GetCtyCodeList'));
    return json(Array.from({ length: 65 }, (_, i) => ({ citycode: String(i + 1), cityname: `지역${i}` })));
  } });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(client.searchStops({ mode: 'train', q: '서울' }), error => error.code === 'INVALID_RESPONSE');
    assert.equal(calls, attempt + 1);
  }
});

test('city-list paging beyond ten pages checkpoints within the same 40-attempt budget and eventually reaches city 64', async () => {
  const calls = [];
  const client = createTransportClient({ serviceKey: key, pageSize: 1, fetchImpl: async url => {
    calls.push(new URL(url));
    if (url.pathname.endsWith('GetCtyCodeList')) {
      const page = Number(url.searchParams.get('pageNo'));
      return json([{ citycode: String(page), cityname: `지역${page}` }], 64);
    }
    const city = url.searchParams.get('cityCode');
    return json([{ nodeid: `NAT${city}`, nodename: city === '64' ? '마지막역' : `일반역${city}` }]);
  } });
  let result;
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = calls.length;
    result = await client.searchStops({ mode: 'train', q: '마지막' });
    assert.ok(calls.length - before <= 40);
    if (attempt === 0) { assert.equal(result.partial, true); assert.deepEqual(result.items, []); }
    if (!result.partial) break;
  }
  assert.equal(result.partial, false); assert.equal(result.items[0].providerId, 'NAT64');
  assert.deepEqual(calls.filter(url => url.pathname.endsWith('GetCtyCodeList')).map(url => Number(url.searchParams.get('pageNo'))),
    Array.from({ length: 64 }, (_, i) => i + 1));
});

test('a cold train trip shares one 40-attempt budget with catalog paging and reserves all ten trip pages', async () => {
  const calls = [];
  const cities = Array.from({ length: 64 }, (_, i) => ({ citycode: String(i + 1), cityname: `지역${i}` }));
  const tripRows = Array.from({ length: 80 }, (_, i) => ({ ...rows.train, trainno: String(i + 1) }));
  const client = createTransportClient({ serviceKey: key, pageSize: 8, fetchImpl: async url => {
    calls.push(new URL(url));
    const page = Number(url.searchParams.get('pageNo'));
    if (url.pathname.endsWith('GetCtyCodeList')) return json(cities.slice((page - 1) * 8, page * 8), 64);
    if (url.pathname.endsWith('GetStrtpntAlocFndTrainInfo')) return json(tripRows.slice((page - 1) * 8, page * 8), 80);
    const city = url.searchParams.get('cityCode');
    return json(city === '1' ? stations.train : [{ nodeid: `NAT${city}`, nodename: `지방역${city}` }]);
  } });
  const result = await client.getTrips({ service: 'train', from: 'NAT010000', to: 'NAT014445', date: day });
  assert.equal(result.items.length, 80); assert.equal(result.truncated, false);
  assert.equal(calls.length, 40);
  assert.equal(calls.filter(url => url.pathname.endsWith('GetStrtpntAlocFndTrainInfo')).length, 10);
});

test('concurrent train, bus and ferry public calls own independent budgets on the same client', async () => {
  const owner = new AsyncLocalStorage(), counts = new Map();
  const client = createTransportClient({ serviceKey: key, fetchImpl: async url => {
    const id = owner.getStore(); counts.set(id, (counts.get(id) || 0) + 1);
    await new Promise(resolve => setImmediate(resolve));
    if (url.pathname.endsWith('GetCtyCodeList')) return json(Array.from({ length: 64 }, (_, i) => ({ citycode: String(i + 1), cityname: `지역${i}` })));
    if (url.pathname.includes('TrainInfo')) return json([{ nodeid: `NAT${url.searchParams.get('cityCode')}`, nodename: '서울기차역' }]);
    const page = Number(url.searchParams.get('pageNo'));
    const row = url.pathname.includes('DmstcShip') ? { nodeId: `PORT${page}`, nodeNm: '목포항' }
      : { terminalId: `TERMINAL${page}`, terminalNm: '서울터미널' };
    return json([row], 10);
  } });
  const results = await Promise.all([
    owner.run('train', () => client.searchStops({ mode: 'train', q: '서울' })),
    owner.run('bus', () => client.searchStops({ mode: 'bus', q: '서울' })),
    owner.run('ferry', () => client.searchStops({ mode: 'ferry', q: '목포' }))
  ]);
  assert.equal(results[0].partial, true);
  assert.equal(results[1].partial, false); assert.equal(results[2].partial, false);
  assert.deepEqual(Object.fromEntries(counts), { train: 40, bus: 20, ferry: 10 });
});

test('failed early train regions cannot starve later regions, and recovery retries failures with a fresh budget', async () => {
  const calls = []; let fail = true;
  const client = createTransportClient({ serviceKey: key, fetchImpl: async url => {
    calls.push(new URL(url));
    if (url.pathname.endsWith('GetCtyCodeList')) return json(Array.from({ length: 64 }, (_, i) => ({ citycode: String(i + 1), cityname: `지역${i}` })));
    const city = Number(url.searchParams.get('cityCode'));
    if (fail && city <= 39) return new Response('', { status: 500 });
    return json([{ nodeid: `NAT${city}`, nodename: city === 64 ? '마지막역' : `일반역${city}` }]);
  } });
  await assert.rejects(client.searchStops({ mode: 'train', q: '마지막' }), error => error.code === 'UPSTREAM_ERROR');
  assert.equal(calls.length, 40);
  let before = calls.length;
  const partial = await client.searchStops({ mode: 'train', q: '마지막' });
  assert.ok(calls.length - before <= 40);
  assert.equal(partial.partial, true); assert.equal(partial.items[0].providerId, 'NAT64');
  fail = false; before = calls.length;
  const complete = await client.searchStops({ mode: 'train', q: '마지막' });
  assert.ok(calls.length - before <= 40); assert.equal(complete.partial, false);
  assert.equal(calls.filter(url => url.searchParams.get('cityCode') === '64').length, 1);
  assert.ok(calls.filter(url => url.searchParams.get('cityCode') === '1').length >= 2);
  assert.equal(calls.filter(url => url.pathname.endsWith('GetCtyCodeList')).length, 1);
});

test('catalog deadlines abort stalled region pages and late responses cannot fetch more pages or fill the cache', async () => {
  const calls = []; let release, fail = true, lateSignal;
  const client = createTransportClient({ serviceKey: key, pageSize: 1, catalogTimeoutMs: 5, timeoutMs: 1000, fetchImpl: async (url, { signal }) => {
    calls.push(new URL(url));
    if (url.pathname.endsWith('GetCtyCodeList')) return json([{ citycode: '11', cityname: '서울' }, { citycode: '21', cityname: '부산' }]);
    if (url.searchParams.get('cityCode') === '11') return json([stations.train[0]]);
    if (fail) { lateSignal = signal; return new Promise(resolve => { release = () => resolve(json([stations.train[1]], 2)); }); }
    return json([stations.train[1]], 2);
  } });
  const first = await client.searchStops({ mode: 'train', q: '서울' });
  assert.equal(first.partial, true); assert.equal(first.items.length, 1); assert.equal(lateSignal.aborted, true);
  const beforeLate = calls.length;
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, beforeLate);
  fail = false;
  const recovered = await client.searchStops({ mode: 'train', q: '부산' });
  assert.equal(recovered.partial, false); assert.equal(recovered.items.length, 1);
  assert.equal(calls.filter(url => url.searchParams.get('cityCode') === '11').length, 1);
  assert.deepEqual(calls.filter(url => url.searchParams.get('cityCode') === '21').map(url => url.searchParams.get('pageNo')), ['1', '1', '2']);
});

test('the total train catalog deadline also covers city-list pages and does not cache late city responses', async () => {
  const calls = []; let release, stall = true;
  const client = createTransportClient({ serviceKey: key, catalogTimeoutMs: 5, timeoutMs: 1000, fetchImpl: async url => {
    calls.push(new URL(url));
    if (url.pathname.endsWith('GetCtyCodeList')) {
      if (stall) return new Promise(resolve => { release = () => resolve(json([{ citycode: '11', cityname: '서울' }], 2)); });
      return json([{ citycode: '11', cityname: '서울' }]);
    }
    return json(stations.train);
  } });
  await assert.rejects(client.searchStops({ mode: 'train', q: '서울' }), error => error.code === 'TIMEOUT');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  stall = false;
  const recovered = await client.searchStops({ mode: 'train', q: '서울' });
  assert.equal(recovered.partial, false); assert.equal(recovered.items.length, 1);
  assert.equal(calls.filter(url => url.pathname.endsWith('GetCtyCodeList')).length, 2);
});

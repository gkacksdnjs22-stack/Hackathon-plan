import test from 'node:test';
import assert from 'node:assert/strict';
import { createDepartureClient, DepartureSearchError } from './departure-server.mjs';

const feature = (id = 123, extra = {}) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [126.97, 37.55] },
  properties: { osm_type: 'N', osm_id: id, name: '서울역', countrycode: 'KR', state: '서울특별시',
    city: '서울특별시', district: '용산구', street: '한강대로', housenumber: '405', ...extra }
});
const response = (features = [feature()]) => new Response(JSON.stringify({ type: 'FeatureCollection', features }));
function clockOptions() {
  let time = 10000;
  const waits = [];
  return { now: () => time, advance: milliseconds => { time += milliseconds; }, waits,
    delayImpl: async milliseconds => { waits.push(milliseconds); time += milliseconds; } };
}

test('출발지 검색은 국내 범위·한국어·식별 헤더로 조회한다', async () => {
  let calls = 0;
  const client = createDepartureClient({ fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url.origin, 'https://photon.komoot.io');
    assert.equal(url.pathname, '/api/');
    assert.equal(url.searchParams.get('q'), '서울역');
    assert.equal(url.searchParams.get('bbox'), '124,33,132,39.5');
    assert.equal(url.searchParams.get('countrycode'), 'KR');
    assert.equal(url.searchParams.get('limit'), '5');
    assert.equal(url.searchParams.has('osm_tag'), false, '주소도 검색할 수 있도록 교통수단으로 제한하지 않는다');
    assert.equal(options.headers['Accept-Language'], 'ko');
    assert.equal(options.headers['User-Agent'], 'GilTravelPlanner/1.0');
    assert.equal(options.redirect, 'manual');
    return response();
  } });
  const result = await client.search('  서울역  ');
  assert.equal(calls, 1);
  assert.equal(result.provider, 'Photon / OpenStreetMap');
  assert.equal(Number.isNaN(Date.parse(result.fetchedAt)), false);
  assert.deepEqual(result.items[0], { id: 'osm-node-123', name: '서울역', address: '서울특별시 용산구 한강대로 405',
    latitude: 37.55, longitude: 126.97, source: 'OpenStreetMap', sourceUrl: 'https://www.openstreetmap.org/node/123' });
});

test('UTF-8 한글 문자가 여러 응답 조각으로 나뉘어도 보존한다', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ features: [feature()] }));
  const client = createDepartureClient({ fetchImpl: async () => new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += 2) controller.enqueue(bytes.slice(offset, offset + 2));
      controller.close();
    }
  })) });
  const result = await client.search('서울역');
  assert.equal(result.items[0].name, '서울역');
  assert.equal(result.items[0].address, '서울특별시 용산구 한강대로 405');
});

test('국내 좌표·OSM 식별자를 검증하고 중복과 임의 링크를 제거한다', async () => {
  const client = createDepartureClient({ fetchImpl: async () => response([
    feature(123, { website: 'https://untrusted.example', extra: 'ignored' }), feature(123),
    feature(456, { osm_type: 'W', countrycode: 'kr' }), feature('789', { osm_type: 'relation' }),
    feature(222, { countrycode: 'JP' }), feature(223, { countrycode: 'KRX' }),
    { ...feature(333), geometry: { type: 'Point', coordinates: [139.6, 35.6] } },
    { ...feature(334), geometry: { type: 'Point', coordinates: {} } },
    { ...feature(335), geometry: { type: 'Point', coordinates: [126.97] } },
    feature('1/../../evil'), feature(0), feature(777, { osm_type: 'evil' }),
    { ...feature(888), geometry: { type: 'Point', coordinates: ['126.9', 37.5] } }
  ]) });
  const result = await client.search('서울역');
  assert.deepEqual(result.items.map(item => item.id), ['osm-node-123', 'osm-way-456', 'osm-relation-789']);
  assert.equal(JSON.stringify(result).includes('untrusted'), false);
  assert.equal(JSON.stringify(result).includes('ignored'), false);
});

test('이름 없는 주소 결과를 표시하고 이름·주소 길이와 목록 개수를 제한한다', async () => {
  const client = createDepartureClient({ fetchImpl: async () => response([
    feature(1, { name: '', street: '한강대로', housenumber: '405' }),
    ...Array.from({ length: 8 }, (_, index) => feature(index + 2, { name: '가'.repeat(200), state: '나'.repeat(200), city: '다'.repeat(200), district: '라'.repeat(200), street: '마'.repeat(200) }))
  ]) });
  const result = await client.search('한강대로 405');
  assert.equal(result.items[0].name, '한강대로 405');
  assert.equal(result.items.length, 5);
  assert.ok(result.items.every(item => item.name.length <= 120 && item.address.length <= 300));
});

test('잘못된 검색어는 외부 요청 없이 거절한다', async () => {
  let requests = 0;
  const client = createDepartureClient({ fetchImpl: async () => { requests++; return response(); } });
  for (const query of ['', ' ', '가', '가'.repeat(101), null, 123, '서\n울역']) {
    await assert.rejects(client.search(query), error => error instanceof DepartureSearchError && error.code === 'INVALID_QUERY' && error.status === 400);
  }
  assert.equal(requests, 0);
});

test('같은 검색어의 동시 요청을 합치고 1시간 캐시를 사용한다', async () => {
  const clock = clockOptions();
  let calls = 0;
  const client = createDepartureClient({ ...clock, fetchImpl: async () => { calls++; return response(); } });
  const [first, second] = await Promise.all([client.search('서울역'), client.search(' 서울역 ')]);
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  clock.advance(3599999);
  assert.strictEqual(await client.search('서울역'), first);
  clock.advance(1);
  await client.search('서울역');
  assert.equal(calls, 2);
});

test('서로 다른 검색은 초당 1회로 순차 실행하며 실패 후에도 계속된다', async () => {
  const clock = clockOptions();
  const starts = [];
  let active = 0;
  const client = createDepartureClient({ ...clock, fetchImpl: async url => {
    assert.equal(active, 0);
    active++;
    starts.push(clock.now());
    await Promise.resolve();
    active--;
    if (url.searchParams.get('q') === '실패역') throw new Error('raw private query');
    return response();
  } });
  const results = await Promise.allSettled([client.search('서울역'), client.search('실패역'), client.search('부산역')]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual(starts, [10000, 11000, 12000]);
  assert.deepEqual(clock.waits, [1000, 1000]);
});

test('한도를 넘은 캐시는 오래 사용하지 않은 검색어부터 제거한다', async () => {
  const clock = clockOptions();
  const calls = [];
  const client = createDepartureClient({ ...clock, maxCacheEntries: 2, fetchImpl: async url => { calls.push(url.searchParams.get('q')); return response(); } });
  await client.search('서울역');
  await client.search('부산역');
  await client.search('서울역');
  await client.search('대전역');
  await client.search('부산역');
  assert.deepEqual(calls, ['서울역', '부산역', '대전역', '부산역']);
});

test('빈 결과는 정상이고 잘못된 응답·HTTP 오류는 고정 문구로 정제한다', async () => {
  assert.deepEqual((await createDepartureClient({ fetchImpl: async () => response([]) }).search('없는장소')).items, []);
  const cases = [
    [() => new Response(JSON.stringify({ features: null })), 'INVALID_RESPONSE', 502],
    [() => new Response('raw query response'), 'INVALID_RESPONSE', 502],
    [() => new Response('raw query response', { status: 429 }), 'SEARCH_RATE_LIMIT', 429],
    [() => new Response('raw query response', { status: 500 }), 'SEARCH_UNAVAILABLE', 502],
    [() => { throw new Error('raw query response'); }, 'SEARCH_UNAVAILABLE', 502]
  ];
  for (const [makeResponse, code, status] of cases) {
    const clock = clockOptions();
    let calls = 0;
    const client = createDepartureClient({ ...clock, fetchImpl: async () => { calls++; return makeResponse(); } });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(client.search('비밀검색어'), error => error.code === code && error.status === status && !error.message.includes('raw') && !error.message.includes('비밀검색어'));
    }
    assert.equal(calls, 2, '실패 응답은 캐시하지 않아야 한다');
  }
});

test('응답이 지연되면 취소하고 정제한 시간 초과 오류를 반환한다', async () => {
  const client = createDepartureClient({ timeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('raw private query')), { once: true });
  }) });
  await assert.rejects(client.search('서울역'), error => error.code === 'SEARCH_TIMEOUT' && error.status === 504 && !error.message.includes('raw'));
});

test('출발지 검색의 외부 리다이렉트를 따라가지 않고 거절한다', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const client = createDepartureClient({ fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url.origin, 'https://photon.komoot.io');
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status, headers: { Location: 'https://redirect.example/private' } });
    } });
    await assert.rejects(client.search('서울역'), error => error.code === 'SEARCH_UNAVAILABLE' && !error.message.includes('redirect.example'));
    assert.equal(calls, 1);
  }
});

test('대기열이 가득 차면 같은 검색어 병합은 허용하고 새 검색은 제한한다', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const client = createDepartureClient({ maxPending: 1, fetchImpl: async () => { await gate; return response(); } });
  const first = client.search('서울역');
  const same = client.search('서울역');
  await assert.rejects(client.search('부산역'), error => error.code === 'SEARCH_RATE_LIMIT' && error.status === 429);
  finish();
  assert.strictEqual(await first, await same);
});

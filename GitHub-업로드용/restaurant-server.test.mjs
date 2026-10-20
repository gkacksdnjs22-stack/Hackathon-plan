import test from 'node:test';
import assert from 'node:assert/strict';
import { createRestaurantClient, RestaurantApiError } from './restaurant-server.mjs';

const key = 'SYNTHETIC-CULTURE-KEY+/=';
const sourceUrl = 'https://www.culture.go.kr/data/openapi/openapiView.do?id=603';
const time = Date.UTC(2026, 9, 20);
const restaurant = (number = 1, changes = {}) => ({ title: '이름으로 사용하면 안 되는 시티투어',
  rstrNm: `식당 ${number}`, rstrBhfNm: '본점', rstrClNm: '한식', rstrRoadAddr: `서울특별시 종로구 여행로 ${number}`,
  rstrLnbrAddr: '서울특별시 종로구', rstrPnu: String(number), rstrLatPos: '37.57', rstrLotPos: '126.98', rstrInfoStdDt: '2026-01-01', ...changes });
const json = (items = [], totalCount = Array.isArray(items) ? items.length : 1, code = '0000', message = 'OK') => new Response(JSON.stringify({ response: {
  header: { resultCode: code, resultMsg: message }, body: { items: { item: items }, totalCount }
} }), { headers: { 'Content-Type': 'application/json' } });
const fixture = (rows = [restaurant()], options = {}) => {
  const calls = []; let clock = time;
  const client = createRestaurantClient({ serviceKey: encodeURIComponent(key), now: () => clock,
    fetchImpl: async (url, request) => {
      calls.push({ url: new URL(url), request });
      const size = Number(url.searchParams.get('numOfRows')), page = Number(url.searchParams.get('pageNo'));
      return json(rows.slice((page - 1) * size, page * size), rows.length);
    }, ...options });
  return { client, calls, advance: milliseconds => { clock += milliseconds; } };
};
const hasCode = code => error => error instanceof RestaurantApiError && error.code === code && !error.message.includes(key);

test('공식 HTTPS 주소와 필수 인자·JSON Accept를 사용하고 식당 필드만 반환한다', async () => {
  const { client, calls } = fixture();
  const result = await client.search({ area: '서울', category: '한식' });
  assert.equal(calls.length, 1);
  const { url, request } = calls[0];
  assert.equal(url.origin + url.pathname, 'https://api.kcisa.kr/openapi/API_CNV_063/request');
  assert.equal(url.searchParams.get('serviceKey'), key);
  assert.equal(url.searchParams.get('numOfRows'), '100');
  assert.equal(url.searchParams.get('pageNo'), '1');
  assert.equal(url.searchParams.get('areaNm'), '서울');
  assert.equal(url.searchParams.get('clNm'), '한식');
  assert.equal(request.headers.Accept, 'application/json');
  assert.equal(request.redirect, 'error');
  assert.equal(result.items[0].name, '식당 1');
  assert.equal(result.items[0].branch, '본점');
  assert.equal(result.items[0].source, '한국문화정보원');
  assert.equal(result.items[0].sourceUrl, sourceUrl);
  assert.equal(result.items[0].updatedAt, '2026-01-01');
  assert.equal(result.fetchedAt, new Date(time).toISOString());
  assert.equal(result.truncated, false);
  assert.equal('distanceKm' in result.items[0], false);
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('지역·분류·좌표를 외부 요청 전에 검증한다', async () => {
  const { client, calls } = fixture();
  for (const area of ['', '서', 'aSeoul', '서울&serviceKey=evil', '서울\n', '가'.repeat(81), {}, null]) await assert.rejects(client.search({ area, category: '한식' }), hasCode('INVALID_AREA'));
  for (const value of [null, '서울', []]) await assert.rejects(client.search(value), hasCode('INVALID_AREA'));
  await assert.rejects(client.search({ area: '서울', category: '피자' }), hasCode('INVALID_CATEGORY'));
  for (const coords of [{ latitude: 37.5 }, { latitude: null, longitude: 127 }, { latitude: 0, longitude: 127 }, { latitude: true, longitude: 127 }, { latitude: 37.5, longitude: 140 }]) await assert.rejects(client.search({ area: '서울', ...coords, category: '한식' }), hasCode('INVALID_COORDINATES'));
  assert.equal(calls.length, 0);
});

test('JSON 단일 item과 배열 items·빈 결과를 구분한다', async () => {
  const single = createRestaurantClient({ serviceKey: key, fetchImpl: async () => json(restaurant()) });
  assert.equal((await single.search({ area: '서울', category: '한식' })).items.length, 1);
  const array = createRestaurantClient({ serviceKey: key, fetchImpl: async () => new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: [restaurant()], totalCount: 1 } } })) });
  assert.equal((await array.search({ area: '서울', category: '한식' })).items.length, 1);
  for (const response of [json([], 0), json([], 0, '03', 'NO_DATA')]) {
    const client = createRestaurantClient({ serviceKey: key, fetchImpl: async () => response });
    const result = await client.search({ area: '서울', category: '한식' });
    assert.equal(result.items.length, 0); assert.equal(result.truncated, false);
  }
});

test('실제 문화603의 전역 totalCount와 null 필터결과를 정상 빈목록으로 처리한다', async () => {
  let calls = 0;
  const client = createRestaurantClient({ serviceKey: key, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ response: { header: { resultCode: '0000', resultMsg: 'OK' },
      body: { items: null, numOfRows: 100, pageNo: 1, totalCount: '1195062' } } }));
  } });
  const result = await client.search({ area: '부산', category: '치킨' });
  assert.deepEqual(result.items, []); assert.equal(result.truncated, false); assert.equal(calls, 1);
  await client.search({ area: '부산', category: '치킨' }); assert.equal(calls, 1);
});

test('전역 총건수가 커도 요청 행수보다 짧은 필터 페이지 다음은 조회하지 않는다', async () => {
  let calls = 0;
  const client = createRestaurantClient({ serviceKey: key, fetchImpl: async () => { calls++; return json([restaurant()], '1195062'); } });
  const result = await client.search({ area: '서울', category: '한식' });
  assert.equal(result.items.length, 1); assert.equal(result.truncated, false); assert.equal(calls, 1);
});

test('XML 성공 응답의 CDATA·엔티티·단일 item을 읽는다', async () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><response><header><resultCode>0000</resultCode><resultMsg>OK</resultMsg></header><body><items><item><title>시티투어</title><rstrNm><![CDATA[밥집 & 카페]]></rstrNm><rstrBhfNm>1호점</rstrBhfNm><rstrClNm>한식</rstrClNm><rstrRoadAddr>서울특별시 종로구 한길 &#49;</rstrRoadAddr><rstrLatPos>37.57</rstrLatPos><rstrLotPos>126.98</rstrLotPos><rstrInfoStdDt>2026-01-01</rstrInfoStdDt></item></items><totalCount>1</totalCount></body></response>';
  const client = createRestaurantClient({ serviceKey: key, fetchImpl: async () => new Response(xml) });
  const result = await client.search({ area: '서울', category: '한식' });
  assert.equal(result.items[0].name, '밥집 & 카페');
  assert.equal(result.items[0].address, '서울특별시 종로구 한길 1');
});

test('빈 이름·주소·다른 지역·다른 실제 분류를 제외하고 주소 대체와 한국 좌표를 확인한다', async () => {
  const { client } = fixture([
    restaurant(1, { rstrNm: '' }), restaurant(2, { rstrRoadAddr: '', rstrLnbrAddr: '' }),
    restaurant(3, { rstrRoadAddr: '부산광역시 해운대구 한길 1' }), restaurant(4, { rstrClNm: '치킨' }),
    restaurant(5, { rstrRoadAddr: '', rstrLatPos: '0' }), restaurant(6, { rstrLatPos: '', rstrLotPos: '' })
  ]);
  const result = await client.search({ area: '서울', category: '한식' });
  assert.deepEqual(result.items.map(item => item.name), ['식당 5', '식당 6']);
  assert.equal(result.items[0].address, '서울특별시 종로구');
  assert.ok(result.items.every(item => item.latitude === null && item.longitude === null));
});

test('부산·부산광역시와 전북의 새·옛 명칭을 대조하고 주소 밖 지역을 섞지 않는다', async () => {
  for (const [area, address] of [['부산', '부산광역시 해운대구'], ['부산광역시', '부산 해운대구'], ['전북', '전라북도 전주시'], ['전북특별자치도', '전북특별자치도 전주시'], ['강남구', '서울특별시 강남구']]) {
    const { client } = fixture([restaurant(1, { rstrRoadAddr: address })]);
    assert.equal((await client.search({ area, category: '한식' })).items.length, 1);
  }
  const { client } = fixture([restaurant(1, { rstrRoadAddr: '경기도 광주시' })]);
  assert.equal((await client.search({ area: '광주', category: '한식' })).items.length, 0);
});

test('시티투어에서 반복되는 같은 식당을 안정된 이름·주소 식별자로 중복 제거한다', async () => {
  const first = restaurant();
  const { client } = fixture([first, { ...first, title: '다른 시티투어', dataStdDt: '2020-01-01' }, restaurant(2)]);
  const result = await client.search({ area: '서울', category: '한식' });
  assert.equal(result.items.length, 2);
  const copy = fixture([{ ...first }]);
  assert.equal((await copy.client.search({ area: '서울', category: '한식' })).items[0].id, result.items[0].id);
});

test('기본 100행씩 3페이지까지만 받고 반환 20개와 잘림 표시를 제공한다', async () => {
  const { client, calls } = fixture(Array.from({ length: 350 }, (_, index) => restaurant(index + 1)));
  const result = await client.search({ area: '서울', category: '한식' });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.url.searchParams.get('pageNo')), ['1', '2', '3']);
  assert.equal(result.items.length, 20); assert.equal(result.truncated, true);
});

test('지역+분류 원본 캐시를 1시간 재사용하고 동시 요청을 합친다', async () => {
  const { client, calls, advance } = fixture();
  await Promise.all([client.search({ area: '서울', category: '한식' }), client.search({ area: '서울', category: '한식' })]);
  assert.equal(calls.length, 1);
  advance(60 * 60 * 1000 - 1); await client.search({ area: '서울', category: '한식' }); assert.equal(calls.length, 1);
  advance(1); await client.search({ area: '서울', category: '한식' }); assert.equal(calls.length, 2);
  await client.search({ area: '서울', category: '분식' }); await client.search({ area: '부산', category: '한식' }); assert.equal(calls.length, 4);
});

test('두 기준점에서 같은 원본 캐시를 각각 거리 정렬하며 캐시와 반환 객체를 변형하지 않는다', async () => {
  const { client, calls } = fixture([restaurant(1, { rstrLatPos: '37.51', rstrLotPos: '127.01' }), restaurant(2, { rstrLatPos: '37.61', rstrLotPos: '127.11' }), restaurant(3, { rstrLatPos: '' })]);
  const first = await client.search({ area: '서울', latitude: 37.51, longitude: 127.01, category: '한식' });
  assert.equal(first.items[0].name, '식당 1'); assert.equal(first.items[0].distanceKm, 0);
  first.items[0].name = '변경';
  const second = await client.search({ area: '서울', latitude: '37.61', longitude: '127.11', category: '한식' });
  assert.equal(second.items[0].name, '식당 2'); assert.equal(second.items.at(-1).name, '식당 3');
  assert.equal('distanceKm' in second.items.at(-1), false);
  const original = await client.search({ area: '서울', category: '한식' });
  assert.deepEqual(original.items.map(item => item.name), ['식당 1', '식당 2', '식당 3']);
  assert.equal('distanceKm' in original.items[0], false); assert.equal(calls.length, 1);
});

test('인증·호출 한도·HTTP 오류를 안전한 오류로 바꾸고 키를 노출하지 않는다', async () => {
  for (const [status, code] of [[401, 'AUTH_ERROR'], [403, 'AUTH_ERROR'], [429, 'RATE_LIMIT'], [500, 'UPSTREAM_ERROR']]) {
    const client = createRestaurantClient({ serviceKey: key, fetchImpl: async () => new Response(`sensitive ${key}`, { status }) });
    await assert.rejects(client.search({ area: '서울', category: '한식' }), hasCode(code));
  }
  for (const response of [json([], 0, '30', `SERVICE_KEY_IS_NOT_REGISTERED_ERROR ${key}`), new Response(`<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR ${key}</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>`)]) {
    const client = createRestaurantClient({ serviceKey: key, fetchImpl: async () => response });
    await assert.rejects(client.search({ area: '서울', category: '한식' }), hasCode('AUTH_ERROR'));
  }
  const missing = createRestaurantClient({ fetchImpl: async () => { throw Error('must not fetch'); } });
  await assert.rejects(missing.search({ area: '서울', category: '한식' }), hasCode('KEY_MISSING'));
});

test('잘못된 JSON/XML·DTD·과대 응답을 거절한다', async () => {
  const bad = ['{not-json}', JSON.stringify({ response: { header: { resultCode: '0000' }, body: { totalCount: 10 } } }), '<response><header></response>', '<!DOCTYPE response [<!ENTITY x SYSTEM "file:///private">]><response>&x;</response>'];
  for (const body of bad) {
    const client = createRestaurantClient({ serviceKey: key, fetchImpl: async () => new Response(body) });
    await assert.rejects(client.search({ area: '서울', category: '한식' }), hasCode('INVALID_RESPONSE'));
  }
  const huge = createRestaurantClient({ serviceKey: key, fetchImpl: async () => new Response('x', { headers: { 'content-length': String(5 * 1024 * 1024) } }) });
  await assert.rejects(huge.search({ area: '서울', category: '한식' }), hasCode('INVALID_RESPONSE'));
});

test('시간 초과는 abort하며 실패를 캐시하지 않고 다음 요청을 재시도한다', async () => {
  let calls = 0, signal;
  const client = createRestaurantClient({ serviceKey: key, timeoutMs: 10, fetchImpl: async (url, request) => {
    calls++; signal = request.signal;
    if (calls === 1) return new Promise(() => {});
    return json([restaurant()]);
  } });
  await assert.rejects(client.search({ area: '서울', category: '한식' }), hasCode('TIMEOUT'));
  assert.equal(signal.aborted, true);
  assert.equal((await client.search({ area: '서울', category: '한식' })).items.length, 1); assert.equal(calls, 2);
});

test('기본 전체 조회는 clNm을 비워 보내고 혼합된 실제 음식점 분류를 유지한다', async () => {
  const { client, calls } = fixture([
    restaurant(1), restaurant(2, { rstrClNm: '치킨' }), restaurant(3, { rstrClNm: '동양식' }),
    restaurant(4, { rstrClNm: '카페' }), restaurant(5, { rstrClNm: '' }), restaurant(6, { rstrClNm: undefined })
  ]);
  const result = await client.search({ area: '서울' });
  assert.equal(result.category, '전체');
  assert.equal(calls[0].url.searchParams.has('clNm'), true);
  assert.equal(calls[0].url.searchParams.get('clNm'), '');
  assert.deepEqual(result.items.map(item => item.category), ['한식', '치킨', '동양식', '카페', '음식점', '음식점']);
  assert.equal(result.items.length, 6);
});

test('전체 캐시와 기존 분류별 캐시를 구분하고 전체에도 이름·주소·지역 필터를 적용한다', async () => {
  const { client, calls } = fixture([restaurant(1), restaurant(2, { rstrClNm: '치킨' }),
    restaurant(3, { rstrNm: '' }), restaurant(4, { rstrRoadAddr: '', rstrLnbrAddr: '' }),
    restaurant(5, { rstrRoadAddr: '부산광역시 해운대구 여행로 1' })]);
  const all = await client.search({ area: '서울', category: '전체' });
  const korean = await client.search({ area: '서울', category: '한식' });
  assert.deepEqual(all.items.map(item => item.name), ['식당 1', '식당 2']);
  assert.deepEqual(korean.items.map(item => item.name), ['식당 1']);
  await client.search({ area: '서울' });
  assert.equal(calls.length, 2);
});

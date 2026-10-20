import test from 'node:test';
import assert from 'node:assert/strict';
import { createTourRestaurantClient, TourRestaurantError } from './tour-restaurants.mjs';

const key = 'SYNTHETIC-TOUR-FOOD-KEY+/=';
const time = Date.UTC(2026, 9, 20);
const restaurant = (id = 1, changes = {}) => ({ contentid: String(id), contenttypeid: '39', title: `음식점 ${id}`,
  addr1: '서울특별시 종로구 여행로', addr2: String(id), mapy: '37.57', mapx: '126.98', modifiedtime: '20261020090000', ...changes });
const json = (items = [], totalCount = Array.isArray(items) ? items.length : 1, code = '0000', message = 'OK') => new Response(JSON.stringify({ response: {
  header: { resultCode: code, resultMsg: message }, body: { items: { item: items }, totalCount }
} }), { headers: { 'Content-Type': 'application/json' } });
const fixture = (rows = [restaurant()], options = {}) => {
  const calls = []; let clock = time;
  const client = createTourRestaurantClient({ serviceKey: encodeURIComponent(key), now: () => clock,
    fetchImpl: async (url, request) => {
      calls.push({ url: new URL(url), request });
      const size = Number(url.searchParams.get('numOfRows')), page = Number(url.searchParams.get('pageNo'));
      return json(rows.slice((page - 1) * size, page * size), rows.length);
    }, ...options });
  return { client, calls, advance: milliseconds => { clock += milliseconds; } };
};
const hasCode = (code, status) => error => {
  assert.ok(error instanceof TourRestaurantError);
  assert.equal(error.code, code);
  if (status) assert.equal(error.status, status);
  assert.ok(!`${error.message} ${error.stack}`.includes(key));
  assert.ok(!`${error.message} ${error.stack}`.includes(encodeURIComponent(key)));
  assert.equal(error.cause, undefined);
  return true;
};

test('TourAPI 음식점 유형39를 한 번 인코딩한 키와 공식 요청 필드로 조회한다', async () => {
  for (const serviceKey of [key, encodeURIComponent(key)]) {
    const { client, calls } = fixture([restaurant()], { serviceKey });
    const result = await client.search({ area: '서울특별시' });
    const { url, request } = calls[0];
    assert.equal(url.origin + url.pathname, 'https://apis.data.go.kr/B551011/KorService2/areaBasedList2');
    assert.equal(url.searchParams.get('serviceKey'), key);
    for (const [field, value] of Object.entries({ MobileOS: 'ETC', MobileApp: 'TravelPlanner', _type: 'json', contentTypeId: '39', areaCode: '1', numOfRows: '100', pageNo: '1', arrange: 'A' })) assert.equal(url.searchParams.get(field), value);
    assert.equal(request.redirect, 'manual'); assert.equal(request.headers.Accept, 'application/json');
    assert.equal(result.provider, '한국관광공사 TourAPI'); assert.equal(result.area, '서울'); assert.equal(result.category, '전체');
    assert.equal(result.fetchedAt, new Date(time).toISOString());
    assert.equal(result.items[0].sourceUrl, 'https://www.data.go.kr/data/15101578/openapi.do');
  }
});

test('BOM과 조각난 UTF-8 한글 본문을 기존과 같이 읽는다', async () => {
  const bytes = new TextEncoder().encode('\uFEFF' + JSON.stringify({ response: {
    header: { resultCode: '0000' }, body: { items: { item: [restaurant(1, { title: '서울 밥집' })] }, totalCount: 1 }
  } }));
  const client = createTourRestaurantClient({ serviceKey: key, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += 2) controller.enqueue(bytes.slice(offset, offset + 2));
      controller.close();
    }
  })) });
  const result = await client.search({ area: '서울' });
  assert.equal(result.items[0].name, '서울 밥집');
  assert.equal(result.items[0].address, '서울특별시 종로구 여행로 1');
});

test('17개 지역과 신구 정식 명칭을 올바른 TourAPI 지역코드로 대응한다', async () => {
  const regions = [['서울', '1'], ['인천광역시', '2'], ['대전', '3'], ['대구', '4'], ['광주광역시', '5'],
    ['부산광역시', '6'], ['울산', '7'], ['세종특별자치시', '8'], ['경기도', '31'], ['강원특별자치도', '32'],
    ['충청북도', '33'], ['충청남도', '34'], ['경상북도', '35'], ['경상남도', '36'], ['전북특별자치도', '37'], ['전라남도', '38'], ['제주특별자치도', '39']];
  const { client, calls } = fixture([]);
  for (const [area, code] of regions) {
    await client.search({ area });
    assert.equal(calls.at(-1).url.searchParams.get('areaCode'), code);
  }
  await client.search({ area: '강원도' }); await client.search({ area: '전라북도' }); await client.search({ area: '제주도' });
  assert.equal(calls.length, 17);
});

test('안정된 콘텐츠 ID로 중복 제거하며 잘못된 유형·지역·이름·주소·좌표를 걸러낸다', async () => {
  const { client } = fixture([
    restaurant(), restaurant(1, { title: '중복 레코드' }), restaurant(2, { contenttypeid: '12' }),
    restaurant(3, { title: '' }), restaurant(4, { addr1: '', addr2: '' }), restaurant(5, { contentid: 'bad/id' }),
    restaurant(6, { areacode: '6' }), restaurant(7, { contentid: 1e30 }), restaurant(8, { mapy: '', mapx: '' }),
    restaurant(9, { mapy: '0' }), restaurant(10, { mapx: '140' }), restaurant(11, { contenttypeid: undefined, areacode: '1', title: '  밥집\u0000  이름  ' }),
    restaurant(12, { contentid: '0' }), restaurant(13, {contentid:'01'}), restaurant(14, {contentid:'123456789012345678901'}), null, 'invalid'
  ]);
  const result = await client.search({ area: '서울' });
  assert.deepEqual(result.items.map(item => item.id), ['tour-food-1', 'tour-food-8', 'tour-food-9', 'tour-food-10', 'tour-food-11']);
  assert.equal(result.items[0].name, '음식점 1'); assert.equal(result.items[0].address, '서울특별시 종로구 여행로 1');
  assert.equal(result.items[0].branch, ''); assert.equal(result.items[0].category, '음식점');
  assert.equal(result.items[0].updatedAt, '20261020090000'); assert.equal(result.items.at(-1).name, '밥집 이름');
  assert.ok(result.items.slice(1, 4).every(item => item.latitude === null && item.longitude === null));
});

test('단일 item과 정상 빈 결과·NO_DATA를 처리한다', async () => {
  for (const response of [json(restaurant()), json([], 0), json([], 0, '03', 'NO_DATA'),
    new Response(JSON.stringify({ response: { header: { resultCode: '0000' }, body: { items: '', totalCount: '0' } } }))]) {
    const client = createTourRestaurantClient({ serviceKey: key, fetchImpl: async () => response });
    const result = await client.search({ area: '서울' });
    assert.ok(result.items.length <= 1); assert.equal(result.truncated, false);
  }
});

test('기본 100행 3페이지와 반환50개 상한을 지키고 잘린 목록임을 알린다', async () => {
  for (const options of [{}, { pageSize: 10000, maxPages: 10000 }]) {
    const { client, calls } = fixture(Array.from({ length: 350 }, (_, index) => restaurant(index + 1)), options);
    const result = await client.search({ area: '서울' });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(call => call.url.searchParams.get('pageNo')), ['1', '2', '3']);
    assert.ok(calls.every(call => call.url.searchParams.get('numOfRows') === '100'));
    assert.equal(result.items.length, 50); assert.equal(result.truncated, true);
  }
});

test('명시된 마지막 페이지에서 멈추며 짧게 잘린 페이지는 불완전한 결과로 표시한다', async () => {
  const { client, calls } = fixture(Array.from({ length: 100 }, (_, index) => restaurant(index + 1)));
  await client.search({ area: '서울' }); assert.equal(calls.length, 1);
  const partial = createTourRestaurantClient({ serviceKey: key, fetchImpl: async () => json([restaurant()], 301) });
  const result = await partial.search({ area: '서울' });
  assert.equal(result.items.length, 1); assert.equal(result.truncated, true);
});

test('같은 지역의 별칭·동시 요청을 합치고 1시간 후 다시 조회한다', async () => {
  const { client, calls, advance } = fixture();
  await Promise.all([client.search({ area: '서울' }), client.search({ area: '서울특별시' })]); assert.equal(calls.length, 1);
  advance(60 * 60 * 1000 - 1); await client.search({ area: '서울시' }); assert.equal(calls.length, 1);
  advance(1); await client.search({ area: '서울' }); assert.equal(calls.length, 2);
  await client.search({ area: '부산' }); assert.equal(calls.length, 3);
});

test('같은 원본 캐시를 기준 좌표마다 정렬하고 반환 객체로 캐시를 바꾸지 못한다', async () => {
  const { client, calls } = fixture([restaurant(1, { mapy: '37.51', mapx: '127.01' }),
    restaurant(2, { mapy: '37.61', mapx: '127.11' }), restaurant(3, { mapy: '' })]);
  const first = await client.search({ area: '서울', latitude: 37.51, longitude: 127.01 });
  assert.equal(first.items[0].id, 'tour-food-1'); assert.equal(first.items[0].distanceKm, 0);
  first.items[0].name = '직접 변경';
  const second = await client.search({ area: '서울', latitude: '37.61', longitude: '127.11' });
  assert.equal(second.items[0].id, 'tour-food-2'); assert.equal(second.items.at(-1).id, 'tour-food-3');
  assert.equal('distanceKm' in second.items.at(-1), false);
  const original = await client.search({ area: '서울' });
  assert.equal(original.items[0].name, '음식점 1'); assert.equal('distanceKm' in original.items[0], false); assert.equal(calls.length, 1);
});

test('거리 정렬을 전체 조회 후보에 적용한 뒤50개를 자른다', async () => {
  const rows = Array.from({ length: 60 }, (_, index) => restaurant(index + 1, { mapy: String(37.4 + index / 100), mapx: '127' }));
  const { client } = fixture(rows);
  const result = await client.search({ area: '서울', latitude: 37.99, longitude: 127 });
  assert.equal(result.items[0].id, 'tour-food-60'); assert.equal(result.items[0].distanceKm, 0);
  assert.equal(result.items.length, 50); assert.equal(result.truncated, true);
});

test('주소의 시도와 시군구 접두 토큰을 확인해 유성구 요청에 동구·다른 도시·도로명을 섞지 않는다', async () => {
  const { client, calls } = fixture([
    restaurant(1, { addr1: '대전광역시 유성구 대학로', addr2: '1' }),
    restaurant(2, { addr1: '대전광역시 동구 유성구로', addr2: '2' }),
    restaurant(3, { addr1: '대전 유성구 대학로', addr2: '3' }),
    restaurant(4, { addr1: '부산광역시 유성구 대학로', addr2: '4' }),
    restaurant(5, { addr1: '대전광역시 유성구가짜 대학로', addr2: '5' })
  ]);
  const first = await client.search({ area: '대전', district: '유성구', latitude: 36.36, longitude: 127.35 });
  assert.deepEqual(first.items.map(item => item.id), ['tour-food-1', 'tour-food-3']); assert.equal(first.district, '유성구');
  const second = await client.search({ area: '대전광역시', district: '동구' });
  assert.deepEqual(second.items.map(item => item.id), ['tour-food-2']); assert.equal(calls.length, 1);
});

test('통합 주소명으로 바뀐 광주는 원본 지역·구 코드를 확인하고 선택한 구만 반환한다', async () => {
  const districts = [['광산구', '1'], ['남구', '2'], ['동구', '3'], ['북구', '4'], ['서구', '5']];
  const { client } = fixture(districts.map(([district, sigungucode], index) => restaurant(index + 1, {
    areacode: '5', sigungucode, addr1: `전남광주통합특별시 ${district} 여행로`
  })));
  const all = await client.search({ area: '광주' });
  assert.equal(all.items.length, 5);
  for (let index = 0; index < districts.length; index++) {
    const result = await client.search({ area: '광주광역시', district: districts[index][0] });
    assert.deepEqual(result.items.map(item => item.id), [`tour-food-${index + 1}`]);
    assert.equal(result.district, districts[index][0]);
  }
  assert.deepEqual((await client.search({ area: '광주', district: '담양군' })).items, []);
});

test('같은 통합 주소명을 쓰는 전남 시군은 광주와 분리하며 경기 광주시나 잘못된 코드를 섞지 않는다', async () => {
  const rows = [
    restaurant(1, { areacode: '38', sigungucode: '7', addr1: '전남광주통합특별시 담양군 여행로' }),
    restaurant(2, { areacode: '38', sigungucode: '13', addr1: '대한민국 전남광주통합특별시 여수시 여행로' }),
    restaurant(3, { areacode: '5', sigungucode: '3', addr1: '전남광주통합특별시 동구 여행로' }),
    restaurant(4, { areacode: '38', sigungucode: '3', addr1: '전남광주통합특별시 동구 여행로' }),
    restaurant(5, { areacode: '5', sigungucode: '7', addr1: '전남광주통합특별시 담양군 여행로' }),
    restaurant(6, { areacode: '38', sigungucode: '7', addr1: '전남광주통합특별시 광주시 여행로' }),
    restaurant(7, { areacode: '31', addr1: '경기도 광주시 여행로' }),
    restaurant(8, { areacode: '38', sigungucode: '13', addr1: '전남광주통합특별시 담양군 여행로' }),
    restaurant(9, { areacode: '', addr1: '전남광주통합특별시 담양군 여행로' }),
    restaurant(10, { areacode: '1', addr1: '전남광주통합특별시 담양군 여행로' })
  ];
  const { client } = fixture(rows);
  assert.deepEqual((await client.search({ area: '전남' })).items.map(item => item.id), ['tour-food-1', 'tour-food-2']);
  assert.deepEqual((await client.search({ area: '전남', district: '담양군' })).items.map(item => item.id), ['tour-food-1']);
  assert.deepEqual((await client.search({ area: '전남', district: '동구' })).items, []);
  assert.deepEqual((await client.search({ area: '광주' })).items.map(item => item.id), ['tour-food-3']);
  assert.deepEqual((await client.search({ area: '경기', district: '광주시' })).items.map(item => item.id), ['tour-food-7']);
  await assert.rejects(client.search({ area: '전남광주통합특별시' }), hasCode('INVALID_AREA', 400));
});

test('기존 광주·전남 주소와 통합 주소를 함께 지원하며 통합 주소에는 명시적 지역코드가 필요하다', async () => {
  const { client } = fixture([
    restaurant(1, { addr1: '광주광역시 남구 여행로' }),
    restaurant(2, { areacode: '5', addr1: '전남광주통합특별시 남구 여행로' }),
    restaurant(3, { addr1: '전라남도 담양군 여행로' }),
    restaurant(4, { areacode: '38', addr1: '전남광주통합특별시 담양군 여행로' }),
    restaurant(5, { addr1: '전남광주통합특별시 남구 여행로' }),
    restaurant(6, { addr1: '전남광주통합특별시 담양군 여행로' })
  ]);
  assert.deepEqual((await client.search({ area: '광주', district: '남구' })).items.map(item => item.id), ['tour-food-1', 'tour-food-2']);
  assert.deepEqual((await client.search({ area: '전남', district: '담양군' })).items.map(item => item.id), ['tour-food-3', 'tour-food-4']);
});

test('청주시 흥덕구·제주시처럼 시군구 전체 토큰을 앞에서 일치시키고 없으면 다른 구로 대체하지 않는다', async () => {
  const { client } = fixture([
    restaurant(1, { addr1: '충청북도 청주시 흥덕구 여행로' }),
    restaurant(2, { addr1: '충북 청주시 상당구 여행로' }),
    restaurant(3, { addr1: '충북 충주시 흥덕구로' })
  ]);
  assert.deepEqual((await client.search({ area: '충북', district: '청주시 흥덕구' })).items.map(item => item.id), ['tour-food-1']);
  assert.deepEqual((await client.search({ area: '충북', district: '흥덕구' })).items, []);
  const jeju = fixture([restaurant(1, { addr1: '제주특별자치도 제주시 여행로' }), restaurant(2, { addr1: '제주도 서귀포시 여행로' })]);
  assert.deepEqual((await jeju.client.search({ area: '제주', district: '제주시' })).items.map(item => item.id), ['tour-food-1']);
});

test('시군구 후보가 조회 상한 밖에 있으면 빈 결과와 잘림 표시를 유지한다', async () => {
  const rows = Array.from({ length: 301 }, (_, index) => restaurant(index + 1, { addr1: `대전광역시 ${index === 300 ? '유성구' : '동구'} 여행로` }));
  const { client, calls } = fixture(rows);
  const result = await client.search({ area: '대전', district: '유성구' });
  assert.deepEqual(result.items, []); assert.equal(result.truncated, true); assert.equal(calls.length, 3);
});

test('원본 캐시와 진행 중 요청 개수를 제한하며 실패 후 다시 요청할 수 있다', async () => {
  const { client, calls } = fixture([], { maxCacheEntries: 1 });
  await client.search({ area: '서울' }); await client.search({ area: '부산' }); await client.search({ area: '서울' }); assert.equal(calls.length, 3);
  let release;
  const waiting = createTourRestaurantClient({ serviceKey: key, maxPending: 1, fetchImpl: async () => {
    await new Promise(resolve => { release = resolve; }); return json([]);
  } });
  const first = waiting.search({ area: '서울' });
  await assert.rejects(waiting.search({ area: '부산' }), hasCode('RATE_LIMIT', 429));
  release(); await first;
  const next = waiting.search({ area: '부산' }); release(); await next;
});

test('유효하지 않은 지역과 좌표를 외부 호출 없이 거절한다', async () => {
  let calls = 0;
  const client = createTourRestaurantClient({ serviceKey: key, fetchImpl: async () => { calls++; return json([]); } });
  for (const area of [undefined, null, '', '도쿄', '서울 종로구', '서울\n', {}, '1', '가'.repeat(81)]) await assert.rejects(client.search({ area }), hasCode('INVALID_AREA', 400));
  for (const coords of [{ latitude: 37.5 }, { longitude: 127 }, { latitude: 0, longitude: 0 }, { latitude: '', longitude: '' },
    { latitude: Infinity, longitude: 127 }, { latitude: {}, longitude: 127 }, { latitude: '3.75e1', longitude: 127 }]) await assert.rejects(client.search({ area: '서울', ...coords }), hasCode('INVALID_COORDINATES', 400));
  for (const query of [null, [], '서울']) await assert.rejects(client.search(query), hasCode('INVALID_AREA', 400));
  for (const district of ['유성', '동', '유성구\n', '유성구 가짜로', 'Yuseong-gu', '<구>', {}, '가'.repeat(61)]) await assert.rejects(client.search({ area: '대전', district }), hasCode('INVALID_DISTRICT', 400));
  assert.equal(calls, 0);
});

test('HTTP·인증·호출 한도·외부 예외를 키가 없는 고정 오류로 바꾼다', async () => {
  for (const [status, code] of [[401, 'AUTH_ERROR'], [403, 'AUTH_ERROR'], [429, 'RATE_LIMIT'], [500, 'UPSTREAM_ERROR']]) {
    const client = createTourRestaurantClient({ serviceKey: key, fetchImpl: async () => new Response(`sensitive ${key}`, { status }) });
    await assert.rejects(client.search({ area: '서울' }), hasCode(code));
  }
  for (const response of [json([], 0, '30', `SERVICE_KEY_IS_NOT_REGISTERED_ERROR ${key}`),
    new Response(`<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode><returnAuthMsg>${key}</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>`),
    new Response(JSON.stringify({ OpenAPI_ServiceResponse: { cmmMsgHeader: { returnReasonCode: '30', returnAuthMsg: key } } }))]) {
    const client = createTourRestaurantClient({ serviceKey: key, fetchImpl: async () => response });
    await assert.rejects(client.search({ area: '서울' }), hasCode('AUTH_ERROR', 502));
  }
  const quota = createTourRestaurantClient({ serviceKey: key, fetchImpl: async () => json([], 0, '22', key) });
  await assert.rejects(quota.search({ area: '서울' }), hasCode('RATE_LIMIT', 429));
  const network = createTourRestaurantClient({ serviceKey: key, fetchImpl: async () => { throw new Error(key); } });
  await assert.rejects(network.search({ area: '서울' }), hasCode('NETWORK_ERROR', 502));
  let calls = 0;
  for (const [serviceKey, code] of [[undefined, 'KEY_MISSING'], ['', 'KEY_MISSING'], ['bad%FF', 'AUTH_ERROR']]) {
    const client = createTourRestaurantClient({ serviceKey, fetchImpl: async () => { calls++; return json([]); } });
    await assert.rejects(client.search({ area: '서울' }), hasCode(code));
  }
  assert.equal(calls, 0);
});

test('잘못된 응답·총건수·페이지 크기·과대 본문을 거절한다', async () => {
  const invalidBodies = ['{bad-json}', '{}', JSON.stringify({ response: { header: { resultCode: '0000' }, body: { totalCount: 2 } } }),
    JSON.stringify({ response: { header: { resultCode: '0000' }, body: { items: { item: [] }, totalCount: -1 } } }),
    JSON.stringify({ response: { header: { resultCode: '0000' }, body: { items: { item: [restaurant()] }, totalCount: 0 } } }),
    '<!DOCTYPE response [<!ENTITY x SYSTEM "file:///private">]><response>&x;</response>'];
  for (const body of invalidBodies) {
    const client = createTourRestaurantClient({ serviceKey: key, fetchImpl: async () => new Response(body) });
    await assert.rejects(client.search({ area: '서울' }), hasCode('INVALID_RESPONSE', 502));
  }
  const oversizedPage = createTourRestaurantClient({ serviceKey: key, pageSize: 1, fetchImpl: async () => json([restaurant(), restaurant(2)], 2) });
  await assert.rejects(oversizedPage.search({ area: '서울' }), hasCode('INVALID_RESPONSE', 502));
  const huge = createTourRestaurantClient({ serviceKey: key, fetchImpl: async () => new Response('x', { headers: { 'content-length': String(5 * 1024 * 1024) } }) });
  await assert.rejects(huge.search({ area: '서울' }), hasCode('INVALID_RESPONSE', 502));
});

test('시간 초과는 abort하고 실패를 캐시하지 않아 다음 조회가 회복된다', async () => {
  let calls = 0, signal;
  const client = createTourRestaurantClient({ serviceKey: key, timeoutMs: 10, fetchImpl: async (url, request) => {
    calls++; signal = request.signal;
    if (calls === 1) return new Promise(() => {});
    return json([restaurant()]);
  } });
  await assert.rejects(client.search({ area: '서울' }), hasCode('TIMEOUT', 504));
  assert.equal(signal.aborted, true);
  assert.equal((await client.search({ area: '서울' })).items.length, 1); assert.equal(calls, 2);
});

test('음식점 인증키가 있는 요청의 외부 리다이렉트를 따라가지 않는다', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const client = createTourRestaurantClient({ serviceKey: key, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url.origin, 'https://apis.data.go.kr');
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status, headers: { Location: 'https://redirect.example/private' } });
    } });
    await assert.rejects(client.search({ area: '서울' }), hasCode('UPSTREAM_ERROR', 502));
    assert.equal(calls, 1);
  }
});

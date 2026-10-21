import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sources = ['places.js', 'planner.js', 'tour-data.js'].map(name => ({
  name,
  code: readFileSync(new URL(name, import.meta.url), 'utf8')
}));
const centers = [
  { id: 'jongno', latitude: 37.5796, longitude: 126.9790 },
  { id: 'yongsan', latitude: 37.5240, longitude: 126.9820 },
  { id: 'seongsu', latitude: 37.5450, longitude: 127.0420 },
  { id: 'gangseo', latitude: 37.5600, longitude: 126.8400 },
  { id: 'gangnam', latitude: 37.5000, longitude: 127.0650 },
  { id: 'nowon', latitude: 37.6550, longitude: 127.0560 },
  { id: 'gangdong', latitude: 37.5500, longitude: 127.1450 }
];
const plain = value => JSON.parse(JSON.stringify(value));
const visitIds = itinerary => plain(itinerary.days.map(day => day.events
  .filter(event => event.type === 'place').map(event => event.place.id)));
const timeline = itinerary => plain(itinerary.days.map(({ departure, needsTravelTime, timesProvisional, ...day }) => ({
  ...day, events: day.events.filter(event => event.type !== 'departure')
})));
function assertSequential(day) {
  let clock = day.start;
  for (const event of day.events) {
    assert.equal(event.start, clock, 'events follow consecutively without overlap or fixed meal waits');
    assert.equal(event.end, event.start + event.duration);
    const canBePending = ['departure', 'arrival', 'arrival-transfer', 'finish'].includes(event.id)
      || event.type === 'transfer';
    assert.ok(canBePending ? event.duration >= 0 : event.duration > 0);
    clock = event.end;
  }
  assert.equal(day.end, clock);
}

function fixtures() {
  return centers.flatMap((center, areaIndex) => Array.from({ length: 4 }, (_, placeIndex) => ({
    contentId: String(1000 + areaIndex * 10 + placeIndex),
    title: `  ${center.id} 관광장소 ${placeIndex + 1}  `,
    contentTypeId: placeIndex % 2 ? '12' : '14',
    areaCode: '1', sigunguCode: String(areaIndex + 1),
    latitude: center.latitude + placeIndex * 0.0001,
    longitude: center.longitude + placeIndex * 0.0001,
    address: `서울 ${center.id} 주소 ${placeIndex + 1}`
  })));
}

function response(items = fixtures(), areaCode = '1') {
  return { ok: true, json: async () => ({ items, areaCode, fetchedAt: '2026-10-20T00:00:00.000Z' }) };
}

function areasResponse(items = [{ code: '1', name: '서울' }, { code: '6', name: '부산' }, { code: '39', name: '제주' }]) {
  return { ok: true, json: async () => ({ provider: 'TourAPI', items, fetchedAt: '2026-10-20T00:00:00.000Z' }) };
}

function regionalFixtures(areaCode = '6', areaCount = 3) {
  const coordinates = areaCode === '39'
    ? [[33.50, 126.52], [33.25, 126.56], [33.45, 126.92]]
    : [[35.16, 129.16], [35.10, 129.03], [35.18, 129.08]];
  return coordinates.slice(0, areaCount).flatMap(([latitude, longitude], areaIndex) => Array.from({ length: 4 }, (_, index) => ({
    contentId: String(Number(areaCode) * 10000 + areaIndex * 10 + index),
    title: `${areaCode}지역 관광지 ${areaIndex + 1}-${index + 1}`,
    contentTypeId: index % 2 ? '14' : '12', areaCode, sigunguCode: String(areaIndex + 1),
    latitude: latitude + index * 0.0001, longitude: longitude + index * 0.0001,
    address: areaCode === '39' ? `제주특별자치도 제주시 애월읍 해안로 ${index}` : `부산광역시 해운대구 우동 관광로 ${index}`
  })));
}

function departureFixture(overrides = {}) {
  return { mode: 'train', id: 'osm-node-123456', name: '서울역', address: '서울특별시 용산구 한강대로',
    latitude: 37.5547, longitude: 126.9707, source: 'OpenStreetMap', sourceUrl: 'https://www.openstreetmap.org/node/123456', ...overrides };
}

function arrivalFixture(overrides = {}) {
  return departureFixture({ id: 'osm-node-789012', name: '도착역', address: '서울특별시 도착역로',
    sourceUrl: 'https://www.openstreetmap.org/node/789012', ...overrides });
}

const tagoServices = {
  train: ['train', '15098552'], express: ['bus', '15098522'], intercity: ['bus', '15098541'],
  flight: ['flight', '15098526'], ferry: ['ferry', '15098523']
};
function tagoStop(service = 'train', providerId = 'ORIGIN1', overrides = {}) {
  return { mode: tagoServices[service][0], service, providerId, id: `tago-${service}-${providerId}`,
    name: providerId === 'ORIGIN1' ? '출발 정류장' : '도착 정류장', address: '', latitude: null, longitude: null,
    source: 'TAGO', sourceUrl: `https://www.data.go.kr/data/${tagoServices[service][1]}/openapi.do`, ...overrides };
}
function transportFixture(service = 'train', overrides = {}) {
  return { id: `${service}-20261020-0830-T101`, service, departureId: 'ORIGIN1', arrivalId: 'DEST1',
    departureName: '출발 정류장', arrivalName: '도착 정류장', date: '2026-10-20', departureMinutes: 510,
    arrivalMinutes: 660, durationMinutes: 150, tripNo: 'T101', grade: '일반', source: 'TAGO',
    sourceUrl: `https://www.data.go.kr/data/${tagoServices[service][1]}/openapi.do`, fetchedAt: '2026-10-20T00:00:00.000Z', ...overrides };
}
function officialItinerary(app, city, service = 'train', overrides = {}) {
  return app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayDepartures: { 0: tagoStop(service) }, dayArrivals: { 0: tagoStop(service, 'DEST1') },
    eventEdits: { 0: { 'arrival-transfer': { duration: 25 }, finish: { title: '숙소 복귀', duration: 60 } } }, ...overrides });
}
function connectionFixtures(service = 'train') {
  return {
    via: tagoStop(service, 'VIA1', { name: '대전 환승지' }),
    legs: [transportFixture(service, { id: `${service}-leg1`, departureName: '조치원', arrivalId: 'VIA1', arrivalName: '대전',
      departureMinutes: 540, arrivalMinutes: 600, durationMinutes: 60, tripNo: 'T101' }),
    transportFixture(service, { id: `${service}-leg2`, departureId: 'VIA1', departureName: '대전', arrivalName: '포항',
      departureMinutes: 630, arrivalMinutes: 750, durationMinutes: 120, tripNo: 'T202', fetchedAt: '2026-10-20T00:10:00.000Z' })]
  };
}

function runtime(fetchImpl = async () => response(), protocol = 'http:') {
  const calls = [];
  const context = vm.createContext({
    window: {}, location: { protocol }, AbortSignal, Intl,
    fetch: (...args) => { calls.push(args); return fetchImpl(...args); }
  });
  for (const { name, code } of sources) vm.runInContext(code, context, { filename: name });
  return { ...context.window, calls };
}

test('TourAPI response replaces Seoul atomically with API-derived clusters in a Korea-only catalog', async () => {
  const app = runtime();
  const seoul = app.TRAVEL_DATA.cities.seoul;
  assert.deepEqual(Object.keys(app.TRAVEL_DATA.countries), ['KR']);
  assert.ok(Object.values(app.TRAVEL_DATA.cities).every(city => city.country === 'KR'));
  assert.equal(Object.hasOwn(app.TRAVEL_DATA.cities, 'tokyo'), false);
  const loaded = await app.TourData.ensureCity('seoul');
  assert.equal(loaded, seoul, 'planner requires the registered city object identity');
  assert.equal(seoul.dataSource, 'tourapi');
  assert.equal(seoul.supportedDays, 7);
  assert.deepEqual(plain(seoul.areas.map(area => area.id)), centers.map((_, index) => `tour-cluster-${1000 + index * 10}`));
  assert.equal(app.TravelPlanner.validateCity(seoul).ok, true);
  assert.equal(seoul.areas.flatMap(area => area.places).length, fixtures().length);
  for (const area of seoul.areas) for (const place of area.places) {
    assert.equal(place.areaId, area.id);
    assert.equal(place.areaName, area.name);
    assert.equal(place.area, area.name);
    assert.equal(place.name, place.name.trim());
    assert.equal(place.source, '한국관광공사 TourAPI');
    assert.equal(place.mapQuery, `${place.latitude},${place.longitude}`);
    assert.ok(place.id.startsWith('tourapi-'));
    assert.ok(place.distanceToCenter <= 2.5);
  }
  assert.equal(seoul.areas[0].places[0].category, '문화시설');
  assert.equal(seoul.areas[0].places[0].stayMinutes, 75);
  assert.equal(seoul.areas[0].places[1].category, '관광지');
  assert.equal(seoul.areas[0].places[1].stayMinutes, 60);
  await assert.rejects(app.TourData.ensureCity('tokyo'), /도시/);
  assert.equal(await app.TourData.ensureCity('seoul'), seoul);
  assert.equal(app.calls.length, 1, 'an unknown city and an already loaded catalog need no fetch');
  assert.equal(app.calls[0][0], '/api/tour/places?areaCode=1');
  assert.ok(app.calls[0][1].signal instanceof AbortSignal);
});

test('API catalog supports one to three days with unique places and consecutive calculated times', async () => {
  const app = runtime();
  const city = await app.TourData.ensureCity('seoul');
  for (const dayCount of [1, 2, 3]) {
    const itinerary = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount });
    assert.equal(itinerary.ok, true, itinerary.reason);
    assert.equal(itinerary.days.length, dayCount);
    const ids = visitIds(itinerary).flat();
    assert.equal(ids.length, dayCount * 3);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(new Set(itinerary.dayAreaIds).size, dayCount);
    for (const day of itinerary.days) {
      assertSequential(day);
      assert.equal(day.events[0].start, 9 * 60);
      assert.equal(day.events.filter(event => event.type === 'meal').length, 2);
      assert.ok(day.events.filter(event => event.type === 'place').every(event => event.place.areaId === day.areaId));
    }
  }
});

test('new recommendations choose the next nearest visit within the same area instead of crossing back past the first visit', async () => {
  const points = [37.5, 37.505, 37.494, 37.507];
  const items = points.map((latitude, index) => ({
    contentId: String(7000 + index), title: `근접 관광지 ${index}`, contentTypeId: '12', areaCode: '1',
    latitude, longitude: 127, address: `서울 관광로 ${index}`
  }));
  const app = runtime(async () => response(items)), city = await app.TourData.ensureCity('seoul');
  const before = plain(city), [first, second, across, onward] = city.areas[0].places;
  assert.deepEqual([first.id, second.id, across.id, onward.id], items.map(item => `tourapi-${item.contentId}`));
  const itinerary = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  assert.equal(itinerary.ok, true, itinerary.reason);
  assert.deepEqual(visitIds(itinerary), [[first.id, second.id, onward.id]]);
  const oldLegs = Math.abs(first.latitude - second.latitude) + Math.abs(second.latitude - across.latitude);
  const newLegs = Math.abs(first.latitude - second.latitude) + Math.abs(second.latitude - onward.latitude);
  assert.ok(newLegs < oldLegs / 2, 'a nearby continuation avoids a needless return across the anchor');
  assert.deepEqual(plain(city), before, 'recommendations never reorder or mutate the shared catalog');
  assert.ok(itinerary.days[0].events.filter(event => event.type === 'transfer').every(event => event.duration === 0),
    'straight-line selection does not invent a travel duration');

  const withExtra = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
    extraEvents: { 0: [{ id: 'extra-1', beforeId: 'finish', type: 'place', placeId: first.id, duration: 60 }] } });
  assert.equal(withExtra.ok, true, withExtra.reason);
  assert.equal(new Set(visitIds(withExtra).flat()).size, 4, 'a directly added visit stays excluded from new recommendations');
  assert.deepEqual(plain(withExtra.selections[0]), [second.id, onward.id, across.id]);
});

test('new proximity recommendations preserve legacy order for invalid coordinates and distance ties', () => {
  const make = points => {
    const app = runtime(), city = app.TRAVEL_DATA.cities.seoul;
    const area = { id: 'legacy-area', name: '기존 권역', places: [] };
    area.places = points.map((point, index) => ({ id: `legacy-${index}`, name: `기존 장소 ${index}`,
      areaId: area.id, areaName: area.name, area: area.name, stayMinutes: 60, ...point }));
    city.areas = [area]; city.supportedDays = 1;
    return app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  };
  const valid = { latitude: 37.5, longitude: 127 };
  for (const invalid of [{}, { latitude: null, longitude: 127 }, { latitude: '37.5', longitude: 127 },
    { latitude: NaN, longitude: 127 }, { latitude: 37.5, longitude: Infinity }, { latitude: 0, longitude: 127 },
    { latitude: 37.5, longitude: 133 }]) {
    const itinerary = make([valid, { latitude: 37.51, longitude: 127 }, { latitude: 37.5001, longitude: 127 }, invalid]);
    assert.equal(itinerary.ok, true, itinerary.reason);
    assert.deepEqual(visitIds(itinerary), [['legacy-0', 'legacy-1', 'legacy-2']]);
  }
  const tied = make([valid, { latitude: 37.501, longitude: 127 }, { latitude: 37.499, longitude: 127 }, valid]);
  assert.equal(tied.ok, true, tied.reason);
  assert.deepEqual(visitIds(tied), [['legacy-0', 'legacy-3', 'legacy-1']], 'equal-distance candidates keep their catalog order');
});

test('explicit saved selections and manual row placement bypass new proximity recommendations', async () => {
  const items = [37.5, 37.505, 37.494, 37.507].map((latitude, index) => ({
    contentId: String(7100 + index), title: `저장 관광지 ${index}`, contentTypeId: '12', areaCode: '1',
    latitude, longitude: 127, address: `서울 저장로 ${index}`
  }));
  const app = runtime(async () => response(items)), city = await app.TourData.ensureCity('seoul');
  const selections = { 0: ['tourapi-7102', 'tourapi-7100', 'tourapi-7101'] };
  const itinerary = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
    selections, eventOrders: { 0: ['place-2', 'place-1', 'place-0'] }, eventEdits: { 0: { lunch: { description: '예약한 식당' } } } });
  assert.equal(itinerary.ok, true, itinerary.reason);
  assert.deepEqual(plain(itinerary.selections), selections);
  assert.deepEqual(visitIds(itinerary), [['tourapi-7101', 'tourapi-7100', 'tourapi-7102']]);
  const saved = plain(itinerary);
  const restored = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount,
    dayAreaIds: saved.dayAreaIds, selections: saved.selections, eventOrders: saved.eventOrders, eventEdits: saved.eventEdits });
  assert.equal(restored.ok, true, restored.reason);
  assert.deepEqual(plain(restored.days), saved.days);
  const edited = app.TravelPlanner.updateEvent({ city, itinerary: restored, dayIndex: 0, eventId: 'lunch', description: '예약 시간 변경' });
  assert.equal(edited.ok, true, edited.reason);
  assert.deepEqual(visitIds(edited.itinerary), visitIds(saved));
  assert.deepEqual(plain(edited.itinerary.selections), selections);
});

test('Seoul includes Gangseo, Gangnam and Nowon beyond the previous fixed areas and supports three to seven days', async () => {
  const app = runtime();
  const city = await app.TourData.ensureCity('seoul');
  assert.equal(city.areas.length, 7);
  assert.equal(city.supportedDays, 7);
  const places = city.areas.flatMap(area => area.places);
  for (const district of ['gangseo', 'gangnam', 'nowon']) {
    assert.equal(places.filter(place => place.name.startsWith(district)).length, 4, `${district} API places must not be geographically excluded`);
  }
  for (const dayCount of [3, 4, 5, 6, 7]) {
    const result = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.maxDays, 7);
    assert.equal(result.days.length, dayCount);
    assert.equal(new Set(visitIds(result).flat()).size, dayCount * 3);
    assert.ok(result.days.every(day => day.events.filter(event => event.type === 'place').every(event => event.place.distanceToCenter <= 2.5)));
  }
  const tooLong = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 8 });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.reason, /1~7일/);
});

test('Seoul clustering processes all 363 valid API records without a fixed-area candidate limit', async () => {
  const items = Array.from({ length: 363 }, (_, index) => {
    const areaIndex = index % centers.length, offset = Math.floor(index / centers.length);
    const center = centers[areaIndex];
    return {
      contentId: String(200000 + areaIndex * 1000 + offset), title: `${center.id} API 관광지 ${offset}`,
      contentTypeId: '12', areaCode: '1', sigunguCode: String(areaIndex + 1),
      latitude: center.latitude + offset * 0.00001, longitude: center.longitude + offset * 0.00001,
      address: `서울 ${center.id} 관광로 ${offset}`
    };
  });
  const app = runtime(async () => response(items));
  const city = await app.TourData.ensureCity('seoul');
  const places = city.areas.flatMap(area => area.places);
  assert.equal(places.length, 363);
  assert.equal(new Set(places.map(place => place.id)).size, 363);
  assert.equal(city.supportedDays, 7);
  assert.ok(places.every(place => place.distanceToCenter <= 2.5));
});

test('national catalogs support seven days and reject eight even with an eighth available area', async () => {
  for (const areaCount of [7, 8]) {
    const items = Array.from({ length: areaCount }, (_, areaIndex) => Array.from({ length: 4 }, (_, index) => ({
      contentId: String(320000 + areaIndex * 10 + index), title: `강원 관광지 ${areaIndex + 1}-${index + 1}`,
      contentTypeId: '12', areaCode: '32', sigunguCode: String(areaIndex + 1),
      latitude: 37 + areaIndex * 0.08 + index * 0.0001, longitude: 128.1 + index * 0.0001,
      address: `강원특별자치도 평창군 관광로 ${areaIndex}`
    }))).flat();
    const app = runtime(async url => url === '/api/tour/areas'
      ? areasResponse([{ code: '32', name: '강원' }]) : response(items, '32'));
    await app.TourData.loadDestinations();
    const city = await app.TourData.ensureCity('tour-area-32');
    assert.equal(city.areas.length, areaCount);
    assert.equal(city.supportedDays, 7);
    const result = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 7 });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.maxDays, 7);
    assert.equal(result.days.length, 7);
    assert.equal(new Set(result.dayAreaIds).size, 7);
    assert.equal(new Set(visitIds(result).flat()).size, 21);
    result.days.forEach(assertSequential);
    const excessive = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 8 });
    assert.equal(excessive.ok, false);
    assert.match(excessive.reason, /1~7일/);
    assert.equal(excessive.maxDays, 7);
  }
});

test('API places can be replaced and day areas swapped while preserving schedule invariants', async () => {
  const app = runtime();
  const city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 3 });
  const oldId = visitIds(original)[0][0];
  const alternatives = app.TravelPlanner.getAlternatives({ city, itinerary: original, dayIndex: 0, placeId: oldId });
  assert.equal(alternatives.length, 1);
  const replacement = app.TravelPlanner.replacePlace({ city, itinerary: original, dayIndex: 0, placeId: oldId, replacementId: alternatives[0].id });
  assert.equal(replacement.ok, true, replacement.reason);
  assert.equal(visitIds(original)[0][0], oldId, 'the original saved snapshot stays unchanged');
  assert.equal(visitIds(replacement.itinerary)[0][0], alternatives[0].id);
  const swapped = app.TravelPlanner.changeDayArea({ city, itinerary: replacement.itinerary, dayIndex: 0, areaId: original.days[1].areaId });
  assert.equal(swapped.ok, true, swapped.reason);
  assert.equal(swapped.swappedIndex, 1);
  assert.equal(swapped.itinerary.days[0].areaId, original.days[1].areaId);
  const ids = visitIds(swapped.itinerary).flat();
  assert.equal(new Set(ids).size, 9);
  swapped.itinerary.days.forEach(assertSequential);
});

test('serialized API selections restore by stable content IDs after catalog order changes', async () => {
  const first = runtime();
  const firstCity = await first.TourData.ensureCity('seoul');
  const original = first.TravelPlanner.createItinerary({ city: firstCity, startDate: '2026-10-20', dayCount: 3 });
  const saved = plain(original);
  const second = runtime(async () => response(fixtures().reverse()));
  const secondCity = await second.TourData.ensureCity('seoul');
  const selections = Object.fromEntries(visitIds(saved).map((ids, index) => [index, ids]));
  const restored = second.TravelPlanner.createItinerary({
    city: secondCity, startDate: saved.startDate, dayCount: saved.dayCount,
    dayAreaIds: saved.days.map(day => day.areaId), selections
  });
  assert.equal(restored.ok, true, restored.reason);
  assert.deepEqual(visitIds(restored), visitIds(saved));
  assert.deepEqual(plain(restored.dayAreaIds), saved.dayAreaIds);
  assert.equal(restored.startDate, saved.startDate);
});

test('duplicate IDs, invalid coordinates and places beyond area radius are excluded', () => {
  const app = runtime();
  const items = fixtures();
  const invalid = [
    { ...items[0], title: 'duplicate ID must not replace original' },
    { ...items[0], contentId: '9001', latitude: NaN },
    { ...items[0], contentId: '9002', longitude: Infinity },
    { ...items[0], contentId: '9003', latitude: String(items[0].latitude) },
    { ...items[0], contentId: '9004', latitude: 37.70, longitude: 127.15 },
    { ...items[0], contentId: '9005', latitude: 36.5, longitude: 126.98 },
    { ...items[0], contentId: '9006', title: '   ' },
    { ...items[0], contentId: '9007', contentTypeId: '39' },
    { ...items[0], contentId: 'bad-id' },
    null
  ];
  const areas = app.TourData.buildAreas([...items, ...invalid]);
  const places = areas.flatMap(area => area.places);
  assert.equal(areas.length, centers.length);
  assert.equal(places.length, items.length);
  assert.equal(new Set(places.map(place => place.id)).size, items.length);
  assert.equal(places.find(place => place.id === `tourapi-${items[0].contentId}`).name, items[0].title.trim());
  assert.equal(app.TourData.buildAreas(items.slice(0, 2)).length, 0, 'areas need three distinct places');
});

test('failed API loads leave original city intact and allow a successful retry', async t => {
  const failureCases = [
    ['connection failure', async () => { throw new Error('offline'); }, /연결하지 못/],
    ['non-JSON response', async () => ({ ok: true, json: async () => { throw new Error('not json'); } }), /응답을 읽지/],
    ['upstream error', async () => ({ ok: false, json: async () => ({ error: 'mock upstream error' }) }), /mock upstream error/],
    ['malformed catalog', async () => ({ ok: true, json: async () => ({ items: null }) }), /형식이 올바르지/],
    ['insufficient places', async () => response(fixtures().slice(0, 2)), /관광정보가 부족/],
    ['wrong area code', async () => response(fixtures(), '6'), /지역코드가 다릅니다/]
  ];
  for (const [name, fail, expected] of failureCases) await t.test(name, async () => {
    let attempts = 0;
    const app = runtime((...args) => ++attempts === 1 ? fail(...args) : response());
    const city = app.TRAVEL_DATA.cities.seoul;
    const originalAreas = city.areas;
    const snapshot = plain(city);
    await assert.rejects(app.TourData.ensureCity('seoul'), expected);
    assert.equal(city.areas, originalAreas);
    assert.deepEqual(plain(city), snapshot);
    assert.equal(await app.TourData.ensureCity('seoul'), city);
    assert.equal(attempts, 2);
    assert.equal(city.dataSource, 'tourapi');
  });
});

test('concurrent ensureCity calls share one request and commit only after it succeeds', async () => {
  let resolveFetch;
  const app = runtime(() => new Promise(resolve => { resolveFetch = resolve; }));
  const city = app.TRAVEL_DATA.cities.seoul;
  const originalAreas = city.areas;
  const first = app.TourData.ensureCity('seoul');
  const second = app.TourData.ensureCity('seoul');
  assert.equal(app.calls.length, 1);
  assert.equal(city.areas, originalAreas, 'pending work must not expose a partial catalog');
  assert.equal(city.dataSource, undefined);
  resolveFetch(response());
  const results = await Promise.all([first, second]);
  assert.equal(results[0], city);
  assert.equal(results[1], city);
  assert.notEqual(city.areas, originalAreas);
  assert.equal(city.dataSource, 'tourapi');
  assert.equal(app.calls.length, 1);
});

test('file URLs explain the required local server without issuing network requests', async () => {
  const app = runtime(undefined, 'file:');
  await assert.rejects(app.TourData.ensureCity('seoul'), /npm start/);
  assert.equal(app.calls.length, 0);
  assert.equal(app.TRAVEL_DATA.cities.seoul.dataSource, undefined);
});

test('destination options come only from the API in API order, with registered identities preserved', async () => {
  const app = runtime(async () => areasResponse([
    { code: '39', name: ' 제주 ' }, { code: '1', name: '서울' }, { code: '6', name: '부산' }, { code: '32', name: '강원' }
  ]));
  const seoul = app.TRAVEL_DATA.cities.seoul, busan = app.TRAVEL_DATA.cities.busan;
  // Only this test supplies an old fixed-area catalog; production places.js contains metadata stubs.
  const legacyArea = app.TourData.buildAreas(fixtures().slice(0, 4))[0];
  legacyArea.id = 'jongno';
  legacyArea.name = '종로·광화문';
  legacyArea.places.forEach(place => Object.assign(place, { areaId: legacyArea.id, areaName: legacyArea.name, area: legacyArea.name }));
  seoul.areas = [legacyArea];
  seoul.supportedDays = 3;
  const legacyAreas = seoul.areas;
  const cities = await app.TourData.loadDestinations();
  assert.deepEqual(plain(cities.map(city => city.id)), ['tour-area-39', 'seoul', 'busan', 'tour-area-32']);
  assert.deepEqual(plain(cities.map(city => city.name)), ['제주', '서울', '부산', '강원']);
  assert.equal(cities[1], seoul);
  assert.equal(cities[2], busan);
  assert.equal(seoul.areas, legacyAreas, 'legacy Seoul snapshots retain their static place catalog until API load');
  assert.ok(cities.every(city => city.country === 'KR' && city.timezone === 'Asia/Seoul'));
  assert.ok(cities.filter(city => city !== seoul).every(city => city.supportedDays === 7));
  assert.equal(seoul.supportedDays, 3, 'legacy metadata stays intact until the API catalog is loaded');
  assert.equal(cities[0].tourAreaCode, '39');
  assert.deepEqual(plain(cities[0].areas), []);
  cities.pop();
  assert.equal(app.TourData.getDestinations().length, 4, 'callers cannot change the cached option list');
  assert.equal((await app.TourData.loadDestinations()).length, 4);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0][0], '/api/tour/areas');

  const apiOnly = runtime(async () => areasResponse([{ code: '39', name: '제주' }]));
  assert.deepEqual(plain((await apiOnly.TourData.loadDestinations()).map(city => city.id)), ['tour-area-39']);
  assert.ok(apiOnly.TRAVEL_DATA.cities.seoul, 'excluded legacy cities may remain registered for saved data');
});

test('API destination loading can register Seoul into an entirely empty city registry', async () => {
  const app = runtime(async () => areasResponse([{ code: '1', name: '서울' }]));
  app.TRAVEL_DATA.cities = {};
  const cities = await app.TourData.loadDestinations();
  assert.equal(cities.length, 1);
  assert.equal(cities[0].id, 'seoul');
  assert.equal(cities[0].tourAreaCode, '1');
  assert.equal(cities[0], app.TRAVEL_DATA.cities.seoul);
  assert.deepEqual(plain(cities[0].areas), []);
});

test('destination failures do not partly register cities and can be retried', async t => {
  const cases = [
    ['offline', async () => { throw new Error('offline'); }, /연결하지 못/],
    ['non-JSON', async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }), /응답을 읽지/],
    ['upstream error', async () => ({ ok: false, json: async () => ({ error: { message: 'area error' } }) }), /area error/],
    ['empty list', async () => areasResponse([]), /목록 형식/],
    ['invalid trailing item', async () => areasResponse([{ code: '39', name: '제주' }, { code: 'bad', name: '잘못된 지역' }]), /목록 형식/],
    ['duplicate code', async () => areasResponse([{ code: '39', name: '제주' }, { code: '39', name: '다른 이름' }]), /목록 형식/]
  ];
  for (const [name, fail, expected] of cases) await t.test(name, async () => {
    let attempts = 0;
    const app = runtime(() => ++attempts === 1 ? fail() : areasResponse());
    const before = plain(app.TRAVEL_DATA);
    await assert.rejects(app.TourData.loadDestinations(), expected);
    assert.deepEqual(plain(app.TRAVEL_DATA), before);
    assert.equal(app.TourData.getDestinations().length, 0);
    const cities = await app.TourData.loadDestinations();
    assert.equal(cities.length, 3);
    assert.equal(attempts, 2);
  });
});

test('concurrent destination loads share a request', async () => {
  let resolveFetch;
  const app = runtime(() => new Promise(resolve => { resolveFetch = resolve; }));
  const first = app.TourData.loadDestinations(), second = app.TourData.loadDestinations();
  assert.equal(app.calls.length, 1);
  assert.equal(app.TourData.getDestinations().length, 0);
  resolveFetch(areasResponse());
  const [firstCities, secondCities] = await Promise.all([first, second]);
  assert.equal(firstCities[0], secondCities[0]);
  assert.equal(firstCities.length, 3);
});

test('Busan loads by its API area code and creates one to three day itineraries', async () => {
  const app = runtime(async url => url === '/api/tour/areas' ? areasResponse() : response(regionalFixtures(), '6'));
  await app.TourData.loadDestinations();
  const city = await app.TourData.ensureCity('busan');
  assert.equal(city, app.TRAVEL_DATA.cities.busan);
  assert.equal(city.areas.length, 3);
  assert.equal(city.supportedDays, 3);
  assert.equal(app.calls[1][0], '/api/tour/places?areaCode=6');
  assert.equal(app.TravelPlanner.validateCity(city).ok, true);
  for (const dayCount of [1, 2, 3]) {
    const result = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.cityName, '부산');
    assert.equal(new Set(visitIds(result).flat()).size, dayCount * 3);
    result.days.forEach(assertSequential);
  }
  assert.ok(city.areas.every(area => area.id.startsWith('tour-cluster-') && area.name.includes('해운대구')));
});

test('Jeju keeps distant locations in separate geographic clusters and stable area IDs', async () => {
  const items = regionalFixtures('39');
  const app = runtime(async url => url === '/api/tour/areas' ? areasResponse() : response(items, '39'));
  await app.TourData.loadDestinations();
  const city = await app.TourData.ensureCity('tour-area-39');
  assert.equal(city.areas.length, 3);
  const allIds = city.areas.flatMap(area => area.places.map(place => place.id));
  assert.equal(new Set(allIds).size, items.length);
  for (const area of city.areas) {
    assert.equal(area.places.length, 4);
    assert.ok(area.places.every(place => place.distanceToCenter <= 2.5));
    const groups = new Set(area.places.map(place => Math.floor(Number(place.contentId) / 10)));
    assert.equal(groups.size, 1, 'widely separated fixture groups must never share a day area');
  }
  const before = plain(city.areas.map(area => ({ id: area.id, places: area.places.map(place => place.id) })));
  const reordered = app.TourData.buildAreas([...items].reverse(), '39');
  assert.deepEqual(plain(reordered.map(area => ({ id: area.id, places: area.places.map(place => place.id) }))), before);

  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 3 });
  const saved = plain(original);
  city.areas = reordered;
  const selections = Object.fromEntries(visitIds(saved).map((ids, index) => [index, ids]));
  const restored = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: 3, dayAreaIds: saved.dayAreaIds, selections });
  assert.equal(restored.ok, true, restored.reason);
  assert.deepEqual(visitIds(restored), visitIds(saved));
});

test('regions with only one or two nearby clusters advertise their actual day capacity', async () => {
  for (const areaCount of [1, 2]) {
    const app = runtime(async url => url === '/api/tour/areas' ? areasResponse() : response(regionalFixtures('6', areaCount), '6'));
    await app.TourData.loadDestinations();
    const city = await app.TourData.ensureCity('busan');
    assert.equal(city.supportedDays, areaCount);
    const valid = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: areaCount });
    assert.equal(valid.ok, true, valid.reason);
    const excessive = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: areaCount + 1 });
    assert.equal(excessive.ok, false);
    assert.match(excessive.reason, new RegExp(`최대 일정은 ${areaCount}일`));
  }
});

test('a sparse region fails without replacing its state, then permits a retry', async () => {
  let placeAttempts = 0;
  const sparse = regionalFixtures('39').filter((_, index) => index % 4 === 0);
  const app = runtime(async url => {
    if (url === '/api/tour/areas') return areasResponse();
    return response(++placeAttempts === 1 ? sparse : regionalFixtures('39'), '39');
  });
  await app.TourData.loadDestinations();
  const city = app.TRAVEL_DATA.cities['tour-area-39'];
  const before = plain(city);
  await assert.rejects(app.TourData.ensureCity(city.id), /가까운 관광지 3곳/);
  assert.deepEqual(plain(city), before);
  assert.equal(await app.TourData.ensureCity(city.id), city);
  assert.equal(placeAttempts, 2);
});

test('different regions load concurrently without sharing or clearing each other pending requests', async () => {
  const deferred = new Map();
  const app = runtime(url => {
    if (url === '/api/tour/areas') return areasResponse();
    const code = new URL(url, 'http://127.0.0.1').searchParams.get('areaCode');
    return new Promise(resolve => { deferred.set(code, resolve); });
  });
  await app.TourData.loadDestinations();
  const seoul = app.TRAVEL_DATA.cities.seoul, originalSeoulAreas = seoul.areas;
  const firstSeoul = app.TourData.ensureCity('seoul');
  const firstBusan = app.TourData.ensureCity('busan');
  const secondBusan = app.TourData.ensureCity('busan');
  assert.equal(app.calls.length, 3, 'one destination request and two separate region requests');
  deferred.get('6')(response(regionalFixtures(), '6'));
  const busanResults = await Promise.all([firstBusan, secondBusan]);
  assert.equal(busanResults[0], busanResults[1]);
  assert.equal(busanResults[0].tourAreaCode, '6');
  assert.equal(seoul.areas, originalSeoulAreas);
  const secondSeoul = app.TourData.ensureCity('seoul');
  assert.equal(app.calls.length, 3, 'Busan completion must not clear Seoul pending state');
  deferred.get('1')(response());
  const seoulResults = await Promise.all([firstSeoul, secondSeoul]);
  assert.equal(seoulResults[0], seoulResults[1]);
  assert.equal(seoulResults[0].tourAreaCode, '1');
  assert.ok(seoulResults[0].areas.every(area => area.id.startsWith('tour-cluster-')));
});

test('regional filtering rejects foreign coordinates and mismatched API area codes', () => {
  const app = runtime();
  const valid = regionalFixtures('39', 1);
  const invalid = [
    { ...valid[0], contentId: '80001', areaCode: '6' },
    { ...valid[0], contentId: '80002', latitude: 32.99 },
    { ...valid[0], contentId: '80003', longitude: 132.01 },
    { ...valid[0], contentId: '80004', latitude: 39.51 },
    { ...valid[0], contentId: '80005', longitude: 123.99 },
    { ...valid[0], contentId: '80006', longitude: '126.52' },
    { ...valid[0], title: 'duplicate' }
  ];
  const areas = app.TourData.buildAreas([...valid, ...invalid], '39');
  assert.equal(areas.length, 1);
  assert.equal(areas[0].places.length, 4);
  assert.ok(areas[0].places.every(place => valid.some(item => item.contentId === place.contentId)));
});

test('default flow has stable editable IDs, longer free time and a calculated finish after 18:00', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const result = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  assert.equal(result.ok, true);
  const day = result.days[0];
  assert.deepEqual(plain(day.events.map(event => event.id)), ['departure', 'place-0', 'transfer-0', 'free-0', 'lunch', 'place-1', 'rest', 'transfer-1', 'place-2', 'dinner', 'free-1', 'finish']);
  assert.equal(day.events.find(event => event.id === 'free-0').duration, 90);
  assert.equal(day.events.find(event => event.id === 'free-1').duration, 120);
  assert.equal(day.events.find(event => event.id === 'rest').duration, 30);
  assert.equal(day.start, 9 * 60);
  assert.ok(day.end > 18 * 60, '18:00 is no longer a hard deadline');
  assert.deepEqual(plain(result.dayStarts), { 0: '09:00' });
  assert.deepEqual(plain(result.eventEdits), {});
  assertSequential(day);
});

test('long API stay durations are allowed and overnight time labels remain unambiguous', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  city.areas[0].places[0].stayMinutes = 720;
  const result = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.days[0].end > 24 * 60);
  assert.match(result.days[0].events.at(-1).endLabel, /^다음 날 /);
  assert.equal(app.TravelPlanner.formatTime(25 * 60), '다음 날 01:00');
  assert.equal(app.TravelPlanner.formatTime(49 * 60), '2일 후 01:00');
  assertSequential(result.days[0]);
});

test('editing a free event updates only its slot and subsequent times without mutating the original', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2 });
  const snapshot = plain(original);
  const changed = app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'free-0', title: '  카페에서 쉬기  ', description: '  동네 카페 자유 방문  ', duration: 150 });
  assert.equal(changed.ok, true, changed.reason);
  const before = original.days[0].events, after = changed.itinerary.days[0].events;
  const index = before.findIndex(event => event.id === 'free-0');
  assert.equal(after[index].title, '카페에서 쉬기');
  assert.equal(after[index].description, '동네 카페 자유 방문');
  assert.equal(after[index].start, before[index].start);
  assert.equal(after[index].duration, 150);
  assert.equal(after[index].end, before[index].end + 60);
  assert.deepEqual(plain(after.slice(0, index)), plain(before.slice(0, index)));
  for (let offset = index + 1; offset < before.length; offset++) {
    assert.equal(after[offset].start, before[offset].start + 60);
    assert.equal(after[offset].duration, before[offset].duration);
  }
  assert.deepEqual(plain(changed.itinerary.days[1]), plain(original.days[1]));
  assert.deepEqual(plain(original), snapshot);
  assertSequential(changed.itinerary.days[0]);
});

test('place and transfer events accept custom display text while retaining actual API place identity', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  const place = original.days[0].events.find(event => event.id === 'place-0').place;
  const placeEdit = app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'place-0', title: '우리의 첫 방문', description: '', duration: 120 });
  assert.equal(placeEdit.ok, true);
  assert.equal(placeEdit.itinerary.days[0].events.find(event => event.id === 'place-0').place, place);
  assert.equal(placeEdit.itinerary.days[0].events.find(event => event.id === 'place-0').place.name, place.name);
  assert.equal(placeEdit.itinerary.days[0].events.find(event => event.id === 'place-0').title, '우리의 첫 방문');
  const transferEdit = app.TravelPlanner.updateEvent({ city, itinerary: placeEdit.itinerary, dayIndex: 0, eventId: 'transfer-0', title: '버스로 이동', duration: 45 });
  assert.equal(transferEdit.ok, true);
  assert.equal(transferEdit.itinerary.days[0].events.find(event => event.id === 'transfer-0').title, '버스로 이동');
  assert.equal(transferEdit.itinerary.days[0].events.find(event => event.id === 'transfer-0').duration, 45);
  assert.equal(transferEdit.itinerary.days[0].events.find(event => event.id === 'place-0').title, '우리의 첫 방문');
  assertSequential(transferEdit.itinerary.days[0]);
});

test('invalid event edits and saved option shapes fail without changing existing data', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  const snapshot = plain(original);
  const invalidEdits = [{ title: '' }, { title: ' '.repeat(3) }, { title: 'x'.repeat(81) }, { description: 'x'.repeat(501) },
    { duration: 0 }, { duration: -1 }, { duration: 1.5 }, { duration: 721 }, { duration: '60' }, { title: null }, { description: null }];
  for (const edit of invalidEdits) {
    const result = app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'free-0', ...edit });
    assert.equal(result.ok, false, JSON.stringify(edit));
  }
  assert.equal(app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'unknown', title: 'test' }).ok, false);
  assert.equal(app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 1, eventId: 'rest', title: 'test' }).ok, false);
  const invalidOptions = [
    { dayStarts: null }, { dayStarts: [] }, { dayStarts: { 1: '10:00' } }, { dayStarts: { 0: '24:00' } },
    { eventEdits: null }, { eventEdits: [] }, { eventEdits: { 1: { rest: { title: 'test' } } } },
    { eventEdits: { 0: { unknown: { duration: 30 } } } }, { eventEdits: { 0: { rest: { duration: 0 } } } },
    { eventEdits: { 0: { rest: { unexpected: 'field' } } } }
  ];
  for (const options of invalidOptions) {
    assert.equal(app.TravelPlanner.createItinerary({ city, startDate: original.startDate, dayCount: 1, ...options }).ok, false, JSON.stringify(options));
  }
  assert.deepEqual(plain(original), snapshot);
});

test('departure time shifts the chosen day, permits overnight schedules and validates clock inputs', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2 });
  const shifted = app.TravelPlanner.setDayStart({ city, itinerary: original, dayIndex: 0, startTime: '23:15' });
  assert.equal(shifted.ok, true, shifted.reason);
  assert.equal(shifted.itinerary.dayStarts[0], '23:15');
  assert.equal(shifted.itinerary.days[0].start, 23 * 60 + 15);
  const delta = (23 * 60 + 15) - original.days[0].start;
  shifted.itinerary.days[0].events.forEach((event, index) => {
    assert.equal(event.start, original.days[0].events[index].start + delta);
    assert.equal(event.duration, original.days[0].events[index].duration);
  });
  assert.match(shifted.itinerary.days[0].events.at(-1).endLabel, /^다음 날 /);
  assert.deepEqual(plain(shifted.itinerary.days[1]), plain(original.days[1]));
  for (const startTime of ['24:00', '7:00', '09:60', '', null]) {
    assert.equal(app.TravelPlanner.setDayStart({ city, itinerary: original, dayIndex: 0, startTime }).ok, false);
  }
  assertSequential(shifted.itinerary.days[0]);
});

test('serialized edits and departure times rebuild exactly, while legacy snapshots still use defaults', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayStarts: { 0: '08:15', 1: '10:45' }, eventEdits: { 0: { 'free-1': { title: '야경 산책', description: '사진 찍기', duration: 180 } }, 1: { lunch: { title: '예약한 점심', duration: 90 } } } });
  assert.equal(original.ok, true, original.reason);
  const saved = plain(original), selections = Object.fromEntries(visitIds(saved).map((ids, index) => [index, ids]));
  const rebuilt = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount,
    dayAreaIds: saved.dayAreaIds, selections, dayStarts: saved.dayStarts, eventEdits: saved.eventEdits });
  assert.equal(rebuilt.ok, true, rebuilt.reason);
  assert.deepEqual(plain(rebuilt.days), saved.days);
  assert.deepEqual(plain(rebuilt.dayStarts), saved.dayStarts);
  assert.deepEqual(plain(rebuilt.eventEdits), saved.eventEdits);
  const legacy = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount, dayAreaIds: saved.dayAreaIds, selections });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.days[0].start, 9 * 60);
  assert.deepEqual(plain(legacy.eventEdits), {});
});

test('place replacement clears that place slot edits and keeps unrelated edits and departure clocks', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayStarts: { 0: '11:00' }, eventEdits: { 0: { 'place-0': { title: '이전 장소 메모', description: '예약', duration: 300 }, 'free-0': { title: '카페', duration: 150 }, 'place-1': { title: '오후 방문' } }, 1: { rest: { title: '둘째 날 휴식' } } } });
  const oldId = visitIds(original)[0][0];
  city.areas[0].places[3].stayMinutes = 720;
  const options = app.TravelPlanner.getAlternatives({ city, itinerary: original, dayIndex: 0, placeId: oldId });
  assert.equal(options.length, 1, 'long-stay alternatives are no longer rejected by an 18:00 deadline');
  const result = app.TravelPlanner.replacePlace({ city, itinerary: original, dayIndex: 0, placeId: oldId, replacementId: options[0].id });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.itinerary.eventEdits[0]['place-0'], undefined);
  assert.equal(result.itinerary.days[0].events.find(event => event.id === 'place-0').title, options[0].name);
  assert.equal(result.itinerary.days[0].events.find(event => event.id === 'place-0').duration, 720);
  assert.equal(result.itinerary.eventEdits[0]['free-0'].title, '카페');
  assert.equal(result.itinerary.eventEdits[0]['place-1'].title, '오후 방문');
  assert.deepEqual(plain(result.itinerary.eventEdits[1]), plain(original.eventEdits[1]));
  assert.deepEqual(plain(result.itinerary.dayStarts), plain(original.dayStarts));
  assert.ok(original.eventEdits[0]['place-0'], 'the old snapshot is not modified');
  assertSequential(result.itinerary.days[0]);
});

test('replacing any tourist resets affected road-leg durations, keeps notes and survives saved reload without stale estimates', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const edits = {
    departure: { title: '숙소에서 출발', description: '짐 챙기기', duration: 23 },
    'transfer-0': { title: '첫 차량 이동', description: '첫 이동 메모', duration: 6 },
    'transfer-1': { title: '둘째 차량 이동', description: '둘째 이동 메모', duration: 8 },
    'place-0': { title: '첫 장소 메모' }, 'place-1': { title: '둘째 장소 메모' }, 'place-2': { title: '셋째 장소 메모' },
    rest: { title: '쉬면서 사진 정리', duration: 45 }
  };
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayStarts: { 0: '07:30' }, dayDepartures: { 0: departureFixture({ mode: 'car' }) }, eventEdits: { 0: edits } });
  assert.equal(original.ok, true, original.reason);
  const snapshot = plain(original);
  for (const slot of [0, 1, 2]) {
    const placeId = visitIds(original)[0][slot];
    const candidate = app.TravelPlanner.getAlternatives({ city, itinerary: original, dayIndex: 0, placeId })[0];
    const result = app.TravelPlanner.replacePlace({ city, itinerary: original, dayIndex: 0, placeId, replacementId: candidate.id });
    assert.equal(result.ok, true, result.reason);
    const next = result.itinerary, patches = next.eventEdits[0];
    assert.equal(next.days[0].events[0].duration, slot === 0 ? 0 : 23);
    assert.equal(next.days[0].needsTravelTime, true);
    assert.equal(next.days[0].events.find(event => event.id === 'transfer-0').duration, slot < 2 ? 0 : 6);
    assert.equal(next.days[0].events.find(event => event.id === 'transfer-1').duration, slot > 0 ? 0 : 8);
    assert.equal(patches.departure.title, edits.departure.title);
    assert.equal(patches.departure.description, edits.departure.description);
    for (const leg of ['transfer-0', 'transfer-1']) {
      assert.equal(patches[leg].title, edits[leg].title);
      assert.equal(patches[leg].description, edits[leg].description);
    }
    assert.deepEqual(plain(patches.rest), edits.rest);
    for (const other of [0, 1, 2]) assert.deepEqual(plain(patches[`place-${other}`] ?? null), other === slot ? null : edits[`place-${other}`]);
    assert.deepEqual(plain(next.dayStarts), snapshot.dayStarts);
    assert.deepEqual(plain(next.dayDepartures), snapshot.dayDepartures);
    assert.deepEqual(plain(next.days[1]), snapshot.days[1]);
    const saved = plain(next);
    const restored = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount,
      dayAreaIds: saved.dayAreaIds, selections: Object.fromEntries(visitIds(saved).map((ids, index) => [index, ids])),
      dayStarts: saved.dayStarts, eventEdits: saved.eventEdits, dayDepartures: saved.dayDepartures,
      dayArrivals: saved.dayArrivals, dayTransports: saved.dayTransports });
    assert.equal(restored.ok, true, restored.reason);
    assert.deepEqual(plain(restored.days), saved.days);
    assert.deepEqual(plain(restored.eventEdits), saved.eventEdits);
    assert.deepEqual(plain(original), snapshot, 'clearing a leg cannot modify the previous saved snapshot');
    assertSequential(next.days[0]);
  }
});

test('replacing the middle tourist removes empty duration-only transfer edits', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
    dayDepartures: { 0: departureFixture({ mode: 'rental-car' }) },
    eventEdits: { 0: { 'transfer-0': { duration: 6 }, 'transfer-1': { duration: 8 } } } });
  const placeId = visitIds(original)[0][1];
  const candidate = app.TravelPlanner.getAlternatives({ city, itinerary: original, dayIndex: 0, placeId })[0];
  const result = app.TravelPlanner.replacePlace({ city, itinerary: original, dayIndex: 0, placeId, replacementId: candidate.id });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.itinerary.eventEdits[0], undefined);
  assert.equal(original.eventEdits[0]['transfer-0'].duration, 6);
  assert.equal(original.eventEdits[0]['transfer-1'].duration, 8);
});

test('switching between vehicle and nonvehicle modes clears stale transfer times while preserving notes, origins and departure clocks', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayStarts: { 0: '07:30' }, dayDepartures: { 0: departureFixture({ mode: 'car' }) }, eventEdits: { 0: {
      departure: { duration: 23 }, 'transfer-0': { duration: 6, title: '이동 제목', description: '이동 메모' },
      'transfer-1': { duration: 8 }, rest: { title: '쉬면서 사진 정리', duration: 45 }
    } } });
  const snapshot = plain(original);
  const walking = app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex: 0, departure: departureFixture({ mode: 'walk' }) });
  assert.equal(walking.ok, true, walking.reason);
  const next = walking.itinerary;
  assert.deepEqual(plain(next.dayDepartures[0]), { ...snapshot.dayDepartures[0], mode: 'walk' });
  assert.deepEqual(plain(next.dayStarts), snapshot.dayStarts);
  assert.equal(next.days[0].events[0].duration, 0);
  assert.equal(next.days[0].events.find(event => event.id === 'transfer-0').duration, 0);
  assert.equal(next.days[0].events.find(event => event.id === 'transfer-1').duration, 0);
  assert.deepEqual(plain(next.eventEdits[0]['transfer-0']), { title: '이동 제목', description: '이동 메모' });
  assert.equal(next.eventEdits[0]['transfer-1'], undefined);
  assert.deepEqual(plain(next.eventEdits[0].rest), snapshot.eventEdits[0].rest);
  assert.deepEqual(plain(next.days[1]), snapshot.days[1]);
  assert.deepEqual(plain(original), snapshot);
  const editedWalking = app.TravelPlanner.updateEvent({ city, itinerary: next, dayIndex: 0, eventId: 'transfer-0', duration: 40 }).itinerary;
  const backToCar = app.TravelPlanner.setDayDeparture({ city, itinerary: editedWalking, dayIndex: 0, departure: departureFixture({ mode: 'car' }) });
  assert.equal(backToCar.ok, true, backToCar.reason);
  assert.equal(backToCar.itinerary.days[0].events.find(event => event.id === 'transfer-0').duration, 0);
  assert.equal(backToCar.itinerary.eventEdits[0]['transfer-0'].description, '이동 메모');
  assert.equal(editedWalking.days[0].events.find(event => event.id === 'transfer-0').duration, 40);
});

test('vehicle-category switches and same-category origin changes keep valid between-tourist durations', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
    dayStarts: { 0: '07:30' }, dayDepartures: { 0: departureFixture({ mode: 'car' }) },
    eventEdits: { 0: { departure: { duration: 23 }, 'transfer-0': { duration: 6, description: '구간 메모' }, 'transfer-1': { duration: 8 } } } });
  const snapshot = plain(original);
  for (const departure of [departureFixture({ mode: 'rental-car' }), departureFixture({ mode: 'taxi' }),
    departureFixture({ mode: 'car', id: 'osm-node-999999', sourceUrl: 'https://www.openstreetmap.org/node/999999', name: '새 출발지' })]) {
    const result = app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex: 0, departure });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.itinerary.days[0].events[0].duration, departure.id === original.dayDepartures[0].id ? 23 : 0,
      'legacy vehicle aliases keep the same route time; an actual new origin requires a new estimate');
    assert.equal(result.itinerary.days[0].events.find(event => event.id === 'transfer-0').duration, 6);
    assert.equal(result.itinerary.days[0].events.find(event => event.id === 'transfer-1').duration, 8);
    assert.deepEqual(plain(result.itinerary.eventEdits[0]['transfer-0']), snapshot.eventEdits[0]['transfer-0']);
    assert.deepEqual(plain(result.itinerary.dayStarts), snapshot.dayStarts);
  }
  assert.deepEqual(plain(original), snapshot);
});

test('internal transfer modes are optional, support four choices and never inherit the day departure mode', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  for (const departureMode of ['car', 'train', 'walk']) {
    const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
      dayDepartures: { 0: departureFixture({ mode: departureMode }) } });
    assert.equal(original.ok, true, original.reason);
    for (const event of original.days[0].events.filter(event => ['transfer-0', 'transfer-1'].includes(event.id))) assert.equal(event.travelMode, null);
    for (const mode of ['walk', 'local-bus', 'subway', 'car']) {
      const result = app.TravelPlanner.setTransferMode({ city, itinerary: original, dayIndex: 0, eventId: 'transfer-0', mode });
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.itinerary.eventEdits[0]['transfer-0'].travelMode, mode);
      assert.equal(result.itinerary.days[0].events.find(event => event.id === 'transfer-0').travelMode, mode);
      assert.equal(result.itinerary.days[0].events.find(event => event.id === 'transfer-1').travelMode, null);
      assert.equal(result.itinerary.dayDepartures[0].mode, departureMode);
      assert.equal(original.eventEdits[0], undefined);
    }
  }
});

test('legacy vehicle aliases in serialized origins and internal legs normalize to car without losing times or notes', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const baseline = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayStarts: { 0: '07:30', 1: '08:30' }, dayDepartures: { 0: departureFixture({ mode: 'car' }), 1: departureFixture({ mode: 'car' }) },
    eventEdits: { 0: { departure: { duration: 23, description: '출발 메모' },
      'transfer-0': { travelMode: 'car', duration: 6, title: '첫 이동', description: '구간 메모' },
      'transfer-1': { travelMode: 'car', duration: 8 }, rest: { title: '사진 정리', duration: 45 } },
    1: { departure: { duration: 25 }, 'transfer-0': { travelMode: 'car', duration: 11 } } } });
  assert.equal(baseline.ok, true, baseline.reason);
  const saved = plain(baseline);
  saved.departure.mode = 'taxi'; saved.dayDepartures[0].mode = 'taxi'; saved.dayDepartures[1].mode = 'rental-car';
  saved.eventEdits[0]['transfer-0'].travelMode = 'rental-car'; saved.eventEdits[0]['transfer-1'].travelMode = 'taxi';
  saved.eventEdits[1]['transfer-0'].travelMode = 'taxi';
  const snapshot = plain(saved);
  const restored = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount,
    dayAreaIds: saved.dayAreaIds, selections: Object.fromEntries(visitIds(saved).map((ids, index) => [index, ids])),
    dayStarts: saved.dayStarts, eventEdits: saved.eventEdits, departure: saved.departure, dayDepartures: saved.dayDepartures,
    dayArrivals: saved.dayArrivals, dayTransports: saved.dayTransports });
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(restored.departure.mode, 'car');
  assert.ok(restored.days.every(day => day.departure.mode === 'car'));
  assert.deepEqual(plain(restored.days), plain(baseline.days));
  assert.deepEqual(plain(restored.eventEdits), plain(baseline.eventEdits));
  assert.deepEqual(plain(restored.dayStarts), plain(baseline.dayStarts));
  assert.deepEqual(plain(saved), snapshot, 'migration cannot mutate the saved source');
  saved.eventEdits[0]['transfer-0'].duration = 99;
  assert.equal(restored.eventEdits[0]['transfer-0'].duration, 6, 'migrated edits remain independent copies');
});

test('legacy vehicle input aliases are equivalent to car in origin and transfer setters and retain current estimates', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
    dayStarts: { 0: '07:30' }, dayDepartures: { 0: departureFixture({ mode: 'car' }) }, eventEdits: { 0: {
      departure: { duration: 23, description: '출발 메모' }, 'transfer-0': { travelMode: 'car', duration: 6, description: '구간 메모' }
    } } });
  const legacy = plain(original); legacy.departure.mode = 'taxi'; legacy.dayDepartures[0].mode = 'rental-car';
  legacy.eventEdits[0]['transfer-0'].travelMode = 'taxi';
  const snapshot = plain(legacy);
  for (const mode of ['car', 'taxi', 'rental-car']) {
    const origin = app.TravelPlanner.setDayDeparture({ city, itinerary: legacy, dayIndex: 0, departure: departureFixture({ mode }) });
    assert.equal(origin.ok, true, origin.reason);
    assert.equal(origin.itinerary.dayDepartures[0].mode, 'car');
    assert.equal(origin.itinerary.days[0].events[0].duration, 23);
    assert.equal(origin.itinerary.eventEdits[0].departure.description, '출발 메모');
    const transfer = app.TravelPlanner.setTransferMode({ city, itinerary: legacy, dayIndex: 0, eventId: 'transfer-0', mode });
    assert.equal(transfer.ok, true, transfer.reason);
    assert.equal(transfer.itinerary.eventEdits[0]['transfer-0'].travelMode, 'car');
    assert.equal(transfer.itinerary.eventEdits[0]['transfer-0'].duration, 6);
    assert.equal(transfer.itinerary.eventEdits[0]['transfer-0'].description, '구간 메모');
    assert.deepEqual(plain(transfer.itinerary.dayStarts), plain(original.dayStarts));
  }
  assert.deepEqual(plain(legacy), snapshot);
});

test('invalid internal modes, nontransfer IDs and malformed saved travelMode fields fail without changing the itinerary', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  const snapshot = plain(original);
  for (const mode of [undefined, null, '', 'bus', 'train', 'flight', 'ferry', 'WALK', ' walk ', 'Taxi', 'rental_car', 'vehicle', true, {}, []]) {
    assert.equal(app.TravelPlanner.setTransferMode({ city, itinerary: original, dayIndex: 0, eventId: 'transfer-0', mode }).ok, false);
    assert.equal(app.TravelPlanner.createItinerary({ city, startDate: original.startDate, dayCount: 1,
      eventEdits: { 0: { 'transfer-0': { travelMode: mode } } } }).ok, false);
  }
  for (const eventId of ['departure', 'arrival-transfer', 'arrival', 'rest', 'place-0', 'transfer-2']) {
    assert.equal(app.TravelPlanner.setTransferMode({ city, itinerary: original, dayIndex: 0, eventId, mode: 'walk' }).ok, false);
    assert.equal(app.TravelPlanner.createItinerary({ city, startDate: original.startDate, dayCount: 1,
      eventEdits: { 0: { [eventId]: { travelMode: 'walk' } } } }).ok, false);
  }
  for (const dayIndex of [-1, 1, '0', 0.5]) assert.equal(app.TravelPlanner.setTransferMode({ city, itinerary: original, dayIndex, eventId: 'transfer-0', mode: 'walk' }).ok, false);
  assert.deepEqual(plain(original), snapshot);
});

test('changing an internal mode clears only its duration except equivalent vehicle modes, retaining notes and other legs', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    eventEdits: { 0: { 'transfer-0': { travelMode: 'car', duration: 6, title: '구간 제목', description: '이동 메모' },
      'transfer-1': { travelMode: 'subway', duration: 45 } } } });
  const snapshot = plain(original);
  for (const mode of ['car', 'rental-car', 'taxi']) {
    const result = app.TravelPlanner.setTransferMode({ city, itinerary: original, dayIndex: 0, eventId: 'transfer-0', mode });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.itinerary.days[0].events.find(event => event.id === 'transfer-0').duration, 6);
    assert.equal(result.itinerary.days[0].events.find(event => event.id === 'transfer-0').travelMode, 'car');
  }
  const walking = app.TravelPlanner.setTransferMode({ city, itinerary: original, dayIndex: 0, eventId: 'transfer-0', mode: 'walk' });
  assert.equal(walking.ok, true, walking.reason);
  assert.deepEqual(plain(walking.itinerary.eventEdits[0]['transfer-0']), { travelMode: 'walk', title: '구간 제목', description: '이동 메모' });
  assert.equal(walking.itinerary.days[0].events.find(event => event.id === 'transfer-0').duration, 0);
  assert.deepEqual(plain(walking.itinerary.eventEdits[0]['transfer-1']), snapshot.eventEdits[0]['transfer-1']);
  assert.deepEqual(plain(walking.itinerary.days[1]), snapshot.days[1]);
  const manualWalking = app.TravelPlanner.updateEvent({ city, itinerary: walking.itinerary, dayIndex: 0, eventId: 'transfer-0', duration: 40 }).itinerary;
  const sameMode = app.TravelPlanner.setTransferMode({ city, itinerary: manualWalking, dayIndex: 0, eventId: 'transfer-0', mode: 'walk' });
  assert.equal(sameMode.itinerary.days[0].events.find(event => event.id === 'transfer-0').duration, 40);
  for (const mode of ['local-bus', 'subway', 'car']) {
    const changed = app.TravelPlanner.setTransferMode({ city, itinerary: manualWalking, dayIndex: 0, eventId: 'transfer-0', mode });
    assert.equal(changed.ok, true, changed.reason);
    assert.equal(changed.itinerary.days[0].events.find(event => event.id === 'transfer-0').duration, 0);
    assert.equal(changed.itinerary.eventEdits[0]['transfer-0'].description, '이동 메모');
  }
  assert.deepEqual(plain(original), snapshot);
  assertSequential(walking.itinerary.days[0]);
});

test('explicit internal modes and durations stay independent of day-origin changes while unconfigured legacy legs reset', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
    dayStarts: { 0: '07:30' }, dayDepartures: { 0: departureFixture({ mode: 'car' }) },
    eventEdits: { 0: { 'transfer-0': { travelMode: 'walk', duration: 40, description: '동네 산책' }, 'transfer-1': { duration: 8 } } } });
  const snapshot = plain(original);
  for (const mode of ['walk', 'local-bus', 'train']) {
    const result = app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex: 0, departure: departureFixture({ mode }) });
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(plain(result.itinerary.eventEdits[0]['transfer-0']), snapshot.eventEdits[0]['transfer-0']);
    assert.equal(result.itinerary.days[0].events.find(event => event.id === 'transfer-0').duration, 40);
    assert.equal(result.itinerary.days[0].events.find(event => event.id === 'transfer-0').travelMode, 'walk');
    assert.equal(result.itinerary.days[0].events.find(event => event.id === 'transfer-1').duration, 0);
    assert.equal(result.itinerary.days[0].events.find(event => event.id === 'transfer-1').travelMode, null);
    assert.deepEqual(plain(result.itinerary.dayStarts), snapshot.dayStarts);
  }
  assert.deepEqual(plain(original), snapshot);
});

test('internal mode choices survive JSON reload and place swaps keep modes and notes while resetting affected times', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
    eventEdits: { 0: { 'transfer-0': { travelMode: 'local-bus', duration: 40, description: '환승 확인' },
      'transfer-1': { travelMode: 'rental-car', duration: 6, title: '차량 이동' } } } });
  const saved = plain(original);
  const restored = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount,
    dayAreaIds: saved.dayAreaIds, selections: Object.fromEntries(visitIds(saved).map((ids, index) => [index, ids])),
    dayStarts: saved.dayStarts, eventEdits: saved.eventEdits, dayDepartures: saved.dayDepartures });
  assert.equal(restored.ok, true, restored.reason);
  assert.deepEqual(plain(restored.days), saved.days);
  saved.eventEdits[0]['transfer-0'].travelMode = 'taxi';
  assert.equal(restored.eventEdits[0]['transfer-0'].travelMode, 'local-bus', 'restoration clones saved patches');
  for (const slot of [0, 1, 2]) {
    const placeId = visitIds(restored)[0][slot], candidate = app.TravelPlanner.getAlternatives({ city, itinerary: restored, dayIndex: 0, placeId })[0];
    const changed = app.TravelPlanner.replacePlace({ city, itinerary: restored, dayIndex: 0, placeId, replacementId: candidate.id });
    assert.equal(changed.ok, true, changed.reason);
    assert.equal(changed.itinerary.eventEdits[0]['transfer-0'].travelMode, 'local-bus');
    assert.equal(changed.itinerary.eventEdits[0]['transfer-1'].travelMode, 'car');
    assert.equal(changed.itinerary.eventEdits[0]['transfer-0'].description, '환승 확인');
    assert.equal(changed.itinerary.eventEdits[0]['transfer-1'].title, '차량 이동');
    assert.equal(changed.itinerary.days[0].events.find(event => event.id === 'transfer-0').duration, slot < 2 ? 0 : 40);
    assert.equal(changed.itinerary.days[0].events.find(event => event.id === 'transfer-1').duration, slot > 0 ? 0 : 6);
  }
  assert.equal(restored.eventEdits[0]['transfer-0'].duration, 40);
  assert.equal(restored.eventEdits[0]['transfer-1'].duration, 6);
});

test('setting an internal mode preserves official intercity transport, its clock and other dates', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.setDayTransport({ city, itinerary: officialItinerary(app, city), dayIndex: 0, transport: transportFixture() }).itinerary;
  const snapshot = plain(original);
  const changed = app.TravelPlanner.setTransferMode({ city, itinerary: original, dayIndex: 0, eventId: 'transfer-0', mode: 'subway' });
  assert.equal(changed.ok, true, changed.reason);
  assert.deepEqual(plain(changed.itinerary.dayTransports), snapshot.dayTransports);
  assert.deepEqual(plain(changed.itinerary.dayStarts), snapshot.dayStarts);
  assert.deepEqual(plain(changed.itinerary.days[1]), snapshot.days[1]);
  assert.equal(changed.itinerary.days[0].events.find(event => event.id === 'transfer-0').travelMode, 'subway');
  assert.deepEqual(plain(original), snapshot);
});

test('nearby transfer suggestions use straight-line distance only and never invent bus or subway availability or time', async () => {
  const app = runtime();
  const origin = { latitude: 37, longitude: 127 };
  const near = app.TravelPlanner.getTransferSuggestion({ origin, destination: { latitude: 37.004, longitude: 127 } });
  assert.deepEqual(plain(near), { mode: 'walk', label: '도보 추천', reason: '가까운 구간 · 직선거리 기준', distanceMeters: 445 });
  const far = app.TravelPlanner.getTransferSuggestion({ origin, destination: { latitude: 37.01, longitude: 127 } });
  assert.deepEqual(plain(far), { mode: null, label: '대중교통·차량 고려', reason: '노선과 실제 경로를 확인해 주세요.', distanceMeters: 1112 });
  for (const distance of [799, 801]) {
    const recommendation = app.TravelPlanner.getTransferSuggestion({ origin, destination: { latitude: origin.latitude + distance / 6371000 * 180 / Math.PI, longitude: 127 } });
    assert.equal(recommendation.mode, distance < 800 ? 'walk' : null);
    assert.equal(recommendation.distanceMeters, distance);
    assert.equal(Object.hasOwn(recommendation, 'durationMinutes'), false);
    assert.equal(Object.hasOwn(recommendation, 'line'), false);
  }
  for (const point of [undefined, null, {}, { latitude: '37', longitude: 127 }, { latitude: NaN, longitude: 127 },
    { latitude: 0, longitude: 0 }, { latitude: 37, longitude: 133 }]) assert.equal(app.TravelPlanner.getTransferSuggestion({ origin, destination: point }), null);
});

test('tourist replacements reset only local affected legs while preserving official TAGO transport and its departure clock', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const draft = officialItinerary(app, city, 'train', { eventEdits: { 0: {
    departure: { description: '승차 메모' }, 'arrival-transfer': { duration: 25 },
    'transfer-0': { duration: 6, description: '첫 이동 메모' }, 'transfer-1': { duration: 8, title: '다음 이동' },
    finish: { title: '숙소 복귀', duration: 60 }
  } } });
  const original = app.TravelPlanner.setDayTransport({ city, itinerary: draft, dayIndex: 0, transport: transportFixture() }).itinerary;
  const snapshot = plain(original);
  for (const slot of [0, 1, 2]) {
    const placeId = visitIds(original)[0][slot];
    const candidate = app.TravelPlanner.getAlternatives({ city, itinerary: original, dayIndex: 0, placeId })[0];
    const result = app.TravelPlanner.replacePlace({ city, itinerary: original, dayIndex: 0, placeId, replacementId: candidate.id });
    assert.equal(result.ok, true, result.reason);
    const next = result.itinerary;
    assert.deepEqual(plain(next.dayTransports), snapshot.dayTransports);
    assert.deepEqual(plain(next.dayStarts), snapshot.dayStarts);
    assert.deepEqual(plain(next.dayDepartures), snapshot.dayDepartures);
    assert.deepEqual(plain(next.dayArrivals), snapshot.dayArrivals);
    assert.deepEqual(plain(next.eventEdits[0].departure), snapshot.eventEdits[0].departure);
    assert.equal(next.days[0].events[0].duration, 150);
    assert.equal(next.days[0].events.find(event => event.id === 'arrival-transfer').duration, slot === 0 ? 0 : 25);
    assert.equal(next.days[0].events.find(event => event.id === 'transfer-0').duration, slot < 2 ? 0 : 6);
    assert.equal(next.days[0].events.find(event => event.id === 'transfer-1').duration, slot > 0 ? 0 : 8);
    assert.equal(next.eventEdits[0]['transfer-0'].description, '첫 이동 메모');
    assert.equal(next.eventEdits[0]['transfer-1'].title, '다음 이동');
    assert.deepEqual(plain(next.eventEdits[0].finish), snapshot.eventEdits[0].finish);
    assert.deepEqual(plain(next.days[1]), snapshot.days[1]);
    assert.deepEqual(plain(original), snapshot);
  }
});

test('changing or swapping areas clears affected day edits while retaining departures by calendar day', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 3,
    dayStarts: { 0: '08:00', 1: '11:00', 2: '10:30' }, eventEdits: { 0: { 'free-0': { title: '첫날 메모' } }, 1: { lunch: { title: '둘째 날 메모' } }, 2: { rest: { title: '셋째 날 메모' } } } });
  const swapped = app.TravelPlanner.changeDayArea({ city, itinerary: original, dayIndex: 0, areaId: original.days[1].areaId });
  assert.equal(swapped.ok, true, swapped.reason);
  assert.equal(swapped.itinerary.eventEdits[0], undefined);
  assert.equal(swapped.itinerary.eventEdits[1], undefined);
  assert.deepEqual(plain(swapped.itinerary.eventEdits[2]), plain(original.eventEdits[2]));
  assert.deepEqual(plain(swapped.itinerary.dayStarts), plain(original.dayStarts));
  const changed = app.TravelPlanner.changeDayArea({ city, itinerary: original, dayIndex: 0, areaId: city.areas[3].id });
  assert.equal(changed.ok, true, changed.reason);
  assert.equal(changed.itinerary.eventEdits[0], undefined);
  assert.deepEqual(plain(changed.itinerary.eventEdits[1]), plain(original.eventEdits[1]));
  assert.deepEqual(plain(changed.itinerary.dayStarts), plain(original.dayStarts));
  changed.itinerary.days.forEach(assertSequential);
});

test('departure metadata accepts all five modes and matching OSM object IDs without adding travel time', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const base = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  assert.equal(base.departure, null);
  const modes = ['train', 'bus', 'flight', 'ferry', 'car'];
  for (const [index, mode] of modes.entries()) {
    const type = ['node', 'way', 'relation'][index % 3], id = String(index + 1);
    const input = departureFixture({ mode, id: `osm-${type}-${id}`, sourceUrl: `https://www.openstreetmap.org/${type}/${id}`, name: '  출발 장소  ', address: index ? '' : '  서울특별시  ' });
    const result = app.TravelPlanner.createItinerary({ city, startDate: base.startDate, dayCount: 1, departure: input });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.departure.mode, mode);
    assert.equal(result.departure.name, '출발 장소');
    assert.equal(result.departure.address, index ? '' : '서울특별시');
    assert.notEqual(result.departure, input, 'metadata is copied instead of retaining a mutable caller reference');
    assert.deepEqual(timeline(result), timeline(base), 'origin metadata must not invent transit events or durations');
    input.name = 'changed after creation';
    assert.equal(result.departure.name, '출발 장소');
  }
});

test('invalid departure fields, coordinates and mismatched source URLs are rejected without mutation', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1, departure: departureFixture() });
  const snapshot = plain(original);
  const invalid = [
    false, [], {}, departureFixture({ mode: 'unknown-mode' }), departureFixture({ id: 'osm-node-0' }),
    departureFixture({ id: 'osm-node-001' }), departureFixture({ id: 'node-123456' }), departureFixture({ id: 123456 }),
    departureFixture({ id: 'osm-way-123456' }), departureFixture({ source: 'other' }),
    departureFixture({ sourceUrl: 'http://www.openstreetmap.org/node/123456' }),
    departureFixture({ sourceUrl: 'https://openstreetmap.org/node/123456' }),
    departureFixture({ sourceUrl: 'https://www.openstreetmap.org.evil.test/node/123456' }),
    departureFixture({ sourceUrl: 'https://www.openstreetmap.org/node/654321' }),
    departureFixture({ sourceUrl: 'https://www.openstreetmap.org/node/123456?test=1' }),
    departureFixture({ sourceUrl: 'https://www.openstreetmap.org/node/123456/' }),
    departureFixture({ sourceUrl: 'javascript:alert(1)' }), departureFixture({ name: '  ' }),
    departureFixture({ name: 'x'.repeat(121) }), departureFixture({ address: null }), departureFixture({ address: 'x'.repeat(301) }),
    departureFixture({ latitude: 32.99 }), departureFixture({ latitude: 39.51 }),
    departureFixture({ longitude: 123.99 }), departureFixture({ longitude: 132.01 }),
    departureFixture({ latitude: NaN }), departureFixture({ longitude: Infinity }), departureFixture({ latitude: '37.55' })
  ];
  for (const departure of invalid) {
    const created = app.TravelPlanner.createItinerary({ city, startDate: original.startDate, dayCount: 1, departure });
    assert.equal(created.ok, false, JSON.stringify(departure));
    const changed = app.TravelPlanner.setDeparture({ city, itinerary: original, departure });
    assert.equal(changed.ok, false, JSON.stringify(departure));
  }
  assert.deepEqual(plain(original), snapshot);
});

test('selecting and clearing an origin preserves manual edits and all calculated timeline values', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayStarts: { 0: '10:15', 1: '07:30' }, eventEdits: { 0: { 'free-1': { title: '나만의 야경', description: '사진 찍기', duration: 180 } }, 1: { lunch: { title: '특별한 점심' } } } });
  const input = departureFixture({ mode: 'bus' });
  const selected = app.TravelPlanner.setDeparture({ city, itinerary: original, departure: input });
  assert.equal(selected.ok, true, selected.reason);
  assert.deepEqual(timeline(selected.itinerary), timeline(original));
  assert.deepEqual(plain(selected.itinerary.dayStarts), plain(original.dayStarts));
  assert.deepEqual(plain(selected.itinerary.eventEdits), plain(original.eventEdits));
  assert.deepEqual(plain(selected.itinerary.departure), input);
  assert.notEqual(selected.itinerary.departure, input);
  assert.equal(original.departure, null);
  const cleared = app.TravelPlanner.setDeparture({ city, itinerary: selected.itinerary, departure: null });
  assert.equal(cleared.ok, true, cleared.reason);
  assert.equal(cleared.itinerary.departure, null);
  assert.deepEqual(timeline(cleared.itinerary), timeline(original));
  const tampered = { ...original, eventEdits: { 0: { unknown: { duration: 20 } } } };
  assert.equal(app.TravelPlanner.setDeparture({ city, itinerary: tampered, departure: input }).ok, false, 'origin updates still verify the complete saved itinerary');
});

test('event edits, departure clock changes, place replacements and area swaps retain copied origin metadata', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 3, departure: departureFixture() });
  const event = app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'rest', title: '충분한 휴식', duration: 90 });
  assert.equal(event.ok, true);
  const clock = app.TravelPlanner.setDayStart({ city, itinerary: event.itinerary, dayIndex: 0, startTime: '11:30' });
  assert.equal(clock.ok, true);
  const placeId = visitIds(clock.itinerary)[0][0];
  const alternative = app.TravelPlanner.getAlternatives({ city, itinerary: clock.itinerary, dayIndex: 0, placeId })[0];
  const place = app.TravelPlanner.replacePlace({ city, itinerary: clock.itinerary, dayIndex: 0, placeId, replacementId: alternative.id });
  assert.equal(place.ok, true);
  const swapped = app.TravelPlanner.changeDayArea({ city, itinerary: place.itinerary, dayIndex: 0, areaId: original.days[1].areaId });
  assert.equal(swapped.ok, true);
  const changed = app.TravelPlanner.changeDayArea({ city, itinerary: original, dayIndex: 0, areaId: city.areas[3].id });
  assert.equal(changed.ok, true);
  for (const result of [event, clock, place, swapped, changed]) {
    assert.deepEqual(plain(result.itinerary.departure), plain(original.departure));
    assert.notEqual(result.itinerary.departure, original.departure);
  }
});

test('origin metadata persists through JSON rebuild and absent legacy values normalize to null', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2, departure: departureFixture({ mode: 'ferry' }),
    dayStarts: { 0: '12:00' }, eventEdits: { 0: { 'free-0': { title: '우리만의 시간', duration: 100 } } } });
  const saved = plain(original), selections = Object.fromEntries(visitIds(saved).map((ids, index) => [index, ids]));
  const result = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount,
    dayAreaIds: saved.dayAreaIds, selections, dayStarts: saved.dayStarts, eventEdits: saved.eventEdits, departure: saved.departure });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(plain(result.departure), saved.departure);
  assert.deepEqual(plain(result.days), saved.days);
  assert.notEqual(result.departure, saved.departure);
  for (const departure of [undefined, null]) {
    const legacy = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount, departure });
    assert.equal(legacy.ok, true);
    assert.equal(legacy.departure, null);
  }
});

test('early departure labels meals by their calculated clock time without inserting waits', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const result = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1, dayStarts: { 0: '05:00' } });
  assert.equal(result.ok, true, result.reason);
  const first = result.days[0].events.find(event => event.id === 'lunch');
  const second = result.days[0].events.find(event => event.id === 'dinner');
  assert.equal(first.startLabel, '07:45');
  assert.equal(first.meal, '아침 식사');
  assert.equal(first.title, '아침 식사');
  assert.match(first.description, /아침 식사/);
  assert.equal(second.startLabel, '11:30');
  assert.equal(second.meal, '점심 식사');
  assert.equal(second.title, '점심 식사');
  assertSequential(result.days[0]);
  assert.equal(result.days[0].events.find(event => event.id === 'free-1').description, '산책이나 카페 방문 등, 내 마음대로 보내는 시간');
});

test('departure and duration changes recalculate meal captions using actual local time, including overnight', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1, dayStarts: { 0: '06:30' } });
  assert.equal(original.days[0].events.find(event => event.id === 'lunch').meal, '아침 식사');
  const longer = app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'free-0', duration: 150 });
  assert.equal(longer.ok, true, longer.reason);
  const changedMeal = longer.itinerary.days[0].events.find(event => event.id === 'lunch');
  assert.equal(changedMeal.startLabel, '10:15');
  assert.equal(changedMeal.title, '점심 식사');
  assert.equal(changedMeal.start, original.days[0].events.find(event => event.id === 'lunch').start + 60);
  const later = app.TravelPlanner.setDayStart({ city, itinerary: original, dayIndex: 0, startTime: '14:30' });
  assert.equal(later.ok, true);
  assert.equal(later.itinerary.days[0].events.find(event => event.id === 'lunch').title, '저녁 식사');
  assert.equal(later.itinerary.days[0].events.find(event => event.id === 'dinner').title, '늦은 식사');
  assert.ok(later.itinerary.days[0].end >= 24 * 60, 'meal naming adds no finishing cutoff');
  const overnight = app.TravelPlanner.setDayStart({ city, itinerary: original, dayIndex: 0, startTime: '19:00' });
  assert.equal(overnight.ok, true);
  assert.equal(overnight.itinerary.days[0].events.find(event => event.id === 'lunch').title, '늦은 식사');
  const nextMeal = overnight.itinerary.days[0].events.find(event => event.id === 'dinner');
  assert.match(nextMeal.startLabel, /^다음 날 /);
  assert.equal(nextMeal.title, '아침 식사');
  for (const result of [longer, later, overnight]) assertSequential(result.itinerary.days[0]);
});

test('custom meal titles and descriptions take precedence over automatic clock-based captions', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1, dayStarts: { 0: '05:00' },
    eventEdits: { 0: { lunch: { title: '예약한 식당', description: '창가 자리에서 식사' }, dinner: { title: '친구와 만남', description: '' } } } });
  const changed = app.TravelPlanner.setDayStart({ city, itinerary: original, dayIndex: 0, startTime: '14:30' });
  assert.equal(changed.ok, true, changed.reason);
  const first = changed.itinerary.days[0].events.find(event => event.id === 'lunch');
  assert.equal(first.meal, '저녁 식사');
  assert.equal(first.title, '예약한 식당');
  assert.equal(first.description, '창가 자리에서 식사');
  const second = changed.itinerary.days[0].events.find(event => event.id === 'dinner');
  assert.equal(second.meal, '늦은 식사');
  assert.equal(second.title, '친구와 만남');
  assert.equal(second.description, '');
  assertSequential(changed.itinerary.days[0]);
});

test('each calendar day can keep a different origin mode without changing the local timeline', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const dayDepartures = Object.fromEntries(['train', 'bus', 'flight', 'ferry', 'car'].map((mode, index) => [index,
    departureFixture({ mode, id: `osm-node-${index + 1}`, name: `${mode} 출발지`, sourceUrl: `https://www.openstreetmap.org/node/${index + 1}` })]));
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 5 });
  const result = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 5, dayDepartures });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(plain(result.dayDepartures), dayDepartures);
  assert.deepEqual(timeline(result), timeline(original));
  for (let index = 0; index < 5; index++) {
    assert.deepEqual(plain(result.days[index].departure), dayDepartures[index]);
    assert.notEqual(result.dayDepartures[index], dayDepartures[index]);
  }
  assert.equal(result.departure, result.dayDepartures[0], 'legacy alias follows the normalized first day');
  dayDepartures[1].name = 'caller changed later';
  assert.equal(result.dayDepartures[1].name, 'bus 출발지');
});

test('legacy departure migrates only to day zero, while explicit null takes precedence', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const departure = departureFixture();
  const migrated = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 3, departure });
  assert.equal(migrated.ok, true);
  assert.deepEqual(plain(migrated.dayDepartures), { 0: departure, 1: null, 2: null });
  assert.equal(migrated.days[1].departure, null);
  const cleared = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 3, departure, dayDepartures: { 0: null } });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.departure, null);
  assert.deepEqual(plain(cleared.dayDepartures), { 0: null, 1: null, 2: null });
  const legacyWithoutOrigin = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2 });
  assert.deepEqual(plain(legacyWithoutOrigin.dayDepartures), { 0: null, 1: null });
  assert.equal(legacyWithoutOrigin.departure, null);
});

test('invalid per-day origins and indices are rejected without modifying a saved itinerary', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2, dayDepartures: { 0: departureFixture() } });
  const snapshot = plain(original);
  const invalidMaps = [null, [], 'wrong', { 2: null }, { '-1': null }, { '01': null }, { bogus: null },
    { 0: false }, { 0: {} }, { 0: undefined }, { 1: departureFixture({ latitude: 0 }) },
    { 1: departureFixture({ id: 'osm-way-123456' }) }];
  for (const dayDepartures of invalidMaps) {
    assert.equal(app.TravelPlanner.createItinerary({ city, startDate: original.startDate, dayCount: 2, dayDepartures }).ok, false);
  }
  for (const dayIndex of [-1, 2, 0.5, '0', undefined]) {
    assert.equal(app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex, departure: null }).ok, false);
  }
  assert.equal(app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex: 1, departure: departureFixture({ sourceUrl: 'https://wrong.test/' }) }).ok, false);
  assert.deepEqual(plain(original), snapshot);
});

test('setting or clearing one day origin preserves other dates, manual edits and clock values', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 3,
    dayStarts: { 0: '05:00', 1: '11:30' }, eventEdits: { 1: { 'free-0': { title: '나만의 방문', duration: 150 } } },
    dayDepartures: { 0: departureFixture(), 1: departureFixture({ mode: 'bus' }), 2: departureFixture({ mode: 'flight' }) } });
  const cleared = app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex: 1, departure: null });
  assert.equal(cleared.ok, true, cleared.reason);
  assert.equal(cleared.itinerary.dayDepartures[1], null);
  assert.equal(cleared.itinerary.days[1].departure, null);
  assert.deepEqual(plain(cleared.itinerary.dayDepartures[0]), plain(original.dayDepartures[0]));
  assert.deepEqual(plain(cleared.itinerary.dayDepartures[2]), plain(original.dayDepartures[2]));
  assert.deepEqual(timeline(cleared.itinerary), timeline(original));
  assert.deepEqual(plain(cleared.itinerary.eventEdits), plain(original.eventEdits));
  const changed = app.TravelPlanner.setDeparture({ city, itinerary: original, departure: departureFixture({ mode: 'car', name: '첫날 새 출발지' }) });
  assert.equal(changed.ok, true);
  assert.equal(changed.itinerary.dayDepartures[0].mode, 'car');
  assert.equal(changed.itinerary.departure.name, '첫날 새 출발지');
  assert.deepEqual(plain(changed.itinerary.dayDepartures[1]), plain(original.dayDepartures[1]));
  const clearFirst = app.TravelPlanner.setDeparture({ city, itinerary: changed.itinerary, departure: null });
  assert.equal(clearFirst.itinerary.departure, null);
  assert.equal(clearFirst.itinerary.dayDepartures[0], null);
  assert.ok(original.dayDepartures[1], 'the previous snapshot remains unchanged');
});

test('all itinerary edits retain origins by calendar date and JSON rebuild restores the full origin map', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 3,
    dayDepartures: { 0: departureFixture(), 1: departureFixture({ mode: 'ferry', name: '둘째 날 항구' }), 2: departureFixture({ mode: 'car', name: '셋째 날 숙소' }) } });
  const edited = app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 1, eventId: 'free-1', title: '바닷가 산책', duration: 160 });
  const started = app.TravelPlanner.setDayStart({ city, itinerary: edited.itinerary, dayIndex: 1, startTime: '07:00' });
  const placeId = visitIds(started.itinerary)[1][0];
  const candidate = app.TravelPlanner.getAlternatives({ city, itinerary: started.itinerary, dayIndex: 1, placeId })[0];
  const replaced = app.TravelPlanner.replacePlace({ city, itinerary: started.itinerary, dayIndex: 1, placeId, replacementId: candidate.id });
  const swapped = app.TravelPlanner.changeDayArea({ city, itinerary: replaced.itinerary, dayIndex: 0, areaId: original.days[1].areaId });
  const changed = app.TravelPlanner.changeDayArea({ city, itinerary: swapped.itinerary, dayIndex: 2, areaId: city.areas[3].id });
  for (const result of [edited, started, replaced, swapped, changed]) {
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(plain(result.itinerary.dayDepartures), plain(original.dayDepartures));
    assert.notEqual(result.itinerary.dayDepartures, original.dayDepartures);
    for (let index = 0; index < 3; index++) {
      assert.notEqual(result.itinerary.dayDepartures[index], original.dayDepartures[index]);
      assert.deepEqual(plain(result.itinerary.days[index].departure), plain(original.days[index].departure));
    }
  }
  const saved = plain(changed.itinerary), selections = Object.fromEntries(visitIds(saved).map((ids, index) => [index, ids]));
  const restored = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount,
    dayAreaIds: saved.dayAreaIds, selections, dayStarts: saved.dayStarts, eventEdits: saved.eventEdits, departure: saved.departure, dayDepartures: saved.dayDepartures });
  assert.equal(restored.ok, true, restored.reason);
  assert.deepEqual(plain(restored.days), saved.days);
  assert.deepEqual(plain(restored.dayDepartures), saved.dayDepartures);
  assert.notEqual(restored.dayDepartures, saved.dayDepartures);
});

test('the first timeline row states when and where to depart, with zero travel time explicitly pending', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const selected = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1, dayDepartures: { 0: departureFixture() } });
  const day = selected.days[0], first = day.events[0];
  assert.equal(first.id, 'departure');
  assert.equal(first.type, 'departure');
  assert.equal(first.title, '서울역에서 출발');
  assert.equal(first.description, departureFixture().address);
  assert.deepEqual(plain(first.departure), departureFixture());
  assert.equal(first.duration, 0);
  assert.equal(first.startLabel, '09:00');
  assert.equal(first.endLabel, '09:00');
  assert.equal(day.events[1].id, 'place-0');
  assert.equal(day.needsTravelTime, true);
  assert.equal(day.timesProvisional, true, 'zero means unentered travel time, not an API estimate');
  const unselected = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  assert.equal(unselected.days[0].events[0].departure, null);
  assert.equal(unselected.days[0].events[0].title, '출발지를 선택해 주세요');
  assert.equal(unselected.days[0].needsTravelTime, true);
  assert.equal(unselected.days[0].timesProvisional, true);
  assert.equal(unselected.days[0].events.filter(event => event.type === 'place').length, 3);
  assertSequential(day);
  assertSequential(unselected.days[0]);
});

test('user-entered origin travel time shifts every subsequent event and can return to pending zero', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayDepartures: { 0: departureFixture({ mode: 'car' }) }, dayStarts: { 0: '05:00' }, eventEdits: { 0: { 'free-1': { title: '예약한 공연', duration: 180 } } } });
  const result = app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'departure', duration: 60 });
  assert.equal(result.ok, true, result.reason);
  const day = result.itinerary.days[0];
  assert.equal(day.events[0].startLabel, '05:00');
  assert.equal(day.events[0].endLabel, '06:00');
  assert.equal(day.events[1].startLabel, '06:00');
  for (let index = 1; index < day.events.length; index++) {
    assert.equal(day.events[index].start, original.days[0].events[index].start + 60);
    assert.equal(day.events[index].end, original.days[0].events[index].end + 60);
    assert.equal(day.events[index].duration, original.days[0].events[index].duration);
  }
  assert.equal(day.end, original.days[0].end + 60);
  assert.equal(day.needsTravelTime, true);
  assert.equal(day.timesProvisional, true);
  assert.deepEqual(plain(result.itinerary.days[1]), plain(original.days[1]));
  assert.equal(result.itinerary.eventEdits[0]['free-1'].title, '예약한 공연');
  const pending = app.TravelPlanner.updateEvent({ city, itinerary: result.itinerary, dayIndex: 0, eventId: 'departure', duration: 0 });
  assert.equal(pending.ok, true);
  assert.equal(pending.itinerary.days[0].needsTravelTime, true);
  assert.equal(pending.itinerary.days[0].end, original.days[0].end);
  assertSequential(day);
});

test('zero departure time is valid while invalid travel values leave the schedule untouched', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1, departure: departureFixture() });
  const snapshot = plain(original);
  for (const duration of [-1, 4321, 0.5, '60', null]) {
    assert.equal(app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'departure', duration }).ok, false);
  }
  assert.equal(app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'lunch', duration: 0 }).ok, false);
  assert.equal(app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'place-0', duration: 0 }).ok, false);
  assert.equal(app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'departure', duration: 0 }).ok, true);
  assert.deepEqual(plain(original), snapshot);
});

test('changing origin identity, mode or clearing it resets only that origin travel edit', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayDepartures: { 0: departureFixture(), 1: departureFixture({ mode: 'bus' }) }, dayStarts: { 0: '05:30' },
    eventEdits: { 0: { departure: { duration: 90, description: '기존 출발지 메모' }, rest: { title: '긴 휴식', duration: 60 } }, 1: { departure: { duration: 30 } } } });
  for (const departure of [null, departureFixture({ mode: 'car' }), departureFixture({ id: 'osm-node-999', sourceUrl: 'https://www.openstreetmap.org/node/999' })]) {
    const result = app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex: 0, departure });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.itinerary.eventEdits[0].departure, undefined);
    assert.equal(result.itinerary.days[0].events[0].duration, 0);
    assert.deepEqual(plain(result.itinerary.eventEdits[0].rest), plain(original.eventEdits[0].rest));
    assert.deepEqual(plain(result.itinerary.days[1]), plain(original.days[1]));
    assert.deepEqual(plain(result.itinerary.dayStarts), plain(original.dayStarts));
  }
  const refreshed = app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex: 0, departure: departureFixture({ name: '서울역 새 표기', address: '갱신된 주소' }) });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.itinerary.days[0].events[0].duration, 90);
  assert.equal(refreshed.itinerary.days[0].events[0].title, '서울역 새 표기에서 출발');
  assert.equal(refreshed.itinerary.days[0].events[0].description, '기존 출발지 메모');
  assert.equal(original.days[0].events[0].duration, 90);
});

test('origin row travel times and clock inputs survive JSON rebuild and area changes reset stale travel only on affected days', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 3,
    dayDepartures: { 0: departureFixture(), 1: departureFixture({ mode: 'bus' }), 2: departureFixture({ mode: 'car' }) },
    dayStarts: { 0: '07:15', 1: '11:00' }, eventEdits: { 0: { departure: { duration: 60 } }, 1: { departure: { duration: 90 } }, 2: { departure: { duration: 40 } } } });
  const saved = plain(original), selections = Object.fromEntries(visitIds(saved).map((ids, index) => [index, ids]));
  const restored = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount,
    dayAreaIds: saved.dayAreaIds, selections, dayStarts: saved.dayStarts, eventEdits: saved.eventEdits, dayDepartures: saved.dayDepartures });
  assert.equal(restored.ok, true, restored.reason);
  assert.deepEqual(plain(restored.days), saved.days);
  const shifted = app.TravelPlanner.setDayStart({ city, itinerary: restored, dayIndex: 0, startTime: '23:00' });
  assert.equal(shifted.ok, true);
  assert.equal(shifted.itinerary.days[0].events[0].duration, 60);
  assert.equal(shifted.itinerary.days[0].events[1].startLabel, '다음 날 00:00');
  const swapped = app.TravelPlanner.changeDayArea({ city, itinerary: restored, dayIndex: 0, areaId: restored.days[1].areaId });
  assert.equal(swapped.ok, true);
  assert.equal(swapped.itinerary.days[0].events[0].duration, 0);
  assert.equal(swapped.itinerary.days[1].events[0].duration, 0);
  assert.equal(swapped.itinerary.days[2].events[0].duration, 40);
  assert.deepEqual(plain(swapped.itinerary.dayDepartures), saved.dayDepartures);
  assert.deepEqual(plain(swapped.itinerary.dayStarts), saved.dayStarts);
});

test('finish is always the last row at the actual calculated end, including provisional schedules', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const result = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayDepartures: { 1: departureFixture() } });
  assert.equal(result.ok, true);
  for (const day of result.days) {
    const finish = day.events.at(-1), preceding = day.events.at(-2);
    assert.equal(finish.id, 'finish');
    assert.equal(finish.type, 'finish');
    assert.equal(finish.title, '오늘 여행 마무리');
    assert.equal(finish.description, '오늘의 길을 돌아보며, 편안하게 쉬어가요.');
    assert.equal(finish.duration, 0);
    assert.equal(finish.start, preceding.end);
    assert.equal(finish.end, preceding.end);
    assert.equal(finish.end, day.end);
    assert.equal(finish.startLabel, finish.endLabel);
    assert.equal(day.timesProvisional, true);
    assertSequential(day);
  }
});

test('a custom ninety-minute finish changes only the final row and supports overnight ending labels', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2, dayStarts: { 0: '14:30' } });
  const snapshot = plain(original);
  const result = app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'finish',
    title: '숙소로 돌아가기', description: '편의점에 들러 간식 사기', duration: 90 });
  assert.equal(result.ok, true, result.reason);
  const finish = result.itinerary.days[0].events.at(-1);
  assert.equal(finish.title, '숙소로 돌아가기');
  assert.equal(finish.description, '편의점에 들러 간식 사기');
  assert.equal(finish.duration, 90);
  assert.equal(finish.start, original.days[0].end);
  assert.equal(result.itinerary.days[0].end, original.days[0].end + 90);
  assert.match(finish.endLabel, /^다음 날 /);
  assert.deepEqual(plain(result.itinerary.days[0].events.slice(0, -1)), plain(original.days[0].events.slice(0, -1)));
  assert.deepEqual(plain(result.itinerary.days[1]), plain(original.days[1]));
  assert.deepEqual(plain(original), snapshot);
  for (const duration of [-1, 721, 1.5, '90', null]) {
    assert.equal(app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'finish', duration }).ok, false);
  }
  const marker = app.TravelPlanner.updateEvent({ city, itinerary: result.itinerary, dayIndex: 0, eventId: 'finish', duration: 0 });
  assert.equal(marker.ok, true);
  assert.equal(marker.itinerary.days[0].end, original.days[0].end);
  assertSequential(result.itinerary.days[0]);
});

test('finish overrides survive JSON rebuild, other event edits, departure changes and place replacements', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayDepartures: { 0: departureFixture() }, eventEdits: { 0: { departure: { duration: 60 }, finish: { title: '숙소로 돌아가기', description: '짐 정리하기', duration: 90 } } } });
  const saved = plain(original), selections = Object.fromEntries(visitIds(saved).map((ids, index) => [index, ids]));
  const restored = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount,
    dayAreaIds: saved.dayAreaIds, selections, dayStarts: saved.dayStarts, dayDepartures: saved.dayDepartures, eventEdits: saved.eventEdits });
  assert.equal(restored.ok, true);
  assert.deepEqual(plain(restored.days), saved.days);
  const event = app.TravelPlanner.updateEvent({ city, itinerary: restored, dayIndex: 0, eventId: 'rest', duration: 80 });
  const start = app.TravelPlanner.setDayStart({ city, itinerary: event.itinerary, dayIndex: 0, startTime: '11:00' });
  const origin = app.TravelPlanner.setDayDeparture({ city, itinerary: start.itinerary, dayIndex: 0, departure: departureFixture({ mode: 'car' }) });
  assert.equal(origin.itinerary.eventEdits[0].departure, undefined);
  const placeId = visitIds(origin.itinerary)[0][0];
  const alternative = app.TravelPlanner.getAlternatives({ city, itinerary: origin.itinerary, dayIndex: 0, placeId })[0];
  const replaced = app.TravelPlanner.replacePlace({ city, itinerary: origin.itinerary, dayIndex: 0, placeId, replacementId: alternative.id });
  for (const result of [event, start, origin, replaced]) {
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(plain(result.itinerary.eventEdits[0].finish), saved.eventEdits[0].finish);
    assert.equal(result.itinerary.days[0].events.at(-1).id, 'finish');
    assert.equal(result.itinerary.days[0].events.at(-1).duration, 90);
    assertSequential(result.itinerary.days[0]);
  }
  const changed = app.TravelPlanner.changeDayArea({ city, itinerary: replaced.itinerary, dayIndex: 0, areaId: city.areas[2].id });
  assert.equal(changed.ok, true);
  assert.equal(changed.itinerary.eventEdits[0], undefined);
  assert.equal(changed.itinerary.days[0].events.at(-1).title, '오늘 여행 마무리');
  assert.equal(changed.itinerary.days[0].events.at(-1).duration, 0);
});

test('public transport arrivals insert a fixed marker and a separate first-attraction travel leg for all four modes', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  for (const mode of ['train', 'bus', 'flight', 'ferry']) {
    const origin = departureFixture({ mode }), arrival = arrivalFixture({ mode });
    const result = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
      dayStarts: { 0: '23:00' }, dayDepartures: { 0: origin }, dayArrivals: { 0: arrival },
      eventEdits: { 0: { departure: { duration: 120 }, 'arrival-transfer': { duration: 30 } } } });
    assert.equal(result.ok, true, result.reason);
    const day = result.days[0];
    assert.deepEqual(plain(day.events.slice(0, 4).map(event => event.id)), ['departure', 'arrival', 'arrival-transfer', 'place-0']);
    assert.equal(day.events[0].startLabel, '23:00');
    assert.equal(day.events[0].endLabel, '다음 날 01:00');
    assert.equal(day.events[1].title, '도착역 도착');
    assert.equal(day.events[1].type, 'arrival');
    assert.equal(day.events[1].duration, 0);
    assert.equal(day.events[1].startLabel, day.events[1].endLabel);
    assert.equal(day.events[2].title, '첫 관광지로 이동');
    assert.match(day.events[2].description, /도착역 → /);
    assert.equal(day.events[3].startLabel, '다음 날 01:30');
    assert.equal(day.needsTravelTime, true);
    assert.equal(day.timesProvisional, true);
    assert.equal(day.events.filter(event => event.type === 'place').length, 3);
    assert.deepEqual(plain(result.dayArrivals[0]), arrival);
    assert.notEqual(result.dayArrivals[0], arrival);
    assert.equal(app.TravelPlanner.updateEvent({ city, itinerary: result, dayIndex: 0, eventId: 'arrival', duration: 1 }).ok, false);
    assertSequential(day);
  }
});

test('legacy public transport timing stays intact without an arrival but remains provisional until both legs are entered', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const legacy = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
    departure: departureFixture(), eventEdits: { 0: { departure: { duration: 60 } } } });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.days[0].events.length, 12);
  assert.equal(legacy.days[0].events[1].id, 'place-0');
  assert.equal(legacy.days[0].events[1].startLabel, '10:00');
  assert.equal(legacy.dayArrivals[0], null);
  assert.equal(legacy.days[0].needsTravelTime, true);
  assert.equal(legacy.days[0].timesProvisional, true);
  const added = app.TravelPlanner.setDayArrival({ city, itinerary: legacy, dayIndex: 0, arrival: arrivalFixture() });
  assert.equal(added.ok, true);
  assert.equal(added.itinerary.days[0].events[0].duration, 0, 'old total-to-attraction time cannot become main transport time');
  assert.equal(added.itinerary.days[0].events[2].duration, 0);
  const mainOnly = app.TravelPlanner.updateEvent({ city, itinerary: added.itinerary, dayIndex: 0, eventId: 'departure', duration: 60 });
  assert.equal(mainOnly.itinerary.days[0].needsTravelTime, true);
  const complete = app.TravelPlanner.updateEvent({ city, itinerary: mainOnly.itinerary, dayIndex: 0, eventId: 'arrival-transfer', duration: 15 });
  assert.equal(complete.ok, true);
  assert.equal(complete.itinerary.days[0].needsTravelTime, true);
  const car = app.TravelPlanner.createItinerary({ city, startDate: legacy.startDate, dayCount: 1,
    departure: departureFixture({ mode: 'car' }), eventEdits: { 0: { departure: { duration: 60 } } } });
  assert.equal(car.ok, true);
  assert.equal(car.days[0].events.length, 12);
  assert.equal(car.days[0].needsTravelTime, true);
});

test('invalid arrival maps, mode combinations and marker edits fail without mutating valid data', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayDepartures: { 0: departureFixture() }, dayArrivals: { 0: arrivalFixture() } });
  const snapshot = plain(original);
  const maps = [null, [], { 2: null }, { '-1': null }, { '01': null }, { 0: undefined }, { 0: false },
    { 0: arrivalFixture({ mode: 'flight' }) }, { 0: arrivalFixture({ latitude: 32 }) }, { 0: arrivalFixture({ id: 'osm-way-789012' }) }];
  for (const dayArrivals of maps) {
    assert.equal(app.TravelPlanner.createItinerary({ city, startDate: original.startDate, dayCount: 2,
      dayDepartures: original.dayDepartures, dayArrivals }).ok, false);
  }
  for (const departure of [null, departureFixture({ mode: 'car' })]) {
    assert.equal(app.TravelPlanner.createItinerary({ city, startDate: original.startDate, dayCount: 1,
      departure, dayArrivals: { 0: arrivalFixture({ mode: departure?.mode || 'train' }) } }).ok, false);
  }
  for (const dayIndex of [-1, 2, 0.5, '0']) {
    assert.equal(app.TravelPlanner.setDayArrival({ city, itinerary: original, dayIndex, arrival: null }).ok, false);
  }
  assert.equal(app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'arrival', title: 'editable marker' }).ok, false);
  for (const duration of [-1, 721, 0.5]) {
    assert.equal(app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'arrival-transfer', duration }).ok, false);
  }
  assert.equal(app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 1, eventId: 'arrival-transfer', duration: 15 }).ok, false);
  assert.deepEqual(plain(original), snapshot);
});

test('arrival identity changes reset both travel edits, while refreshes and unrelated day edits remain intact', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayDepartures: { 0: departureFixture() }, dayArrivals: { 0: arrivalFixture() }, dayStarts: { 0: '07:30' },
    eventEdits: { 0: { departure: { duration: 120 }, 'arrival-transfer': { duration: 25 }, finish: { title: '숙소 체크인', duration: 60 } } } });
  const refreshed = app.TravelPlanner.setDayArrival({ city, itinerary: original, dayIndex: 0,
    arrival: arrivalFixture({ name: '갱신된 도착역', address: '주소 갱신' }) });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.itinerary.eventEdits[0].departure.duration, 120);
  assert.equal(refreshed.itinerary.eventEdits[0]['arrival-transfer'].duration, 25);
  assert.equal(refreshed.itinerary.days[0].events[1].title, '갱신된 도착역 도착');
  for (const arrival of [null, arrivalFixture({ id: 'osm-node-999', sourceUrl: 'https://www.openstreetmap.org/node/999' })]) {
    const changed = app.TravelPlanner.setDayArrival({ city, itinerary: original, dayIndex: 0, arrival });
    assert.equal(changed.ok, true, changed.reason);
    assert.equal(changed.itinerary.eventEdits[0].departure, undefined);
    assert.equal(changed.itinerary.eventEdits[0]['arrival-transfer'], undefined);
    assert.deepEqual(plain(changed.itinerary.eventEdits[0].finish), plain(original.eventEdits[0].finish));
    assert.deepEqual(plain(changed.itinerary.dayStarts), plain(original.dayStarts));
    assert.deepEqual(plain(changed.itinerary.days[1]), plain(original.days[1]));
    assert.equal(changed.itinerary.days[0].events[0].duration, 0);
  }
});

test('origin ID changes keep the same-mode arrival leg, but mode changes and clearing remove it', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
    departure: departureFixture(), dayArrivals: { 0: arrivalFixture() },
    eventEdits: { 0: { departure: { duration: 120 }, 'arrival-transfer': { duration: 25 }, rest: { title: '쉬어 가기' } } } });
  const differentOrigin = app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex: 0,
    departure: departureFixture({ id: 'osm-node-111', sourceUrl: 'https://www.openstreetmap.org/node/111' }) });
  assert.equal(differentOrigin.ok, true);
  assert.deepEqual(plain(differentOrigin.itinerary.dayArrivals), plain(original.dayArrivals));
  assert.equal(differentOrigin.itinerary.eventEdits[0].departure, undefined);
  assert.equal(differentOrigin.itinerary.eventEdits[0]['arrival-transfer'].duration, 25);
  for (const departure of [null, departureFixture({ mode: 'car' }), departureFixture({ mode: 'bus' })]) {
    const changed = app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex: 0, departure });
    assert.equal(changed.ok, true, changed.reason);
    assert.equal(changed.itinerary.dayArrivals[0], null);
    assert.equal(changed.itinerary.days[0].events.some(event => event.id === 'arrival'), false);
    assert.equal(changed.itinerary.eventEdits[0].departure, undefined);
    assert.equal(changed.itinerary.eventEdits[0]['arrival-transfer'], undefined);
    assert.equal(changed.itinerary.eventEdits[0].rest.title, '쉬어 가기');
  }
});

test('area swaps retain main public transport time and calendar origins but reset local travel and edited visits', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 3,
    dayDepartures: { 0: departureFixture(), 1: departureFixture({ mode: 'bus' }), 2: departureFixture({ mode: 'car' }) },
    dayArrivals: { 0: arrivalFixture(), 1: arrivalFixture({ mode: 'bus' }) }, dayStarts: { 0: '07:00', 1: '11:00' },
    eventEdits: { 0: { departure: { duration: 120 }, 'arrival-transfer': { duration: 25 }, rest: { title: '첫날 메모' } },
      1: { departure: { duration: 90 }, 'arrival-transfer': { duration: 30 }, finish: { title: '둘째 날 마무리' } }, 2: { departure: { duration: 45 } } } });
  const result = app.TravelPlanner.changeDayArea({ city, itinerary: original, dayIndex: 0, areaId: original.days[1].areaId });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(plain(result.itinerary.dayArrivals), plain(original.dayArrivals));
  assert.deepEqual(plain(result.itinerary.dayDepartures), plain(original.dayDepartures));
  assert.deepEqual(plain(result.itinerary.dayStarts), plain(original.dayStarts));
  assert.deepEqual(plain(result.itinerary.eventEdits[0]), { departure: { duration: 120 } });
  assert.deepEqual(plain(result.itinerary.eventEdits[1]), { departure: { duration: 90 } });
  assert.deepEqual(plain(result.itinerary.days[2]), plain(original.days[2]));
  assert.equal(result.itinerary.days[0].events[2].duration, 0);
  assert.equal(result.itinerary.days[0].needsTravelTime, true);
  const replacementArea = app.TravelPlanner.changeDayArea({ city, itinerary: original, dayIndex: 0, areaId: city.areas[3].id });
  assert.equal(replacementArea.ok, true);
  assert.equal(replacementArea.itinerary.eventEdits[0].departure.duration, 120);
  assert.equal(replacementArea.itinerary.eventEdits[0]['arrival-transfer'], undefined);
});

test('only replacing the first tourist place clears arrival transfer time and preserves main transport', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
    departure: departureFixture(), dayArrivals: { 0: arrivalFixture() },
    eventEdits: { 0: { departure: { duration: 120 }, 'arrival-transfer': { duration: 25 }, finish: { title: '숙소로 돌아가기' } } } });
  for (const slot of [0, 1]) {
    const placeId = visitIds(original)[0][slot];
    const candidate = app.TravelPlanner.getAlternatives({ city, itinerary: original, dayIndex: 0, placeId })[0];
    const result = app.TravelPlanner.replacePlace({ city, itinerary: original, dayIndex: 0, placeId, replacementId: candidate.id });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.itinerary.eventEdits[0].departure.duration, 120);
    assert.equal(result.itinerary.days[0].events[2].duration, slot === 0 ? 0 : 25);
    assert.equal(result.itinerary.eventEdits[0].finish.title, '숙소로 돌아가기');
    if (slot === 0) assert.match(result.itinerary.days[0].events[2].description, new RegExp(candidate.name));
  }
});

test('arrival maps and both travel legs persist through JSON rebuild, edits and departure clock changes', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayStarts: { 0: '22:30' }, dayDepartures: { 0: departureFixture() }, dayArrivals: { 0: arrivalFixture() },
    eventEdits: { 0: { departure: { duration: 180 }, 'arrival-transfer': { duration: 45 }, finish: { title: '호텔로 이동', duration: 90 } } } });
  const saved = plain(original), selections = Object.fromEntries(visitIds(saved).map((ids, index) => [index, ids]));
  const restored = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount,
    dayAreaIds: saved.dayAreaIds, selections, dayStarts: saved.dayStarts, eventEdits: saved.eventEdits,
    dayDepartures: saved.dayDepartures, dayArrivals: saved.dayArrivals });
  assert.equal(restored.ok, true, restored.reason);
  assert.deepEqual(plain(restored.days), saved.days);
  assert.deepEqual(plain(restored.dayArrivals), saved.dayArrivals);
  assert.notEqual(restored.dayArrivals[0], saved.dayArrivals[0]);
  const edit = app.TravelPlanner.updateEvent({ city, itinerary: restored, dayIndex: 0, eventId: 'rest', duration: 60 });
  const clock = app.TravelPlanner.setDayStart({ city, itinerary: edit.itinerary, dayIndex: 0, startTime: '23:00' });
  assert.equal(clock.ok, true);
  assert.equal(clock.itinerary.days[0].events[1].startLabel, '다음 날 02:00');
  assert.equal(clock.itinerary.days[0].events[3].startLabel, '다음 날 02:45');
  assert.deepEqual(plain(clock.itinerary.dayArrivals), saved.dayArrivals);
  assert.equal(clock.itinerary.eventEdits[0].departure.duration, 180);
  assert.equal(clock.itinerary.eventEdits[0]['arrival-transfer'].duration, 45);
  assertSequential(clock.itinerary.days[0]);
});

test('local bus, subway, vehicle and walking modes including legacy aliases prohibit intercity arrival markers', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  for (const mode of ['local-bus', 'subway', 'rental-car', 'taxi', 'walk']) {
    assert.equal(app.TravelPlanner.requiresArrival(mode), false);
    const result = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
      dayDepartures: { 0: departureFixture({ mode, name: '둘째 날 숙소' }) }, eventEdits: { 0: { departure: { duration: 30 } } } });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.days[0].events[0].departure.mode, ['rental-car', 'taxi'].includes(mode) ? 'car' : mode);
    assert.equal(result.days[0].events[1].id, 'place-0');
    assert.equal(result.days[0].events[1].startLabel, '09:30');
    assert.equal(result.days[0].events.some(event => event.id === 'arrival'), false);
    assert.equal(result.days[0].needsTravelTime, true);
    assert.equal(result.days[0].timesProvisional, true);
    assert.equal(app.TravelPlanner.setDayArrival({ city, itinerary: result, dayIndex: 0, arrival: arrivalFixture({ mode }) }).ok, false);
    assert.equal(app.TravelPlanner.createItinerary({ city, startDate: result.startDate, dayCount: 1,
      dayDepartures: { 0: departureFixture({ mode }) }, dayArrivals: { 0: arrivalFixture({ mode }) } }).ok, false);
    assertSequential(result.days[0]);
  }
  for (const mode of ['train', 'bus', 'flight', 'ferry']) assert.equal(app.TravelPlanner.requiresArrival(mode), true);
  for (const mode of ['car', null, undefined, 'unknown-mode']) assert.equal(app.TravelPlanner.requiresArrival(mode), false);
});

test('a train arrival on day one and local bus from a hotel on day two persist independently', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayStarts: { 0: '07:00', 1: '10:00' }, dayDepartures: { 0: departureFixture(), 1: departureFixture({ mode: 'local-bus', name: '숙소' }) },
    dayArrivals: { 0: arrivalFixture() }, eventEdits: { 0: { departure: { duration: 120 }, 'arrival-transfer': { duration: 25 } },
      1: { departure: { duration: 30 }, finish: { title: '숙소 복귀', duration: 40 } } } });
  assert.equal(original.ok, true, original.reason);
  assert.deepEqual(plain(original.days[0].events.slice(0, 4).map(event => event.id)), ['departure', 'arrival', 'arrival-transfer', 'place-0']);
  assert.deepEqual(plain(original.days[1].events.slice(0, 2).map(event => event.id)), ['departure', 'place-0']);
  assert.equal(original.days[1].events[1].startLabel, '10:30');
  assert.ok(original.days.every(day => day.timesProvisional));
  const saved = plain(original), selections = Object.fromEntries(visitIds(saved).map((ids, index) => [index, ids]));
  const restored = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount,
    dayAreaIds: saved.dayAreaIds, selections, dayStarts: saved.dayStarts, dayDepartures: saved.dayDepartures,
    dayArrivals: saved.dayArrivals, eventEdits: saved.eventEdits });
  assert.equal(restored.ok, true);
  assert.deepEqual(plain(restored.days), saved.days);
  const clock = app.TravelPlanner.setDayStart({ city, itinerary: restored, dayIndex: 1, startTime: '11:00' });
  assert.equal(clock.itinerary.days[1].events[1].startLabel, '11:30');
  assert.deepEqual(plain(clock.itinerary.days[0]), saved.days[0]);
  const swapped = app.TravelPlanner.changeDayArea({ city, itinerary: restored, dayIndex: 0, areaId: restored.days[1].areaId });
  assert.equal(swapped.ok, true);
  assert.deepEqual(plain(swapped.itinerary.dayDepartures), saved.dayDepartures);
  assert.deepEqual(plain(swapped.itinerary.dayArrivals), saved.dayArrivals);
  assert.deepEqual(plain(swapped.itinerary.dayStarts), saved.dayStarts);
  assert.equal(swapped.itinerary.days[0].events[0].duration, 120, 'main train time survives a local area change');
  assert.equal(swapped.itinerary.days[1].events[0].duration, 0, 'local bus time must be re-entered for a new first place');
});

test('switching intercity transport to a rental car clears the arrival and travel estimates but keeps other edits', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    dayDepartures: { 0: departureFixture() }, dayArrivals: { 0: arrivalFixture() }, dayStarts: { 0: '08:30' },
    eventEdits: { 0: { departure: { duration: 120 }, 'arrival-transfer': { duration: 25 }, finish: { title: '호텔 체크인' } } } });
  const rental = app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex: 0, departure: departureFixture({ mode: 'rental-car' }) });
  assert.equal(rental.ok, true, rental.reason);
  assert.equal(rental.itinerary.dayArrivals[0], null);
  assert.equal(rental.itinerary.days[0].events[1].id, 'place-0');
  assert.equal(rental.itinerary.eventEdits[0].departure, undefined);
  assert.equal(rental.itinerary.eventEdits[0]['arrival-transfer'], undefined);
  assert.equal(rental.itinerary.eventEdits[0].finish.title, '호텔 체크인');
  assert.equal(rental.itinerary.dayStarts[0], '08:30');
  const timed = app.TravelPlanner.updateEvent({ city, itinerary: rental.itinerary, dayIndex: 0, eventId: 'departure', duration: 45 });
  assert.equal(timed.ok, true);
  assert.equal(timed.itinerary.days[0].events[1].startLabel, '09:15');
  assert.equal(timed.itinerary.days[0].timesProvisional, true);
  const subway = app.TravelPlanner.setDayDeparture({ city, itinerary: timed.itinerary, dayIndex: 0, departure: departureFixture({ mode: 'subway' }) });
  assert.equal(subway.ok, true);
  assert.equal(subway.itinerary.days[0].events[0].duration, 0);
  assert.equal(subway.itinerary.days[0].needsTravelTime, true);
  assert.deepEqual(plain(subway.itinerary.days[1]), plain(original.days[1]));
});

test('TAGO stops accept all official services with null coordinates and reject mixed providers or bus services', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  for (const service of Object.keys(tagoServices)) {
    const result = officialItinerary(app, city, service);
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(plain(result.dayDepartures[0]), tagoStop(service));
    assert.equal(result.dayDepartures[0].latitude, null);
    assert.equal(result.dayArrivals[0].service, service);
    assert.equal(result.dayTransports[0], null);
  }
  const invalidStops = [tagoStop('train', 'ORIGIN1', { mode: 'local-bus' }), tagoStop('train', 'ORIGIN1', { latitude: 37.5 }),
    tagoStop('train', 'ORIGIN1', { providerId: 'WRONG' }), tagoStop('train', 'ORIGIN1', { id: 'tago-train-WRONG' }),
    tagoStop('train', 'ORIGIN1', { sourceUrl: tagoStop('flight').sourceUrl }), tagoStop('train', 'ORIGIN1', { longitude: undefined })];
  for (const departure of invalidStops) {
    assert.equal(officialItinerary(app, city, 'train', { dayDepartures: { 0: departure } }).ok, false);
  }
  assert.equal(officialItinerary(app, city, 'train', { dayArrivals: { 0: arrivalFixture() } }).ok, false);
  assert.equal(officialItinerary(app, city, 'train', { dayDepartures: { 0: departureFixture() } }).ok, false);
  assert.equal(officialItinerary(app, city, 'express', { dayArrivals: { 0: tagoStop('intercity', 'DEST1') } }).ok, false);
});

test('selecting an official transport atomically applies departure clock, duration and copied trip metadata', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = officialItinerary(app, city, 'train', { dayStarts: { 0: '05:00' },
    eventEdits: { 0: { departure: { duration: 60, description: '승차 메모' }, 'arrival-transfer': { duration: 25 }, finish: { title: '호텔 체크인' } } } });
  const snapshot = plain(original), input = transportFixture();
  const result = app.TravelPlanner.setDayTransport({ city, itinerary: original, dayIndex: 0, transport: input });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.itinerary.dayStarts[0], '08:30');
  assert.equal(result.itinerary.eventEdits[0].departure.duration, 150);
  assert.equal(result.itinerary.eventEdits[0].departure.description, '승차 메모');
  assert.equal(result.itinerary.days[0].events[1].startLabel, '11:00');
  assert.equal(result.itinerary.days[0].events[3].startLabel, '11:25');
  assert.equal(result.itinerary.days[0].timesProvisional, true);
  assert.deepEqual(plain(result.itinerary.dayTransports[0]), input);
  assert.equal(result.itinerary.days[0].transport, result.itinerary.dayTransports[0]);
  assert.notEqual(result.itinerary.dayTransports[0], input);
  assert.deepEqual(plain(result.itinerary.days[1]), plain(original.days[1]));
  assert.deepEqual(plain(original), snapshot);
  input.tripNo = 'caller changed';
  assert.equal(result.itinerary.days[0].transport.tripNo, 'T101');
  const cleared = app.TravelPlanner.setDayTransport({ city, itinerary: result.itinerary, dayIndex: 0, transport: null });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.itinerary.dayTransports[0], null);
  assert.deepEqual(plain(cleared.itinerary.days[0].events), plain(result.itinerary.days[0].events));
  assert.deepEqual(plain(cleared.itinerary.dayStarts), plain(result.itinerary.dayStarts));
  assertSequential(result.itinerary.days[0]);
});

test('invalid official trip context, source, times and metadata fail without a partial schedule update', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = officialItinerary(app, city), snapshot = plain(original);
  const invalid = [undefined, {}, transportFixture('flight'), transportFixture('train', { id: '' }),
    transportFixture('train', { id: 'x'.repeat(301) }), transportFixture('train', { departureId: 'WRONG' }),
    transportFixture('train', { arrivalId: 'WRONG' }), transportFixture('train', { date: '2026-10-21' }),
    transportFixture('train', { departureMinutes: -1 }), transportFixture('train', { departureMinutes: 1440 }),
    transportFixture('train', { arrivalMinutes: 510, durationMinutes: 0 }), transportFixture('train', { durationMinutes: 151 }),
    transportFixture('train', { arrivalMinutes: 4831, durationMinutes: 4321 }), transportFixture('train', { fetchedAt: 'not-a-date' }),
    transportFixture('train', { source: 'other' }), transportFixture('train', { sourceUrl: tagoStop('express').sourceUrl }),
    transportFixture('train', { extra: 'unexpected field' }), transportFixture('train', { tripNo: null })];
  for (const transport of invalid) {
    const result = app.TravelPlanner.setDayTransport({ city, itinerary: original, dayIndex: 0, transport });
    assert.equal(result.ok, false, JSON.stringify(transport));
  }
  assert.deepEqual(plain(original), snapshot);
  for (const dayIndex of [-1, 2, 0.5, '0']) {
    assert.equal(app.TravelPlanner.setDayTransport({ city, itinerary: original, dayIndex, transport: transportFixture() }).ok, false);
  }
});

test('official trip selection survives JSON rebuild while missing legacy transport maps normalize to null', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const selected = app.TravelPlanner.setDayTransport({ city, itinerary: officialItinerary(app, city), dayIndex: 0, transport: transportFixture() }).itinerary;
  const saved = plain(selected), selections = Object.fromEntries(visitIds(saved).map((ids, index) => [index, ids]));
  const options = { city, startDate: saved.startDate, dayCount: saved.dayCount, dayAreaIds: saved.dayAreaIds,
    selections, dayStarts: saved.dayStarts, eventEdits: saved.eventEdits, dayDepartures: saved.dayDepartures, dayArrivals: saved.dayArrivals };
  const restored = app.TravelPlanner.createItinerary({ ...options, dayTransports: saved.dayTransports });
  assert.equal(restored.ok, true, restored.reason);
  assert.deepEqual(plain(restored.days), saved.days);
  assert.deepEqual(plain(restored.dayTransports), saved.dayTransports);
  assert.notEqual(restored.dayTransports[0], saved.dayTransports[0]);
  const legacy = app.TravelPlanner.createItinerary(options);
  assert.equal(legacy.ok, true);
  assert.deepEqual(plain(legacy.dayTransports), { 0: null, 1: null });
  assert.equal(legacy.days[0].events[0].duration, 150);
  for (const dayTransports of [null, [], { 2: null }, { '01': null }, { 0: undefined }]) {
    assert.equal(app.TravelPlanner.createItinerary({ ...options, dayTransports }).ok, false);
  }
  assert.equal(app.TravelPlanner.createItinerary({ ...options, dayTransports: saved.dayTransports, dayStarts: { 0: '09:00' } }).ok, false);
  assert.equal(app.TravelPlanner.createItinerary({ ...options, dayTransports: saved.dayTransports, startDate: '2026-10-21' }).ok, false);
});

test('clock or main-duration changes clear official selection, while equal values and memo edits preserve it', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.setDayTransport({ city, itinerary: officialItinerary(app, city), dayIndex: 0, transport: transportFixture() }).itinerary;
  const sameClock = app.TravelPlanner.setDayStart({ city, itinerary: original, dayIndex: 0, startTime: '08:30' });
  const sameDuration = app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'departure', duration: 150 });
  const memo = app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'departure', description: '메모만 수정' });
  const localLeg = app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'arrival-transfer', duration: 40 });
  const otherEvent = app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'finish', title: '새 마무리' });
  for (const result of [sameClock, sameDuration, memo, localLeg, otherEvent]) {
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(plain(result.itinerary.dayTransports[0]), plain(original.dayTransports[0]));
  }
  const changedClock = app.TravelPlanner.setDayStart({ city, itinerary: original, dayIndex: 0, startTime: '08:31' });
  assert.equal(changedClock.ok, true);
  assert.equal(changedClock.itinerary.dayTransports[0], null);
  assert.equal(changedClock.itinerary.days[0].events[0].duration, 150);
  const changedDuration = app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'departure', duration: 151 });
  assert.equal(changedDuration.ok, true);
  assert.equal(changedDuration.itinerary.dayTransports[0], null);
  assert.equal(changedDuration.itinerary.dayStarts[0], '08:30');
});

test('official selection follows route identity but stays attached to its date when local areas or places change', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = app.TravelPlanner.setDayTransport({ city, itinerary: officialItinerary(app, city), dayIndex: 0, transport: transportFixture() }).itinerary;
  const refreshed = app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex: 0, departure: tagoStop('train', 'ORIGIN1', { name: '출발역 새 표기' }) });
  assert.equal(refreshed.ok, true);
  assert.ok(refreshed.itinerary.dayTransports[0]);
  const newOrigin = app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex: 0, departure: tagoStop('train', 'ORIGIN2') });
  assert.equal(newOrigin.ok, true);
  assert.equal(newOrigin.itinerary.dayTransports[0], null);
  assert.equal(newOrigin.itinerary.dayArrivals[0].providerId, 'DEST1');
  const newArrival = app.TravelPlanner.setDayArrival({ city, itinerary: original, dayIndex: 0, arrival: tagoStop('train', 'DEST2') });
  assert.equal(newArrival.ok, true);
  assert.equal(newArrival.itinerary.dayTransports[0], null);
  const legacySwitch = app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex: 0, departure: departureFixture() });
  assert.equal(legacySwitch.ok, true);
  assert.equal(legacySwitch.itinerary.dayArrivals[0], null);
  assert.equal(legacySwitch.itinerary.dayTransports[0], null);
  const swapped = app.TravelPlanner.changeDayArea({ city, itinerary: original, dayIndex: 0, areaId: original.days[1].areaId });
  assert.equal(swapped.ok, true, swapped.reason);
  assert.deepEqual(plain(swapped.itinerary.dayTransports), plain(original.dayTransports));
  assert.equal(swapped.itinerary.eventEdits[0].departure.duration, 150);
  const placeId = visitIds(original)[0][0], candidate = app.TravelPlanner.getAlternatives({ city, itinerary: original, dayIndex: 0, placeId })[0];
  const replaced = app.TravelPlanner.replacePlace({ city, itinerary: original, dayIndex: 0, placeId, replacementId: candidate.id });
  assert.equal(replaced.ok, true);
  assert.deepEqual(plain(replaced.itinerary.dayTransports[0]), plain(original.dayTransports[0]));
  assert.equal(replaced.itinerary.eventEdits[0]['arrival-transfer'], undefined);
  const express = app.TravelPlanner.setDayTransport({ city, itinerary: officialItinerary(app, city, 'express'), dayIndex: 0, transport: transportFixture('express') }).itinerary;
  const intercity = app.TravelPlanner.setDayDeparture({ city, itinerary: express, dayIndex: 0, departure: tagoStop('intercity') });
  assert.equal(intercity.ok, true, intercity.reason);
  assert.equal(intercity.itinerary.dayArrivals[0], null, 'same bus mode still clears an arrival from a different official service');
  assert.equal(intercity.itinerary.dayTransports[0], null);
  assert.equal(intercity.itinerary.eventEdits[0].departure, undefined);
});

test('official ferry and manual departure durations can span up to seventy-two hours without expanding local edit limits', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = officialItinerary(app, city, 'ferry');
  const longTrip = transportFixture('ferry', { departureMinutes: 1380, arrivalMinutes: 2880, durationMinutes: 1500, tripNo: '', grade: '' });
  const result = app.TravelPlanner.setDayTransport({ city, itinerary: original, dayIndex: 0, transport: longTrip });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.itinerary.days[0].events[1].startLabel, '2일 후 00:00');
  assert.equal(result.itinerary.days[0].events[3].startLabel, '2일 후 00:25');
  const manual = app.TravelPlanner.updateEvent({ city, itinerary: result.itinerary, dayIndex: 0, eventId: 'departure', duration: 4320 });
  assert.equal(manual.ok, true);
  assert.equal(manual.itinerary.dayTransports[0], null);
  assert.equal(manual.itinerary.days[0].events[1].startLabel, '3일 후 23:00');
  assert.equal(app.TravelPlanner.updateEvent({ city, itinerary: manual.itinerary, dayIndex: 0, eventId: 'departure', duration: 4321 }).ok, false);
  assert.equal(app.TravelPlanner.updateEvent({ city, itinerary: manual.itinerary, dayIndex: 0, eventId: 'finish', duration: 721 }).ok, false);
  assert.equal(app.TravelPlanner.updateEvent({ city, itinerary: manual.itinerary, dayIndex: 0, eventId: 'arrival-transfer', duration: 721 }).ok, false);
  assertSequential(result.itinerary.days[0]);
});

test('transport dates validate the actual calendar day across month boundaries', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = officialItinerary(app, city, 'train', { startDate: '2026-10-31',
    dayDepartures: { 0: tagoStop(), 1: tagoStop() }, dayArrivals: { 0: tagoStop('train', 'DEST1'), 1: tagoStop('train', 'DEST1') } });
  assert.equal(original.ok, true);
  assert.equal(app.TravelPlanner.setDayTransport({ city, itinerary: original, dayIndex: 1, transport: transportFixture('train', { date: '2026-10-31' }) }).ok, false);
  const selected = app.TravelPlanner.setDayTransport({ city, itinerary: original, dayIndex: 1, transport: transportFixture('train', { date: '2026-11-01' }) });
  assert.equal(selected.ok, true, selected.reason);
  assert.equal(selected.itinerary.dayTransports[0], null);
  assert.equal(selected.itinerary.dayTransports[1].date, '2026-11-01');
  assert.equal(selected.itinerary.dayStarts[1], '08:30');
  assert.deepEqual(plain(selected.itinerary.days[0]), plain(original.days[0]));
});

test('one-via connections combine two official same-service trips and actual waiting time into the timeline', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  for (const service of Object.keys(tagoServices)) {
    const original = officialItinerary(app, city, service);
    const snapshot = plain(original), { via, legs } = connectionFixtures(service);
    const result = app.TravelPlanner.setDayConnection({ city, itinerary: original, dayIndex: 0, via, legs, minimumTransferMinutes: 15 });
    assert.equal(result.ok, true, result.reason);
    const next = result.itinerary, transport = next.dayTransports[0];
    assert.equal(transport.service, service); assert.equal(transport.departureId, 'ORIGIN1'); assert.equal(transport.arrivalId, 'DEST1');
    assert.equal(transport.departureMinutes, 540); assert.equal(transport.arrivalMinutes, 750); assert.equal(transport.durationMinutes, 210);
    assert.equal(transport.durationMinutes - legs.reduce((total, leg) => total + leg.durationMinutes, 0), 30);
    assert.deepEqual(plain(transport.connection), { via, legs, minimumTransferMinutes: 15 });
    assert.equal(transport.tripNo, 'T101 → T202'); assert.equal(transport.fetchedAt, legs[1].fetchedAt);
    assert.equal(next.dayStarts[0], '09:00'); assert.equal(next.days[0].events[0].duration, 210);
    assert.equal(next.days[0].events.find(event => event.id === 'arrival').start, 750);
    assert.equal(next.days[0].events.find(event => event.id === 'place-0').start, 775);
    assert.deepEqual(plain(next.days[1]), snapshot.days[1]); assert.deepEqual(plain(original), snapshot);
    assertSequential(next.days[0]);
  }
});

test('connection validation rejects insufficient or negative transfer gaps and invalid minimums without moving real trips', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = officialItinerary(app, city), snapshot = plain(original), { via, legs } = connectionFixtures();
  for (const minimumTransferMinutes of [-1, 181, 1.5, '15', null, 31]) {
    const result = app.TravelPlanner.setDayConnection({ city, itinerary: original, dayIndex: 0, via, legs, minimumTransferMinutes });
    assert.equal(result.ok, false);
  }
  for (const departureMinutes of [599, 600, 614]) {
    const invalidLegs = [legs[0], { ...legs[1], departureMinutes, durationMinutes: 750 - departureMinutes }];
    assert.equal(app.TravelPlanner.setDayConnection({ city, itinerary: original, dayIndex: 0, via, legs: invalidLegs }).ok, false);
  }
  const exact = app.TravelPlanner.setDayConnection({ city, itinerary: original, dayIndex: 0, via,
    legs: [legs[0], { ...legs[1], departureMinutes: 615, durationMinutes: 135 }] });
  assert.equal(exact.ok, true, exact.reason); assert.equal(exact.itinerary.dayTransports[0].connection.legs[1].departureMinutes, 615);
  const zero = app.TravelPlanner.setDayConnection({ city, itinerary: original, dayIndex: 0, via, minimumTransferMinutes: 0,
    legs: [legs[0], { ...legs[1], departureMinutes: 600, durationMinutes: 150 }] });
  assert.equal(zero.ok, true, zero.reason); assert.deepEqual(plain(original), snapshot);
});

test('connection helper requires exact official stop identities, two direct trips and matching services and dates', async () => {
  const app = runtime(); const { via, legs } = connectionFixtures();
  const args = { departure: tagoStop(), arrival: tagoStop('train', 'DEST1'), via, legs, date: '2026-10-20' };
  const valid = app.TravelPlanner.buildConnection(args); assert.equal(valid.ok, true, valid.reason);
  for (const patch of [
    { via: undefined }, { via: departureFixture() }, { via: tagoStop('express', 'VIA1') }, { via: tagoStop('train', 'ORIGIN1') },
    { arrival: tagoStop('express', 'DEST1') }, { date: '2026-02-30' }, { legs: [] }, { legs: [null, legs[1]] },
    { legs: [legs[0]] }, { legs: [legs[0], legs[1], legs[1]] },
    { legs: [{ ...legs[0], arrivalId: 'WRONG' }, legs[1]] }, { legs: [legs[0], { ...legs[1], departureId: 'WRONG' }] },
    { legs: [legs[0], { ...legs[1], service: 'express' }] }, { legs: [legs[0], { ...legs[1], date: '2026-10-19' }] },
    { legs: [{ ...legs[0], date: '2026-10-21' }, legs[1]] }, { legs: [valid.transport, legs[1]] }
  ]) assert.equal(app.TravelPlanner.buildConnection({ ...args, ...patch }).ok, false);
});

test('overnight connections use the second actual service date and reject implied dates or total journeys beyond seventy-two hours', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = officialItinerary(app, city), { via, legs } = connectionFixtures();
  const overnight = [
    { ...legs[0], departureMinutes: 1410, arrivalMinutes: 1500, durationMinutes: 90 },
    { ...legs[1], date: '2026-10-21', departureMinutes: 90, arrivalMinutes: 210, durationMinutes: 120 }
  ];
  const result = app.TravelPlanner.setDayConnection({ city, itinerary: original, dayIndex: 0, via, legs: overnight });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.itinerary.dayStarts[0], '23:30'); assert.equal(result.itinerary.dayTransports[0].durationMinutes, 240);
  assert.equal(result.itinerary.dayTransports[0].arrivalMinutes, 1650);
  assert.equal(result.itinerary.days[0].events.find(event => event.id === 'arrival').startLabel, '다음 날 03:30');
  const implicitDate = [overnight[0], { ...overnight[1], date: '2026-10-20' }];
  assert.equal(app.TravelPlanner.setDayConnection({ city, itinerary: original, dayIndex: 0, via, legs: implicitDate }).ok, false);
  const tooLong = [legs[0], { ...legs[1], date: '2026-10-23', departureMinutes: 600, arrivalMinutes: 750, durationMinutes: 150 }];
  assert.equal(app.TravelPlanner.setDayConnection({ city, itinerary: original, dayIndex: 0, via, legs: tooLong }).ok, false);
  assertSequential(result.itinerary.days[0]);
});

test('saved connection aggregates must exactly match validated underlying trips, not tampered outer totals or metadata', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const original = officialItinerary(app, city), { via, legs } = connectionFixtures();
  const aggregate = app.TravelPlanner.buildConnection({ departure: original.dayDepartures[0], arrival: original.dayArrivals[0], via, legs, date: original.startDate }).transport;
  for (const patch of [{ departureMinutes: 541 }, { arrivalMinutes: 751 }, { durationMinutes: 211 }, { departureId: 'WRONG' },
    { arrivalId: 'WRONG' }, { id: 'fabricated' }, { tripNo: 'fake' }, { grade: 'fake' }, { sourceUrl: 'https://example.invalid' },
    { fetchedAt: '2026-10-20T05:00:00Z' }, { date: '2026-10-21' }, { private: 'extra' },
    { connection: { ...aggregate.connection, minimumTransferMinutes: 31 } },
    { connection: { ...aggregate.connection, legs: [{ ...legs[0], durationMinutes: 61 }, legs[1]] } },
    { connection: { ...aggregate.connection, via: tagoStop('train', 'WRONG') } },
    { connection: { ...aggregate.connection, extra: true } }]) {
    const result = app.TravelPlanner.setDayTransport({ city, itinerary: original, dayIndex: 0, transport: { ...aggregate, ...patch } });
    assert.equal(result.ok, false, JSON.stringify(patch));
  }
});

test('connections survive JSON reload and tourist changes while source-context or clock changes clear their selection', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul');
  const draft = officialItinerary(app, city), { via, legs } = connectionFixtures();
  const original = app.TravelPlanner.setDayConnection({ city, itinerary: draft, dayIndex: 0, via, legs }).itinerary;
  const snapshot = plain(original), saved = plain(original);
  const restored = app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount,
    dayAreaIds: saved.dayAreaIds, selections: Object.fromEntries(visitIds(saved).map((ids, index) => [index, ids])),
    dayStarts: saved.dayStarts, eventEdits: saved.eventEdits, dayDepartures: saved.dayDepartures,
    dayArrivals: saved.dayArrivals, dayTransports: saved.dayTransports });
  assert.equal(restored.ok, true, restored.reason); assert.deepEqual(plain(restored.days), saved.days);
  saved.dayTransports[0].connection.legs[0].tripNo = 'changed'; saved.dayTransports[0].connection.via.name = 'changed';
  assert.equal(restored.dayTransports[0].connection.legs[0].tripNo, 'T101');
  assert.equal(restored.dayTransports[0].connection.via.name, '대전 환승지');
  const placeId = visitIds(original)[0][0], replacement = app.TravelPlanner.getAlternatives({ city, itinerary: original, dayIndex: 0, placeId })[0];
  const swapped = app.TravelPlanner.replacePlace({ city, itinerary: original, dayIndex: 0, placeId, replacementId: replacement.id });
  assert.equal(swapped.ok, true, swapped.reason); assert.deepEqual(plain(swapped.itinerary.dayTransports), snapshot.dayTransports);
  assert.equal(swapped.itinerary.days[0].events.find(event => event.id === 'arrival-transfer').duration, 0);
  const localMode = app.TravelPlanner.setTransferMode({ city, itinerary: original, dayIndex: 0, eventId: 'transfer-0', mode: 'subway' });
  assert.deepEqual(plain(localMode.itinerary.dayTransports), snapshot.dayTransports);
  const mutations = [
    app.TravelPlanner.setDayStart({ city, itinerary: original, dayIndex: 0, startTime: '09:01' }),
    app.TravelPlanner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'departure', duration: 211 }),
    app.TravelPlanner.setDayDeparture({ city, itinerary: original, dayIndex: 0, departure: tagoStop('train', 'ORIGIN2') }),
    app.TravelPlanner.setDayArrival({ city, itinerary: original, dayIndex: 0, arrival: tagoStop('train', 'DEST2') })
  ];
  for (const mutation of mutations) { assert.equal(mutation.ok, true, mutation.reason); assert.equal(mutation.itinerary.dayTransports[0], null); }
  const cleared = app.TravelPlanner.setDayTransport({ city, itinerary: original, dayIndex: 0, transport: null });
  assert.equal(cleared.ok, true); assert.equal(cleared.itinerary.dayTransports[0], null);
  assert.equal(cleared.itinerary.days[0].events[0].duration, 210, 'manual mode keeps the selected total as an editable estimate');
  assert.deepEqual(plain(original), snapshot);
});

function restoreCustomItinerary(app, city, itinerary) {
  const saved = plain(itinerary);
  return app.TravelPlanner.createItinerary({ city, startDate: saved.startDate, dayCount: saved.dayCount,
    dayAreaIds: saved.dayAreaIds, selections: saved.selections, dayStarts: saved.dayStarts, eventEdits: saved.eventEdits,
    extraEvents: saved.extraEvents, excludedEvents: saved.excludedEvents, eventOrders: saved.eventOrders,
    dayDepartures: saved.dayDepartures, dayArrivals: saved.dayArrivals, dayTransports: saved.dayTransports });
}

test('custom free, meal, rest, tourist and transfer events keep stable IDs and use the chosen position without inventing connectors', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  const original = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2 }), snapshot = plain(original);
  let current = original;
  const inputs = [
    { type: 'free', title: '친구 만나기', description: '역 앞에서 만나기', duration: 25, beforeId: 'lunch' },
    { type: 'meal', title: '예약한 식당', duration: 40, beforeId: 'place-1' },
    { type: 'rest', title: '카페에서 쉬기', duration: 20 },
    { type: 'transfer', title: '숙소로 이동', duration: 0, travelMode: 'local-bus' },
    { type: 'place', placeId: city.areas[2].places[0].id, beforeId: 'place-1' }
  ];
  for (let index = 0; index < inputs.length; index++) {
    const result = planner.addEvent({ city, itinerary: current, dayIndex: 0, ...inputs[index] });
    assert.equal(result.ok, true, result.reason); assert.equal(result.eventId, `extra-${index + 1}`); current = result.itinerary;
  }
  const day = current.days[0], ids = day.events.map(event => event.id);
  assert.ok(ids.indexOf('extra-1') < ids.indexOf('lunch'));
  assert.ok(ids.indexOf('extra-2') < ids.indexOf('extra-5') && ids.indexOf('extra-5') < ids.indexOf('place-1'));
  assert.equal(day.events.find(event => event.id === 'extra-2').title, '예약한 식당');
  assert.equal(day.events.find(event => event.id === 'extra-5').place.id, inputs[4].placeId);
  assert.notEqual(day.events.find(event => event.id === 'extra-5').place.areaId, day.areaId);
  assert.equal(day.events.filter(event => event.type === 'transfer').length, 3, 'only the user-added transfer joins the two original transfers');
  assert.equal(current.selections[0].length, 3); assert.equal(current.extraEvents[0].length, 5);
  assert.deepEqual(plain(current.days[1]), snapshot.days[1]); assert.deepEqual(plain(original), snapshot);
  assertSequential(day);
});

test('an unestimated extra transfer marks times provisional and mode changes invalidate only its duration', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  const original = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
    departure: departureFixture({ mode: 'car' }), eventEdits: { 0: { departure: { duration: 35 }, 'transfer-0': { duration: 28 }, 'transfer-1': { duration: 10 } } } });
  assert.equal(original.days[0].timesProvisional, false);
  const added = planner.addEvent({ city, itinerary: original, dayIndex: 0, type: 'transfer', description: '버스 정류장 확인' });
  assert.equal(added.ok, true, added.reason); assert.equal(added.itinerary.days[0].timesProvisional, true);
  let result = planner.updateEvent({ city, itinerary: added.itinerary, dayIndex: 0, eventId: added.eventId, duration: 12 });
  assert.equal(result.ok, true, result.reason); assert.equal(result.itinerary.days[0].timesProvisional, false);
  result = planner.setTransferMode({ city, itinerary: result.itinerary, dayIndex: 0, eventId: added.eventId, mode: 'taxi' });
  assert.equal(result.ok, true); assert.equal(result.itinerary.extraEvents[0][0].travelMode, 'car');
  assert.equal(result.itinerary.extraEvents[0][0].duration, 0); assert.equal(result.itinerary.days[0].timesProvisional, true);
  result = planner.updateEvent({ city, itinerary: result.itinerary, dayIndex: 0, eventId: added.eventId, duration: 18 });
  result = planner.setTransferMode({ city, itinerary: result.itinerary, dayIndex: 0, eventId: added.eventId, mode: 'rental-car' });
  assert.equal(result.itinerary.extraEvents[0][0].duration, 18, 'legacy vehicle aliases do not discard the same valid estimate');
  assert.equal(result.itinerary.extraEvents[0][0].description, '버스 정류장 확인');
  assert.equal(result.itinerary.eventEdits[0]['transfer-0'].duration, 28);
  assert.equal(result.itinerary.eventEdits[0].departure.duration, 35);
  const rejected = planner.setTransferMode({ city, itinerary: result.itinerary, dayIndex: 0, eventId: added.eventId, mode: 'train' });
  assert.equal(rejected.ok, false);
});

test('adding ordinary notes and meals preserves route estimates and extra edits survive unrelated day edits', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  const original = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    departure: departureFixture({ mode: 'car' }), eventEdits: { 0: { departure: { duration: 32 }, 'transfer-0': { duration: 18, description: '기존 이동 메모' } } } });
  const added = planner.addEvent({ city, itinerary: original, dayIndex: 0, title: '자유 산책', duration: 15 });
  assert.equal(added.ok, true, added.reason);
  const edited = planner.updateEvent({ city, itinerary: added.itinerary, dayIndex: 0, eventId: added.eventId,
    title: '강변 산책', description: '비가 오면 카페', duration: 30, beforeId: 'dinner' });
  assert.equal(edited.ok, true, edited.reason);
  const next = planner.setDayStart({ city, itinerary: edited.itinerary, dayIndex: 1, startTime: '10:30' });
  assert.equal(next.ok, true, next.reason);
  assert.deepEqual(plain(next.itinerary.extraEvents[0]), plain(edited.itinerary.extraEvents[0]));
  assert.equal(next.itinerary.eventEdits[0].departure.duration, 32);
  assert.equal(next.itinerary.eventEdits[0]['transfer-0'].duration, 18);
  assert.equal(next.itinerary.days[0].events.find(event => event.id === added.eventId).description, '비가 오면 카페');
  assertSequential(next.itinerary.days[0]);
});

test('adding and replacing extra tourists clears stale local estimates but preserves official connections, notes and other dates', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  const draft = officialItinerary(app, city, 'train', { eventEdits: { 0: {
    'arrival-transfer': { duration: 25, description: '내리는 문 확인' }, 'transfer-0': { duration: 27, description: '걷기 메모', travelMode: 'walk' },
    'transfer-1': { duration: 31 }, 'free-1': { title: '자유 시간 메모' }
  } } });
  const connection = planner.setDayConnection({ city, itinerary: draft, dayIndex: 0, ...connectionFixtures() }).itinerary;
  const withTransfer = planner.addEvent({ city, itinerary: connection, dayIndex: 0, type: 'transfer', duration: 17, description: '추가 이동 메모' }).itinerary;
  const snapshot = plain(withTransfer), candidate = city.areas[2].places[0];
  const added = planner.addEvent({ city, itinerary: withTransfer, dayIndex: 0, type: 'place', placeId: candidate.id, beforeId: 'place-0' });
  assert.equal(added.ok, true, added.reason);
  assert.deepEqual(plain(added.itinerary.dayTransports), snapshot.dayTransports);
  assert.equal(added.itinerary.dayStarts[0], '09:00'); assert.equal(added.itinerary.eventEdits[0].departure.duration, 210);
  assert.equal(added.itinerary.days[0].events.find(event => event.id === 'arrival-transfer').duration, 0);
  assert.equal(added.itinerary.days[0].events.find(event => event.id === 'arrival-transfer').to, candidate.id);
  assert.equal(added.itinerary.days[0].events.find(event => event.id === 'arrival-transfer').description, '내리는 문 확인');
  assert.equal(added.itinerary.eventEdits[0]['transfer-0'].duration, undefined);
  assert.equal(added.itinerary.eventEdits[0]['transfer-0'].description, '걷기 메모');
  assert.equal(added.itinerary.eventEdits[0]['transfer-0'].travelMode, 'walk');
  assert.equal(added.itinerary.extraEvents[0].find(event => event.type === 'transfer').duration, 0);
  const swapped = planner.updateEvent({ city, itinerary: added.itinerary, dayIndex: 0, eventId: added.eventId, placeId: city.areas[2].places[1].id, description: '방문 전 확인' });
  assert.equal(swapped.ok, true, swapped.reason);
  assert.equal(swapped.itinerary.days[0].events.find(event => event.id === added.eventId).title, city.areas[2].places[1].name);
  assert.equal(swapped.itinerary.extraEvents[0].find(event => event.id === added.eventId).description, '방문 전 확인');
  assert.deepEqual(plain(swapped.itinerary.dayTransports), snapshot.dayTransports);
  assert.deepEqual(plain(swapped.itinerary.days[1]), snapshot.days[1]); assert.deepEqual(plain(withTransfer), snapshot);
});

test('hiding and restoring original visits retains canonical selections, custom notes and all-three-hidden reloads', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  const original = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
    eventEdits: { 0: { 'place-0': { duration: 125, description: '미리 예매하기' }, lunch: { title: '맛집 예약', description: '창가 자리' } } } });
  let current = original;
  for (const eventId of ['place-0', 'place-1', 'place-2', 'lunch']) {
    const removed = planner.removeEvent({ city, itinerary: current, dayIndex: 0, eventId });
    assert.equal(removed.ok, true, removed.reason); current = removed.itinerary;
  }
  assert.equal(current.days[0].events.filter(event => event.type === 'place').length, 0);
  assert.equal(current.days[0].hiddenEvents.length, 4);
  assert.deepEqual(plain(current.selections), plain(original.selections));
  assert.equal(current.days[0].hiddenEvents.find(event => event.id === 'place-0').description, '미리 예매하기');
  const reloaded = restoreCustomItinerary(app, city, current);
  assert.equal(reloaded.ok, true, reloaded.reason); assert.deepEqual(plain(reloaded.days), plain(current.days));
  const restored = planner.restoreEvent({ city, itinerary: reloaded, dayIndex: 0, eventId: 'place-0' });
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(restored.itinerary.days[0].events.find(event => event.id === 'place-0').duration, 125);
  assert.equal(restored.itinerary.days[0].events.find(event => event.id === 'place-0').description, '미리 예매하기');
  assert.equal(planner.addEvent({ city, itinerary: current, dayIndex: 0, type: 'place', placeId: current.selections[0][0] }).ok, false,
    'a hidden recommendation is restored instead of added a second time');
  assertSequential(restored.itinerary.days[0]);
});

test('original and added rows can move together while protected rows and finish remain fixed, including saved reload', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  const original = officialItinerary(app, city), tagged = planner.setDayTransport({ city, itinerary: original, dayIndex: 0, transport: transportFixture() }).itinerary;
  const added = planner.addEvent({ city, itinerary: tagged, dayIndex: 0, title: '예약 확인', duration: 10, beforeId: 'place-1' });
  let current = added.itinerary;
  for (let index = 0; index < 7; index++) {
    const moved = planner.moveEvent({ city, itinerary: current, dayIndex: 0, eventId: 'place-2', direction: -1 });
    assert.equal(moved.ok, true, moved.reason); current = moved.itinerary;
  }
  const ids = current.days[0].events.map(event => event.id);
  assert.deepEqual(plain(ids.slice(0, 3)), ['departure', 'arrival', 'arrival-transfer']);
  assert.equal(ids.at(-1), 'finish'); assert.ok(ids.indexOf('place-2') < ids.indexOf('place-1'));
  assert.equal(current.days[0].events.find(event => event.id === 'arrival-transfer').description.includes(current.days[0].events.find(event => event.type === 'place').place.name), true);
  assert.equal(current.dayTransports[0].id, tagged.dayTransports[0].id);
  assert.equal(current.eventEdits[0].departure.duration, 150);
  const reloaded = restoreCustomItinerary(app, city, current);
  assert.equal(reloaded.ok, true, reloaded.reason); assert.deepEqual(plain(reloaded.days), plain(current.days));
  for (const eventId of ['departure', 'arrival', 'arrival-transfer', 'finish']) {
    assert.equal(planner.moveEvent({ city, itinerary: current, dayIndex: 0, eventId, direction: 1 }).ok, false);
    assert.equal(planner.removeEvent({ city, itinerary: current, dayIndex: 0, eventId }).ok, false);
  }
  assertSequential(current.days[0]);
});

test('new additions retain an existing manual order and moving an extra by position leaves other row order intact', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  const original = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  const moved = planner.moveEvent({ city, itinerary: original, dayIndex: 0, eventId: 'free-0', direction: -1 }).itinerary;
  const added = planner.addEvent({ city, itinerary: moved, dayIndex: 0, title: '시간 확인', duration: 5, beforeId: 'lunch' });
  assert.equal(added.ok, true, added.reason);
  let ids = added.itinerary.days[0].events.map(event => event.id);
  assert.ok(ids.indexOf('free-0') < ids.indexOf('transfer-0'));
  assert.equal(ids[ids.indexOf('lunch') - 1], added.eventId);
  const edited = planner.updateEvent({ city, itinerary: added.itinerary, dayIndex: 0, eventId: added.eventId, beforeId: 'dinner' });
  assert.equal(edited.ok, true, edited.reason);
  ids = edited.itinerary.days[0].events.map(event => event.id);
  assert.equal(ids[ids.indexOf('dinner') - 1], added.eventId);
  assert.deepEqual(ids.filter(id => id !== added.eventId), added.itinerary.days[0].events.map(event => event.id).filter(id => id !== added.eventId));
});

test('an explicit original beforeId reanchors an extra after manual moves while ordinary edits keep its current position', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  const original = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  const added = planner.addEvent({ city, itinerary: original, dayIndex: 0, title: '확인할 일', duration: 15 });
  const moved = planner.moveEvent({ city, itinerary: added.itinerary, dayIndex: 0, eventId: added.eventId, direction: -1 });
  assert.equal(moved.ok, true, moved.reason);
  assert.equal(moved.itinerary.extraEvents[0][0].beforeId, 'finish', 'the default insertion anchor differs from the final manual order');
  const edited = planner.updateEvent({ city, itinerary: moved.itinerary, dayIndex: 0, eventId: added.eventId, description: '메모만 고침' });
  assert.equal(edited.ok, true, edited.reason);
  assert.deepEqual(plain(edited.itinerary.eventOrders), plain(moved.itinerary.eventOrders));
  const reanchored = planner.updateEvent({ city, itinerary: edited.itinerary, dayIndex: 0, eventId: added.eventId, beforeId: 'finish' });
  assert.equal(reanchored.ok, true, reanchored.reason);
  const ids = reanchored.itinerary.days[0].events.map(event => event.id);
  assert.equal(ids.at(-2), added.eventId); assert.equal(ids.at(-1), 'finish');
  assert.equal(reanchored.itinerary.extraEvents[0][0].description, '메모만 고침');
});

test('tourist additions, removals and row moves invalidate the day road estimates while unrelated notes and dates survive', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  const original = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 2,
    departure: departureFixture({ mode: 'car' }), eventEdits: { 0: { departure: { duration: 35, description: '출발 메모' },
      'transfer-0': { duration: 19, description: '이동 메모', travelMode: 'car' }, 'place-1': { description: '박물관 예약' } } } });
  const added = planner.addEvent({ city, itinerary: original, dayIndex: 0, type: 'place', placeId: city.areas[2].places[0].id }).itinerary;
  for (const current of [added,
    planner.removeEvent({ city, itinerary: added, dayIndex: 0, eventId: added.extraEvents[0][0].id }).itinerary,
    planner.moveEvent({ city, itinerary: original, dayIndex: 0, eventId: 'place-1', direction: -1 }).itinerary]) {
    assert.equal(current.days[0].events[0].duration, 0);
    assert.equal(current.eventEdits[0].departure.description, '출발 메모');
    assert.equal(current.eventEdits[0]['transfer-0'].duration, undefined);
    assert.equal(current.eventEdits[0]['transfer-0'].description, '이동 메모');
    assert.equal(current.eventEdits[0]['transfer-0'].travelMode, 'car');
    assert.equal(current.eventEdits[0]['place-1'].description, '박물관 예약');
    assert.deepEqual(plain(current.days[1]), plain(original.days[1]));
  }
});

test('replacing a base tourist after manual reordering clears estimates against the actual visit order rather than its old slot', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  let current = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1, departure: departureFixture({ mode: 'car' }) });
  while (current.days[0].events[1].id !== 'place-2') {
    const moved = planner.moveEvent({ city, itinerary: current, dayIndex: 0, eventId: 'place-2', direction: -1 });
    assert.equal(moved.ok, true, moved.reason); current = moved.itinerary;
  }
  for (const [eventId, duration] of [['departure', 44], ['transfer-0', 24], ['transfer-1', 26]]) {
    current = planner.updateEvent({ city, itinerary: current, dayIndex: 0, eventId, duration, description: `${eventId} 메모` }).itinerary;
  }
  const originalFirstId = current.days[0].events[1].place.id;
  const replacement = planner.getAlternatives({ city, itinerary: current, dayIndex: 0, placeId: originalFirstId })[0];
  const result = planner.replacePlace({ city, itinerary: current, dayIndex: 0, placeId: originalFirstId, replacementId: replacement.id });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.itinerary.days[0].events[1].place.id, replacement.id);
  assert.equal(result.itinerary.days[0].events[0].duration, 0);
  assert.equal(result.itinerary.eventEdits[0]['transfer-0'].duration, undefined);
  assert.equal(result.itinerary.eventEdits[0]['transfer-1'].duration, undefined);
  assert.equal(result.itinerary.eventEdits[0].departure.description, 'departure 메모');
  assert.equal(result.itinerary.eventEdits[0]['transfer-0'].description, 'transfer-0 메모');
  assertSequential(result.itinerary.days[0]);
});

test('custom state rejects malformed days, IDs, duplicate or unregistered tourists and invalid positions without mutation', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  const original = officialItinerary(app, city), snapshot = plain(original), candidate = city.areas[2].places[0].id;
  for (const input of [{ type: 'unknown' }, { type: 'place', placeId: 'unknown' },
    { type: 'place', placeId: original.selections[0][0] }, { type: 'place', placeId: original.selections[1][0] },
    { type: 'place', placeId: candidate, title: '다른 장소인 척' },
    { type: 'free', duration: 0 }, { type: 'meal', duration: -1 }, { type: 'transfer', duration: 721 },
    { type: 'transfer', duration: 1.5 }, { type: 'free', beforeId: 'departure' }, { type: 'free', beforeId: 'arrival' },
    { type: 'free', beforeId: 'arrival-transfer' }, { type: 'free', beforeId: 'extra-1' },
    { type: 'free', beforeId: 'unknown' }, { type: 'free', title: ' ' }, { type: 'free', description: '가'.repeat(501) },
    { type: 'free', placeId: candidate }, { type: 'rest', travelMode: 'walk' }]) {
    assert.equal(planner.addEvent({ city, itinerary: original, dayIndex: 0, ...input }).ok, false, JSON.stringify(input));
  }
  for (const patch of [
    { extraEvents: { 2: [] } }, { extraEvents: { 0: null } },
    { extraEvents: { 0: [{ id: 'place-0', type: 'free', duration: 10 }] } },
    { excludedEvents: { 0: ['departure'] } }, { excludedEvents: { 0: ['finish'] } },
    { excludedEvents: { 0: ['place-0', 'place-0'] } }, { excludedEvents: { 0: ['unknown'] } },
    { eventOrders: { 0: ['finish'] } }, { eventOrders: { 0: ['lunch', 'lunch'] } }, { eventOrders: { 0: ['unknown'] } }
  ]) assert.equal(planner.createItinerary({ city, startDate: original.startDate, dayCount: 2, ...patch }).ok, false);
  assert.equal(planner.updateEvent({ city, itinerary: original, dayIndex: 0, eventId: 'lunch', beforeId: 'dinner' }).ok, false);
  assert.equal(planner.moveEvent({ city, itinerary: original, dayIndex: 0, eventId: 'place-0', direction: -1 }).ok, false);
  assert.equal(planner.moveEvent({ city, itinerary: original, dayIndex: 0, eventId: 'place-0', direction: '1' }).ok, false);
  assert.deepEqual(plain(original), snapshot);
});

test('saved extra state is detached, caps additions and keeps an extra anchored to a subsequently hidden base row', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  let current = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  const first = planner.addEvent({ city, itinerary: current, dayIndex: 0, title: '자유 일정', description: '원본 메모', duration: 10, beforeId: 'lunch' });
  current = planner.removeEvent({ city, itinerary: first.itinerary, dayIndex: 0, eventId: 'lunch' }).itinerary;
  assert.equal(current.days[0].events.some(event => event.id === first.eventId), true);
  assert.equal(restoreCustomItinerary(app, city, current).ok, true);
  assert.equal(planner.addEvent({ city, itinerary: current, dayIndex: 0, title: '숨긴 위치', beforeId: 'lunch' }).ok, false);
  for (let index = 1; index < 20; index++) current = planner.addEvent({ city, itinerary: current, dayIndex: 0, title: `짧은 메모 ${index}`, duration: 1 }).itinerary;
  assert.equal(current.extraEvents[0].length, 20);
  assert.equal(planner.addEvent({ city, itinerary: current, dayIndex: 0, title: '스물한 번째' }).ok, false);
  const restored = restoreCustomItinerary(app, city, current); assert.equal(restored.ok, true, restored.reason);
  current.extraEvents[0][0].description = '외부 변경'; current.eventOrders[0].reverse(); current.excludedEvents[0].push('dinner');
  assert.equal(restored.extraEvents[0][0].description, '원본 메모');
  assert.equal(restored.excludedEvents[0].includes('dinner'), false);
  const removed = planner.removeEvent({ city, itinerary: restored, dayIndex: 0, eventId: first.eventId });
  assert.equal(removed.ok, true, removed.reason); assert.equal(removed.itinerary.extraEvents[0].length, 19);
  assert.equal(removed.itinerary.eventOrders[0].includes(first.eventId), false);
});

async function sejongCatalogRuntime() {
  const items = Array.from({ length: 19 }, (_, index) => ({
    contentId: String(88000 + index), contentTypeId: index % 2 ? '14' : '12', areaCode: '8', sigunguCode: '1',
    title: `세종 관광지 ${index + 1}`, address: `세종특별자치시 여행로 ${index + 1}`,
    latitude: index < 3 ? 36.5 + index * 0.0001 : 36.2 + Math.floor((index - 3) / 4) * 0.05,
    longitude: index < 3 ? 127.25 + index * 0.0001 : 127.1 + ((index - 3) % 4) * 0.05
  }));
  const app = runtime(async url => url.includes('/areas') ? areasResponse([{ code: '8', name: '세종' }]) : response(items, '8'));
  await app.TourData.loadDestinations();
  const city = await app.TourData.ensureCity('tour-area-8');
  return { app, city, items };
}

test('a city with one three-place cluster still exposes all nineteen valid API tourists for manual planning', async () => {
  const { app, city } = await sejongCatalogRuntime(), planner = app.TravelPlanner;
  assert.equal(city.areas.length, 1); assert.equal(city.areas[0].places.length, 3);
  assert.equal(city.catalogPlaces.length, 19); assert.equal(planner.allPlaces(city).length, 19);
  const checked = planner.validateCity(city); assert.equal(checked.ok, true, checked.reason); assert.equal(checked.places.length, 19);
  assert.equal(planner.allPlaces(city)[0], city.areas[0].places[0], 'the original clustered object remains canonical');
  const original = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  assert.equal(original.ok, true, original.reason);
  assert.equal(planner.getAlternatives({ city, itinerary: original, dayIndex: 0, placeId: original.selections[0][0] }).length, 0,
    'legacy same-cluster alternatives retain their original scope');
  const outside = city.catalogPlaces.find(place => place.areaId.startsWith('tour-catalog-'));
  const added = planner.addEvent({ city, itinerary: original, dayIndex: 0, type: 'place', placeId: outside.id });
  assert.equal(added.ok, true, added.reason);
  assert.equal(added.itinerary.days[0].events.find(event => event.id === added.eventId).place, outside);
});

test('catalog validation allows matching clustered copies and rejects duplicate, conflicting, foreign or unparented entries', async () => {
  const { app, city } = await sejongCatalogRuntime(), planner = app.TravelPlanner, original = city.catalogPlaces;
  city.catalogPlaces = original.map(place => ({ ...place }));
  assert.equal(planner.validateCity(city).ok, true);
  assert.equal(planner.allPlaces(city)[0], city.areas[0].places[0]);
  const outsideIndex = original.findIndex(place => place.areaId.startsWith('tour-catalog-'));
  for (const changes of [{ id: 'unregistered' }, { contentId: 'different' }, { latitude: 32.9 }, { longitude: 150 },
    { name: '' }, { source: '외부 입력' }, { sourceUrl: 'https://example.invalid' },
    { areaId: 'tour-catalog-1' }, { area: '다른 지역 전체' }, { areaName: '다른 지역 전체' }]) {
    city.catalogPlaces = original.map((place, index) => index === outsideIndex ? { ...place, ...changes } : place);
    assert.equal(planner.validateCity(city).ok, false, JSON.stringify(changes));
  }
  for (const changes of [{ name: '같은 ID 다른 이름' }, { latitude: original[0].latitude + 0.01 }, { areaId: '다른 권역' }]) {
    city.catalogPlaces = original.map((place, index) => index === 0 ? { ...place, ...changes } : place);
    assert.equal(planner.validateCity(city).ok, false);
  }
  city.catalogPlaces = [...original, original[0]]; assert.equal(planner.validateCity(city).ok, false);
  city.catalogPlaces = null; assert.equal(planner.validateCity(city).ok, false);
  city.catalogPlaces = original;
  assert.equal(planner.validateCity({ ...city }).ok, false, 'unregistered lookalike city objects cannot supply a catalog');
  assert.equal(planner.validateCity(city).ok, true);
});

test('replacing a recommendation with any catalog tourist is atomic, preserves the official trip and restores through JSON', async () => {
  const { app, city } = await sejongCatalogRuntime(), planner = app.TravelPlanner;
  const draft = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
    dayDepartures: { 0: tagoStop() }, dayArrivals: { 0: tagoStop('train', 'DEST1') }, eventEdits: { 0: {
      'place-0': { description: '기존 관광지 예약 메모', duration: 100 }, 'arrival-transfer': { duration: 25 },
      'transfer-0': { duration: 22, description: '내부 이동 메모', travelMode: 'walk' }
    } } });
  const original = planner.setDayConnection({ city, itinerary: draft, dayIndex: 0, ...connectionFixtures() }).itinerary;
  const snapshot = plain(original), candidate = city.catalogPlaces[3];
  const result = planner.replaceTouristEvent({ city, itinerary: original, dayIndex: 0, eventId: 'place-0', replacementId: candidate.id });
  assert.equal(result.ok, true, result.reason); assert.equal(result.eventId, 'extra-1');
  assert.equal(result.itinerary.days[0].events.find(event => event.type === 'place').place.id, candidate.id);
  assert.equal(result.itinerary.days[0].events.filter(event => event.type === 'place').length, 3);
  assert.deepEqual(plain(result.itinerary.selections), snapshot.selections);
  assert.equal(result.itinerary.excludedEvents[0].includes('place-0'), true);
  assert.equal(result.itinerary.days[0].hiddenEvents.find(event => event.id === 'place-0').description, '기존 관광지 예약 메모');
  assert.deepEqual(plain(result.itinerary.dayTransports), snapshot.dayTransports);
  assert.equal(result.itinerary.eventEdits[0].departure.duration, 210);
  assert.equal(result.itinerary.days[0].events.find(event => event.id === 'arrival-transfer').to, candidate.id);
  assert.equal(result.itinerary.days[0].events.find(event => event.id === 'arrival-transfer').duration, 0);
  assert.equal(result.itinerary.eventEdits[0]['transfer-0'].description, '내부 이동 메모');
  assert.equal(result.itinerary.eventEdits[0]['transfer-0'].duration, undefined);
  const restored = restoreCustomItinerary(app, city, result.itinerary);
  assert.equal(restored.ok, true, restored.reason); assert.deepEqual(plain(restored.days), plain(result.itinerary.days));
  assert.deepEqual(plain(original), snapshot); assertSequential(restored.days[0]);
});

test('extra tourist replacement refreshes generated introductions and stay time while keeping user-written notes', async () => {
  const { app, city } = await sejongCatalogRuntime(), planner = app.TravelPlanner;
  const original = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  const added = planner.addEvent({ city, itinerary: original, dayIndex: 0, type: 'place', placeId: city.catalogPlaces[3].id });
  const first = planner.replaceTouristEvent({ city, itinerary: added.itinerary, dayIndex: 0, eventId: added.eventId, replacementId: city.catalogPlaces[4].id });
  assert.equal(first.ok, true, first.reason); assert.equal(first.eventId, added.eventId);
  let event = first.itinerary.days[0].events.find(item => item.id === added.eventId);
  assert.equal(event.description, city.catalogPlaces[4].intro); assert.equal(event.duration, city.catalogPlaces[4].stayMinutes);
  const annotated = planner.updateEvent({ city, itinerary: first.itinerary, dayIndex: 0, eventId: added.eventId, description: '비 오면 오후에 방문', duration: 120 });
  const next = planner.replaceTouristEvent({ city, itinerary: annotated.itinerary, dayIndex: 0, eventId: added.eventId, replacementId: city.catalogPlaces[5].id });
  assert.equal(next.ok, true, next.reason);
  event = next.itinerary.days[0].events.find(item => item.id === added.eventId);
  assert.equal(event.title, city.catalogPlaces[5].name); assert.equal(event.description, '비 오면 오후에 방문');
  assert.equal(event.duration, city.catalogPlaces[5].stayMinutes);
  assert.equal(next.itinerary.extraEvents[0].length, 1);
});

test('catalog replacement rejects duplicate visits and full additions without partially hiding the original recommendation', async () => {
  const { app, city } = await sejongCatalogRuntime(), planner = app.TravelPlanner;
  let original = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  for (let index = 0; index < 20; index++) original = planner.addEvent({ city, itinerary: original, dayIndex: 0, title: `메모 ${index}`, duration: 1 }).itinerary;
  const snapshot = plain(original);
  const failed = planner.replaceTouristEvent({ city, itinerary: original, dayIndex: 0, eventId: 'place-0', replacementId: city.catalogPlaces[3].id });
  assert.equal(failed.ok, false); assert.deepEqual(plain(original), snapshot);
  assert.equal(original.excludedEvents[0], undefined);
  for (const input of [{ eventId: 'place-0', replacementId: original.selections[0][1] },
    { eventId: 'place-0', replacementId: 'unknown' }, { eventId: 'lunch', replacementId: city.catalogPlaces[3].id }])
    assert.equal(planner.replaceTouristEvent({ city, itinerary: original, dayIndex: 0, ...input }).ok, false);
  const same = planner.replaceTouristEvent({ city, itinerary: original, dayIndex: 0, eventId: 'place-0', replacementId: original.selections[0][0] });
  assert.equal(same.ok, true); assert.equal(same.eventId, 'place-0'); assert.deepEqual(plain(same.itinerary.days), snapshot.days);
});

test('same-cluster replacement keeps its base ID while other-cluster replacement follows the current manual position', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  const original = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  const same = planner.replaceTouristEvent({ city, itinerary: original, dayIndex: 0, eventId: 'place-0', replacementId: city.areas[0].places[3].id });
  assert.equal(same.ok, true, same.reason); assert.equal(same.eventId, 'place-0'); assert.equal(same.itinerary.extraEvents[0], undefined);
  let current = same.itinerary;
  while (current.days[0].events[1].id !== 'place-2') current = planner.moveEvent({ city, itinerary: current, dayIndex: 0, eventId: 'place-2', direction: -1 }).itinerary;
  const other = planner.replaceTouristEvent({ city, itinerary: current, dayIndex: 0, eventId: 'place-2', replacementId: city.areas[3].places[0].id });
  assert.equal(other.ok, true, other.reason);
  assert.equal(other.itinerary.days[0].events[1].id, other.eventId);
  assert.equal(other.itinerary.days[0].events[1].place.id, city.areas[3].places[0].id);
  assert.equal(other.itinerary.days[0].events.some(event => event.id === 'place-2'), false);
});


test('unknown inter-place durations are pending until every required leg is entered, and a mode change invalidates only its leg', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  let itinerary = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1,
    departure: departureFixture({ mode: 'car' }), eventEdits: { 0: { departure: { duration: 35 } } } });
  for (const id of ['transfer-0', 'transfer-1']) assert.equal(itinerary.days[0].events.find(event => event.id === id).duration, 0);
  assert.equal(itinerary.days[0].timesProvisional, true);
  for (const id of ['transfer-0', 'transfer-1']) itinerary = planner.updateEvent({ city, itinerary, dayIndex: 0, eventId: id, duration: 25 }).itinerary;
  assert.equal(itinerary.days[0].timesProvisional, false);
  const changed = planner.setTransferMode({ city, itinerary, dayIndex: 0, eventId: 'transfer-0', mode: 'walk' });
  assert.equal(changed.ok, true);
  assert.equal(changed.itinerary.days[0].timesProvisional, true);
  assert.equal(changed.itinerary.days[0].events.find(event => event.id === 'transfer-0').duration, 0);
  assert.equal(changed.itinerary.days[0].events.find(event => event.id === 'transfer-1').duration, 25);
  const reset = planner.updateEvent({ city, itinerary, dayIndex: 0, eventId: 'transfer-0', duration: 0 });
  assert.equal(reset.ok, true, reset.reason);
  assert.equal(reset.itinerary.days[0].timesProvisional, true, 'explicit zero also means unknown, not confirmed instantaneous travel');
});

test('mid-afternoon meals are not labelled dinner and custom restaurant titles survive', async () => {
  const app = runtime(), city = await app.TourData.ensureCity('seoul'), planner = app.TravelPlanner;
  const itinerary = planner.createItinerary({ city, startDate: '2026-10-20', dayCount: 1 });
  const meal = itinerary.days[0].events.find(event => event.id === 'dinner');
  assert.ok(meal.start >= 15 * 60 && meal.start < 17 * 60);
  assert.equal(meal.title, '오후 식사');
  const custom = planner.updateEvent({ city, itinerary, dayIndex: 0, eventId: 'dinner', title: '예약한 식당' });
  assert.equal(custom.itinerary.days[0].events.find(event => event.id === 'dinner').title, '예약한 식당');
});

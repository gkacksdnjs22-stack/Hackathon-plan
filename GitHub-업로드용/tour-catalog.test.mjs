import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('tour-data.js', import.meta.url), 'utf8');
function sample(contentId, latitude, longitude, overrides = {}) {
  return { contentId: String(contentId), title: `관광지 ${contentId}`, contentTypeId: '12', latitude, longitude,
    areaCode: '8', address: '세종특별자치시 문화로 10', ...overrides };
}
function sampleItems() {
  return [sample(1, 36.48, 127.18), sample(2, 36.481, 127.181), sample(3, 36.482, 127.182),
    ...Array.from({ length: 16 }, (_, index) => sample(index + 4, 36.36 + Math.floor(index / 4) * 0.04, 127.24 + index % 4 * 0.04,
      { contentTypeId: index % 2 ? '14' : '12' }))];
}
function runtime(fetchImpl = async () => ({ ok: true, json: async () => ({ areaCode: '8', items: sampleItems(), fetchedAt: '2026-10-20T00:00:00Z' }) })) {
  const city = { id: 'tour-area-8', name: '세종', country: 'KR', timezone: 'Asia/Seoul', tourAreaCode: '8', supportedDays: 7, areas: [] };
  const window = { TRAVEL_DATA: { cities: { [city.id]: city } } }, calls = [];
  vm.runInContext(code, vm.createContext({ window, location: { protocol: 'http:' }, AbortSignal,
    fetch: (...args) => { calls.push(args); return fetchImpl(...args); } }), { filename: 'tour-data.js' });
  return { api: window.TourData, city, calls };
}

test('the catalog retains all nineteen valid places while the existing three-place recommendation cluster stays unchanged', () => {
  const { api } = runtime(), items = sampleItems();
  const areas = api.buildAreas(items, '8'), before = JSON.stringify(areas);
  assert.equal(areas.length, 1); assert.equal(areas[0].places.length, 3);
  const catalog = api.buildCatalog(items, '8', '세종', areas);
  assert.equal(catalog.length, 19); assert.equal(new Set(catalog.map(place => place.id)).size, 19);
  assert.equal(JSON.stringify(areas), before);
  assert.equal(JSON.stringify(api.buildAreas(items, '8')), before);
  for (const place of areas[0].places) assert.equal(catalog.find(candidate => candidate.id === place.id), place);
  assert.ok(catalog.some(place => place.id === 'tourapi-19'));
});

test('catalog validation excludes duplicate IDs, invalid coordinates, wrong regions and unsupported content types', () => {
  const { api } = runtime(), valid = sampleItems();
  const items = [...valid, { ...valid[0], title: '같은 ID 두 번째 응답' },
    sample(20, 36.5, 127.4, { areaCode: '1' }), sample(21, 32.9, 127.4), sample(22, 36.5, 132.1),
    sample(23, 36.5, 127.4, { contentTypeId: '39' }), sample(24, 36.5, 127.4, { title: '  ' }),
    sample('invalid-id', 36.5, 127.4), sample(25, '36.5', 127.4), null];
  const areas = api.buildAreas(items, '8'), catalog = api.buildCatalog(items, '8', '세종', areas);
  assert.equal(catalog.length, 19);
  assert.equal(catalog.find(place => place.id === 'tourapi-1').name, '관광지 1');
  assert.deepEqual(Array.from(catalog, place => place.id), valid.map(item => `tourapi-${item.contentId}`));
  assert.equal(areas.length, 1); assert.equal(areas[0].places.length, 3);
});

test('unclustered places use the same normalized fields and source with a self-centered catalog area', () => {
  const { api } = runtime(), items = sampleItems();
  items[4] = { ...items[4], title: '  문화관 5  ', address: '  세종특별자치시 문화로 5  ' };
  const areas = api.buildAreas(items, '8'), catalog = api.buildCatalog(items, '8', '세종', areas);
  const place = catalog.find(candidate => candidate.id === 'tourapi-5');
  assert.equal(place.name, '문화관 5'); assert.equal(place.areaId, 'tour-catalog-8');
  assert.equal(place.area, '세종 전체'); assert.equal(place.areaName, '세종 전체');
  assert.equal(place.distanceToCenter, 0); assert.equal(place.stayMinutes, 75); assert.equal(place.category, '문화시설');
  assert.equal(place.address, '세종특별자치시 문화로 5'); assert.equal(place.intro, place.address);
  assert.equal(place.source, '한국관광공사 TourAPI'); assert.equal(place.sourceUrl, 'https://www.data.go.kr/data/15101578/openapi.do');
  assert.equal(place.mapQuery, `${items[4].latitude},${items[4].longitude}`);
  assert.deepEqual(Object.keys(place).sort(), Object.keys(areas[0].places[0]).sort());
});

test('ensureCity adds the full catalog without expanding recommended areas or supported travel days', async () => {
  const { api, city, calls } = runtime();
  const [first, second] = await Promise.all([api.ensureCity(city.id), api.ensureCity(city.id)]);
  assert.equal(first, city); assert.equal(second, city); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/tour/places?areaCode=8');
  assert.equal(city.catalogPlaces.length, 19); assert.equal(city.areas.length, 1); assert.equal(city.supportedDays, 1);
  for (const place of city.areas[0].places) assert.equal(city.catalogPlaces.find(candidate => candidate.id === place.id), place);
  assert.equal(await api.ensureCity(city.id), city); assert.equal(calls.length, 1);
});

test('a previously loaded city without a catalog is upgraded, and a mismatched response leaves the city untouched', async () => {
  const app = runtime();
  app.city.dataSource = 'tourapi'; app.city.areas = app.api.buildAreas(sampleItems(), '8'); app.city.supportedDays = 1;
  await app.api.ensureCity(app.city.id); assert.equal(app.city.catalogPlaces.length, 19); assert.equal(app.calls.length, 1);

  const wrong = runtime(async () => ({ ok: true, json: async () => ({ areaCode: '1', items: sampleItems() }) }));
  const before = JSON.stringify(wrong.city);
  await assert.rejects(wrong.api.ensureCity(wrong.city.id), /지역코드가 다릅니다/);
  assert.equal(JSON.stringify(wrong.city), before); assert.equal(wrong.city.catalogPlaces, undefined);
});

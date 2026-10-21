import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./planner.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function runtime() {
  const area = (id, offset = 0) => ({ id, name: id === 'area-one' ? '첫 권역' : '둘째 권역', places: [0, 1, 2, 3, 4, 5].map((index) => ({
    id: `tourapi-${100 + offset + index}`, contentId: String(100 + offset + index), name: `관광지 ${offset + index}`,
    areaId: id, area: id === 'area-one' ? '첫 권역' : '둘째 권역', areaName: id === 'area-one' ? '첫 권역' : '둘째 권역',
    stayMinutes: 60, latitude: 37.55, longitude: 126.9 + [0, 0.03, 0.01, 0.02, 0.04, 0.05][index],
    address: `서울 주소 ${offset + index}`, intro: `공식 소개 ${offset + index}`, contentTypeId: '12', source: '한국관광공사 TourAPI'
  })) });
  const city = { id: 'seoul', country: 'KR', name: '서울', supportedDays: 2, areas: [area('area-one'), area('area-two', 10)] };
  const window = { TRAVEL_DATA: { countries: { KR: '대한민국' }, cities: { seoul: city } } };
  const context = vm.createContext({ window, Intl, Map }); vm.runInContext(source, context);
  const planner = window.TravelPlanner;
  const create = options => planner.createItinerary({ city, startDate: '2026-10-21', dayCount: 1,
    selections: { 0: city.areas[0].places.slice(0, 3).map(place => place.id) }, ...options });
  return { city, planner, create };
}
const visitIds = day => plain(day.events.filter(event => event.type === 'place').map(event => event.id));
const placeIds = day => plain(day.events.filter(event => event.type === 'place').map(event => event.place.id));
function graph(ids, base = 30) { return Object.fromEntries(ids.flatMap(from => ids.filter(to => to !== from).map(to => [`${from}>${to}`, base]))); }

test('straight-line suggestions reorder event IDs in existing tourist slots and preserve place edits, meals and other days', () => {
  const { city, planner, create } = runtime();
  const itinerary = create({ dayCount: 2, selections: { 0: city.areas[0].places.slice(0, 3).map(place => place.id), 1: city.areas[1].places.slice(0, 3).map(place => place.id) },
    eventEdits: { 0: { 'place-0': { description: 'A의 메모', duration: 80 }, 'place-1': { description: 'B의 메모', duration: 45 }, lunch: { title: '직접 정한 점심', description: '예약 아님' } } } });
  assert.equal(itinerary.ok, true); const before = JSON.stringify(itinerary);
  const proposal = planner.proposeVisitOrder({ city, itinerary, dayIndex: 0 });
  assert.equal(proposal.ok, true); assert.equal(proposal.changed, true); assert.equal(proposal.unit, 'meters'); assert.ok(proposal.afterCost < proposal.beforeCost);
  assert.deepEqual(plain(proposal.beforeIds), ['place-0', 'place-1', 'place-2']); assert.deepEqual(plain(proposal.afterIds), ['place-0', 'place-2', 'place-1']);
  const next = proposal.itinerary;
  assert.equal(JSON.stringify(itinerary), before, 'proposal must not mutate the active note');
  assert.deepEqual(next.days[0].events.filter(event => event.type !== 'place').map(event => event.id), itinerary.days[0].events.filter(event => event.type !== 'place').map(event => event.id));
  assert.deepEqual(plain(next.days[1]), plain(itinerary.days[1]));
  for (const id of ['place-0', 'place-1', 'place-2']) {
    const old = itinerary.days[0].events.find(event => event.id === id), event = next.days[0].events.find(event => event.id === id);
    assert.equal(event.place.id, old.place.id); assert.equal(event.duration, old.duration); assert.equal(event.description, old.description);
  }
  assert.equal(next.days[0].events.find(event => event.id === 'lunch').title, '직접 정한 점심');
});

test('directed vehicle costs use every queried direction, accept fractional minutes and never persist route costs', () => {
  const { city, planner, create } = runtime(), itinerary = create(), costs = graph(visitIds(itinerary.days[0]), 40);
  costs['place-2>place-0'] = 1.25; costs['place-0>place-1'] = 2.5;
  const result = planner.proposeVisitOrder({ city, itinerary, dayIndex: 0, mode: 'car', costs });
  assert.equal(result.ok, true); assert.equal(result.changed, true); assert.equal(result.unit, 'minutes');
  assert.deepEqual(plain(result.afterIds), ['place-2', 'place-0', 'place-1']); assert.equal(result.afterCost, 3.75); assert.equal(result.beforeCost, 42.5);
  assert.equal(Object.hasOwn(result.itinerary, 'costs'), false); assert.equal(Object.hasOwn(result.itinerary, 'routes'), false);
  assert.equal(JSON.stringify(result.itinerary).includes('place-2>place-0'), false);
  assert.deepEqual(plain(planner.createItinerary({ city, ...plain(result.itinerary) }).days), plain(result.itinerary.days), 'selected event order survives the normal rebuild');
});

test('ties and already-best routes return no change with the original stable order', () => {
  const { city, planner, create } = runtime(), itinerary = create(), ids = visitIds(itinerary.days[0]);
  const result = planner.proposeVisitOrder({ city, itinerary, dayIndex: 0, mode: 'car', costs: graph(ids, 10) });
  assert.equal(result.ok, true); assert.equal(result.changed, false); assert.equal(result.beforeCost, result.afterCost);
  assert.deepEqual(plain(result.beforeIds), plain(result.afterIds)); assert.deepEqual(plain(result.itinerary), plain(itinerary));
  const first = planner.proposeVisitOrder({ city, itinerary, dayIndex: 0 });
  const repeated = planner.proposeVisitOrder({ city, itinerary: first.itinerary, dayIndex: 0 });
  assert.equal(repeated.changed, false);
});

test('a booked meal is a full-order barrier, preventing tourist visits from crossing it', () => {
  const { city, planner, create } = runtime();
  const itinerary = create({ personalization: { eventTags: { 0: { lunch: 'booked' } } } });
  const costs = graph(visitIds(itinerary.days[0]), 50); costs['place-2>place-0'] = 1; costs['place-0>place-1'] = 1;
  const result = planner.proposeVisitOrder({ city, itinerary, dayIndex: 0, mode: 'car', costs });
  assert.equal(result.ok, true); assert.equal(result.changed, false);
  assert.deepEqual(plain(result.afterIds), ['place-0', 'place-1', 'place-2']);
});

test('booked tourist anchors cannot move and valid changes preserve every booked start and end', () => {
  const { city, planner, create } = runtime();
  let itinerary = create(); const added = planner.addEvent({ city, itinerary, dayIndex: 0, type: 'place', placeId: city.areas[0].places[3].id, beforeId: 'place-1' });
  assert.equal(added.ok, true); itinerary = added.itinerary;
  itinerary = planner.updatePersonalization({ city, itinerary, personalization: { eventTags: { 0: { 'place-0': 'booked', 'place-2': 'booked' } } } }).itinerary;
  const costs = graph(visitIds(itinerary.days[0]), 30); costs['place-0>place-1'] = 1; costs[`place-1>${added.eventId}`] = 1; costs[`${added.eventId}>place-2`] = 1;
  const result = planner.proposeVisitOrder({ city, itinerary, dayIndex: 0, mode: 'car', costs });
  assert.equal(result.changed, true); assert.deepEqual(plain(result.afterIds), ['place-0', 'place-1', added.eventId, 'place-2']);
  for (const id of ['place-0', 'place-2']) {
    const before = itinerary.days[0].events.find(event => event.id === id), after = result.itinerary.days[0].events.find(event => event.id === id);
    assert.equal(after.start, before.start); assert.equal(after.end, before.end);
  }
});

test('an apparently faster order is rejected when clearing changed travel duration would move a booked time', () => {
  const { city, planner, create } = runtime();
  const itinerary = create({ eventEdits: { 0: { 'transfer-0': { duration: 20, travelMode: 'car', description: '이동 메모' } } }, personalization: { eventTags: { 0: { finish: 'booked' } } } });
  const result = planner.proposeVisitOrder({ city, itinerary, dayIndex: 0 });
  assert.equal(result.ok, true); assert.equal(result.changed, false); assert.deepEqual(plain(result.itinerary), plain(itinerary));
});

test('changed legs lose only their manual duration while travel mode and memo remain attached to the same row', () => {
  const { city, planner, create } = runtime();
  const itinerary = create({ eventEdits: { 0: { 'transfer-0': { duration: 20, travelMode: 'car', description: '보존할 이동 메모' }, 'transfer-1': { duration: 15, travelMode: 'walk', description: '다음 이동 메모' } } } });
  const result = planner.proposeVisitOrder({ city, itinerary, dayIndex: 0 }); assert.equal(result.changed, true);
  for (const id of ['transfer-0', 'transfer-1']) {
    const before = itinerary.days[0].events.find(event => event.id === id), after = result.itinerary.days[0].events.find(event => event.id === id);
    assert.equal(after.duration, 0); assert.equal(after.travelMode, before.travelMode); assert.equal(after.description, before.description);
  }
});

test('hidden visits are excluded, two visible visits work and six visible visits are rejected before permutation', () => {
  const { city, planner, create } = runtime(); let itinerary = create();
  itinerary = planner.removeEvent({ city, itinerary, dayIndex: 0, eventId: 'place-1' }).itinerary;
  const ids = visitIds(itinerary.days[0]), result = planner.proposeVisitOrder({ city, itinerary, dayIndex: 0, mode: 'car', costs: { [`${ids[0]}>${ids[1]}`]: 30, [`${ids[1]}>${ids[0]}`]: 5 } });
  assert.equal(result.changed, true); assert.deepEqual(plain(result.afterIds), [...ids].reverse());
  assert.ok(result.itinerary.days[0].hiddenEvents.some(event => event.id === 'place-1'));
  itinerary = create();
  for (let index = 3; index < 6; index++) itinerary = planner.addEvent({ city, itinerary, dayIndex: 0, type: 'place', placeId: city.areas[0].places[index].id }).itinerary;
  assert.equal(planner.proposeVisitOrder({ city, itinerary, dayIndex: 0 }).ok, false);
});

test('invalid days, modes, coordinates and incomplete or invalid directed costs fail without modifying the note', () => {
  const { city, planner, create } = runtime(), itinerary = create(), before = JSON.stringify(itinerary), valid = graph(visitIds(itinerary.days[0]));
  for (const options of [{ dayIndex: -1 }, { dayIndex: 1 }, { mode: 'transit' }, { mode: 'car' }, { mode: 'car', costs: {} },
    ...[0, -1, 1441, Infinity, NaN, '5', { duration: 5 }].map(value => ({ mode: 'car', costs: { ...valid, 'place-0>place-1': value } }))]) {
    assert.equal(planner.proposeVisitOrder({ city, itinerary, dayIndex: 0, ...options }).ok, false);
  }
  assert.equal(JSON.stringify(itinerary), before);
  city.areas[0].places[0].latitude = null; assert.equal(planner.proposeVisitOrder({ city, itinerary, dayIndex: 0 }).ok, false);
});

test('the five-visit bound finds the complete directed optimum while retaining custom tourism IDs', () => {
  const { city, planner, create } = runtime(); let itinerary = create(); const added = [];
  for (let index = 3; index < 5; index++) {
    const result = planner.addEvent({ city, itinerary, dayIndex: 0, type: 'place', placeId: city.areas[0].places[index].id });
    assert.equal(result.ok, true); added.push(result.eventId); itinerary = result.itinerary;
  }
  const expected = [added[0], 'place-2', 'place-0', added[1], 'place-1'], costs = graph(visitIds(itinerary.days[0]), 50);
  for (let index = 1; index < expected.length; index++) costs[`${expected[index - 1]}>${expected[index]}`] = 1;
  const result = planner.proposeVisitOrder({ city, itinerary, dayIndex: 0, mode: 'car', costs });
  assert.equal(result.changed, true); assert.equal(result.afterCost, 4); assert.deepEqual(plain(result.afterIds), expected);
});

test('an unchanged earlier leg keeps its manual travel time when later tourism visits change order', () => {
  const { city, planner, create } = runtime();
  let itinerary = create({ eventEdits: { 0: { 'transfer-0': { duration: 23, travelMode: 'walk', description: '같은 구간' }, 'transfer-1': { duration: 17, travelMode: 'car' } } } });
  const added = planner.addEvent({ city, itinerary, dayIndex: 0, type: 'place', placeId: city.areas[0].places[3].id }); itinerary = added.itinerary;
  const expected = ['place-0', 'place-1', added.eventId, 'place-2'], costs = graph(visitIds(itinerary.days[0]), 50);
  for (let index = 1; index < expected.length; index++) costs[`${expected[index - 1]}>${expected[index]}`] = 1;
  const result = planner.proposeVisitOrder({ city, itinerary, dayIndex: 0, mode: 'car', costs });
  assert.equal(result.changed, true);
  assert.equal(result.itinerary.days[0].events.find(event => event.id === 'transfer-0').duration, 23);
  assert.equal(result.itinerary.days[0].events.find(event => event.id === 'transfer-1').duration, 0);
});

test('new recommendations prioritize only verified preferred themes and do not persist the preference choice', () => {
  const { city, planner, create } = runtime(), places = city.areas[0].places;
  places[3].theme = 'nature'; places[4].theme = 'nature'; places[5].theme = 'rest';
  const original = create({ selections: {} }), nature = create({ selections: {}, preferences: ['nature'] }), rest = create({ selections: {}, preferences: ['rest'] });
  assert.equal(original.ok, true); assert.equal(nature.ok, true); assert.equal(rest.ok, true);
  assert.ok(placeIds(nature.days[0]).includes(places[3].id)); assert.ok(placeIds(nature.days[0]).includes(places[4].id));
  assert.equal(placeIds(rest.days[0])[0], places[5].id);
  assert.equal(Object.hasOwn(nature, 'preferences'), false); assert.equal(Object.hasOwn(nature, 'recommendationMatches'), false);
  assert.notDeepEqual(placeIds(nature.days[0]), placeIds(original.days[0]));
  const changed = planner.updateEvent({ city, itinerary: nature, dayIndex: 0, eventId: 'place-0', description: '선택 유지' });
  assert.equal(changed.ok, true); assert.deepEqual(placeIds(changed.itinerary.days[0]), placeIds(nature.days[0]));
});

test('culture uses explicit official type 14, never category labels or tourist title guesses', () => {
  const { city, create } = runtime(), places = city.areas[0].places;
  places[0].name = '문화 박물관 자연 공원 휴양림'; places[0].category = '문화시설'; places[4].contentTypeId = '14';
  const result = create({ selections: {}, preferences: ['culture'] });
  assert.equal(result.ok, true); assert.equal(placeIds(result.days[0])[0], places[4].id);
});

test('no matching classification falls back exactly, while explicit saved selections remain unchanged for every preference', () => {
  const { city, create } = runtime(), baseline = create({ selections: {} });
  assert.deepEqual(plain(create({ selections: {}, preferences: ['nature'] })), plain(baseline));
  for (const preference of ['nature', 'culture', 'rest']) {
    city.areas[0].places[5].theme = preference;
    const selected = create({ preferences: [preference] }); assert.deepEqual(placeIds(selected.days[0]), city.areas[0].places.slice(0, 3).map(place => place.id));
  }
  for (const preferences of [null, 'nature', ['unknown'], ['nature', 'nature'], ['nature', 'culture', 'rest', 'nature']]) assert.equal(create({ preferences }).ok, false);
});

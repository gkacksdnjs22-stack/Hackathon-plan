import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const window = {};
vm.runInNewContext(readFileSync(new URL('note-tools.js', import.meta.url), 'utf8'), { window, Intl, Date });
const tools = window.TravelNoteTools;

test('countdown uses calendar dates in the destination timezone across midnight, years and leap days', () => {
  const now = new Date('2026-10-20T15:01:00Z');
  assert.equal(tools.countdown('2026-10-22', 1, 'Asia/Seoul', now), 'D-1');
  assert.equal(tools.countdown('2026-10-21', 1, 'Asia/Seoul', now), '오늘 출발');
  assert.equal(tools.countdown('2026-10-20', 3, 'Asia/Seoul', now), '여행 중');
  assert.equal(tools.countdown('2026-10-20', 1, 'Asia/Seoul', now), '지난 여행');
  assert.equal(tools.countdown('2027-01-01', 1, 'Asia/Seoul', new Date('2026-12-31T03:00:00Z')), 'D-1');
  assert.equal(tools.countdown('2028-03-01', 1, 'Asia/Seoul', new Date('2028-02-28T03:00:00Z')), 'D-2');
});

test('day summary separates place stays and known travel from zero-minute pending legs without double counting arrivals', () => {
  const result = tools.daySummary({ events: [
    { type: 'departure', duration: 120 }, { type: 'arrival', duration: 0 },
    { type: 'transfer', duration: 25 }, { type: 'transfer', duration: 0 },
    { type: 'place', duration: 60 }, { type: 'place', duration: 90 },
    { type: 'meal', duration: 60 }, { type: 'rest', duration: 30 }, { type: 'finish', duration: 15 }
  ] });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { places: 2, stay: 150, travel: 145, pending: 1 });
});

test('pending transfers derive only unresolved active legs across days without counting instant markers or excluded events', () => {
  const note = { days: [
    { events: [
      { id: 'departure', type: 'departure', duration: 0 }, { type: 'place', place: { name: '첫 공원' } },
      { id: 'extra-1', type: 'transfer', title: '버스 이동', duration: 0 }, { type: 'place', place: { name: '박물관' } },
      { id: 'rest', type: 'rest', duration: 0 }, { id: 'finish', type: 'finish', duration: 0 }
    ], hiddenEvents: [{ id: 'extra-2', type: 'transfer', duration: 0 }] },
    { departure: { mode: 'train', name: '출발역' }, events: [{ id: 'departure', type: 'departure', duration: 90 }] },
    { departure: { mode: 'car', name: '숙소' }, events: [
      { id: 'departure', type: 'departure', duration: 10 }, { id: 'arrival', type: 'arrival', duration: 0 },
      { id: 'extra-3', type: 'transfer', duration: 12 }
    ] }
  ] };
  const before = JSON.stringify(note), pending = JSON.parse(JSON.stringify(tools.pendingTransfers(note)));
  assert.deepEqual(pending, [
    { dayIndex: 0, eventId: 'departure', title: '출발지 → 첫 공원', reason: '출발지 미정 · 이동시간 미정', target: 'departure' },
    { dayIndex: 0, eventId: 'extra-1', title: '첫 공원 → 박물관', reason: '이동시간 미정', target: 'time' },
    { dayIndex: 1, eventId: 'departure', title: '출발역 → 도착지', reason: '도착지 미정', target: 'arrival' }
  ]);
  assert.equal(JSON.stringify(note), before);
});

test('pending transfers separate arrival-to-first-place from intercity travel and retain the title of a final custom move', () => {
  const origin = { mode: 'train', name: '출발역' }, arrival = { name: '도착역' };
  const result = tools.pendingTransfers({ days: [{ departure: origin, arrival, events: [
    { id: 'departure', type: 'departure', duration: 90 }, { id: 'arrival', type: 'arrival', arrival, duration: 0 },
    { id: 'arrival-transfer', type: 'transfer', duration: 0 }, { type: 'place', place: { name: '공원' } },
    { id: 'extra-1', type: 'transfer', title: '숙소로 이동', duration: 0 }
  ] }] });
  assert.equal(result.length, 2); assert.equal(result[0].title, '도착역 → 공원');
  assert.equal(result[1].title, '숙소로 이동');
});

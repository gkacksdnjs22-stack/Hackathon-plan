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

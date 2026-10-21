import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const window = { crypto };
vm.runInContext(readFileSync(new URL('itinerary-export.js', import.meta.url), 'utf8'), vm.createContext({ window, Date, TextEncoder }));
const exports = window.TravelItineraryExport;
const options = { now: new Date('2026-10-21T01:02:03Z'), exportId: 'test-export' };
const unfold = value => value.replace(/\r\n /g, '');
const event = (overrides = {}) => ({ id: 'free-0', type: 'free', title: '야경 산책', description: '저장한 메모', duration: 90, start: 1410, end: 1500, ...overrides });
const note = (overrides = {}) => ({ cityName: '서울', startDate: '2026-12-31', dayCount: 2, days: [
  { events: [event()], hiddenEvents: [event({ title: '뺀 일정' })], timesProvisional: false },
  { events: [event({ id: 'extra-one', title: '직접 추가한 일정', start: 540, end: 630 })], timesProvisional: false }
], ...overrides });

test('text exports selected or all days, current event order, addresses and edited memos without hidden events or mutations', () => {
  const trip = note();
  trip.days[0].events.push(event({ id: 'place-0', type: 'place', place: { name: '남산', address: '서울 중구', intro: '관광 소개' }, description: '수정한 메모' }));
  const before = JSON.stringify(trip), first = exports.text(trip, 0), all = exports.text(trip);
  assert.match(first, /2026-12-31 · Day 01/);
  assert.match(first, /23:30–다음 날 01:00 야경 산책/);
  assert.match(first, /주소: 서울 중구\n  수정한 메모/);
  assert.ok(first.indexOf('야경 산책') < first.indexOf('남산'));
  assert.doesNotMatch(first, /관광 소개|직접 추가한 일정|뺀 일정/);
  assert.match(all, /2027-01-01 · Day 02/);
  assert.match(all, /직접 추가한 일정/);
  assert.equal(JSON.stringify(trip), before);
});

test('calendar uses UTC instants for Korean dates across midnight and year boundaries', () => {
  const trip = note(), before = JSON.stringify(trip);
  const first = exports.calendar(trip, 0, options), all = exports.calendar(trip, null, options);
  assert.match(first, /DTSTART:20261231T143000Z\r\nDTEND:20261231T160000Z/);
  assert.match(first, /DTSTAMP:20261021T010203Z/);
  assert.equal((first.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.equal((all.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(all, /DTSTART:20270101T000000Z/);
  assert.match(all, /UID:test-export-2@gil/);
  assert.equal(new Set([...all.matchAll(/UID:(.*)/g)].map(match => match[1])).size, 2);
  assert.ok(first.endsWith('END:VCALENDAR\r\n'));
  assert.doesNotMatch(first, /(?<!\r)\n/);
  assert.doesNotMatch(unfold(first), /뺀 일정|직접 추가한 일정/);
  assert.equal(JSON.stringify(trip), before);
});

test('calendar advances leap days, multiple overflow days and Korean early morning into the previous UTC date', () => {
  const trip = note({ startDate: '2028-02-28', days: [{ events: [event({ start: 60, end: 120 }), event({ start: 2940, end: 3000 })] }, { events: [event({ start: 540, end: 600 })] }] });
  const all = exports.calendar(trip, null, options);
  assert.match(all, /DTSTART:20280227T160000Z/);
  assert.match(all, /DTSTART:20280229T160000Z/);
  assert.match(all, /DTSTART:20280229T000000Z/);
  assert.match(exports.text(trip), /2일 후 01:00/);
});

test('calendar escapes user content and folds Korean and emoji at 75 UTF-8 octets without allowing property injection', () => {
  const malicious = '메모,쉼표;세미콜론\\역슬래시\r\nEND:VEVENT\r\nBEGIN:VEVENT\n😀'.repeat(12);
  const trip = note({ days: [{ events: [event({ title: malicious, description: malicious, place: { address: malicious } })] }] });
  const file = exports.calendar(trip, 0, options), plain = unfold(file);
  for (const line of file.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, line);
  assert.equal((plain.match(/\r\nBEGIN:VEVENT\r\n/g) || []).length, 1);
  assert.equal((plain.match(/\r\nEND:VEVENT\r\n/g) || []).length, 1);
  assert.match(plain, /메모\\,쉼표\\;세미콜론\\\\역슬래시\\nEND:VEVENT\\nBEGIN:VEVENT\\n😀/);
  assert.ok(!file.includes('\uFFFD'));
  assert.equal(Buffer.from(file).toString('utf8'), file);
});

test('unknown travel remains explicitly tentative and zero-duration markers do not invent end times', () => {
  const trip = note({ days: [{ timesProvisional: true, events: [
    event({ type: 'transfer', title: '다음 장소로 이동', duration: 0, start: 540, end: 540 }),
    event({ type: 'finish', title: '마무리', duration: 0, start: 600, end: 600 }), event({ start: 540, end: 630 })
  ] }] });
  const file = unfold(exports.calendar(trip, 0, options));
  assert.equal((file.match(/DTEND:/g) || []).length, 1);
  assert.equal((file.match(/STATUS:TENTATIVE/g) || []).length, 3);
  assert.match(file, /SUMMARY:\[임시 시각\] 다음 장소로 이동 \[이동시간 미정\]/);
  assert.match(file, /실제 0분을 뜻하지 않아요/);
  assert.match(exports.text(trip), /09:00 다음 장소로 이동 \[이동시간 미정\]/);
});

test('invalid dates, scopes, time ranges and unsupported time zones fail before a misleading calendar is produced', () => {
  assert.throws(() => exports.text(note({ startDate: '2026-02-30' })), /여행 날짜/);
  for (const index of [-1, 2, '0', 0.5]) assert.throws(() => exports.text(note(), index), /날짜를 다시/);
  assert.throws(() => exports.calendar(note(), 0, { ...options, timeZone: 'Europe/Paris' }), /한국 시간/);
  assert.throws(() => exports.calendar(note({ days: [{ events: [event({ start: 10, end: 9 })] }] }), 0, options), /일정 시각/);
  assert.throws(() => exports.text(note({ days: [] })), /내보낼 일정/);
  assert.equal(exports.filename(note({ cityName: '서울/중구:여행' }), 1), '길_서울_중구_여행_2026-12-31_Day02.ics');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('connection-ui.js', import.meta.url), 'utf8');
const plannerCode = readFileSync(new URL('planner.js', import.meta.url), 'utf8');
const transportCode = readFileSync(new URL('transport-ui.js', import.meta.url), 'utf8');
const departureCode = readFileSync(new URL('departure-ui.js', import.meta.url), 'utf8');
const configs = { train: ['train', '15098552'], express: ['bus', '15098522'], intercity: ['bus', '15098541'], flight: ['flight', '15098526'], ferry: ['ferry', '15098523'] };
const date = '2026-10-20';
function stop(providerId, name, service = 'train') {
  return { id: `tago-${service}-${providerId}`, providerId, service, mode: configs[service][0], name, address: '',
    latitude: null, longitude: null, source: 'TAGO', sourceUrl: `https://www.data.go.kr/data/${configs[service][1]}/openapi.do` };
}
const origin = stop('ORIGIN', '조치원역'), via = stop('VIA', '대전역'), destination = stop('DEST', '포항역');
function trip(from = origin, to = via, overrides = {}) {
  return { id: `${from.providerId}-${to.providerId}-trip`, service: from.service, departureId: from.providerId,
    arrivalId: to.providerId, departureName: from.name, arrivalName: to.name, date,
    departureMinutes: 540, arrivalMinutes: 600, durationMinutes: 60, tripNo: 'T101', grade: '일반',
    source: 'TAGO', sourceUrl: from.sourceUrl, fetchedAt: '2026-10-20T00:00:00.000Z', ...overrides };
}
const firstTrip = () => trip();
const secondTrip = (overrides = {}) => trip(via, destination, { departureMinutes: 630, arrivalMinutes: 750, durationMinutes: 120, ...overrides });

class Element {
  constructor(tagName) {
    this.tagName = tagName; this.children = []; this.parentNode = null; this.className = ''; this._text = '';
    this.attributes = new Map(); this.listeners = new Map(); this.hidden = false; this.disabled = false; this.open = false;
    this.value = ''; this.inert = false;
    this.classList = { toggle: (name, force) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      const active = force === undefined ? !classes.has(name) : force;
      if (active) classes.add(name); else classes.delete(name); this.className = [...classes].join(' '); return active;
    } };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = []; this._text = ''; this.append(...children);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  dispatch(type, extra = {}) { for (const handler of this.listeners.get(type) || []) handler({ type, target: this, ...extra }); }
}
function find(root, className) {
  if (root.className.split(/\s+/).includes(className)) return root;
  for (const child of root.children) { const match = find(child, className); if (match) return match; }
  return null;
}
const settle = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
const plain = value => JSON.parse(JSON.stringify(value));

function runtime(options = {}, { usePlanner = true } = {}) {
  const viaMounts = [], transportMounts = [], fetches = [];
  const window = {};
  const context = vm.createContext({ window, document: { createElement: name => new Element(name) }, Intl,
    fetch: (...args) => { fetches.push(args); throw new Error('connection wrapper must not fetch'); } });
  if (usePlanner) vm.runInContext(plannerCode, context, { filename: 'planner.js' });
  window.TravelDeparture = { mount: (host, settings) => {
    const marker = new Element('div'); marker.className = 'test-via-marker'; host.append(marker);
    const record = { host, settings, selected: settings.departure, destroyed: false, setValues: [] }; viaMounts.push(record);
    return { set: value => { record.selected = value; record.setValues.push(value); }, destroy: () => { record.destroyed = true; host.replaceChildren(); } };
  } };
  window.TravelTransport = { mount: (host, settings) => {
    const marker = new Element('div'); marker.className = 'test-trip-marker'; host.append(marker);
    const record = { host, settings, destroyed: false }; transportMounts.push(record);
    return { destroy: () => { record.destroyed = true; host.replaceChildren(); } };
  } };
  vm.runInContext(code, context, { filename: 'connection-ui.js' });
  const host = new Element('div');
  const widget = window.TravelConnections.mount(host, { date, departure: origin, arrival: destination, onApply: () => ({ ok: true }), ...options });
  const findIn = name => find(host, name);
  const activeLeg = number => transportMounts.findLast(record => !record.destroyed && record.host.className === (number === 1 ? 'connection-first-leg' : 'connection-second-leg'));
  const chooseVia = value => viaMounts[0].settings.onChange(value);
  const chooseLeg = (number, value) => activeLeg(number).settings.onApply(value);
  const setGap = value => { const input = findIn('connection-gap'); input.value = String(value); input.dispatch('change'); };
  const setDate = value => { const input = findIn('connection-date'); input.value = value; input.dispatch('change'); };
  return { host, widget, window, viaMounts, transportMounts, fetches, find: findIn, activeLeg, chooseVia, chooseLeg, setGap, setDate };
}
function complete(app, first = firstTrip(), second = secondTrip()) {
  app.chooseVia(via); assert.equal(app.chooseLeg(1, first).ok, true); assert.equal(app.chooseLeg(2, second).ok, true);
}

test('a connection starts closed, searches one same-service via, and stores the two trip drafts without applying the itinerary', async () => {
  const applied = [], app = runtime({ onApply: value => { applied.push(value); return { ok: true }; } });
  assert.equal(app.find('connection-lookup').open, false); assert.equal(app.viaMounts.length, 1); assert.equal(app.transportMounts.length, 0);
  const settings = app.viaMounts[0].settings;
  assert.equal(settings.role, 'arrival'); assert.equal(settings.mode, 'train'); assert.equal(settings.service, 'train'); assert.equal(settings.heading, '환승역');
  assert.equal(app.find('connection-gap').value, '15'); assert.equal(app.find('connection-apply').hidden, true);
  app.chooseVia(via); assert.equal(app.activeLeg(1).settings.departure.providerId, 'ORIGIN'); assert.equal(app.activeLeg(1).settings.arrival.providerId, 'VIA');
  assert.equal(app.activeLeg(1).settings.startTime, '00:00');
  assert.equal(app.activeLeg(1).settings.draft, true);
  assert.equal(app.chooseLeg(1, firstTrip()).ok, true);
  assert.equal(app.activeLeg(1).settings.transport.id, firstTrip().id);
  assert.equal(app.activeLeg(2).settings.date, date); assert.equal(app.activeLeg(2).settings.startTime, '10:15');
  assert.equal(app.activeLeg(2).settings.draft, true);
  assert.equal(app.chooseLeg(2, secondTrip()).ok, true); assert.equal(applied.length, 0);
  assert.match(app.find('connection-preview').textContent, /1구간 조치원역 → 대전역/);
  assert.match(app.find('connection-preview').textContent, /2구간 대전역 → 포항역/);
  assert.match(app.find('connection-preview').textContent, /환승 대기 30분 · 총 이동 3시간 30분/);
  assert.equal(app.find('connection-apply').hidden, false); assert.equal(app.fetches.length, 0);
  app.find('connection-apply').dispatch('click'); await settle();
  assert.equal(applied.length, 1); assert.equal(applied[0].via.providerId, 'VIA'); assert.equal(applied[0].legs.length, 2);
  assert.equal(applied[0].legs[0].id, firstTrip().id); assert.equal(applied[0].legs[1].id, secondTrip().id);
  assert.equal(applied[0].minimumTransferMinutes, 15); assert.equal(Object.hasOwn(applied[0], 'transport'), false);
  app.widget.destroy();
});

test('missing official endpoints, different services and legacy map locations do not create lookup widgets', () => {
  for (const options of [
    { departure: null }, { arrival: null }, { departure: { ...origin, source: 'OpenStreetMap' } },
    { arrival: stop('OTHER', '다른 터미널', 'express') }, { arrival: { ...destination, providerId: origin.providerId, id: origin.id } },
    { date: '2026-02-30' }, { departure: { ...origin, sourceUrl: 'https://invalid.example' } }
  ]) {
    const app = runtime(options); assert.equal(app.viaMounts.length, 0); assert.equal(app.transportMounts.length, 0); assert.equal(app.fetches.length, 0);
    assert.match(app.find('connection-note').textContent, /교통기관 목록에서 같은 종류/); assert.equal(app.find('connection-apply').hidden, true); app.widget.destroy();
  }
});

test('each official service limits via selection to its own catalog and uses its matching heading', () => {
  for (const [service, heading] of [['train', '환승역'], ['express', '환승터미널'], ['intercity', '환승터미널'], ['flight', '환승공항'], ['ferry', '환승항구']]) {
    const app = runtime({ departure: stop('A', '처음', service), arrival: stop('B', '마지막', service) });
    assert.equal(app.viaMounts[0].settings.service, service); assert.equal(app.viaMounts[0].settings.heading, heading);
    assert.equal(app.viaMounts[0].settings.mode, configs[service][0]); app.widget.destroy();
  }
});

test('via endpoints, cross-service stops and spoofed IDs are rejected without replacing a valid draft', () => {
  const app = runtime(); complete(app);
  const oldFirst = app.activeLeg(1);
  for (const invalid of [origin, destination, stop('AIR', '대전역', 'flight'), { ...via, providerId: 'changed' }, { ...via, source: 'OpenStreetMap' }]) {
    app.chooseVia(invalid); assert.equal(app.activeLeg(1), oldFirst); assert.equal(app.viaMounts[0].setValues.at(-1).providerId, 'VIA');
    assert.match(app.find('connection-message').textContent, /다른 환승 장소/);
  }
  const otherVia = stop('OTHER', '조치원역'); app.chooseVia(otherVia);
  assert.equal(app.activeLeg(1).settings.arrival.providerId, 'OTHER', 'station identity uses provider ID rather than station-name matching');
  assert.equal(app.activeLeg(1).settings.transport, null); assert.equal(app.activeLeg(2), undefined); assert.equal(app.find('connection-apply').hidden, true);
  app.widget.destroy();
});

test('increasing transfer margin invalidates an insufficient second leg without shifting its actual times', () => {
  const app = runtime(); const originalSecond = secondTrip(); complete(app, firstTrip(), originalSecond);
  app.setGap(20); assert.equal(app.activeLeg(2).settings.transport.departureMinutes, 630); assert.equal(app.find('connection-apply').hidden, false);
  app.setGap(60); assert.equal(app.activeLeg(1).settings.transport.arrivalMinutes, 600); assert.equal(app.activeLeg(2).settings.startTime, '11:00');
  assert.equal(app.activeLeg(2).settings.transport, null); assert.equal(app.find('connection-apply').hidden, true);
  assert.match(app.find('connection-message').textContent, /두 번째 편을 다시 선택/); assert.equal(originalSecond.departureMinutes, 630);
  assert.equal(app.chooseLeg(2, originalSecond).ok, false); assert.equal(app.find('connection-apply').hidden, true);
  app.setGap(181); assert.equal(app.find('connection-gap').value, '60'); assert.match(app.find('connection-message').textContent, /0~180분/);
  app.setGap(''); assert.equal(app.find('connection-gap').value, '60'); app.widget.destroy();
});

test('an overnight first arrival uses its actual next-day date and transfer margin for the second search', () => {
  const app = runtime(); app.chooseVia(via);
  const first = firstTrip(); Object.assign(first, { departureMinutes: 1430, arrivalMinutes: 1470, durationMinutes: 40 });
  assert.equal(app.chooseLeg(1, first).ok, true);
  assert.equal(app.activeLeg(2).settings.date, '2026-10-21'); assert.equal(app.activeLeg(2).settings.startTime, '00:45');
  assert.equal(app.find('connection-date').min, '2026-10-21'); assert.equal(app.find('connection-date').max, '2026-10-22');
  const second = secondTrip({ date: '2026-10-21', departureMinutes: 60, arrivalMinutes: 180 });
  assert.equal(app.chooseLeg(2, second).ok, true);
  assert.match(app.find('connection-preview').textContent, /2026\.10\.20 23:50 → 2026\.10\.21 00:30/);
  assert.match(app.find('connection-preview').textContent, /환승 대기 30분 · 총 이동 3시간 10분/);
  app.widget.destroy();
});

test('a late arrival plus transfer margin searches next day rather than wrapping the clock on the wrong date', () => {
  const app = runtime(); app.chooseVia(via);
  assert.equal(app.chooseLeg(1, firstTripWith({ departureMinutes: 1400, arrivalMinutes: 1435 })).ok, true);
  assert.equal(app.activeLeg(2).settings.date, '2026-10-21'); assert.equal(app.activeLeg(2).settings.startTime, '00:10');
  assert.equal(app.find('connection-date').min, '2026-10-20'); assert.equal(app.find('connection-date').max, '2026-10-21');
  app.setDate('2026-10-20'); assert.equal(app.activeLeg(2), undefined);
  assert.match(app.find('connection-date-hint').textContent, /2026\.10\.21 00:10 이후/);
  app.setDate('2026-10-21'); assert.equal(app.activeLeg(2).settings.startTime, '00:10');
  app.widget.destroy();
});
function firstTripWith(overrides) { const item = firstTrip(); Object.assign(item, overrides); item.durationMinutes = item.arrivalMinutes - item.departureMinutes; return item; }

test('choosing the next date clears the second leg and permits all next-day departures; invalid dates are restored', () => {
  const app = runtime(); complete(app); app.setDate('2026-10-21');
  assert.equal(app.activeLeg(2).settings.date, '2026-10-21'); assert.equal(app.activeLeg(2).settings.startTime, '00:00');
  assert.equal(app.activeLeg(2).settings.transport, null); assert.equal(app.find('connection-apply').hidden, true);
  app.setDate('2026-10-22'); assert.equal(app.find('connection-date').value, '2026-10-21');
  assert.match(app.find('connection-message').textContent, /도착하는 날이나 다음 날/);
  app.setDate('2026-02-30'); assert.equal(app.find('connection-date').value, '2026-10-21'); app.widget.destroy();
});

test('zero-minute margin is explicit and accepts a simultaneous connection without inventing wait time', () => {
  const app = runtime(); app.chooseVia(via); app.chooseLeg(1, firstTrip()); app.setGap(0);
  assert.equal(app.activeLeg(2).settings.startTime, '10:00');
  assert.equal(app.chooseLeg(2, secondTrip({ departureMinutes: 600, arrivalMinutes: 720 })).ok, true);
  assert.match(app.find('connection-preview').textContent, /환승 대기 0분 · 총 이동 3시간/); assert.equal(app.find('connection-apply').hidden, false);
  app.widget.destroy();
});

test('restoring an aggregate connection restores the via and both raw selected trips without a fresh query', () => {
  const connection = { via, legs: [firstTrip(), secondTrip()], minimumTransferMinutes: 20 };
  const app = runtime({ transport: { id: 'aggregate', connection } });
  assert.equal(app.viaMounts[0].settings.departure.providerId, 'VIA'); assert.equal(app.find('connection-gap').value, '20');
  assert.equal(app.activeLeg(1).settings.transport.id, firstTrip().id); assert.equal(app.activeLeg(2).settings.transport.id, secondTrip().id);
  assert.equal(app.activeLeg(2).settings.startTime, '10:20'); assert.equal(app.find('connection-apply').hidden, false);
  assert.equal(app.fetches.length, 0); assert.equal(app.find('connection-lookup').open, false); app.widget.destroy();
  const bad = runtime({ transport: { connection: { ...connection, minimumTransferMinutes: 90 } } });
  assert.equal(bad.viaMounts[0].settings.departure, null); assert.equal(bad.transportMounts.length, 0); assert.equal(bad.find('connection-apply').hidden, true); bad.widget.destroy();
});

test('clearing a draft leg or the via removes dependent choices without calling the itinerary apply callback', () => {
  let applied = 0; const app = runtime({ onApply: () => { applied++; return { ok: true }; } }); complete(app);
  const oldSecond = app.activeLeg(2); assert.equal(oldSecond.settings.onClear().ok, true);
  assert.equal(oldSecond.destroyed, true); assert.equal(app.activeLeg(1).settings.transport.id, firstTrip().id); assert.equal(app.activeLeg(2).settings.transport, null);
  app.chooseLeg(2, secondTrip()); assert.equal(app.activeLeg(1).settings.onClear().ok, true);
  assert.equal(app.activeLeg(1).settings.transport, null); assert.equal(app.activeLeg(2), undefined);
  app.chooseVia(null); assert.equal(app.activeLeg(1), undefined); assert.equal(app.find('connection-apply').hidden, true); assert.equal(applied, 0); app.widget.destroy();
});

test('trip provenance, dates, IDs and complete raw format are checked before storing a draft', () => {
  const app = runtime(); app.chooseVia(via);
  for (const item of [firstTripWith({ arrivalId: 'DEST' }), firstTripWith({ date: '2026-10-21' }), firstTripWith({ source: 'fake' }),
    firstTripWith({ fetchedAt: 'bad date' }), firstTripWith({ connection: null }), firstTripWith({ extra: 'unexpected' })]) {
    assert.equal(app.chooseLeg(1, item).ok, false); assert.equal(app.activeLeg(2), undefined);
  }
  app.chooseLeg(1, firstTrip());
  assert.equal(app.chooseLeg(2, secondTrip({ departureMinutes: 610, arrivalMinutes: 730 })).ok, false);
  assert.equal(app.chooseLeg(2, secondTrip({ date: '2026-10-21' })).ok, false, 'selected date must match the mounted second search');
  assert.equal(app.find('connection-apply').hidden, true); app.widget.destroy();
});

test('only the final explicit apply invokes persistence; while pending all mutable nested controls are inert', async () => {
  let finish, count = 0;
  const app = runtime({ onApply: () => { count++; return new Promise(resolve => { finish = resolve; }); } }); complete(app);
  app.find('connection-apply').dispatch('click'); app.find('connection-apply').dispatch('click'); await settle();
  assert.equal(count, 1); assert.equal(app.find('connection-apply').disabled, true); assert.equal(app.find('connection-gap').disabled, true);
  assert.equal(app.find('connection-via').inert, true); assert.equal(app.find('connection-legs').inert, true);
  app.setGap(90); app.chooseVia(null); assert.equal(app.activeLeg(1).settings.transport.id, firstTrip().id);
  finish({ ok: false, reason: '다음 일정과 겹쳐요.' }); await settle();
  assert.equal(app.find('connection-via').inert, false); assert.equal(app.find('connection-apply').disabled, false);
  assert.equal(app.find('connection-message').textContent, '다음 일정과 겹쳐요.'); app.widget.destroy();
});

test('persistence exceptions and untrusted names or reasons render safe text', async () => {
  const html = '<img src=x onerror=alert(1)>', htmlVia = { ...via, name: html };
  let shouldThrow = false;
  const app = runtime({ onApply: () => { if (shouldThrow) throw new Error('private-value'); return { ok: false, reason: html }; } });
  app.chooseVia(htmlVia); app.chooseLeg(1, trip(origin, htmlVia)); app.chooseLeg(2, trip(htmlVia, destination, { departureMinutes: 630, arrivalMinutes: 750, durationMinutes: 120 }));
  assert.match(app.find('connection-summary-preview').textContent, /<img/); app.find('connection-apply').dispatch('click'); await settle();
  assert.equal(app.find('connection-message').textContent, html); assert.equal(app.find('connection-message').children.length, 0);
  shouldThrow = true; app.find('connection-apply').dispatch('click'); await settle();
  assert.match(app.find('connection-message').textContent, /適用|適用|적용하지 못했어요/); assert.doesNotMatch(app.host.textContent, /private-value/);
  const tags = []; const visit = node => { tags.push(node.tagName); node.children.forEach(visit); }; visit(app.host);
  assert.equal(tags.includes('img'), false); assert.equal(tags.includes('script'), false); app.widget.destroy();
});

test('synchronous parent rerender and late asynchronous persistence results leave replacement content intact', async () => {
  let app; app = runtime({ onApply: () => { app.widget.destroy(); return { ok: true }; } }); complete(app);
  app.find('connection-apply').dispatch('click'); await settle(); assert.equal(app.host.children.length, 0);
  let finish; const second = runtime({ onApply: () => new Promise(resolve => { finish = resolve; }) }); complete(second);
  second.find('connection-apply').dispatch('click'); await settle(); second.widget.destroy();
  const replacement = new Element('p'); replacement.textContent = '새 일정'; second.host.append(replacement);
  finish({ ok: true }); await settle(); assert.equal(second.host.textContent, '새 일정');
});

test('destroy cancels every nested widget and removes dynamic input listeners', () => {
  const app = runtime(); complete(app); const input = app.find('connection-date'), gap = app.find('connection-gap'), apply = app.find('connection-apply');
  app.widget.destroy(); app.widget.destroy();
  assert.equal(app.viaMounts[0].destroyed, true); assert.ok(app.transportMounts.every(record => record.destroyed));
  assert.equal(input.listeners.get('change').size, 0); assert.equal(gap.listeners.get('change').size, 0); assert.equal(apply.listeners.get('click').size, 0);
  assert.equal(app.host.children.length, 0); app.viaMounts[0].settings.onChange(via); assert.equal(app.host.children.length, 0);
});

function transportRuntime({ draft = false, filtered = false } = {}) {
  const context = vm.createContext({ window: {}, document: { createElement: name => new Element(name) }, Intl,
    AbortController, URLSearchParams, setTimeout: () => 1, clearTimeout: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ items: [firstTrip()] }) }) });
  vm.runInContext(plannerCode, context, { filename: 'planner.js' });
  vm.runInContext(transportCode, context, { filename: 'transport-ui.js' });
  const host = new Element('div'), selected = [];
  const widget = context.window.TravelTransport.mount(host, { date, departure: origin, arrival: via,
    startTime: filtered ? '23:59' : '00:00', transport: firstTrip(), draft, onApply: value => { selected.push(value); return { ok: true }; } });
  const details = find(host, 'transport-lookup');
  return { host, widget, details, selected, find: name => find(host, name) };
}

test('draft timetable copy describes candidate selection and final connection apply while direct-trip copy remains unchanged', async () => {
  for (const draft of [false, true]) {
    const app = transportRuntime({ draft });
    if (draft) {
      assert.match(app.find('transport-footnote').textContent, /‘환승 일정 적용’을 눌러/);
      assert.match(app.find('transport-preview').textContent, /환승 후보 선택됨/);
      assert.match(app.find('transport-controls').textContent, /이 구간 선택 취소/);
    } else {
      assert.equal(app.find('transport-footnote').textContent, '운행시간표 기준 예상이에요. 교통편을 선택하면 출발 시각과 뒤 일정이 함께 조정돼요.');
      assert.match(app.find('transport-controls').textContent, /직접 입력으로 전환/);
    }
    app.details.open = true; app.details.dispatch('toggle'); await settle();
    assert.match(app.find('transport-message').textContent, draft ? /환승 후보로 선택해요/ : /선택해서 예상시간을 반영해요/);
    assert.equal(app.selected.length, 0); app.find('transport-trip').dispatch('click'); assert.equal(app.selected.length, 1);
    app.widget.destroy();
  }
});

test('a filtered draft suggests checking the connection margin and date instead of changing or manually entering a trip time', async () => {
  for (const draft of [false, true]) {
    const app = transportRuntime({ draft, filtered: true }); app.details.open = true; app.details.dispatch('toggle'); await settle();
    if (draft) {
      assert.match(app.find('transport-message').textContent, /환승 여유시간·앞 구간의 도착 시각이나 조회 날짜/);
      assert.doesNotMatch(app.find('transport-message').textContent, /앞당기거나|직접 입력/);
    } else assert.equal(app.find('transport-message').textContent, '선택한 출발 시각 이후에 조회된 편이 없어요. 출발 시각을 앞당기거나 직접 입력해 주세요.');
    assert.equal(app.find('transport-results').children.length, 0); app.widget.destroy();
  }
});

// Reuse the UI element harness, adding only the tree operations needed by the
// trusted departure template. No browser HTML or scripts are executed here.
class DepartureElement extends Element {
  constructor(tag) { super(tag); this.dataset = {}; }
  set innerHTML(markup) {
    this.replaceChildren();
    const stack = [this], voidTags = new Set(['input', 'br', 'hr', 'img']);
    for (const match of markup.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
      const [, closing, tag, attributes] = match;
      if (closing) { if (stack.at(-1).tagName === tag) stack.pop(); continue; }
      const element = new DepartureElement(tag);
      for (const attribute of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
        const [, name, value = ''] = attribute;
        if (name === 'class') element.className = value;
        else if (name === 'hidden' || name === 'disabled') element[name] = true;
        else element.setAttribute(name, value);
      }
      stack.at(-1).append(element);
      if (!voidTags.has(tag) && !attributes.trimEnd().endsWith('/')) stack.push(element);
    }
  }
  querySelector(selector) { return selector.startsWith('.') ? find(this, selector.slice(1)) : null; }
  closest(selector) { return this.tagName === selector ? this : this.parentNode?.closest?.(selector) ?? null; }
  contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
  focus() {}
}
function mobileDepartureRuntime(mode = 'train') {
  const calls = [], timers = new Map(); let timerId = 0, finish;
  const context = vm.createContext({ window: {}, document: { createElement: tag => new DepartureElement(tag) }, AbortController,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); } });
  vm.runInContext(departureCode, context, { filename: 'departure-ui.js' });
  const host = new DepartureElement('div'), widget = context.window.TravelDeparture.mount(host, { mode });
  const findIn = name => find(host, name);
  const enter = (extra = {}) => findIn('origin-query').dispatch('keydown', {
    key: 'Enter', keyCode: 13, isComposing: false, preventDefault() {}, stopPropagation() {}, ...extra
  });
  return { host, widget, find: findIn, enter, calls, timers, finish: response => finish(response) };
}

test('mobile regression: Korean composition Enter and keyCode 229 do not prematurely submit a departure search', async () => {
  const app = mobileDepartureRuntime(), query = app.find('origin-query'); query.value = '서울';
  query.dispatch('compositionstart');
  app.enter({ isComposing: false });
  assert.equal(app.calls.length, 0, 'mobile IME can report isComposing=false before compositionend');
  query.dispatch('compositionend');
  app.enter({ keyCode: 229 }); assert.equal(app.calls.length, 0);
  app.enter({ isComposing: true }); assert.equal(app.calls.length, 0);
  app.enter(); assert.equal(app.calls.length, 1);
  assert.equal(app.find('origin-query').getAttribute('enterkeyhint'), 'search');
  app.finish({ ok: true, json: async () => ({ items: [] }) }); await settle();
  assert.match(app.find('origin-message').textContent, /검색 결과가 없어요/);
  app.widget.destroy(); assert.equal(app.timers.size, 0);
});

test('mobile regression: late departure results after timeout cannot replace the error or become selectable', async () => {
  for (const [mode, deadline] of [['train', 25000], ['car', 15000]]) {
    const app = mobileDepartureRuntime(mode); app.find('origin-query').value = '서울'; app.enter();
    assert.equal(app.calls.length, 1);
    const timer = [...app.timers.values()][0]; assert.equal(timer.delay, deadline);
    timer.callback(); assert.equal(app.calls[0][1].signal.aborted, true);
    // Deliberately ignore AbortSignal in the mocked fetch to exercise the guard.
    const result = mode === 'train' ? origin : { id: 'osm-node-123', name: '서울 숙소', address: '서울특별시 종로구',
      latitude: 37.57, longitude: 126.98, source: 'OpenStreetMap', sourceUrl: 'https://www.openstreetmap.org/node/123' };
    app.finish({ ok: true, json: async () => ({ items: [result] }) }); await settle();
    assert.equal(app.find('origin-results').children.length, 0);
    assert.match(app.find('origin-message').textContent, /검색 시간이 길어지고 있어요/);
    assert.equal(app.find('origin-search').disabled, false);
    assert.equal(app.find('origin-search').getAttribute('aria-busy'), 'false');
    app.widget.destroy(); assert.equal(app.timers.size, 0);
  }
});

test('mobile regression: a late timetable response after timeout cannot render or apply expired trip choices', async () => {
  const timers = new Map(), applied = []; let timerId = 0, finish, signal;
  const context = vm.createContext({ window: {}, document: { createElement: tag => new Element(tag) }, AbortController, URLSearchParams,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id), fetch: (_url, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  vm.runInContext(plannerCode, context, { filename: 'planner.js' });
  vm.runInContext(transportCode, context, { filename: 'transport-ui.js' });
  const host = new Element('div'), widget = context.window.TravelTransport.mount(host, {
    date, departure: origin, arrival: via, startTime: '00:00', onApply: trip => { applied.push(trip); return { ok: true }; }
  });
  const details = find(host, 'transport-lookup'); details.open = true; details.dispatch('toggle');
  [...timers.values()][0].callback(); assert.equal(signal.aborted, true);
  finish({ ok: true, json: async () => ({ items: [firstTrip()] }) }); await settle();
  assert.equal(find(host, 'transport-results').children.length, 0);
  assert.match(find(host, 'transport-message').textContent, /시간표 조회가 지연되고 있어요/);
  assert.equal(find(host, 'transport-controls').children[0].disabled, false);
  assert.equal(applied.length, 0); widget.destroy(); assert.equal(timers.size, 0);
});

test('legacy taxi and rental-car departure selections restore as the single vehicle menu choice', () => {
  const saved = { id: 'osm-node-123', name: '저장한 출발지', address: '대전광역시 유성구',
    latitude: 36.355, longitude: 127.344, source: 'OpenStreetMap', sourceUrl: 'https://www.openstreetmap.org/node/123' };
  for (const legacy of ['taxi', 'rental-car']) {
    const app = mobileDepartureRuntime(legacy), mode = app.find('departure-mode-select');
    assert.equal(mode.value, 'car');
    assert.equal(mode.children.filter(option => option.getAttribute('value') === 'car').length, 1);
    assert.equal(mode.children.some(option => ['taxi', 'rental-car'].includes(option.getAttribute('value'))), false);
    assert.equal(app.widget.set({ ...saved, mode: legacy }).mode, 'car');
    assert.equal(app.widget.get().mode, 'car'); assert.equal(app.find('day-origin-mode').textContent, '차량');
    assert.equal(app.calls.length, 0); app.widget.destroy();
  }
});


test('partial bus catalogs retain usable matches and explain the missing service', async () => {
  const app = mobileDepartureRuntime('bus'); app.find('origin-query').value = '서울'; app.enter();
  app.finish({ ok: true, json: async () => ({ items: [stop('SEOUL', '서울경부', 'express')], partial: true, unavailableServices: [{ service: 'intercity', code: 'AUTH_ERROR' }] }) });
  await settle();
  assert.match(app.find('origin-message').textContent, /시외버스 목록은 불러오지 못해 일부 결과/);
  assert.equal(app.find('origin-results').children.length, 1);
  app.widget.destroy();
});

test('missing key is explained as configuration, not an empty station search', async () => {
  const app = mobileDepartureRuntime('train'); app.find('origin-query').value = '서울'; app.enter();
  app.finish({ ok: false, status: 503, json: async () => ({ error: { code: 'KEY_MISSING', message: 'must not show raw details' } }) });
  await settle(); assert.match(app.find('origin-message').textContent, /API 설정이 아직 없어요/);
  assert.doesNotMatch(app.host.textContent, /must not show/); app.widget.destroy();
});

test('ferry schedules retain provider times with a visible operator-confirmation notice', async () => {
  const from = stop('SEA1', '출발항', 'ferry'), to = stop('SEA2', '도착항', 'ferry');
  const short = trip(from, to, { departureMinutes: 510, arrivalMinutes: 516, durationMinutes: 6 });
  const context = vm.createContext({ window: {}, document: { createElement: tag => new Element(tag) }, Intl,
    AbortController, URLSearchParams, setTimeout: () => 1, clearTimeout: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ items: [short] }) }) });
  vm.runInContext(plannerCode, context); vm.runInContext(transportCode, context);
  const host = new Element('div'), selected = [];
  const widget = context.window.TravelTransport.mount(host, { date, departure: from, arrival: to, startTime: '00:00', onApply: value => selected.push(value) });
  const details = find(host, 'transport-lookup'); details.open = true; details.dispatch('toggle'); await settle();
  assert.match(find(host, 'transport-ferry-notice').textContent, /선사에 확인/);
  find(host, 'transport-trip').dispatch('click'); assert.equal(selected[0].durationMinutes, 6);
  widget.destroy();
});

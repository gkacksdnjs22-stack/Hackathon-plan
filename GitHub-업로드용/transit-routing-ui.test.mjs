import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('transit-routing-ui.js', import.meta.url), 'utf8');
const origin = { latitude: 36.355, longitude: 127.344, name: '첫 관광지' };
const destination = { latitude: 36.36, longitude: 127.387, name: '다음 관광지' };
class Element {
  constructor(tagName) {
    this.tagName = tagName; this.children = []; this.parentNode = null; this.className = ''; this._text = '';
    this.attributes = new Map(); this.listeners = new Map(); this.open = false; this.hidden = false; this.disabled = false; this.value = '';
    this.classList = { toggle: (name, force) => { const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      const active = force === undefined ? !classes.has(name) : force; if (active) classes.add(name); else classes.delete(name); this.className = [...classes].join(' '); return active; } };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(handler); }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  dispatch(type, extra = {}) { for (const handler of this.listeners.get(type) || []) handler({ type, target: this, ...extra }); }
}
function find(root, className) {
  if (root.className.split(/\s+/).includes(className)) return root;
  for (const child of root.children) { const match = find(child, className); if (match) return match; }
  return null;
}
function step(type = 'BUS', overrides = {}) {
  return { type, guidance: '안내', durationSeconds: 1200, distanceMeters: 4000,
    stops: type === 'WALKING' ? [] : ['출발 정류장', '도착 정류장'],
    vehicles: type === 'WALKING' ? [] : [{ name: type === 'SUBWAY' ? '1호선' : '76', type: type === 'BUS' ? '마을' : '일반' }], ...overrides };
}
function route(overrides = {}) {
  return { id: 'transit-1', type: 'BUS', durationSeconds: 1501, durationMinutes: 26, distanceMeters: 4300,
    transfers: 0, steps: [step('WALKING', { durationSeconds: 301, distanceMeters: 300 }), step()], ...overrides };
}
function payload(mode = 'local-bus', routes = null, overrides = {}) {
  return { provider: '카카오맵', fetchedAt: '2026-10-20T03:00:00.000Z', origin: { latitude: origin.latitude, longitude: origin.longitude },
    destination: { latitude: destination.latitude, longitude: destination.longitude }, mode,
    routes: routes || [mode === 'subway' ? route({ type: 'SUBWAY', steps: [step('SUBWAY')] }) : route()], ...overrides };
}
function ok(data = payload()) { return { ok: true, status: 200, json: async () => data }; }
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function runtime(fetchImpl = async () => ok(), options = {}) {
  const calls = [], timers = new Map(); let timerId = 0;
  const forbiddenStorage = new Proxy({}, { get() { throw new Error('transit results must not be stored'); } });
  const context = vm.createContext({ window: { localStorage: forbiddenStorage, sessionStorage: forbiddenStorage },
    localStorage: forbiddenStorage, sessionStorage: forbiddenStorage, document: { createElement: tag => new Element(tag) },
    URLSearchParams, AbortController, Intl,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id), fetch: (...args) => { calls.push(args); return fetchImpl(...args); } });
  vm.runInContext(code, context, { filename: 'transit-routing-ui.js' });
  const host = new Element('div'), widget = context.window.TravelTransitRouting.mount(host, { origin, destination, mode: 'local-bus', ...options });
  const details = find(host, 'transit-route-lookup'), summary = details.children[0];
  const open = async (key = null) => { summary.dispatch(key ? 'keydown' : 'click', key ? { key } : {}); details.open = true; details.dispatch('toggle'); await settle(); };
  const close = () => { details.open = false; details.dispatch('toggle'); };
  return { host, widget, details, summary, open, close, calls, timers, find: name => find(host, name) };
}

test('transit lookup is explicit and display-only; manual editing receives no API time, route or other arguments', async () => {
  const edited = [], applied = [];
  const app = runtime(async () => ok(), { onEdit: (...args) => { edited.push(args); }, onApply: value => applied.push(value) });
  assert.equal(app.calls.length, 0); assert.equal(app.details.open, false);
  app.details.open = true; app.details.dispatch('toggle'); await settle(); assert.equal(app.calls.length, 0);
  app.close(); await app.open('Enter');
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0][0], '/api/transit-routes?originLatitude=36.355&originLongitude=127.344&destinationLatitude=36.36&destinationLongitude=127.387&mode=local-bus');
  assert.equal(app.calls[0][1].cache, 'no-store'); assert.ok(app.calls[0][1].signal instanceof AbortSignal);
  assert.equal(app.find('transit-route-duration').textContent, '예상 26분'); assert.equal(app.find('transit-route-distance').textContent, '거리 4.3km');
  assert.equal(app.find('transit-route-transfers').textContent, '환승 없음'); assert.equal(app.find('transit-route-type').textContent, '버스');
  assert.match(app.find('transit-route-note').textContent, /일정 시간은 직접 수정/);
  assert.doesNotMatch(app.host.textContent, /일정에 적용|시간 적용|예상 도착/);
  assert.equal(applied.length, 0); assert.equal(edited.length, 0);
  app.find('transit-route-edit').dispatch('click'); await settle(); assert.deepEqual(edited, [[]]); assert.equal(applied.length, 0);
  app.widget.destroy();
});

test('closing clears all displayed route data and reopening or retrying makes a new live request', async () => {
  const app = runtime(); await app.open();
  app.close(); assert.equal(app.find('transit-route-duration').textContent, ''); assert.equal(app.find('transit-route-distance').textContent, '');
  assert.equal(app.find('transit-route-step-list').children.length, 0); assert.equal(app.find('transit-route-select').children.length, 0);
  assert.equal(app.find('transit-route-result').hidden, true); await app.open(); assert.equal(app.calls.length, 2);
  app.find('transit-route-refresh').dispatch('click'); await settle(); assert.equal(app.calls.length, 3);
  assert.equal(app.timers.size, 0); app.widget.destroy();
});

test('fastest route is recommended first and mixed bus-subway choices show their type, transfer count and optional steps', async () => {
  const mixed = route({ id: 'transit-2', type: 'BUS_AND_SUBWAY', durationSeconds: 1200, durationMinutes: 20, transfers: 1,
    steps: [step('WALKING', { durationSeconds: 120, distanceMeters: 150 }), step('BUS'), step('SUBWAY')] });
  const app = runtime(async () => ok(payload('local-bus', [route(), mixed]))); await app.open();
  assert.equal(app.find('transit-route-choices').hidden, false);
  assert.match(app.find('transit-route-select').children[0].textContent, /추천 · 버스\+지하철 · 20분/);
  assert.equal(app.find('transit-route-type').textContent, '버스+지하철'); assert.equal(app.find('transit-route-transfers').textContent, '환승 1회');
  assert.equal(app.find('transit-route-steps').open, false); assert.match(app.find('transit-route-step-list').textContent, /버스 · 76 \(마을\)/);
  assert.match(app.find('transit-route-step-list').textContent, /지하철 · 1호선/); assert.match(app.find('transit-route-step-list').textContent, /出発|출발 정류장 → 도착 정류장/);
  const select = app.find('transit-route-select'); select.value = '1'; select.dispatch('change');
  assert.equal(app.find('transit-route-duration').textContent, '예상 26분'); assert.equal(app.find('transit-route-type').textContent, '버스');
  assert.equal(app.calls.length, 1, 'changing the viewed route never requests or persists another result'); app.widget.destroy();
});

test('subway mode accepts subway or mixed results and compact mode omits duplicate location context', async () => {
  const app = runtime(async () => ok(payload('subway')), { mode: 'subway', compact: true }); await app.open();
  assert.equal(app.find('transit-route-preview'), null); assert.equal(app.find('transit-route-heading').textContent, '대중교통 예상시간');
  assert.equal(app.find('transit-route-type').textContent, '지하철'); assert.match(app.calls[0][0], /mode=subway/);
  assert.equal(app.find('transit-route-edit').hidden, true); app.widget.destroy();
});

test('a bus step may contain many alternative lines without rejecting an otherwise valid route or expanding every alternative', async () => {
  const alternatives = Array.from({ length: 22 }, (_, index) => ({ name: String(index + 1), type: '마을' }));
  const app = runtime(async () => ok(payload('local-bus', [route({ steps: [step('BUS', { vehicles: alternatives })] })])));
  await app.open(); assert.equal(app.find('transit-route-result').hidden, false);
  assert.match(app.find('transit-route-step-list').textContent, /외 19개 노선/);
  assert.equal(app.find('transit-route-step-list').children.length, 1); app.widget.destroy();
});

test('empty, no-route and unavailable API responses keep the manual alternative and expose no upstream errors', async () => {
  for (const status of [200, 422, 401, 403, 503, 429, 504, 500]) {
    const app = runtime(async () => status === 200 ? ok(payload('local-bus', [])) : { ok: false, status, json: async () => { throw new Error('must not read unsafe error body'); } }, { onEdit: () => {} });
    await app.open(); assert.equal(app.find('transit-route-result').hidden, true); assert.equal(app.find('transit-route-refresh').disabled, false);
    assert.equal(app.find('transit-route-edit').hidden, false); assert.match(app.find('transit-route-note').textContent, /직접 수정/);
    assert.notEqual(app.find('transit-route-message').textContent, ''); assert.doesNotMatch(app.host.textContent, /unsafe|must not/); app.widget.destroy();
  }
});

test('invalid coordinates and unsupported modes never query but can still open manual editing', async () => {
  for (const options of [{ origin: null }, { origin: { latitude: '36.355', longitude: 127.344 } }, { destination: { latitude: 0, longitude: 0 } }, { mode: 'car' }]) {
    let edited = false; const app = runtime(async () => ok(), { ...options, onEdit: () => { edited = true; } });
    await app.open(); app.find('transit-route-refresh').dispatch('click'); await settle();
    assert.equal(app.calls.length, 0); assert.equal(app.find('transit-route-refresh').disabled, true);
    app.find('transit-route-edit').dispatch('click'); await settle(); assert.equal(edited, true); app.widget.destroy();
  }
});

test('invalid response metrics, route types, provenance and oversized lists never display a route', async () => {
  const cases = [payload('local-bus', [route({ durationMinutes: 25 })]), payload('local-bus', [route({ distanceMeters: 0 })]),
    payload('local-bus', [route({ transfers: 31 })]), payload('local-bus', [route({ type: 'SUBWAY' })]),
    payload('local-bus', [route({ steps: [step('UNKNOWN')] })]), payload('local-bus', [route({ steps: Array.from({ length: 65 }, () => step()) })]),
    payload('local-bus', [route({ steps: [step('BUS', { stops: Array(201).fill('정류장') })] })]),
    payload('local-bus', Array.from({ length: 6 }, (_, index) => route({ id: `transit-${index}` }))),
    payload('local-bus', [route(), route()]), payload('local-bus', null, { provider: 'unknown' }),
    payload('local-bus', null, { origin: { latitude: 37, longitude: 127.344 } }), payload('local-bus', null, { fetchedAt: 'bad' })];
  for (const data of cases) {
    const app = runtime(async () => ok(data)); await app.open(); assert.equal(app.find('transit-route-result').hidden, true);
    assert.match(app.find('transit-route-message').className, /is-error/); assert.equal(app.find('transit-route-select').children.length, 0); app.widget.destroy();
  }
});

test('untrusted names and step text produce text nodes and never create links, images or scripts', async () => {
  const html = '<img src=x onerror=alert(1)>', app = runtime(async () => ok(payload('local-bus', [route({ steps: [step('BUS', { stops: [html], vehicles: [{ name: html, type: '마을' }] })] })])), { origin: { ...origin, name: html } });
  await app.open(); assert.match(app.find('transit-route-preview').textContent, /<img/); assert.equal(app.find('transit-route-preview').children.length, 0);
  assert.match(app.find('transit-route-step-list').textContent, /<img/);
  const tags = []; const visit = node => { tags.push(node.tagName); node.children.forEach(visit); }; visit(app.host);
  assert.equal(tags.includes('img'), false); assert.equal(tags.includes('script'), false); assert.equal(tags.includes('a'), false); app.widget.destroy();
});

test('timeouts and close cancel requests and reject late data even when fetch ignores abort', async () => {
  for (const action of ['timeout', 'close', 'destroy']) {
    let resolve; const app = runtime(() => new Promise(done => { resolve = done; })); await app.open();
    const retry = app.find('transit-route-refresh'); retry.dispatch('click'); await settle(); assert.equal(app.calls.length, 1);
    const [{ callback, delay }] = app.timers.values(); assert.equal(delay, 25000);
    if (action === 'timeout') callback(); else if (action === 'close') app.close(); else app.widget.destroy();
    assert.equal(app.calls[0][1].signal.aborted, true); resolve(ok()); await settle();
    if (action === 'destroy') assert.equal(app.host.children.length, 0);
    else { assert.equal(app.find('transit-route-result').hidden, true); assert.equal(app.find('transit-route-step-list').children.length, 0); }
    assert.equal(app.timers.size, 0); app.widget.destroy();
  }
});

test('manual editing is protected from double clicks and synchronous parent destruction', async () => {
  let finish, calls = 0;
  const app = runtime(async () => ok(), { onEdit: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const button = app.find('transit-route-edit'); button.dispatch('click'); button.dispatch('click'); await settle();
  assert.equal(calls, 1); assert.equal(button.disabled, true); finish({ ok: false, reason: '일정을 다시 확인해 주세요.' }); await settle();
  assert.match(app.find('transit-route-message').textContent, /일정을 다시 확인/); assert.equal(button.disabled, false); app.widget.destroy();
  let destroyed; destroyed = runtime(async () => ok(), { onEdit: () => { destroyed.widget.destroy(); } });
  destroyed.find('transit-route-edit').dispatch('click'); await settle(); assert.equal(destroyed.host.children.length, 0);
});

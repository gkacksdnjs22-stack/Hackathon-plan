import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('car-routing-ui.js', import.meta.url), 'utf8');
const origin = { latitude: 36.35512349, longitude: 127.34412349, name: '유성온천역' };
const destination = { latitude: 36.372, longitude: 127.387, name: '한밭수목원' };

class Element {
  constructor(tagName) {
    this.tagName = tagName; this.children = []; this.parentNode = null; this.className = '';
    this.attributes = new Map(); this.listeners = new Map(); this._text = ''; this.open = false;
    this.hidden = false; this.disabled = false;
    this.classList = {
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' '); return on;
      }
    };
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
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  dispatch(type, extra = {}) {
    for (const handler of this.listeners.get(type) || []) handler({ type, target: this, ...extra });
  }
}
function find(root, className) {
  if (root.className.split(/\s+/).includes(className)) return root;
  for (const child of root.children) { const match = find(child, className); if (match) return match; }
  return null;
}
function payload(overrides = {}) {
  return { provider: '카카오모빌리티', fetchedAt: '2026-10-20T03:00:00.000Z',
    origin: { latitude: 36.355123, longitude: 127.344123 },
    destination: { latitude: destination.latitude, longitude: destination.longitude },
    durationMinutes: 26, durationSeconds: 1501, distanceMeters: 12345, reference: '현재 교통 기준', ...overrides };
}
function ok(data = payload()) { return { ok: true, status: 200, json: async () => data }; }
const settle = async () => { for (let index = 0; index < 7; index++) await Promise.resolve(); };

function runtime(fetchImpl = async () => ok(), options = {}) {
  const calls = [], timers = new Map(); let timerId = 0;
  const context = vm.createContext({
    window: {}, document: { createElement: name => new Element(name) }, Intl, URLSearchParams, AbortController,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: (...args) => { calls.push(args); return fetchImpl(...args); }
  });
  vm.runInContext(code, context, { filename: 'car-routing-ui.js' });
  const host = new Element('div');
  const widget = context.window.TravelCarRouting.mount(host, {
    origin: { ...origin }, destination: { ...destination }, onApply: () => ({ ok: true }), ...options
  });
  const details = host.children[0], summary = details.children[0];
  const open = async (key = null) => {
    summary.dispatch(key ? 'keydown' : 'click', key ? { key } : {});
    details.open = true; details.dispatch('toggle'); await settle();
  };
  return { host, widget, details, summary, open, calls, timers, find: name => find(host, name) };
}

test('vehicle routes are queried on demand and applied only by a separate explicit click', async () => {
  const applied = [];
  const app = runtime(async () => ok(), { onApply: route => { applied.push(route); return { ok: true }; } });
  assert.equal(app.calls.length, 0); assert.equal(app.details.open, false);
  assert.equal(app.find('car-route-apply').hidden, true);
  app.details.open = true; app.details.dispatch('toggle'); await settle();
  assert.equal(app.calls.length, 0, 'programmatic expansion does not make a request');
  app.details.open = false; app.details.dispatch('toggle'); await app.open('Enter');
  assert.equal(app.calls.length, 1); assert.equal(applied.length, 0);
  assert.equal(app.calls[0][0], '/api/car-route?originLatitude=36.35512349&originLongitude=127.34412349&destinationLatitude=36.372&destinationLongitude=127.387');
  assert.equal(app.calls[0][1].headers.Accept, 'application/json');
  assert.ok(app.calls[0][1].signal instanceof AbortSignal);
  assert.match(app.find('car-route-preview').textContent, /유성온천역 → 한밭수목원/);
  assert.match(app.find('car-route-introduction').textContent, /현재 교통 기준 · 여행 당일 예측과 다를 수 있어요/);
  assert.equal(app.find('car-route-apply').hidden, false); assert.equal(app.find('car-route-apply').disabled, false);
  app.details.open = false; app.details.dispatch('toggle'); await app.open();
  assert.equal(app.calls.length, 1); assert.equal(applied.length, 0);
  app.find('car-route-apply').dispatch('click'); await settle();
  assert.equal(applied.length, 1); assert.equal(applied[0].durationMinutes, 26);
  assert.equal(applied[0].durationSeconds, 1501); assert.equal(applied[0].provider, '카카오모빌리티');
  assert.ok(Object.isFrozen(applied[0])); assert.ok(Object.isFrozen(applied[0].origin));
  assert.equal(app.find('car-route-apply').textContent, '적용 완료'); assert.equal(app.find('car-route-apply').disabled, true);
  app.find('car-route-apply').dispatch('click'); await settle(); assert.equal(applied.length, 1);
  assert.equal(app.timers.size, 0); app.widget.destroy();
});

test('a successful route shows travel time, distance and apply while keeping lookup-date and road details hidden', async () => {
  for (const [seconds, minutes, meters, expectedDuration, expectedDistance] of [
    [1, 1, 999, '예상 1분', '거리 999m'], [3600, 60, 1000, '예상 1시간', '거리 1km'],
    [3901, 66, 12345, '예상 1시간 6분', '거리 12.3km']
  ]) {
    const app = runtime(async () => ok(payload({ durationSeconds: seconds, durationMinutes: minutes, distanceMeters: meters })));
    await app.open();
    assert.equal(app.find('car-route-duration').textContent, expectedDuration);
    assert.equal(app.find('car-route-result').children.length, 3);
    assert.equal(app.find('car-route-message').textContent, '');
    assert.equal(app.find('car-route-distance').textContent, expectedDistance);
    assert.equal(app.find('car-route-fetched'), null);
    assert.doesNotMatch(app.host.textContent, /2026[.\-]|한국시간|도로 구간|ITS|지도/);
    app.widget.destroy();
  }
});

test('locations are fixed for the mounted route even when the caller later mutates its input objects', async () => {
  const inputOrigin = { ...origin }, inputDestination = { ...destination };
  const app = runtime(async () => ok(), { origin: inputOrigin, destination: inputDestination });
  inputOrigin.latitude = 37.5; inputDestination.longitude = 129.5;
  await app.open();
  assert.match(app.calls[0][0], /originLatitude=36\.35512349/);
  assert.match(app.calls[0][0], /destinationLongitude=127\.387/);
  assert.equal(app.find('car-route-result').hidden, false);
  app.widget.destroy();
});

test('missing or invalid points prevent a lookup and a missing callback keeps apply hidden', async () => {
  for (const badPoint of [null, {}, { latitude: 0, longitude: 0 }, { latitude: '36.355', longitude: 127.344 }, { latitude: NaN, longitude: 127.344 }]) {
    const app = runtime(async () => ok(), { origin: badPoint });
    await app.open(); app.find('car-route-refresh').dispatch('click'); await settle();
    assert.equal(app.calls.length, 0); assert.equal(app.find('car-route-refresh').disabled, true);
    assert.equal(app.find('car-route-apply').hidden, true);
    assert.match(app.find('car-route-message').textContent, /좌표가 있는 출발지와 도착지/);
    app.widget.destroy();
  }
  const app = runtime(async () => ok(), { onApply: null }); await app.open();
  assert.equal(app.find('car-route-result').hidden, false); assert.equal(app.find('car-route-apply').hidden, true);
  app.widget.destroy();
});

test('no-route, unavailable, authorization and rate-limit states permit only explicit retries', async () => {
  for (const [status, expected] of [[422, /차량 경로가 없어요/], [503, /연결을 준비 중/], [401, /조회할 수 없어요/],
    [403, /조회할 수 없어요/], [429, /조회가 많아/], [504, /응답이 늦어/], [500, /불러오지 못했어요/]]) {
    let failed = true;
    const app = runtime(async () => failed ? { ok: false, status, json: async () => { throw new Error('do not parse upstream error bodies'); } } : ok());
    await app.open();
    assert.match(app.find('car-route-message').textContent, expected);
    assert.match(app.find('car-route-message').className, /is-error/);
    assert.equal(app.find('car-route-refresh').disabled, false); assert.equal(app.find('car-route-apply').hidden, true);
    app.details.open = false; app.details.dispatch('toggle'); await app.open(); assert.equal(app.calls.length, 1);
    failed = false; app.find('car-route-refresh').dispatch('click'); await settle();
    assert.equal(app.calls.length, 2); assert.equal(app.find('car-route-result').hidden, false);
    assert.doesNotMatch(app.find('car-route-message').className, /is-error/);
    app.widget.destroy();
  }
});

test('inconsistent, missing, zero or excessive route metrics cannot be applied', async () => {
  const cases = [
    { durationSeconds: 0, durationMinutes: 0 }, { durationSeconds: '1501' }, { durationSeconds: 1.5 },
    { durationSeconds: 86401, durationMinutes: 1441 }, { durationMinutes: 25 },
    { distanceMeters: 0 }, { distanceMeters: null }, { distanceMeters: 1500001 },
    { provider: 'unknown' }, { reference: '미래 예측' }, { fetchedAt: '2026-10-20' },
    { origin: { latitude: 37.5, longitude: 127.344123 } }, { destination: null }
  ];
  for (const overrides of cases) {
    let applied = false;
    const app = runtime(async () => ok(payload(overrides)), { onApply: () => { applied = true; return { ok: true }; } });
    await app.open(); app.find('car-route-apply').dispatch('click'); await settle();
    assert.equal(app.find('car-route-result').hidden, true); assert.equal(app.find('car-route-apply').hidden, true);
    assert.match(app.find('car-route-message').className, /is-error/); assert.equal(applied, false);
    app.widget.destroy();
  }
});

test('a pending apply disables repeat application and lookup while failed application remains retryable', async () => {
  let finishApply, count = 0;
  const app = runtime(async () => ok(), { onApply: () => { count++; return new Promise(resolve => { finishApply = resolve; }); } });
  await app.open(); const apply = app.find('car-route-apply'), retry = app.find('car-route-refresh');
  apply.dispatch('click'); apply.dispatch('click'); retry.dispatch('click'); await settle();
  assert.equal(count, 1); assert.equal(app.calls.length, 1); assert.equal(apply.disabled, true); assert.equal(retry.disabled, true);
  finishApply({ ok: false, reason: '일정이 너무 늦어져요. 이동시간을 확인해 주세요.' }); await settle();
  assert.match(app.find('car-route-message').textContent, /일정이 너무 늦어져요/);
  assert.equal(apply.disabled, false); assert.equal(retry.disabled, false);
  apply.dispatch('click'); await settle(); assert.equal(count, 2); finishApply({ ok: true }); await settle();
  assert.equal(apply.disabled, true); app.widget.destroy();
});

test('apply exceptions are handled safely and refreshing clears a previously applicable route', async () => {
  let finishFetch, fetchCount = 0, applyCount = 0;
  const app = runtime(() => ++fetchCount === 1 ? Promise.resolve(ok()) : new Promise(resolve => { finishFetch = resolve; }), {
    onApply: () => { applyCount++; throw new Error('secret-value-must-not-render'); }
  });
  await app.open(); app.find('car-route-apply').dispatch('click'); await settle();
  assert.match(app.find('car-route-message').textContent, /適用|적용하지 못했어요/);
  assert.doesNotMatch(app.host.textContent, /secret-value/); assert.equal(app.find('car-route-apply').disabled, false);
  app.find('car-route-refresh').dispatch('click'); await settle();
  assert.equal(app.find('car-route-result').hidden, true); assert.equal(app.find('car-route-apply').hidden, true);
  app.find('car-route-apply').dispatch('click'); await settle(); assert.equal(applyCount, 1);
  finishFetch(ok()); await settle(); assert.equal(app.find('car-route-result').hidden, false);
  app.widget.destroy();
});

test('route labels and a failed-apply reason are text only and unknown response fields are not forwarded', async () => {
  const html = '<img src=x onerror=alert(1)>', data = payload({ secret: 'not-forwarded' }); let selected;
  const app = runtime(async () => ok(data), { origin: { ...origin, name: html }, destination: { ...destination, name: html },
    onApply: route => { selected = route; return { ok: false, reason: html }; } });
  await app.open(); app.find('car-route-apply').dispatch('click'); await settle();
  assert.match(app.find('car-route-preview').textContent, /<img/); assert.equal(app.find('car-route-preview').children.length, 0);
  assert.equal(app.find('car-route-message').textContent, html); assert.equal(app.find('car-route-message').children.length, 0);
  assert.equal(Object.hasOwn(selected, 'secret'), false);
  const tags = []; const visit = node => { tags.push(node.tagName); node.children.forEach(visit); }; visit(app.host);
  assert.equal(tags.includes('img'), false); assert.equal(tags.includes('script'), false);
  app.widget.destroy();
});

test('a synchronous parent rerender may destroy the widget from inside the apply callback', async () => {
  let app, count = 0;
  app = runtime(async () => ok(), { onApply: () => { count++; app.widget.destroy(); return { ok: true }; } });
  await app.open(); const apply = app.find('car-route-apply'); apply.dispatch('click'); await settle();
  assert.equal(count, 1); assert.equal(app.host.children.length, 0);
  apply.dispatch('click'); await settle(); assert.equal(count, 1); assert.equal(app.timers.size, 0);
});

test('lookup timeout aborts after 25 seconds with no automatic polling', async () => {
  const app = runtime((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }));
  await app.open(); app.find('car-route-refresh').dispatch('click'); await settle(); assert.equal(app.calls.length, 1);
  assert.equal(app.timers.size, 1); const [{ callback, delay }] = app.timers.values(); assert.equal(delay, 25000);
  callback(); await settle();
  assert.equal(app.calls[0][1].signal.aborted, true); assert.match(app.find('car-route-message').textContent, /지연/);
  assert.equal(app.find('car-route-apply').hidden, true); assert.equal(app.find('car-route-refresh').disabled, false);
  assert.equal(app.timers.size, 0); app.widget.destroy();
});

test('destroy removes listeners, aborts lookup and ignores late route data', async () => {
  let resolve;
  const app = runtime(() => new Promise(done => { resolve = done; }));
  await app.open(); const retry = app.find('car-route-refresh'), apply = app.find('car-route-apply');
  app.widget.destroy(); app.widget.destroy();
  assert.equal(app.calls[0][1].signal.aborted, true); assert.equal(app.host.children.length, 0); assert.equal(app.timers.size, 0);
  assert.equal(app.summary.listeners.get('click').size, 0); assert.equal(app.summary.listeners.get('keydown').size, 0);
  assert.equal(app.details.listeners.get('toggle').size, 0);
  retry.dispatch('click'); apply.dispatch('click'); resolve(ok()); await settle();
  assert.equal(app.calls.length, 1); assert.equal(app.host.children.length, 0);
});

test('late data after timeout is ignored even if fetch does not honor abort', async () => {
  let resolve;
  const app = runtime(() => new Promise(done => { resolve = done; }));
  await app.open(); const [{ callback }] = app.timers.values(); callback(); resolve(ok()); await settle();
  assert.equal(app.find('car-route-result').hidden, true); assert.equal(app.find('car-route-apply').hidden, true);
  assert.match(app.find('car-route-message').textContent, /지연/); app.widget.destroy();
});

test('destroy while applying ignores a later callback result and keeps replacement content intact', async () => {
  let finishApply;
  const app = runtime(async () => ok(), { onApply: () => new Promise(resolve => { finishApply = resolve; }) });
  await app.open(); app.find('car-route-apply').dispatch('click'); await settle();
  app.widget.destroy(); const replacement = new Element('p'); replacement.textContent = '새 일정'; app.host.append(replacement);
  finishApply({ ok: true }); await settle();
  assert.equal(app.host.textContent, '새 일정'); assert.equal(app.host.children.length, 1);
});

test('compact route lookup avoids duplicate vehicle heading and location context while retaining explicit lookup and apply', async () => {
  const app = runtime(async () => ok(), { compact: true });
  assert.equal(app.find('car-route-heading').textContent, '예상시간 조회');
  assert.equal(app.find('car-route-preview'), null);
  assert.doesNotMatch(app.host.textContent, /차량 예상 이동시간|유성온천역|한밭수목원/);
  assert.equal(app.calls.length, 0); await app.open();
  assert.equal(app.calls.length, 1); assert.match(app.find('car-route-duration').textContent, /예상 26분/);
  assert.match(app.find('car-route-distance').textContent, /거리 12\.3km/);
  assert.equal(app.find('car-route-apply').hidden, false); app.widget.destroy();
});

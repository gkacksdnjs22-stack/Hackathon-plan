import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('local-transfer-ui.js', import.meta.url), 'utf8');
const carCode = readFileSync(new URL('car-routing-ui.js', import.meta.url), 'utf8');
const origin = { latitude: 36.355, longitude: 127.344, name: '첫 관광지' };
const destination = { latitude: 36.36, longitude: 127.347, name: '다음 관광지' };
const near = { mode: 'walk', label: '도보 추천', reason: '가까운 구간 · 직선거리 기준', distanceMeters: 620 };
const far = { mode: null, label: '대중교통·차량 고려', reason: '노선과 실제 경로를 확인해 주세요.', distanceMeters: 5200 };

class Element {
  constructor(tagName) {
    this.tagName = tagName; this.children = []; this.parentNode = null; this.className = '';
    this.attributes = new Map(); this.listeners = new Map(); this._text = ''; this.open = false;
    this.hidden = false; this.disabled = false; this.value = '';
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
const settle = async () => { for (let index = 0; index < 7; index++) await Promise.resolve(); };

function runtime(options = {}, { suggestion = near, realCar = false, plannerPresent = true } = {}) {
  const carMounts = [], transitMounts = [], suggestionCalls = [], fetches = [], timers = new Map(); let timerId = 0;
  const window = {};
  if (plannerPresent) window.TravelPlanner = { getTransferSuggestion: input => { suggestionCalls.push(input); return suggestion; } };
  const context = vm.createContext({
    window, document: { createElement: name => new Element(name) }, Intl, URLSearchParams, AbortController,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: (...args) => {
      fetches.push(args);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({
        provider: '카카오모빌리티', fetchedAt: '2026-10-20T03:00:00.000Z',
        origin: { latitude: origin.latitude, longitude: origin.longitude }, destination: { latitude: destination.latitude, longitude: destination.longitude },
        durationMinutes: 9, durationSeconds: 501, distanceMeters: 3200, reference: '현재 교통 기준'
      }) });
    }
  });
  if (realCar) vm.runInContext(carCode, context, { filename: 'car-routing-ui.js' });
  else window.TravelCarRouting = { mount: (host, settings) => {
    const marker = new Element('div'); marker.className = 'test-route-marker'; host.append(marker);
    const record = { host, settings, destroyed: false }; carMounts.push(record);
    return { destroy: () => { record.destroyed = true; host.replaceChildren(); } };
  } };
  window.TravelTransitRouting = { mount: (host, settings) => {
    const marker = new Element('div'); marker.className = 'test-transit-marker'; host.append(marker);
    const record = { host, settings, destroyed: false }; transitMounts.push(record);
    return { destroy: () => { record.destroyed = true; host.replaceChildren(); } };
  } };
  vm.runInContext(code, context, { filename: 'local-transfer-ui.js' });
  const host = new Element('div');
  const widget = window.TravelLocalTransfer.mount(host, {
    origin, destination, mode: null, durationMinutes: 10, onModeChange: () => ({ ok: true }), onApplyRoute: () => ({ ok: true }), ...options
  });
  const select = find(host, 'local-transfer-select');
  const choose = async mode => { select.value = mode; select.dispatch('change'); await settle(); };
  return { host, widget, select, choose, carMounts, transitMounts, suggestionCalls, fetches, timers, find: name => find(host, name) };
}

test('only the current transit widget can preview time, and changing mode or destroying clears it', async () => {
  const previews = [], app = runtime({ mode: 'local-bus', onPreviewTransitDuration: value => previews.push(value) });
  const bus = app.transitMounts.at(-1);
  bus.settings.onPreviewDuration(53); assert.equal(previews.at(-1), 53);
  await app.choose('subway'); assert.equal(previews.at(-1), null);
  const subway = app.transitMounts.at(-1);
  subway.settings.onPreviewDuration(40); assert.equal(previews.at(-1), 40);
  bus.settings.onPreviewDuration(null); bus.settings.onPreviewDuration(90);
  assert.equal(previews.at(-1), 40, 'an old widget cannot clear or replace the current result');
  app.widget.destroy(); assert.equal(previews.at(-1), null);
  subway.settings.onPreviewDuration(90); assert.equal(previews.at(-1), null);
});

test('a local transfer presents four modes independently and leaves a recommendation unselected', () => {
  const changed = [], app = runtime({ mode: null, onModeChange: mode => { changed.push(mode); return { ok: true }; } });
  assert.equal(app.select.getAttribute('aria-label'), '이동수단');
  assert.deepEqual(app.select.children.map(option => option.value), ['', 'walk', 'local-bus', 'subway', 'car']);
  assert.deepEqual(app.select.children.map(option => option.textContent), ['이동수단 선택', '도보', '시내·마을버스', '지하철', '차량']);
  assert.equal(app.select.children[0].disabled, true); assert.equal(app.select.value, '');
  assert.equal(app.find('local-transfer-recommendation').textContent, '도보 추천');
  assert.equal(app.find('local-transfer-basis').textContent, '직선거리 기준');
  assert.equal(app.find('local-transfer-context').textContent, '첫 관광지 → 다음 관광지');
  assert.equal(changed.length, 0); assert.equal(app.carMounts.length, 0); assert.equal(app.fetches.length, 0);
  assert.equal(app.suggestionCalls.length, 1); assert.equal(app.suggestionCalls[0].origin.latitude, origin.latitude);
  app.widget.destroy();
});

test('far-distance guidance considers transport without promising a bus or subway route', () => {
  const app = runtime({}, { suggestion: far });
  assert.equal(app.find('local-transfer-recommendation').textContent, '대중교통·차량 고려');
  assert.equal(app.find('local-transfer-recommendation').title, '노선과 실제 경로를 확인해 주세요.');
  assert.equal(app.select.value, ''); assert.equal(app.carMounts.length, 0);
  app.widget.destroy();
});

test('walking stays manual while local bus and subway create distinct compact transit lookups without querying automatically', async () => {
  const changed = [], app = runtime({ onModeChange: mode => { changed.push(mode); return { ok: true }; } });
  for (const mode of ['walk', 'local-bus', 'subway']) {
    await app.choose(mode); assert.equal(app.select.value, mode);
    assert.equal(app.find('local-transfer-hint').textContent, mode === 'walk' ? '예상시간은 일정 수정에서 입력해 주세요.' : '');
    if (mode !== 'walk') { assert.equal(app.transitMounts.at(-1).settings.mode, mode); assert.equal(app.transitMounts.at(-1).settings.compact, true); }
    assert.equal(app.carMounts.length, 0); assert.equal(app.fetches.length, 0);
  }
  assert.deepEqual(changed, ['walk', 'local-bus', 'subway']); assert.equal(app.transitMounts.length, 2); assert.equal(app.transitMounts[0].destroyed, true); app.widget.destroy();
});

test('only an explicit vehicle mode creates a compact route lookup and leaving the vehicle mode destroys it', async () => {
  const applied = [], app = runtime({ onApplyRoute: route => { applied.push(route); return { ok: true }; } });
  await app.choose('car'); assert.equal(app.carMounts.length, 1);
  const first = app.carMounts[0]; assert.equal(first.settings.compact, true);
  assert.equal(first.settings.origin.name, origin.name); assert.equal(first.settings.destination.name, destination.name);
  assert.equal(app.find('local-transfer-hint').textContent, ''); assert.equal(app.fetches.length, 0);
  const route = { durationMinutes: 9 }; assert.equal(first.settings.onApply(route).ok, true); assert.equal(applied[0], route);
  await app.choose('local-bus'); assert.equal(first.destroyed, true); assert.equal(app.transitMounts.length, 1);
  assert.equal(first.settings.onApply(route).ok, false, 'an old route cannot apply after a mode change');
  app.widget.destroy();
});

test('legacy rental-car and taxi selections restore as the single vehicle mode without persisting or querying automatically', () => {
  for (const legacy of ['rental-car', 'taxi']) {
    const changed = [], app = runtime({ mode: legacy, onModeChange: value => { changed.push(value); return { ok: true }; } });
    assert.equal(app.select.value, 'car'); assert.equal(app.select.children.find(option => option.value === 'car').textContent, '차량');
    assert.equal(app.select.children.some(option => ['rental-car', 'taxi'].includes(option.value)), false);
    assert.equal(app.carMounts.length, 1); assert.equal(app.carMounts[0].settings.compact, true);
    assert.equal(changed.length, 0); assert.equal(app.fetches.length, 0); app.widget.destroy();
  }
});

test('transit can open only manual editing and never sends its API route through the vehicle apply callback', async () => {
  const edits = [], applied = [], app = runtime({ onEditTime: (...args) => { edits.push(args); return { ok: true }; }, onApplyRoute: value => { applied.push(value); return { ok: true }; } });
  await app.choose('local-bus'); const nested = app.transitMounts[0];
  assert.equal(nested.settings.onApply, undefined); assert.equal(nested.settings.onEdit().ok, true); assert.deepEqual(edits, [[]]); assert.equal(applied.length, 0);
  await app.choose('walk'); assert.equal(nested.destroyed, true); assert.equal(nested.settings.onEdit().ok, false);
  app.widget.destroy();
});

test('persisted vehicle choices remain collapsed and make no request until the nested lookup is explicitly opened', async () => {
  const applied = [], app = runtime({ mode: 'car', onApplyRoute: route => { applied.push(route); return { ok: true }; } }, { realCar: true });
  assert.equal(app.fetches.length, 0); assert.equal(app.select.value, 'car');
  const lookup = app.find('car-route-lookup'), summary = lookup.children[0];
  assert.equal(lookup.open, false); assert.equal(app.find('car-route-heading').textContent, '예상시간 조회');
  assert.equal(app.find('car-route-preview'), null);
  summary.dispatch('click'); lookup.open = true; lookup.dispatch('toggle'); await settle();
  assert.equal(app.fetches.length, 1); assert.equal(applied.length, 0);
  assert.equal(app.find('car-route-duration').textContent, '예상 9분'); assert.equal(app.find('car-route-distance').textContent, '거리 3.2km');
  app.find('car-route-apply').dispatch('click'); await settle();
  assert.equal(applied.length, 1); assert.equal(applied[0].durationMinutes, 9);
  app.widget.destroy(); assert.equal(app.timers.size, 0);
});

test('an asynchronous mode change prevents duplicate callbacks and a rejected change restores the old choice', async () => {
  let finish; const changed = [];
  const app = runtime({ mode: 'walk', onModeChange: mode => { changed.push(mode); return new Promise(resolve => { finish = resolve; }); } });
  await app.choose('car'); assert.equal(app.select.disabled, true); assert.equal(app.select.getAttribute('aria-busy'), 'true');
  await app.choose('subway'); assert.deepEqual(changed, ['car']); assert.equal(app.carMounts.length, 0);
  finish({ ok: false, reason: '일정을 확인해 주세요.' }); await settle();
  assert.equal(app.select.value, 'walk'); assert.equal(app.select.disabled, false);
  assert.equal(app.find('local-transfer-message').textContent, '일정을 확인해 주세요.');
  assert.match(app.find('local-transfer-message').className, /is-error/);
  await app.choose('car'); finish({ ok: true }); await settle();
  assert.equal(app.select.value, 'car'); assert.equal(app.carMounts.length, 1); assert.equal(app.find('local-transfer-message').textContent, '');
  app.widget.destroy();
});

test('unsupported or cleared modes are not submitted and callback exceptions are explained safely', async () => {
  let count = 0;
  const app = runtime({ mode: 'walk', onModeChange: () => { count++; throw new Error('private-value'); } });
  await app.choose(''); await app.choose('train'); await app.choose('walk'); assert.equal(count, 0); assert.equal(app.select.value, 'walk');
  await app.choose('car'); assert.equal(count, 1); assert.equal(app.select.value, 'walk');
  assert.match(app.find('local-transfer-message').textContent, /변경하지 못했어요/); assert.doesNotMatch(app.host.textContent, /private-value/);
  app.widget.destroy();
});

test('missing suggestion or malformed guidance leaves manual choices usable without inventing a recommendation', async () => {
  for (const config of [{ plannerPresent: false }, { suggestion: null }, { suggestion: { ...near, distanceMeters: NaN } }, { suggestion: { ...near, mode: 'subway' } }]) {
    const app = runtime({}, config);
    assert.equal(app.find('local-transfer-recommendation').hidden, true); assert.equal(app.find('local-transfer-basis').hidden, true);
    await app.choose('walk'); assert.equal(app.select.value, 'walk'); assert.equal(app.carMounts.length, 0);
    app.widget.destroy();
  }
});

test('location names, suggestion labels and rejection messages are rendered only as text', async () => {
  const html = '<img src=x onerror=alert(1)>';
  const app = runtime({ origin: { ...origin, name: html }, onModeChange: () => ({ ok: false, reason: html }) }, { suggestion: { ...near, label: html } });
  assert.match(app.find('local-transfer-context').textContent, /<img/); assert.equal(app.find('local-transfer-context').children.length, 0);
  assert.equal(app.find('local-transfer-recommendation').textContent, html); await app.choose('walk');
  assert.equal(app.find('local-transfer-message').textContent, html); assert.equal(app.find('local-transfer-message').children.length, 0);
  const tags = []; const visit = node => { tags.push(node.tagName); node.children.forEach(visit); }; visit(app.host);
  assert.equal(tags.includes('img'), false); assert.equal(tags.includes('script'), false); app.widget.destroy();
});

test('a parent may synchronously destroy the widget when persisting a selected mode', async () => {
  let app; app = runtime({ onModeChange: () => { app.widget.destroy(); return { ok: true }; } });
  await app.choose('car'); assert.equal(app.host.children.length, 0); assert.equal(app.carMounts.length, 0);
  assert.equal(app.select.listeners.get('change').size, 0);
});

test('destroy cleans the route widget and ignores both later selection events and pending outcomes', async () => {
  let finish, calls = 0;
  const app = runtime({ mode: 'car', onModeChange: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const nested = app.carMounts[0]; await app.choose('subway'); assert.equal(nested.destroyed, true);
  app.widget.destroy(); app.widget.destroy(); const replacement = new Element('p'); replacement.textContent = '새 일정'; app.host.append(replacement);
  app.select.value = 'taxi'; app.select.dispatch('change'); finish({ ok: true }); await settle();
  assert.equal(calls, 1); assert.equal(app.host.textContent, '새 일정'); assert.equal(app.carMounts.length, 1);
  assert.equal(nested.settings.onApply({ durationMinutes: 5 }).ok, false);
});

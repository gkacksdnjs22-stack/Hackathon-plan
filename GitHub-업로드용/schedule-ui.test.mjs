import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('schedule-ui.js', import.meta.url), 'utf8');
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Element {
  constructor(tagName, document) {
    this.tagName = tagName; this.document = document; this.children = []; this.parentNode = null; this.className = '';
    this.attributes = new Map(); this.listeners = new Map(); this.dataset = {}; this._text = ''; this.value = '';
    this.open = false; this.hidden = false; this.disabled = false; this.readOnly = false;
    this.classList = { toggle: (name, force) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      const on = force === undefined ? !classes.has(name) : force;
      if (on) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(' '); return on;
    } };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(_value) { throw Error('Schedule UI must use safe DOM text'); }
  append(...children) {
    for (const child of children) {
      child.parentNode = this; this.children.push(child);
      if (this.tagName === 'select' && this.children.length === 1) this.value = child.value;
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = []; this._text = ''; this.append(...children);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, extra = {}) {
    const event = { type, target: this, preventDefault() {}, ...extra };
    for (let node = this; node; node = node.parentNode) for (const listener of node.listeners.get(type) || []) listener(event);
  }
  focus(options) { this.document.activeElement = this; this.lastFocusOptions = options; }
}
function find(root, name) {
  if (root.className.split(/\s+/).includes(name)) return root;
  for (const child of root.children) { const match = find(child, name); if (match) return match; }
  return null;
}
function place(id, name, stayMinutes) { return { id, name, stayMinutes, address: '광주광역시 남구 문화로 10' }; }
const city = { areas: [
  { id: 'south', name: '남구 · 공원', places: [place('used', '이미 방문할 곳', 60), place('south-one', '남구 미술관', 75)] },
  { id: 'east', name: '동구 · 골목', places: [place('south-one', '중복 ID', 60), place('east-one', '동구 산책길', 45)] }
] };
const day = { events: [
  { id: 'departure', type: 'departure', title: '출발' }, { id: 'arrival', type: 'arrival', title: '도착' },
  { id: 'arrival-transfer', type: 'transfer', title: '첫 관광지로 이동' },
  { id: 'place-0', type: 'place', place: { name: '현재 관광지' } },
  { id: 'extra-1', type: 'free', title: '기존 추가 일정' }, { id: 'lunch', type: 'meal', title: '점심 식사' },
  { id: 'finish', type: 'finish', title: '오늘 여행 마무리' }
] };
function runtime(options = {}) {
  let refreshes = 0;
  const document = { activeElement: null, createElement: name => new Element(name, document) };
  const window = { TravelSelect: { refresh() { refreshes++; } } };
  const context = vm.createContext({ window, document, fetch() { throw Error('No API lookup belongs in this form'); } });
  vm.runInContext(readFileSync(new URL('note-tools.js', import.meta.url), 'utf8'), context);
  vm.runInContext(code, context, { filename: 'schedule-ui.js' });
  const host = document.createElement('div'), calls = [];
  const widget = window.TravelSchedule.mount(host, { day, dayIndex: 1, city, usedPlaceIds: ['used'],
    onAdd: payload => { calls.push(payload); return { ok: true }; }, ...options });
  const details = host.children[0];
  return { host, widget, details, document, calls, get refreshes() { return refreshes; },
    find: name => find(host, name),
    async choose(type) { const select = find(host, 'schedule-type-select'); select.value = type; select.dispatch('change'); await settle(); },
    async submit() { find(host, 'schedule-form').dispatch('submit'); await settle(); },
    input(name, value) { const input = find(host, name); input.value = value; input.dispatch('input'); }
  };
}

test('the collapsed add form has no position selector and explains that entries are appended before the finish', () => {
  const app = runtime();
  assert.equal(app.details.open, false); assert.equal(app.details.children[0].textContent, '일정 추가+');
  assert.equal(app.find('schedule-position-select'), null); assert.equal(app.find('schedule-place-field').hidden, true);
  assert.equal(app.find('schedule-place-select').disabled, true);
  assert.match(app.find('schedule-help').textContent, /맨 마지막\(마무리 앞\)/);
  assert.match(app.find('schedule-help').textContent, /시간표의 점에서/);
  assert.equal(app.find('schedule-form').getAttribute('aria-label'), '2일차 일정 추가');
  app.details.open = true; app.details.dispatch('toggle'); assert.ok(app.refreshes >= 2);
  app.widget.destroy();
});

test('opening direct entry focuses its editable title without moving focus while the form is initially collapsed', () => {
  const app = runtime(), title = app.find('schedule-title-input');
  assert.equal(app.document.activeElement, null); assert.equal(title.readOnly, false);
  assert.match(title.placeholder, /숙소 체크인/);
  app.details.open = true; app.details.dispatch('toggle');
  assert.equal(app.document.activeElement, title); assert.equal(title.lastFocusOptions.preventScroll, true);
  app.widget.destroy();
});

test('returning from a tourist spot to direct entry focuses the editable title and preserves its previous draft', async () => {
  const app = runtime(), title = app.find('schedule-title-input'), select = app.find('schedule-type-select');
  app.input('schedule-title-input', '내가 고른 카페'); app.input('schedule-description-input', '창가 자리');
  select.focus(); await app.choose('place');
  assert.equal(title.readOnly, true); assert.equal(app.document.activeElement, select);
  select.focus(); await app.choose('meal'); assert.equal(app.document.activeElement, select);
  await app.choose('free');
  assert.equal(title.readOnly, false); assert.equal(app.document.activeElement, title);
  assert.equal(title.value, '내가 고른 카페'); assert.equal(app.find('schedule-description-input').value, '창가 자리');
  assert.equal(title.lastFocusOptions.preventScroll, true); app.widget.destroy();
});

test('continuous Korean title and memo input keeps focus and submits the complete text without refreshing selects on every input', async () => {
  const app = runtime(), title = app.find('schedule-title-input'), memo = app.find('schedule-description-input');
  app.details.open = true; app.details.dispatch('toggle');
  const refreshes = app.refreshes;
  title.dispatch('compositionstart');
  for (const value of ['ㅋ', '카', '카페', '카페에', '카페에서', '카페에서 쉬', '카페에서 쉬기']) {
    title.value = value; title.dispatch('input', { isComposing: true });
    assert.equal(app.document.activeElement, title); assert.equal(title.readOnly, false); assert.equal(title.disabled, false);
  }
  title.dispatch('compositionend'); title.dispatch('input', { isComposing: false });
  memo.focus(); memo.dispatch('compositionstart');
  for (const value of ['ㅊ', '창', '창가', '창가자리', '창가자리예약']) {
    memo.value = value; memo.dispatch('input', { isComposing: true }); assert.equal(app.document.activeElement, memo);
  }
  memo.dispatch('compositionend'); memo.dispatch('input', { isComposing: false });
  assert.equal(app.refreshes, refreshes);
  await app.submit();
  assert.equal(app.calls[0].title, '카페에서 쉬기'); assert.equal(app.calls[0].description, '창가자리예약');
  assert.ok(app.refreshes > refreshes, 'submission still synchronizes disabled select controls');
  app.widget.destroy();
});

test('free entries pass a frozen payload and successful entries require another edit before resubmission', async () => {
  const app = runtime();
  app.input('schedule-title-input', '  카페에서 책 읽기  '); app.input('schedule-description-input', '예약 확인\n창가 자리');
  app.input('schedule-hours-input', '1'); app.input('schedule-minutes-input', '20');
  await app.submit(); assert.equal(app.calls.length, 1);
  assert.ok(Object.isFrozen(app.calls[0]));
  assert.equal(JSON.stringify(app.calls[0]), JSON.stringify({ beforeId: 'finish', type: 'free', title: '카페에서 책 읽기', description: '예약 확인\n창가 자리', duration: 80 }));
  assert.equal(app.find('schedule-save').textContent, '추가 완료'); assert.equal(app.find('schedule-save').disabled, true);
  await app.submit(); assert.equal(app.calls.length, 1);
  app.input('schedule-title-input', '다른 카페에서 쉬기'); assert.equal(app.find('schedule-save').disabled, false);
  await app.submit(); assert.equal(app.calls.length, 2); app.widget.destroy();
});

test('type switching preserves drafts and place choice spans every area while excluding used or duplicate IDs', async () => {
  const app = runtime();
  app.input('schedule-title-input', '내 일정'); app.input('schedule-description-input', '내 메모');
  app.input('schedule-hours-input', '2'); app.input('schedule-minutes-input', '10');
  await app.choose('meal'); assert.equal(app.find('schedule-title-input').value, '식사');
  assert.equal(app.find('schedule-hours-input').value, '1'); assert.equal(app.find('schedule-minutes-input').value, '0');
  await app.choose('rest'); assert.equal(app.find('schedule-title-input').value, '휴식');
  assert.equal(app.find('schedule-minutes-input').value, '30');
  await app.choose('transfer'); assert.equal(app.find('schedule-minutes-input').value, '0');
  await app.choose('place');
  const select = app.find('schedule-place-select');
  assert.deepEqual(select.children.map(option => option.value), ['south-one', 'east-one']);
  assert.match(select.className, /day-area-select/); assert.match(select.children[1].dataset.search, /동구/);
  assert.equal(app.find('schedule-title-input').value, '남구 미술관'); assert.equal(app.find('schedule-title-input').readOnly, true);
  assert.equal(app.find('schedule-hours-input').value, '1'); assert.equal(app.find('schedule-minutes-input').value, '15');
  assert.match(app.find('schedule-place-hint').textContent, /이미 일정에 담은 관광지/);
  app.input('schedule-hours-input', '3'); app.input('schedule-minutes-input', '5');
  await app.choose('free');
  assert.equal(app.find('schedule-title-input').value, '내 일정'); assert.equal(app.find('schedule-description-input').value, '내 메모');
  assert.equal(app.find('schedule-hours-input').value, '2'); assert.equal(app.find('schedule-minutes-input').value, '10');
  assert.equal(app.find('schedule-title-input').readOnly, false);
  await app.choose('place'); assert.equal(app.find('schedule-hours-input').value, '3');
  select.value = 'east-one'; select.dispatch('change');
  assert.equal(app.find('schedule-title-input').value, '동구 산책길'); assert.equal(app.find('schedule-hours-input').value, '0');
  assert.equal(app.find('schedule-minutes-input').value, '45');
  app.input('schedule-minutes-input', '55'); await app.submit();
  assert.equal(app.calls[0].placeId, 'east-one'); assert.equal(app.calls[0].type, 'place'); assert.equal(app.calls[0].duration, 55);
  assert.equal('title' in app.calls[0], false); app.widget.destroy();
});

test('the full catalog takes priority and offers unclustered places without requiring a parent recommendation area', async () => {
  const app = runtime({ city: { ...city, catalogPlaces: [place('used', '이미 담은 관광지', 60),
    place('catalog-only', '추천 권역 밖 문화관', 75), place('catalog-only', '중복 응답', 60), null] } });
  await app.choose('place');
  const select = app.find('schedule-place-select');
  assert.deepEqual(select.children.map(option => option.value), ['catalog-only']);
  assert.equal(app.find('schedule-title-input').value, '추천 권역 밖 문화관');
  assert.equal(app.find('schedule-hours-input').value, '1'); assert.equal(app.find('schedule-minutes-input').value, '15');
  await app.submit(); assert.equal(app.calls[0].placeId, 'catalog-only'); app.widget.destroy();
});

test('only transfer entries accept an unknown zero-minute duration', async () => {
  const app = runtime();
  for (const type of ['free', 'meal', 'rest', 'place']) {
    await app.choose(type);
    if (type === 'free') app.input('schedule-title-input', '직접 작성');
    app.input('schedule-hours-input', '0'); app.input('schedule-minutes-input', '0');
    await app.submit(); assert.equal(app.calls.length, 0); assert.match(app.find('schedule-message').textContent, /1분부터/);
  }
  await app.choose('transfer'); await app.submit();
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].duration, 0); assert.equal(app.calls[0].title, '이동');
  app.widget.destroy();
});

test('titles, notes and split time are validated before a callback, with a valid maximum of twelve hours', async () => {
  const app = runtime();
  for (const edits of [
    { title: '' }, { title: 'a'.repeat(81) }, { title: '금지\u0000문자' }, { description: 'a'.repeat(501) },
    { hours: '' }, { hours: '-1' }, { hours: '1.5' }, { minutes: '60' }, { hours: '12', minutes: '1' }
  ]) {
    for (const [name, value] of Object.entries({ title: '내 일정', description: '', hours: '0', minutes: '1', ...edits }))
      app.input(`schedule-${name}-input`, value);
    await app.submit(); assert.equal(app.calls.length, 0); assert.match(app.find('schedule-message').className, /is-error/);
  }
  app.input('schedule-hours-input', '12'); app.input('schedule-minutes-input', '0');
  await app.submit();
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].duration, 720); assert.equal(app.calls[0].beforeId, 'finish'); app.widget.destroy();
});

test('unavailable or already used places cannot be submitted and do not prevent other entry types', async () => {
  const app = runtime({ usedPlaceIds: ['used', 'south-one', 'east-one'] }); await app.choose('place');
  assert.equal(app.find('schedule-save').disabled, true); assert.match(app.find('schedule-place-hint').textContent, /추가할 후보가 없어요/);
  app.find('schedule-place-select').value = 'used'; await app.submit(); assert.equal(app.calls.length, 0);
  assert.match(app.find('schedule-message').textContent, /이미 일정에 담았거나/);
  await app.choose('meal'); assert.equal(app.find('schedule-save').disabled, false); await app.submit();
  assert.equal(app.calls[0].type, 'meal'); app.widget.destroy();
});

test('a pending add locks every input and ignores duplicate submits until a failure permits retry', async () => {
  const result = deferred(); let count = 0;
  const app = runtime({ onAdd: () => { count++; return result.promise; } });
  app.input('schedule-title-input', '준비한 일정'); app.find('schedule-form').dispatch('submit');
  assert.equal(app.find('schedule-save').textContent, '추가하는 중…');
  for (const name of ['type-select', 'title-input', 'description-input', 'hours-input', 'minutes-input', 'cancel'])
    assert.equal(app.find(`schedule-${name}`).disabled, true);
  await app.submit(); assert.equal(count, 1);
  result.resolve({ ok: false, reason: '브라우저 저장을 확인해 주세요.' }); await settle();
  assert.match(app.find('schedule-message').textContent, /브라우저 저장/);
  assert.equal(app.find('schedule-save').disabled, false); assert.equal(app.find('schedule-type-select').disabled, false);
  assert.equal(app.find('schedule-title-input').value, '준비한 일정');
  app.widget.destroy();
});

test('throwing or malformed callback outcomes never report success or expose internal diagnostics', async () => {
  for (const result of [undefined, { ok: 'true' }, { ok: false, reason: '\nprivate' }, Error('private diagnostics')]) {
    const app = runtime({ onAdd: () => { if (result instanceof Error) throw result; return result; } });
    app.input('schedule-title-input', '내 일정'); await app.submit();
    assert.match(app.find('schedule-message').textContent, /추가하지 못했어요/);
    assert.doesNotMatch(app.host.textContent, /private/); assert.equal(app.find('schedule-save').disabled, false);
    app.widget.destroy();
  }
});

test('late fulfillment or rejection after destroy cannot alter a newly rendered host', async () => {
  for (const fail of [false, true]) {
    const result = deferred(); let calls = 0;
    const app = runtime({ onAdd: () => { calls++; return result.promise; } });
    app.input('schedule-title-input', '내 일정'); const form = app.find('schedule-form'); form.dispatch('submit');
    app.widget.destroy(); app.host.textContent = '새 여행 일정';
    if (fail) result.reject(Error('late error')); else result.resolve({ ok: true });
    await settle(); assert.equal(app.host.textContent, '새 여행 일정');
    form.dispatch('submit'); await settle(); assert.equal(calls, 1);
  }
});

test('a callback may synchronously destroy the widget, and closing preserves the draft and returns summary focus', async () => {
  const app = runtime({ onAdd: () => { app.widget.destroy(); app.host.textContent = '저장된 일정'; return { ok: true }; } });
  app.details.open = true; app.input('schedule-title-input', '숙소 체크인');
  app.find('schedule-cancel').dispatch('click'); assert.equal(app.details.open, false);
  assert.equal(app.document.activeElement, app.details.children[0]);
  app.details.open = true; assert.equal(app.find('schedule-title-input').value, '숙소 체크인');
  await app.submit(); assert.equal(app.host.textContent, '저장된 일정');
});

test('memo counts follow input and the restored draft when switching schedule types', async () => {
  const app = runtime(); app.input('schedule-description-input', '내 일정 메모');
  assert.equal(app.find('memo-counter').textContent, '7 / 500자');
  await app.choose('meal'); assert.equal(app.find('memo-counter').textContent, '0 / 500자');
  app.input('schedule-description-input', '식당 예약');
  await app.choose('free'); assert.equal(app.find('schedule-description-input').value, '내 일정 메모');
  assert.equal(app.find('memo-counter').textContent, '7 / 500자'); app.widget.destroy();
});

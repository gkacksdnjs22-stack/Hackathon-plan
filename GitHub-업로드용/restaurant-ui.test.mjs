import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('restaurant-ui.js', import.meta.url), 'utf8');
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Element {
  constructor(tagName) {
    this.tagName = tagName; this.children = []; this.parentNode = null; this.className = '';
    this.attributes = new Map(); this.listeners = new Map(); this._text = ''; this.open = false;
    this.hidden = false; this.disabled = false;
    this.classList = { toggle: (name, force) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      const on = force === undefined ? !classes.has(name) : force;
      if (on) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(' '); return on;
    } };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(_value) { throw Error('Restaurant data must be rendered with textContent'); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
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
  dispatch(type) { for (const listener of this.listeners.get(type) || []) listener({ type, target: this }); }
}
function findAll(root, className) {
  const found = root.className.split(/\s+/).includes(className) ? [root] : [];
  return found.concat(root.children.flatMap(child => findAll(child, className)));
}
function item(index = 1, overrides = {}) {
  return { id: `tour-food-${index}`, name: `추천 식당 ${index}`, branch: '', address: '대전광역시 유성구 온천로 10',
    category: '음식점', latitude: 36.355, longitude: 127.344, updatedAt: '2026-10-20',
    source: '한국관광공사 TourAPI', sourceUrl: 'https://www.data.go.kr/data/15101578/openapi.do', distanceKm: 0.3,
    ...overrides };
}
function ok(items = [item()]) { return { ok: true, status: 200, json: async () => ({ items, truncated: false }) }; }
function runtime({ fetchImpl = async () => ok(), ...options } = {}) {
  const calls = [], timers = new Map(); let timerId = 0;
  const window = {}, context = vm.createContext({
    window, document: { createElement: name => new Element(name) }, URLSearchParams, AbortController,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id), fetch: (...args) => { calls.push(args); return fetchImpl(...args); }
  });
  vm.runInContext(readFileSync(new URL('note-tools.js', import.meta.url), 'utf8'), context);
  vm.runInContext(code, context, { filename: 'restaurant-ui.js' });
  const host = new Element('div');
  const widget = window.TravelRestaurants.mount(host, { area: '대전', district: '유성구', latitude: 36.355, longitude: 127.344, ...options });
  const details = host.children[0];
  return { host, widget, details, calls, timers, window, api: window.TravelRestaurants,
    find: name => findAll(host, name)[0] || null, all: name => findAll(host, name),
    async open() { details.open = true; details.dispatch('toggle'); await settle(); },
    async click(name) { findAll(host, name)[0].dispatch('click'); await settle(); }
  };
}

test('the existing lookup stays read-only without onSelect and preserves safe names and map links', async () => {
  const name = '<img src=x onerror=alert(1)>', app = runtime({ fetchImpl: async () => ok([item(1, { name })]) });
  assert.equal(app.calls.length, 0); await app.open();
  assert.equal(app.calls.length, 1);
  const query = new URL(app.calls[0][0], 'https://example.test').searchParams;
  assert.equal(query.get('area'), '대전'); assert.equal(query.get('district'), '유성구');
  assert.equal(query.get('latitude'), '36.355'); assert.equal(query.get('longitude'), '127.344');
  assert.equal(app.find('restaurant-name').textContent, name);
  assert.equal(app.find('restaurant-select'), null);
  assert.equal(app.find('restaurant-actions'), null);
  assert.equal(app.find('restaurant-map').target, '_blank');
  assert.equal(app.find('restaurant-map').rel, 'noopener noreferrer');
  assert.match(app.find('restaurant-map').href, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  assert.equal(app.timers.size, 0); app.widget.destroy();
});

test('selecting an item is explicit, passes a frozen validated snapshot, and allows choosing a different restaurant', async () => {
  const selected = [], responseItem = item(1, { branch: '유성점', privateExtra: 'do not forward' });
  const app = runtime({ fetchImpl: async () => ok([responseItem, item(2)]), onSelect: value => { selected.push(value); return { ok: true }; } });
  await app.open(); assert.equal(selected.length, 0);
  const buttons = app.all('restaurant-select');
  assert.equal(buttons.length, 2); assert.equal(buttons[0].textContent, '식사 일정에 담기');
  assert.equal(buttons[0].getAttribute('aria-label'), '추천 식당 1 유성점 식사 일정에 담기');
  buttons[0].dispatch('click'); await settle();
  assert.equal(selected.length, 1); assert.equal(selected[0].id, responseItem.id);
  assert.equal(selected[0].address, responseItem.address); assert.equal(selected[0].branch, '유성점');
  assert.ok(Object.isFrozen(selected[0])); assert.notEqual(selected[0], responseItem);
  assert.equal(selected[0].privateExtra, undefined);
  assert.equal(buttons[0].textContent, '담은 식당'); assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].disabled, false); assert.match(app.find('restaurant-message').textContent, /담았어요/);
  buttons[0].dispatch('click'); await settle(); assert.equal(selected.length, 1);
  buttons[1].dispatch('click'); await settle(); assert.equal(selected.length, 2);
  assert.equal(buttons[0].disabled, false); assert.equal(buttons[1].disabled, true);
  assert.equal(app.all('restaurant-map').length, 2); app.widget.destroy();
});

test('unsuccessful, malformed and throwing callbacks show safe errors and leave selection retryable', async () => {
  for (const [outcome, expected] of [
    [{ ok: false, reason: '브라우저에 저장하지 못했어요.' }, /브라우저에 저장하지 못했어요/],
    [undefined, /담지 못했어요/], [{ ok: 'true' }, /담지 못했어요/],
    [{ ok: false, reason: '\nprivate error' }, /담지 못했어요/],
    [Error('private server diagnostics'), /담지 못했어요/]
  ]) {
    let success = false, count = 0;
    const app = runtime({ onSelect: () => { count++; if (success) return { ok: true }; if (outcome instanceof Error) throw outcome; return outcome; } });
    await app.open(); await app.click('restaurant-select');
    assert.match(app.find('restaurant-message').textContent, expected);
    assert.match(app.find('restaurant-message').className, /is-error/);
    assert.doesNotMatch(app.host.textContent, /private/);
    assert.equal(app.find('restaurant-select').disabled, false);
    assert.equal(app.find('restaurant-refresh').disabled, false);
    success = true; await app.click('restaurant-select');
    assert.equal(count, 2); assert.equal(app.find('restaurant-select').textContent, '담은 식당');
    app.widget.destroy();
  }
});

test('a pending selection prevents duplicate selection, requery and list growth across all cards', async () => {
  const selection = deferred(), selected = [];
  const app = runtime({ fetchImpl: async () => ok(Array.from({ length: 20 }, (_, index) => item(index + 1))),
    onSelect: value => { selected.push(value); return selection.promise; } });
  await app.open();
  const buttons = app.all('restaurant-select'); buttons[0].dispatch('click');
  assert.equal(buttons[0].textContent, '담는 중…');
  assert.equal(buttons[0].getAttribute('aria-busy'), 'true');
  assert.ok(buttons.every(button => button.disabled));
  assert.equal(app.find('restaurant-refresh').disabled, true); assert.equal(app.find('restaurant-more').disabled, true);
  buttons[0].dispatch('click'); buttons[1].dispatch('click');
  app.find('restaurant-refresh').dispatch('click'); app.find('restaurant-more').dispatch('click');
  await settle(); assert.equal(selected.length, 1); assert.equal(app.calls.length, 1);
  assert.equal(app.all('restaurant-card').length, 5);
  selection.resolve({ ok: false, reason: '다시 선택해 주세요.' }); await settle();
  assert.ok(buttons.every(button => !button.disabled)); assert.equal(app.find('restaurant-more').disabled, false);
  assert.equal(app.find('restaurant-refresh').disabled, false);
  assert.equal(buttons[0].getAttribute('aria-busy'), 'false'); app.widget.destroy();
});

test('destroyed widgets ignore late success and rejection without modifying replacement content', async () => {
  for (const fail of [false, true]) {
    const selection = deferred(); let count = 0;
    const app = runtime({ onSelect: () => { count++; return selection.promise; } }); await app.open();
    const button = app.find('restaurant-select'), message = app.find('restaurant-message');
    button.dispatch('click'); const before = message.textContent;
    app.widget.destroy(); const replacement = new Element('div'); replacement.textContent = '새 일정'; app.host.append(replacement);
    if (fail) selection.reject(Error('late error')); else selection.resolve({ ok: true });
    await settle();
    assert.equal(app.host.textContent, '새 일정'); assert.equal(message.textContent, before);
    button.dispatch('click'); await settle(); assert.equal(count, 1);
    assert.equal(app.timers.size, 0);
  }
});

test('a synchronous parent rerender in onSelect safely destroys the old widget', async () => {
  let count = 0;
  const app = runtime({ onSelect: () => { count++; app.widget.destroy(); app.host.textContent = '저장 후 새 화면'; return { ok: true }; } });
  await app.open(); const button = app.find('restaurant-select'); button.dispatch('click'); await settle();
  assert.equal(count, 1); assert.equal(app.host.textContent, '저장 후 새 화면');
});

test('buttons from a replaced lookup cannot select stale restaurant data', async () => {
  const chosen = []; let count = 0;
  const app = runtime({ fetchImpl: async () => ok([item(++count)]), onSelect: value => { chosen.push(value.id); return { ok: true }; } });
  await app.open(); const oldButton = app.find('restaurant-select');
  await app.click('restaurant-refresh');
  oldButton.dispatch('click'); await settle(); assert.deepEqual(chosen, []);
  await app.click('restaurant-select'); assert.deepEqual(chosen, ['tour-food-2']); app.widget.destroy();
});

test('more shows five then ten more cards locally, including usable selection buttons, without more API requests', async () => {
  const selected = [], app = runtime({ fetchImpl: async () => ok(Array.from({ length: 28 }, (_, index) => item(index + 1))),
    onSelect: value => { selected.push(value.id); return { ok: true }; } });
  await app.open(); assert.equal(app.all('restaurant-card').length, 5);
  for (const expected of [15, 25, 28]) {
    await app.click('restaurant-more'); assert.equal(app.all('restaurant-card').length, expected);
    assert.equal(app.all('restaurant-select').length, expected);
  }
  assert.equal(app.find('restaurant-more').hidden, true); assert.equal(app.calls.length, 1);
  app.all('restaurant-select').at(-1).dispatch('click'); await settle(); assert.deepEqual(selected, ['tour-food-28']);
  app.widget.destroy();
});

test('invalid restaurant data cannot offer a selection and an explicit retry restores valid results', async () => {
  let bad = true, selected = 0;
  const app = runtime({ fetchImpl: async () => ok([item(1, bad ? { sourceUrl: 'https://invalid.test' } : {})]),
    onSelect: () => { selected++; return { ok: true }; } });
  await app.open(); assert.equal(app.find('restaurant-select'), null);
  assert.match(app.find('restaurant-message').className, /is-error/);
  assert.equal(selected, 0); bad = false; await app.click('restaurant-refresh');
  assert.equal(app.all('restaurant-select').length, 1); app.widget.destroy();
});

test('district extraction accepts the integrated Gwangju address prefix without treating arbitrary prefixes as regions', () => {
  const app = runtime();
  for (const district of ['남구', '동구', '북구']) {
    assert.equal(app.api.districtFromAddress(`전남광주통합특별시 ${district} 문화로 10`), district);
    assert.equal(app.api.districtFromAddress(`대한민국 전남광주통합특별시 ${district} 문화로 10`), district);
  }
  assert.equal(app.api.districtFromAddress('광주광역시 남구 문화로 10'), '남구');
  assert.equal(app.api.districtFromAddress('경기도 광주시 중앙로 10'), '광주시');
  assert.equal(app.api.districtFromAddress('경기도 성남시 분당구 판교로 10'), '성남시 분당구');
  assert.equal(app.api.districtFromAddress('새로운특별시 남구 문화로 10'), '');
  assert.equal(app.api.districtFromAddress('전남광주통합특별시 문화로 10'), '');
  assert.equal(app.api.districtFromAddress(null), ''); app.widget.destroy();
});

function manual(options = {}) {
  const app = runtime(); app.widget.destroy();
  app.widget = app.api.mountManual(app.host, options);
  return app;
}
test('restaurant address copy uses the provided address without selecting the restaurant or querying again', async () => {
  const copied = [], selected = [], app = runtime({ onSelect: value => { selected.push(value); return { ok: true }; } });
  app.window.navigator = { clipboard: { writeText: async address => { copied.push(address); } } };
  await app.open(); const queries = app.calls.length;
  await app.click('address-copy-button');
  assert.deepEqual(copied, [item().address]); assert.equal(selected.length, 0); assert.equal(app.calls.length, queries);
  assert.match(app.find('address-copy-status').textContent, /복사했어요/); app.widget.destroy();
});
test('manual memo counter includes restored text and resets only after a successful clear', async () => {
  const app = manual({ name: '식당', description: '예약 메모', onClear: () => ({ ok: true }) });
  assert.equal(app.find('memo-counter').textContent, '5 / 500자');
  const memo = app.find('restaurant-manual-description'); memo.value = '변경'; memo.dispatch('input');
  assert.equal(app.find('memo-counter').textContent, '2 / 500자');
  await app.click('restaurant-manual-clear'); assert.equal(app.find('memo-counter').textContent, '0 / 500자');
  app.widget.destroy();
});
test('manual entry is prepopulated, separately labeled, multiline and never fetches', async () => {
  const saved = [], app = manual({ name:'동네 식당', description:'주소: 서울\n메모: 창가\t자리', onSave:value=>{saved.push(value);return {ok:true};},onClear:()=>({ok:true}) });
  assert.equal(app.find('restaurant-manual-name').value,'동네 식당');
  assert.equal(app.find('restaurant-manual-description').tagName,'textarea');
  assert.equal(app.all('restaurant-manual-label').length,2);
  await app.click('restaurant-manual-save');assert.equal(saved.length,1);assert.ok(Object.isFrozen(saved[0]));
  assert.equal(saved[0].description,'주소: 서울\n메모: 창가\t자리');assert.equal(app.calls.length,0);
  assert.match(app.find('restaurant-message').textContent,/저장했어요/);app.widget.destroy();
});
test('manual validation rejects missing/long names and invalid controls without silently truncating stored fields', async () => {
  let calls=0;const app=manual({name:'가'.repeat(80),description:'나'.repeat(501),onSave:()=>{calls++;return {ok:true};}});
  assert.equal(app.find('restaurant-manual-name').value.length,80);assert.equal(app.find('restaurant-manual-description').value.length,501);
  for(const [name,memo] of [['',''],['   ',''],['가'.repeat(61),''],['이름\n',''],['이름','나'.repeat(501)],['이름','bad\u0000'],['이름','bad\u007f']]) {
    app.find('restaurant-manual-name').value=name;app.find('restaurant-manual-description').value=memo;
    await app.click('restaurant-manual-save');assert.equal(calls,0);assert.match(app.find('restaurant-message').className,/is-error/);
  }
  app.find('restaurant-manual-name').value='가'.repeat(60);app.find('restaurant-manual-description').value='나'.repeat(500);
  await app.click('restaurant-manual-save');assert.equal(calls,1);app.widget.destroy();
});
test('manual clear uses separate callback and only resets after confirmed success', async () => {
  let cleared=0,success=false;const app=manual({name:'식당',description:'메모',onClear:()=>{cleared++;return {ok:success};}});
  assert.equal(app.find('restaurant-manual-save').disabled,true);
  await app.click('restaurant-manual-clear');assert.equal(app.find('restaurant-manual-name').value,'식당');
  success=true;await app.click('restaurant-manual-clear');assert.equal(cleared,2);assert.equal(app.find('restaurant-manual-name').value,'');assert.equal(app.find('restaurant-manual-description').value,'');app.widget.destroy();
});
test('manual pending operations block duplicates and ignore completion after destroy/replacement', async () => {
  for(const reject of [false,true]) {
    const job=deferred();let calls=0;const app=manual({name:'식당',onSave:()=>{calls++;return job.promise;},onClear:()=>{calls++;return {ok:true};}});
    const save=app.find('restaurant-manual-save'),clear=app.find('restaurant-manual-clear'),message=app.find('restaurant-message');
    save.dispatch('click');save.dispatch('click');clear.dispatch('click');assert.equal(calls,1);assert.equal(clear.disabled,true);assert.equal(app.find('restaurant-manual-name').disabled,true);
    const previous=message.textContent;app.widget.destroy();app.host.textContent='새 일정';save.dispatch('click');
    if(reject)job.reject(Error('private error'));else job.resolve({ok:true});await settle();
    assert.equal(app.host.textContent,'새 일정');assert.equal(message.textContent,previous);assert.equal(calls,1);
  }
});
test('manual callback failure is safe and retryable; detached controls cannot submit', async () => {
  let calls=0;const app=manual({name:'식당',onSave:()=>{calls++;throw Error('private diagnostics');}});
  await app.click('restaurant-manual-save');assert.doesNotMatch(app.host.textContent,/private/);assert.equal(app.find('restaurant-manual-save').disabled,false);
  const old=app.find('restaurant-manual-save');app.host.replaceChildren(new Element('div'));old.dispatch('click');await settle();assert.equal(calls,1);app.widget.destroy();assert.equal(app.host.children.length,1);
});
test('manual successful synchronous parent rerender cannot mutate replacement', async () => {
  const app=manual({name:'식당',onSave:()=>{app.widget.destroy();app.host.textContent='저장 완료';return {ok:true};}});
  await app.click('restaurant-manual-save');assert.equal(app.host.textContent,'저장 완료');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('account-ui.js', import.meta.url), 'utf8');
const settle = async () => { for (let index = 0; index < 25; index++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const clone = value => JSON.parse(JSON.stringify(value));
const documentFixture = () => ({ version: 8, itinerary: { cityId: 'sejong', startDate: '2026-10-20', dayCount: 1,
  dayAreaIds: ['a'], selections: { 0: ['place-a', 'place-b', 'place-c'] }, dayStarts: {}, eventEdits: {}, extraEvents: {}, excludedEvents: {}, eventOrders: {} } });
const person = { id: 'user-one', username: 'traveler_1' };
function planFixture(overrides = {}) { return { id: 'plan-one', title: '세종 산책', cityId: 'sejong', startDate: '2026-10-20', dayCount: 1,
  revision: 1, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z', ...overrides }; }
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

class Element {
  constructor(tagName, document) {
    this.tagName = tagName; this.document = document; this.children = []; this.parentNode = null; this.className = '';
    this.attributes = new Map(); this.listeners = new Map(); this._text = ''; this.value = ''; this.hidden = false; this.disabled = false;
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(_value) { throw Error('Account data must be rendered as text'); }
  get isConnected() { return this.document.body.contains(this); }
  append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...children); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  contains(target) { for (let node = target; node; node = node.parentNode) if (node === this) return true; return false; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, extra = {}) { for (const listener of this.listeners.get(type) || []) listener({ type, target: this, preventDefault() {}, ...extra }); }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { if (!this.disabled) this.document.activeElement = this; }
  querySelector(selector) {
    for (const child of this.children) { if (child.tagName === selector) return child; const found = child.querySelector(selector); if (found) return found; }
    return null;
  }
}
function all(root, className) {
  return (root.className.split(/\s+/).includes(className) ? [root] : []).concat(root.children.flatMap(child => all(child, className)));
}
function byText(root, text) {
  if (root.tagName === 'button' && root.textContent === text) return root;
  for (const child of root.children) { const match = byText(child, text); if (match) return match; }
  return null;
}
function runtime({ user = null, configured = true, plans = [], handler, onUserChange, loadDocument, broadcast = false } = {}) {
  const listeners = new Map(), timers = new Map(); let timerId = 0, reads = 0;
  const document = { activeElement: null, createElement: tag => new Element(tag, document),
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, extra = {}) { for (const listener of listeners.get(type) || []) listener({ type, target: document.activeElement, preventDefault() {}, ...extra }); }
  };
  document.body = document.createElement('body');
  const roots = Object.fromEntries(['accountRoot', 'libraryRoot', 'saveRoot'].map(name => [name, document.createElement('div')]));
  document.body.append(...Object.values(roots));
  const state = { user, configured, plans: plans.map(plan => ({ ...plan })), document: documentFixture(), messages: [], users: [], loads: [] };
  const calls = [], signals = [], channels = [], storedDocuments = new Map(plans.map(plan => [plan.id, documentFixture()]));
  let controller;
  async function backend(path, options) {
    const method = options.method, body = options.body ? JSON.parse(options.body) : undefined;
    const request = { path, method, body, options }; calls.push(request);
    if (handler) { const result = await handler(request, state); if (result !== undefined) return result; }
    if (path === '/api/auth/session') return response({ configured: state.configured, user: state.user });
    if (path === '/api/auth/login' || path === '/api/auth/signup') { state.user = { id: 'user-one', username: body.username }; return response({ user: state.user }); }
    if (path === '/api/auth/logout') { state.user = null; return response({ user: null }); }
    if (path === '/api/plans' && method === 'GET') return response({ plans: clone(state.plans) });
    if (path === '/api/plans' && method === 'POST') {
      const plan = planFixture({ id: `plan-${state.plans.length + 1}`, title: body.title }); state.plans.push(plan); storedDocuments.set(plan.id, clone(body.document)); return response({ plan });
    }
    const plan = state.plans.find(value => path === `/api/plans/${value.id}`);
    if (plan && method === 'GET') return response({ plan: { ...plan, document: clone(storedDocuments.get(plan.id)) } });
    if (plan && method === 'PUT') {
      if (body.revision !== plan.revision) return response({ error: { code: 'REVISION_CONFLICT' } }, 409);
      plan.title = body.title; plan.revision++; storedDocuments.set(plan.id, clone(body.document)); return response({ plan: { ...plan } });
    }
    if (plan && method === 'DELETE') { state.plans = state.plans.filter(value => value.id !== plan.id); return response({ ok: true }); }
    return response({ error: { code: 'NOT_FOUND', message: 'private server detail' } }, 404);
  }
  const windowListeners = new Map();
  const window = { TRAVEL_DATA: { cities: { sejong: { name: '세종' } } },
    addEventListener(type, listener) { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(listener); },
    removeEventListener(type, listener) { windowListeners.get(type)?.delete(listener); },
    dispatch(type, event) { for (const listener of windowListeners.get(type) || []) listener(event); }
  };
  if (broadcast) window.BroadcastChannel = class {
    constructor(name) { this.name = name; this.listeners = new Set(); this.closed = false; channels.push(this); }
    addEventListener(_type, listener) { this.listeners.add(listener); }
    removeEventListener(_type, listener) { this.listeners.delete(listener); }
    postMessage(value) { signals.push(value); }
    emit(data) { for (const listener of this.listeners) listener({ data }); }
    close() { this.closed = true; }
  };
  const context = vm.createContext({ window, document, TextEncoder, Intl, Date, AbortController,
    fetch: backend, localStorage: { setItem() { throw Error('Authentication must not use localStorage'); }, getItem() { throw Error('Authentication must not use localStorage'); } },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(code, context, { filename: 'account-ui.js' });
  controller = window.TravelAccount.mount({ ...roots, getDocument: () => { reads++; return state.document; }, getDefaultTitle: () => '세종 · 1일',
    loadDocument: async (doc, settings) => { state.loads.push({ doc, settings }); return loadDocument ? await loadDocument(doc, settings, state) : true; },
    onUserChange: async (next, metadata) => { state.users.push({ user: next, metadata }); if (onUserChange) await onUserChange(next, metadata, state); },
    onMessage: (text, kind) => state.messages.push({ text, kind }) });
  const find = name => all(document.body, name)[0] || null;
  return { controller, document, window, roots, state, calls, timers, signals, channels, find, all: name => all(document.body, name),
    get reads() { return reads; },
    async ready() { await controller.ready; await settle(); },
    async click(text, root = document.body) { const button = byText(root, text); assert.ok(button, `button exists: ${text}`); button.click(); await settle(); },
    async submit() { find('account-dialog-form').dispatch('submit'); await settle(); }
  };
}
function fillLogin(app, username = 'traveler_1') { app.find('account-username').value = username; app.find('account-password').value = 'a-long-password'; }

test('ready awaits the initial account transition and does not fetch plans before the correct draft owner is selected', async () => {
  const gate = deferred(), app = runtime({ user: person, onUserChange: () => gate.promise });
  await settle(); assert.equal(app.state.users[0].metadata.initial, true); assert.equal(app.state.users[0].user.id, person.id);
  assert.equal(app.calls.some(call => call.path === '/api/plans'), false);
  gate.resolve(); await app.ready(); assert.equal(app.calls.filter(call => call.path === '/api/plans').length, 1);
  assert.equal(app.reads, 0); app.controller.destroy();
});

test('unconfigured and unknown sessions settle gracefully, preserve local editing, and use distinct identity callbacks', async () => {
  const unavailable = runtime({ configured: false }); await unavailable.ready();
  assert.equal(unavailable.state.users[0].user, null);
  await unavailable.click('로그인 · 회원가입'); assert.match(unavailable.find('account-dialog-message').textContent, /계정 저장을 준비/);
  assert.equal(unavailable.find('account-username'), null); assert.equal(unavailable.reads, 0); unavailable.controller.destroy();
  const failed = runtime({ handler: request => request.path === '/api/auth/session' ? Promise.reject(Error('private error')) : undefined });
  await failed.ready(); assert.equal(failed.state.users[0].user, undefined);
  assert.match(failed.roots.accountRoot.textContent, /계정 다시 확인/); assert.doesNotMatch(failed.document.body.textContent, /private/);
  failed.controller.destroy();
});

test('signup validates confirmation and uses same-origin cookie requests without putting credentials in URLs or storage', async () => {
  const app = runtime(); await app.ready(); await app.click('로그인 · 회원가입');
  await app.click('회원가입', app.find('account-dialog-tabs')); fillLogin(app, 'Traveler_1');
  app.find('account-password-confirm').value = 'mismatch'; await app.submit();
  assert.match(app.find('account-dialog-message').textContent, /일치하지/);
  assert.equal(app.calls.filter(call => call.path === '/api/auth/signup').length, 0);
  app.find('account-password-confirm').value = 'a-long-password'; await app.submit();
  const request = app.calls.find(call => call.path === '/api/auth/signup');
  assert.equal(request.body.username, 'traveler_1'); assert.equal(request.body.password, 'a-long-password');
  assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.cache, 'no-store');
  assert.ok(app.calls.every(call => !call.path.includes('traveler_1') && !call.path.includes('password')));
  assert.equal(app.find('account-password'), null); assert.equal(app.find('account-user').textContent, 'traveler_1');
  assert.equal(app.state.users.at(-1).metadata.initial, false); assert.equal(app.state.users.at(-1).metadata.previousUser, null);
  assert.doesNotMatch(app.document.body.textContent, /a-long-password/); app.controller.destroy();
});

test('a failed login renders safe feedback and never exposes upstream diagnostics', async () => {
  const app = runtime({ handler: request => request.path === '/api/auth/login' ? response({ error: { code: 'INVALID_CREDENTIALS', message: 'private key diagnostic' } }, 401) : undefined });
  await app.ready(); await app.click('로그인 · 회원가입'); fillLogin(app); await app.submit();
  assert.match(app.find('account-dialog-message').textContent, /아이디나 비밀번호/);
  assert.doesNotMatch(app.document.body.textContent, /private|diagnostic/); assert.equal(app.find('account-username').disabled, false);
  app.controller.destroy();
});

test('changed only marks the current draft; explicit create, update and save-as use the correct revision contracts', async () => {
  const app = runtime({ user: person }); await app.ready(); app.controller.changed(); assert.equal(app.reads, 0);
  await app.click('계획표 저장', app.roots.saveRoot); app.find('account-plan-name').value = '내 계획'; await app.submit();
  const first = app.calls.find(call => call.path === '/api/plans' && call.method === 'POST');
  assert.equal(first.body.document.version, 8); assert.equal(first.body.title, '내 계획'); assert.equal('revision' in first.body, false);
  assert.equal('days' in first.body.document.itinerary, false);
  assert.deepEqual(first.body.document.itinerary.dayAreaIds, ['a']);
  assert.deepEqual(first.body.document.itinerary.selections[0], ['place-a', 'place-b', 'place-c']);
  assert.match(app.roots.saveRoot.textContent, /계정에 저장했어요/);
  app.controller.changed(); await app.click('변경사항 저장', app.roots.saveRoot); await app.submit();
  const update = app.calls.find(call => call.method === 'PUT'); assert.equal(update.body.revision, 1);
  await app.click('새 계획으로 저장', app.roots.saveRoot); await app.submit();
  assert.equal(app.calls.filter(call => call.method === 'POST' && call.path === '/api/plans').length, 2);
  assert.equal(app.reads, 6); app.controller.destroy();
});

test('a save response cannot mark subsequent edits clean or attach an older document to a newly generated note', async () => {
  for (const detach of [false, true]) {
    const saved = deferred(), app = runtime({ user: person, handler: request => request.method === 'POST' && request.path === '/api/plans' ? saved.promise : undefined });
    await app.ready(); await app.click('계획표 저장', app.roots.saveRoot); app.find('account-dialog-form').dispatch('submit');
    app.state.document.itinerary.note = 'new edits'; app.controller.changed(); if (detach) app.controller.detach();
    saved.resolve(response({ plan: planFixture() })); await settle();
    assert.match(app.roots.saveRoot.textContent, detach ? /계획표 저장/ : /계정에 저장하지 않은 수정/);
    assert.equal(app.state.document.itinerary.note, 'new edits'); app.controller.destroy();
  }
});

test('revision conflicts offer explicit save-as or reload and never silently retry an update', async () => {
  const existing = planFixture(), app = runtime({ user: person, plans: [existing], handler: request => request.method === 'PUT' ? response({ error: { code: 'REVISION_CONFLICT' } }, 409) : undefined });
  await app.ready(); app.controller.setCurrentPlan(existing); app.controller.changed();
  await app.click('변경사항 저장', app.roots.saveRoot); await app.submit();
  assert.match(app.find('account-dialog-title').textContent, /다른 기기/);
  assert.equal(app.calls.filter(call => call.method === 'PUT').length, 1);
  await app.click('새 계획으로 저장', app.find('account-dialog-actions')); await app.submit();
  assert.equal(app.calls.filter(call => call.method === 'POST' && call.path === '/api/plans').length, 1);
  assert.equal(app.calls.filter(call => call.method === 'PUT').length, 1); app.controller.destroy();
});

test('loading requires explicit confirmation and supplies a stale-operation guard to the document owner', async () => {
  const app = runtime({ user: person, plans: [planFixture()] }); await app.ready();
  await app.click('불러오기', app.roots.libraryRoot);
  assert.equal(app.calls.filter(call => call.path === '/api/plans/plan-one').length, 0);
  await app.click('불러오기', app.find('account-dialog-actions'));
  assert.equal(app.state.loads.length, 1); assert.equal(app.state.loads[0].doc.version, 8);
  assert.equal(app.state.loads[0].settings.isCurrent(), true);
  app.controller.changed(); assert.equal(app.state.loads[0].settings.isCurrent(), false);
  assert.match(app.roots.saveRoot.textContent, /변경사항 저장/); app.controller.destroy();
});

test('edits made while a plan downloads prevent loading it over the active draft', async () => {
  const download = deferred(), app = runtime({ user: person, plans: [planFixture()], handler: request => request.path === '/api/plans/plan-one' ? download.promise : undefined });
  await app.ready(); await app.click('불러오기', app.roots.libraryRoot);
  byText(app.find('account-dialog-actions'), '불러오기').click(); app.controller.changed();
  download.resolve(response({ plan: { ...planFixture(), document: documentFixture() } })); await settle();
  assert.equal(app.state.loads.length, 0); assert.match(app.find('account-dialog-message').textContent, /노트가 바뀌었어요/);
  app.controller.destroy();
});

test('deleting a saved plan confirms its revision and leaves working document ownership to the app', async () => {
  const existing = planFixture(), app = runtime({ user: person, plans: [existing] }); await app.ready(); app.controller.setCurrentPlan(existing);
  const before = clone(app.state.document); await app.click('삭제', app.roots.libraryRoot);
  assert.equal(app.calls.some(call => call.method === 'DELETE'), false);
  await app.click('삭제', app.find('account-dialog-actions'));
  assert.equal(app.calls.find(call => call.method === 'DELETE').body.revision, 1);
  assert.deepEqual(app.state.document, before); assert.equal(app.all('account-plan-card').length, 0);
  assert.match(app.roots.saveRoot.textContent, /계획표 저장/); app.controller.destroy();
});

test('logout awaits the app identity callback, clears the cloud list and invalidates in-flight load guards', async () => {
  const load = deferred(), identity = deferred();
  const app = runtime({ user: person, plans: [planFixture()], loadDocument: () => load.promise,
    onUserChange: (next, metadata, state) => { if (!metadata.initial && next === null) { state.document = null; return identity.promise; } } });
  await app.ready(); await app.click('불러오기', app.roots.libraryRoot); byText(app.find('account-dialog-actions'), '불러오기').click(); await settle();
  assert.equal(app.state.loads[0].settings.isCurrent(), true);
  byText(app.roots.accountRoot, '로그아웃').click(); await settle();
  assert.equal(app.state.loads[0].settings.isCurrent(), false);
  assert.equal(app.all('account-plan-card').length, 0); assert.equal(app.state.document, null);
  identity.resolve(); load.resolve(true); await settle();
  assert.equal(app.find('account-user'), null); assert.match(app.roots.saveRoot.textContent, /계획표 저장/);
  assert.equal(app.state.users.at(-1).metadata.previousUser.id, person.id); app.controller.destroy();
});

test('modal Escape restores focus, and the UTF-8 document size limit prevents oversized network writes', async () => {
  const app = runtime({ user: person }); await app.ready();
  const trigger = byText(app.roots.saveRoot, '계획표 저장'); trigger.focus(); trigger.click();
  assert.equal(app.document.activeElement, app.find('account-plan-name'));
  app.document.dispatch('keydown', { key: 'Escape' }); assert.equal(app.find('account-dialog-backdrop').hidden, true);
  assert.equal(app.document.activeElement, trigger);
  app.state.document.itinerary.memo = '가'.repeat(90000);
  await app.click('계획표 저장', app.roots.saveRoot);
  assert.match(app.state.messages.at(-1).text, /너무 커서/);
  assert.equal(app.calls.some(call => call.method === 'POST'), false); app.controller.destroy();
});

test('destroy ignores delayed responses, removes modal listeners and never touches replacement content', async () => {
  const session = deferred(), app = runtime({ handler: request => request.path === '/api/auth/session' ? session.promise : undefined });
  app.controller.destroy(); app.roots.accountRoot.textContent = '새 화면';
  session.resolve(response({ configured: true, user: person })); await app.ready();
  assert.equal(app.roots.accountRoot.textContent, '새 화면'); assert.equal(app.state.users.length, 0);
  assert.equal(app.find('account-dialog-backdrop'), null); assert.equal(app.timers.size, 0);
});

test('the initial session timeout releases ready with an unknown identity rather than blocking local startup indefinitely', async () => {
  const app = runtime({ handler: request => request.path === '/api/auth/session' ? new Promise((_resolve, reject) => {
    request.options.signal.addEventListener('abort', () => reject(Error('request aborted')));
  }) : undefined });
  const timeout = [...app.timers.values()][0]; assert.equal(timeout.delay, 8000);
  timeout.callback(); await app.ready();
  assert.equal(app.state.users[0].user, undefined); assert.equal(app.timers.size, 0);
  assert.match(app.roots.accountRoot.textContent, /계정 다시 확인/); app.controller.destroy();
});

test('cross-tab storage signals clear the former account before verification and ignore that account’s delayed list', async () => {
  const staleList = deferred(); let lists = 0;
  const other = { id: 'user-two', username: 'traveler_2' };
  const app = runtime({ user: person, handler: request => request.path === '/api/plans' && ++lists === 1 ? staleList.promise : undefined });
  await app.ready(); app.state.user = other; app.state.plans = [planFixture({ id: 'plan-two', title: '두 번째 계정 계획' })];
  app.window.dispatch('storage', { key: 'gil-account-session-change', newValue: 'changed' });
  assert.equal(app.find('account-user'), null); assert.equal(app.all('account-plan-card').length, 0);
  assert.equal(app.state.users.at(-1).user, undefined);
  assert.equal(app.state.users.at(-1).metadata.previousUser.id, person.id);
  await settle();
  staleList.resolve(response({ plans: [planFixture({ title: '이전 계정 비공개 계획' })] })); await settle();
  assert.equal(app.find('account-user').textContent, other.username);
  assert.match(app.roots.libraryRoot.textContent, /두 번째 계정 계획/);
  assert.doesNotMatch(app.roots.libraryRoot.textContent, /이전 계정/); app.controller.destroy();
});

test('returning to a visible tab verifies the cookie owner again before showing account data', async () => {
  const app = runtime({ user: person, plans: [planFixture()] }); await app.ready();
  app.document.visibilityState = 'hidden'; app.document.dispatch('visibilitychange');
  assert.equal(app.calls.filter(call => call.path === '/api/auth/session').length, 1);
  app.state.user = null; app.document.visibilityState = 'visible'; app.document.dispatch('visibilitychange');
  await settle();
  assert.equal(app.find('account-user'), null); assert.equal(app.calls.filter(call => call.path === '/api/auth/session').length, 2);
  assert.equal(app.state.users.at(-1).user, null); app.controller.destroy();
});

test('a same-account visibility probe preserves the linked plan, unsaved edits, modal fields and focus', async () => {
  const probe = deferred(); let sessions = 0;
  const app = runtime({ user: person, plans: [planFixture()], handler: request => request.path === '/api/auth/session' && ++sessions > 1 ? probe.promise : undefined });
  await app.ready(); app.controller.setCurrentPlan(planFixture()); app.controller.changed();
  await app.click('변경사항 저장', app.roots.saveRoot);
  const title = app.find('account-plan-name'); title.value = '작성 중인 계획표 이름'; title.focus();
  app.document.visibilityState = 'visible'; app.document.dispatch('visibilitychange');
  app.state.document.itinerary.memo = '확인 중에도 계속 작성'; app.controller.changed();
  probe.resolve(response({ configured: true, user: person })); await settle();
  assert.equal(app.state.users.length, 1);
  assert.equal(app.find('account-plan-name'), title); assert.equal(title.value, '작성 중인 계획표 이름');
  assert.equal(app.document.activeElement, title);
  assert.match(app.roots.saveRoot.textContent, /변경사항 저장/); assert.match(app.roots.saveRoot.textContent, /계정에 저장하지 않은 수정/);
  assert.equal(app.state.document.itinerary.memo, '확인 중에도 계속 작성');
  app.controller.destroy();
});

test('broadcast notifications contain no identity or credentials and the channel is cleaned up on destroy', async () => {
  const app = runtime({ broadcast: true }); await app.ready(); await app.click('로그인 · 회원가입'); fillLogin(app); await app.submit();
  assert.equal(app.signals.length, 1); assert.equal(app.signals[0].type, 'session-changed');
  assert.deepEqual(Object.keys(app.signals[0]).sort(), ['nonce', 'type']);
  assert.doesNotMatch(JSON.stringify(app.signals), /traveler_1|user-one|password/);
  app.state.user = null; app.channels[0].emit({ type: 'session-changed' }); await settle();
  assert.equal(app.find('account-user'), null); app.controller.destroy(); assert.equal(app.channels[0].closed, true);
});

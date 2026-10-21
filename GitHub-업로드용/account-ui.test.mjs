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
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  querySelector(selector) {
    for (const child of this.children) { if (selector.startsWith('.') ? child.className.split(/\s+/).includes(selector.slice(1)) : child.tagName === selector) return child; const found = child.querySelector(selector); if (found) return found; }
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
function runtime({ user = null, configured = true, plans = [], handler, onUserChange, onAttachmentChange, loadDocument, broadcast = false, notice = false, providers = [], location, socialPending = null, sessionStorageError = false } = {}) {
  const listeners = new Map(), timers = new Map(); let timerId = 0, reads = 0;
  const document = { activeElement: null, createElement: tag => new Element(tag, document),
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, extra = {}) { for (const listener of listeners.get(type) || []) listener({ type, target: document.activeElement, preventDefault() {}, ...extra }); }
  };
  document.body = document.createElement('body');
  const roots = Object.fromEntries(['accountRoot', 'libraryRoot', 'saveRoot', ...(notice ? ['noticeRoot'] : [])].map(name => [name, document.createElement('div')]));
  document.body.append(...Object.values(roots));
  const state = { user, configured, plans: plans.map(plan => ({ ...plan })), document: documentFixture(), messages: [], users: [], loads: [], attachments: [], navigations: [], history: [],savedDocuments:[] };
  const calls = [], signals = [], channels = [], storedDocuments = new Map(plans.map(plan => [plan.id, documentFixture()]));
  let controller;
  async function backend(path, options) {
    const method = options.method, body = options.body ? JSON.parse(options.body) : undefined;
    const request = { path, method, body, options }; calls.push(request);
    if (handler) { const result = await handler(request, state); if (result !== undefined) return result; }
    if (path === '/api/auth/session') return response({ configured: state.configured, user: state.user });
    if (path === '/api/auth/providers') return response({ configured: providers.length > 0, providers });
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
  const sessionStore = new Map(socialPending ? [['gil-social-login-pending', JSON.stringify(socialPending)]] : []);
  const window = { TRAVEL_DATA: { cities: { sejong: { name: '세종' } } },
    sessionStorage: {
      getItem: key => sessionStore.get(key) ?? null,
      setItem(key, value) { if (sessionStorageError) throw Error('private storage detail'); sessionStore.set(key, value); },
      removeItem: key => sessionStore.delete(key)
    },
    location: { pathname: '/', search: '', hash: '#/start', ...location, assign: target => state.navigations.push(target) },
    history: { state: null, replaceState: (...args) => state.history.push(args) },
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
  const context = vm.createContext({ window, document, TextEncoder, Intl, Date, AbortController, URLSearchParams,
    fetch: backend, localStorage: { setItem() { throw Error('Authentication must not use localStorage'); }, getItem() { throw Error('Authentication must not use localStorage'); } },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(code, context, { filename: 'account-ui.js' });
  controller = window.TravelAccount.mount({ ...roots, getDocument: () => { reads++; return state.document; }, getDefaultTitle: () => '세종 · 1일',
    loadDocument: async (doc, settings) => { state.loads.push({ doc, settings }); return loadDocument ? await loadDocument(doc, settings, state) : true; },
    onUserChange: async (next, metadata) => { state.users.push({ user: next, metadata }); if (onUserChange) await onUserChange(next, metadata, state); },
    onAttachmentChange: snapshot => { state.attachments.push(clone(snapshot)); if (onAttachmentChange) return onAttachmentChange(snapshot, state); },
    onSaved: snapshot=>state.savedDocuments.push(clone(snapshot)),
    onMessage: (text, kind) => state.messages.push({ text, kind }) });
  const find = name => all(document.body, name)[0] || null;
  return { controller, document, window, roots, state, calls, timers, signals, channels, sessionStore, find, all: name => all(document.body, name),
    get reads() { return reads; },
    async ready() { await controller.ready; await settle(); },
    async click(text, root = document.body) { const button = byText(root, text); assert.ok(button, `button exists: ${text}`); button.click(); await settle(); },
    async submit() { find('account-dialog-form').dispatch('submit'); await settle(); }
  };
}
function fillLogin(app, username = 'traveler_1') { app.find('account-username').value = username; app.find('account-password').value = 'a-long-password'; }

test('a restored account attachment verifies ownership and updates the same plan after a refresh', async () => {
  const existing = planFixture(), app = runtime({ user: person, plans: [existing] }); await app.ready();
  const draft = clone(app.state.document);
  const result = await app.controller.restoreAttachment({ ownerId: person.id, plan: existing });
  assert.equal(result.ok, true); assert.deepEqual(app.state.document, draft);
  assert.match(app.roots.saveRoot.textContent, /변경사항 저장/);
  await app.click('변경사항 저장', app.roots.saveRoot); await app.submit();
  const writes = app.calls.filter(call => ['POST', 'PUT'].includes(call.method));
  assert.equal(writes.length, 1); assert.equal(writes[0].method, 'PUT');
  assert.equal(writes[0].path, '/api/plans/plan-one'); assert.equal(writes[0].body.revision, 1);
  const attached = clone(app.controller.getAttachment());
  assert.equal(attached.ownerId, person.id); assert.equal(attached.plan.revision, 2);
  assert.equal(Object.hasOwn(attached.plan, 'document'), false);
  assert.deepEqual(app.state.attachments.at(-1), attached); app.controller.destroy();
});

test('restoration never adopts a newer cloud revision over the local draft or writes without resolving the conflict', async () => {
  const app = runtime({ user: person, plans: [planFixture({ revision: 4 })] }); await app.ready();
  const draft = clone(app.state.document);
  const result = await app.controller.restoreAttachment({ ownerId: person.id, plan: planFixture({ revision: 2 }) });
  assert.equal(result.reason, 'conflict'); assert.equal(app.controller.getAttachment().plan.revision, 2);
  await app.click('변경사항 저장', app.roots.saveRoot);
  assert.match(app.find('account-dialog-title').textContent, /다른 기기/);
  assert.equal(app.calls.some(call => ['POST', 'PUT'].includes(call.method)), false);
  assert.deepEqual(app.state.document, draft); app.controller.destroy();
});

test('a failed attachment check preserves the link and blocks accidental duplicate creates until retry succeeds', async () => {
  let unavailable = true;
  const app = runtime({ user: person, plans: [planFixture()], handler: request => request.path === '/api/plans/plan-one'
    && request.method === 'GET' && unavailable ? Promise.reject(Error('network detail')) : undefined });
  await app.ready();
  const result = await app.controller.restoreAttachment({ ownerId: person.id, plan: planFixture() });
  assert.equal(result.reason, 'unavailable'); assert.equal(app.controller.getAttachment().plan.id, 'plan-one');
  await app.click('저장 연결 다시 확인', app.roots.saveRoot);
  assert.equal(app.find('account-plan-name'), null);
  assert.equal(app.calls.some(call => call.method === 'POST'), false);
  assert.doesNotMatch(app.document.body.textContent, /network detail/);
  unavailable = false; await app.click('저장 연결 다시 확인', app.roots.saveRoot);
  assert.equal(app.find('account-dialog-title').textContent, '계획표 변경사항 저장');
  await app.submit();
  assert.equal(app.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 0); app.controller.destroy();
});

test('attachments belonging to another account never trigger a document request', async () => {
  const app = runtime({ user: person }); await app.ready();
  const before = app.calls.length;
  const result = await app.controller.restoreAttachment({ ownerId: 'someone-else', plan: planFixture() });
  assert.equal(result.reason, 'not-owned'); assert.equal(app.calls.length, before);
  assert.equal(app.controller.getAttachment(), null); assert.deepEqual(app.state.attachments, []); app.controller.destroy();
});

test('a missing attached plan detaches metadata while preserving the working note', async () => {
  const app = runtime({ user: person }); await app.ready();
  const draft = clone(app.state.document);
  const result = await app.controller.restoreAttachment({ ownerId: person.id, plan: planFixture() });
  assert.equal(result.reason, 'missing'); assert.equal(app.controller.getAttachment(), null);
  assert.deepEqual(app.state.attachments, [null]); assert.deepEqual(app.state.document, draft);
  assert.match(app.state.messages.at(-1).text, /이 기기 노트는 유지/); app.controller.destroy();
});

test('an obsolete attachment verification cannot replace a newly detached note', async () => {
  const gate = deferred(), app = runtime({ user: person, plans: [planFixture()], handler: request => request.path === '/api/plans/plan-one'
    && request.method === 'GET' ? gate.promise : undefined }); await app.ready();
  const pending = app.controller.restoreAttachment({ ownerId: person.id, plan: planFixture() });
  app.controller.detach(); gate.resolve(response({ plan: planFixture({ document: documentFixture() }) }));
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(app.controller.getAttachment(), null);
  assert.match(app.roots.saveRoot.textContent, /계획표 저장/); app.controller.destroy();
});

test('account initialization can await restored metadata before enabling cloud saves', async () => {
  let app, restored;
  app = runtime({ user: person, plans: [planFixture()], onUserChange: async next => {
    if (next) restored = await app.controller.restoreAttachment({ ownerId: next.id, plan: planFixture() });
  } });
  await app.ready(); assert.equal(restored.ok, true);
  assert.equal(app.controller.getAttachment().plan.id, 'plan-one');
  assert.equal(app.roots.saveRoot.children[0].disabled, false);
  assert.ok(app.calls.findIndex(call => call.path === '/api/plans/plan-one') < app.calls.findIndex(call => call.path === '/api/plans'));
  app.controller.destroy();
});

test('logout invalidates a pending restoration and never attaches another account response', async () => {
  const gate = deferred(), app = runtime({ user: person, plans: [planFixture()], handler: request => request.path === '/api/plans/plan-one'
    && request.method === 'GET' ? gate.promise : undefined }); await app.ready();
  const pending = app.controller.restoreAttachment({ ownerId: person.id, plan: planFixture() });
  await app.click('로그아웃');
  gate.resolve(response({ plan: planFixture({ document: documentFixture() }) })); await pending;
  assert.equal(app.controller.getAttachment(), null); assert.equal(app.state.attachments.length, 0);
  assert.equal(app.find('account-user'), null); app.controller.destroy();
});

test('attachment callbacks contain only owner and plan metadata and an account reset cannot clear the former owner draft', async () => {
  const app = runtime({ user: person }); await app.ready();
  app.controller.setCurrentPlan({ ...planFixture(), document: documentFixture(), accessToken: 'private', ownerId: 'untrusted' });
  assert.deepEqual(Object.keys(app.state.attachments.at(-1)).sort(), ['ownerId', 'plan']);
  assert.deepEqual(Object.keys(app.state.attachments.at(-1).plan).sort(), ['cityId', 'createdAt', 'dayCount', 'id', 'revision', 'startDate', 'title', 'updatedAt']);
  await app.click('로그아웃');
  assert.equal(app.state.attachments.length, 1); assert.equal(app.controller.getAttachment(), null); app.controller.destroy();
});

test('successful cloud writes retain a local attachment persistence warning instead of reporting unqualified success', async () => {
  for (const fail of [() => false, () => { throw Error('private local error'); }]) {
    const app = runtime({ user: person, onAttachmentChange: fail }); await app.ready();
    await app.click('계획표 저장', app.roots.saveRoot); await app.submit();
    assert.equal(app.calls.filter(call => call.path === '/api/plans' && call.method === 'POST').length, 1);
    assert.equal(app.controller.getAttachment().plan.id, 'plan-1');
    assert.match(app.state.messages.at(-1).text, /계정에는 저장.*새로고침 후/);
    assert.equal(app.state.messages.at(-1).kind, 'error'); assert.doesNotMatch(app.document.body.textContent, /private local error/);
    app.controller.destroy();
  }
});

test('every plan request carries the expected owner while account requests do not', async () => {
  const existing = planFixture(), app = runtime({ user: person, plans: [existing] }); await app.ready();
  await app.click('계획표 저장', app.roots.saveRoot); await app.submit();
  await app.click('변경사항 저장', app.roots.saveRoot); await app.submit();
  await app.click('삭제', app.roots.libraryRoot); await app.click('삭제', app.find('account-dialog'));
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const request = app.calls.find(call => call.path.startsWith('/api/plans') && call.method === method);
    assert.ok(request); assert.equal(request.options.headers['X-Gil-Expected-User'], person.id);
  }
  assert.ok(app.calls.filter(call => call.path.startsWith('/api/plans')).every(call => call.options.headers['X-Gil-Expected-User'] === person.id));
  assert.ok(app.calls.filter(call => call.path.startsWith('/api/auth')).every(call => !Object.hasOwn(call.options.headers, 'X-Gil-Expected-User')));
  await app.click('로그아웃');
  assert.equal(Object.hasOwn(app.calls.find(call => call.path === '/api/auth/logout').options.headers, 'X-Gil-Expected-User'), false);
  app.controller.destroy();
});

test('a cross-tab account mismatch rechecks the session instead of saving or deleting under the new owner', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const replacement = { id: 'user-two', username: 'traveler_2' }, existing = planFixture();
    const app = runtime({ user: person, plans: [existing], handler: (request, state) => {
      if (request.path.startsWith('/api/plans') && request.method === method) {
        state.user = replacement; return response({ error: { code: 'SESSION_CHANGED' } }, 409);
      }
      if (request.path === '/api/plans' && request.method === 'GET' && state.user?.id === replacement.id) return response({ plans: [] });
      return undefined;
    } }); await app.ready();
    if (method === 'PUT') app.controller.setCurrentPlan(existing);
    if (method === 'DELETE') { await app.click('삭제', app.roots.libraryRoot); await app.click('삭제', app.find('account-dialog')); }
    else { await app.click(method === 'POST' ? '계획표 저장' : '변경사항 저장', app.roots.saveRoot); await app.submit(); }
    assert.equal(app.calls.filter(call => call.method === method && call.path.startsWith('/api/plans')).length, 1);
    assert.equal(app.calls.filter(call => call.path === '/api/auth/session').length, 2);
    assert.equal(app.state.users.at(-1).user.id, replacement.id); assert.equal(app.controller.getAttachment(), null);
    assert.match(app.state.messages.at(-1).text, method === 'DELETE' ? /계정이 바뀌어 삭제하지 않았어요/ : /계정이 바뀌어 저장하지 않았어요/);
    assert.equal(app.state.messages.at(-1).kind, 'error');
    assert.equal(app.find('account-dialog-backdrop').hidden, true); app.controller.destroy();
  }
});

test('a changed cookie owner cannot expose another account list or document through a plan read', async () => {
  for (const operation of ['list', 'load', 'restore']) {
    const replacement = { id: 'user-two', username: 'traveler_2' }, existing = planFixture();
    const app = runtime({ user: person, plans: [existing], handler: (request, state) => {
      if (request.method === 'GET' && request.path === (operation === 'list' ? '/api/plans' : '/api/plans/plan-one')
        && state.user.id === person.id) {
        assert.equal(request.options.headers['X-Gil-Expected-User'], person.id);
        state.user = replacement; return response({ error: { code: 'SESSION_CHANGED' } }, 409);
      }
      if (request.path === '/api/plans' && request.method === 'GET' && state.user?.id === replacement.id) {
        assert.equal(request.options.headers['X-Gil-Expected-User'], replacement.id);
        return response({ plans: [] });
      }
      return undefined;
    } }); await app.ready();
    if (operation === 'load') { await app.click('불러오기', app.roots.libraryRoot); await app.click('불러오기', app.find('account-dialog')); }
    if (operation === 'restore') {
      const result = await app.controller.restoreAttachment({ ownerId: person.id, plan: existing });
      assert.equal(result.reason, 'invalid');
    }
    assert.equal(app.state.users.at(-1).user.id, replacement.id);
    assert.equal(app.find('account-user').textContent, replacement.username);
    assert.equal(app.state.loads.length, 0); assert.equal(app.controller.getAttachment(), null);
    assert.equal(app.all('account-plan-card').length, 0);
    assert.equal(app.calls.filter(call => call.path === '/api/auth/session').length, 2);
    assert.match(app.state.messages.at(-1).text, /로그인 계정이 바뀌어/);
    app.controller.destroy();
  }
});

test('configured social providers preserve the current day return route and keep password login available', async () => {
  const providers = ['google', 'kakao', 'naver'].map(id => ({ id, label: id, startUrl: `/api/auth/oauth/${id}/start` }));
  const app = runtime({ providers, location: { hash: '#/note/day/2' } }); await app.ready();
  await app.click('로그인 · 회원가입');
  assert.ok(app.find('account-username')); assert.ok(app.find('account-password'));
  assert.equal(app.all('account-social-button').length, 3);
  await app.click('카카오로 계속하기');
  assert.deepEqual(app.state.navigations, ['/api/auth/oauth/kakao/start?returnTo=%2F%23%2Fnote%2Fday%2F2']);
  assert.equal(app.calls.some(call => call.method !== 'GET'), false); app.controller.destroy();
});

test('unconfigured, unknown and unsafe social links stay hidden without blocking password login', async () => {
  for (const providers of [[], [{ id: 'untrusted', startUrl: 'https://external.test/' }], [{ id: 'google', startUrl: '//external.test/' }],
    [{ id: 'google', startUrl: '/api/auth/oauth/google/start' }, { id: 'google', startUrl: '/api/auth/oauth/google/start' }]]) {
    const app = runtime({ providers }); await app.ready(); await app.click('로그인 · 회원가입');
    assert.equal(app.all('account-social-button').length, 0); assert.ok(app.find('account-username'));
    assert.deepEqual(app.state.navigations, []); app.controller.destroy();
  }
});

test('delayed provider responses cannot insert controls in a replacement dialog', async () => {
  const gate = deferred(), app = runtime({ handler: request => request.path === '/api/auth/providers' ? gate.promise : undefined });
  await app.ready(); await app.click('로그인 · 회원가입');
  app.document.dispatch('keydown', { key: 'Escape' });
  gate.resolve(response({ configured: true, providers: [{ id: 'google', label: 'Google', startUrl: '/api/auth/oauth/google/start' }] }));
  await settle(); assert.equal(app.all('account-social-button').length, 0); app.controller.destroy();
});

test('social callback feedback removes only its status query and preserves the note route', async () => {
  const app = runtime({ user: person, location: { search: '?keep=yes&social=success', hash: '#/note/day/2' } });
  await app.ready();
  assert.equal(app.state.history.at(-1)[2], '/?keep=yes#/note/day/2');
  assert.match(app.state.messages.at(-1).text, /로그인했어요/);
  assert.equal(app.state.messages.at(-1).kind, 'success'); app.controller.destroy();
  const failed = runtime({ location: { search: '?social=failed' } }); await failed.ready();
  assert.match(failed.state.messages.at(-1).text, /완료하지 못했어요/); assert.equal(failed.state.messages.at(-1).kind, 'error'); failed.controller.destroy();
});

test('a verified social sign-in notifies other tabs to recheck their account without broadcasting identity data', async () => {
  const app = runtime({ user: person, broadcast: true, location: { search: '?social=success' } }); await app.ready();
  assert.equal(app.signals.length, 1); assert.equal(app.signals[0].type, 'session-changed');
  assert.deepEqual(Object.keys(app.signals[0]).sort(), ['nonce', 'type']);
  assert.equal(JSON.stringify(app.signals).includes(person.id), false);
  assert.equal(JSON.stringify(app.signals).includes(person.username), false);
  app.controller.destroy();
  for (const location of [{ search: '?social=failed' }, { search: '?social=success' }]) {
    const guest = runtime({ broadcast: true, location }); await guest.ready(); assert.equal(guest.signals.length, 0); guest.controller.destroy();
  }
});

test('only a recent same-tab social attempt can request adoption of the guest note and the marker is consumed once', async () => {
  const marker = { returnTo: '/#/note/day/2', at: Date.now() - 1000 };
  const app = runtime({ user: person, location: { search: '?social=success', hash: '#/note/day/2' }, socialPending: marker });
  await app.ready(); assert.equal(app.state.users[0].metadata.socialReturn, true);
  assert.equal(app.sessionStore.has('gil-social-login-pending'), false); app.controller.destroy();
  for (const [location, socialPending, user] of [
    [{ search: '?social=success', hash: '#/note/day/2' }, null, person],
    [{ search: '?social=success', hash: '#/note/day/2' }, { ...marker, at: Date.now() - 600001 }, person],
    [{ search: '?social=success', hash: '#/note/day/1' }, marker, person],
    [{ search: '?social=failed', hash: '#/note/day/2' }, marker, person],
    [{ search: '?social=success', hash: '#/note/day/2' }, marker, null]
  ]) {
    const rejected = runtime({ user, location, socialPending }); await rejected.ready();
    assert.equal(rejected.state.users[0].metadata.socialReturn, false);
    assert.equal(rejected.sessionStore.has('gil-social-login-pending'), false); rejected.controller.destroy();
  }
});

test('social redirect records only a return route and time, and blocked session storage prevents unsafe navigation', async () => {
  const providers = [{ id: 'google', label: 'Google', startUrl: '/api/auth/oauth/google/start' }];
  const app = runtime({ providers }); await app.ready(); await app.click('로그인 · 회원가입'); await app.click('Google로 계속하기');
  const marker = JSON.parse(app.sessionStore.get('gil-social-login-pending'));
  assert.deepEqual(Object.keys(marker).sort(), ['at', 'returnTo']); assert.equal(marker.returnTo, '/#/start');
  assert.equal(Number.isSafeInteger(marker.at), true); assert.equal(app.state.navigations.length, 1); app.controller.destroy();
  const blocked = runtime({ providers, sessionStorageError: true }); await blocked.ready(); await blocked.click('로그인 · 회원가입'); await blocked.click('Google로 계속하기');
  assert.equal(blocked.state.navigations.length, 0); assert.match(blocked.find('account-dialog-message').textContent, /브라우저 저장/);
  assert.doesNotMatch(blocked.document.body.textContent, /private storage detail/); blocked.controller.destroy();
});

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
  await unavailable.click('계정 저장 준비 중'); assert.match(unavailable.find('account-dialog-message').textContent, /계정 저장을 준비/);
  assert.equal(unavailable.find('account-username'), null); assert.equal(unavailable.reads, 0); unavailable.controller.destroy();
  const failed = runtime({ handler: request => request.path === '/api/auth/session' ? Promise.reject(Error('private error')) : undefined });
  await failed.ready(); assert.equal(failed.state.users[0].user, undefined);
  assert.match(failed.roots.accountRoot.textContent, /계정 다시 확인/); assert.doesNotMatch(failed.document.body.textContent, /private/);
  failed.controller.destroy();
});

test('setup can be checked again from the notice without reloading or replacing the guest draft', async () => {
  const app = runtime({ configured: false, notice: true }); await app.ready();
  app.state.document.itinerary.memo = '설정하는 동안 작성한 메모';
  const draft = clone(app.state.document);
  assert.match(app.roots.noticeRoot.textContent, /계정 저장을 준비/);
  app.state.configured = true;
  await app.click('다시 확인', app.roots.noticeRoot);
  assert.equal(app.calls.filter(call => call.path === '/api/auth/session').length, 2);
  assert.match(app.roots.accountRoot.textContent, /로그인 · 회원가입/);
  assert.match(app.roots.noticeRoot.textContent, /다른 기기에서도 내 계획/);
  assert.deepEqual(app.state.document, draft); assert.equal(app.reads, 0);
  assert.ok(app.state.users.every(change => change.user === null));
  await app.click('로그인', app.roots.noticeRoot);
  assert.ok(app.find('account-username')); app.controller.destroy();
});

test('the unavailable dialog retries safely and opens login only after setup is ready', async () => {
  let failSession = false;
  const app = runtime({ configured: false, handler: request => request.path === '/api/auth/session' && failSession
    ? Promise.reject(Error('private setup diagnostic')) : undefined });
  await app.ready(); app.state.document.itinerary.memo = '그대로 남을 초안';
  const draft = clone(app.state.document);
  await app.click('계정 저장 준비 중', app.roots.accountRoot);
  await app.click('다시 확인', app.find('account-dialog'));
  assert.equal(app.find('account-username'), null);
  assert.match(app.find('account-dialog-message').textContent, /계정 저장을 준비/);
  failSession = true;
  await app.click('다시 확인', app.find('account-dialog'));
  assert.match(app.find('account-dialog-message').textContent, /계정에 연결하지 못했어요/);
  assert.doesNotMatch(app.document.body.textContent, /private|diagnostic/);
  assert.equal(app.find('account-dialog-actions').querySelector('button').disabled, false);
  failSession = false; app.state.configured = true;
  await app.click('다시 확인', app.find('account-dialog'));
  assert.ok(app.find('account-username')); assert.ok(app.find('account-password'));
  assert.equal(app.calls.filter(call => ['/api/auth/signup', '/api/auth/login'].includes(call.path)).length, 0);
  assert.deepEqual(app.state.document, draft); assert.equal(app.reads, 0);
  app.controller.destroy();
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

test('password visibility is independent for signup fields, keeps values and resets when the dialog reopens', async () => {
  const app = runtime(); await app.ready(); await app.click('로그인 · 회원가입'); await app.click('회원가입', app.find('account-dialog-tabs'));
  const password = app.find('account-password'), confirmation = app.find('account-password-confirm');
  password.value = 'a-long-password'; confirmation.value = 'confirmation-value';
  const toggles = app.all('account-password-toggle'); assert.equal(toggles.length, 2);
  toggles[0].click(); assert.equal(password.type, 'text'); assert.equal(confirmation.type, 'password');
  assert.equal(toggles[0].getAttribute('aria-pressed'), 'true');
  assert.equal(password.value, 'a-long-password'); assert.equal(confirmation.value, 'confirmation-value');
  toggles[1].click(); assert.equal(confirmation.type, 'text');
  toggles[0].click(); assert.equal(password.type, 'password');
  await app.click('×'); await app.click('로그인 · 회원가입');
  assert.equal(app.find('account-password').type, 'password'); assert.equal(app.find('account-password').value, '');
  app.controller.destroy();
});

test('saved plans sort locally by updated time or start date and retain the choice through refresh', async () => {
  const plans = [
    planFixture({ id: 'later', title: '늦게 출발', startDate: '2026-12-01', updatedAt: '2026-10-21T01:00:00Z' }),
    planFixture({ id: 'soon', title: '먼저 출발', startDate: '2026-11-01', updatedAt: '2026-10-20T01:00:00Z' }),
    planFixture({ id: 'middle', title: '중간 출발', startDate: '2026-11-10', updatedAt: '2026-10-21T00:00:00Z' })
  ];
  const app = runtime({ user: person, plans }); await app.ready();
  const titles = () => app.all('account-plan-title').map(node => node.textContent);
  assert.deepEqual(titles(), ['늦게 출발', '중간 출발', '먼저 출발']);
  const calls = app.calls.length, sort = app.find('account-sort-select'); sort.value = 'start'; sort.dispatch('change');
  assert.deepEqual(titles(), ['먼저 출발', '중간 출발', '늦게 출발']); assert.equal(app.calls.length, calls);
  await app.click('새로고침', app.roots.libraryRoot);
  assert.equal(app.find('account-sort-select').value, 'start'); assert.deepEqual(titles(), ['먼저 출발', '중간 출발', '늦게 출발']);
  app.controller.destroy();
});

test('saved plan search combines normalized title and region words locally while preserving the input and its focus', async () => {
  const app = runtime({ user: person, plans: [
    planFixture({ id: 'one', title: '가족 Summer 여행', cityId: 'busan' }),
    planFixture({ id: 'two', title: '친구 Summer 여행', cityId: 'busan' }),
    planFixture({ id: 'three', title: '가족 산책' })
  ] });
  app.window.TRAVEL_DATA.cities.busan = { name: '부산' }; await app.ready();
  const before = clone(app.state), calls = app.calls.length, search = app.find('account-plan-search');
  const titles = () => app.all('account-plan-title').map(node => node.textContent);
  search.focus();
  for (const query of ['부산 가족', '  ＳＵＭＭＥＲ 가족  ']) {
    search.value = query; search.dispatch('input');
    assert.deepEqual(titles(), ['가족 Summer 여행']);
    assert.equal(app.find('account-plan-search'), search); assert.equal(app.document.activeElement, search);
    assert.match(app.find('account-search-result').textContent, /검색 결과 1개 · 전체 3개/);
  }
  search.value = '<script>.*'; search.dispatch('input');
  assert.equal(titles().length, 0); assert.match(app.find('account-search-result').textContent, /검색 결과가 없어요/);
  await app.click('검색 지우기');
  assert.equal(search.value, ''); assert.equal(titles().length, 3); assert.equal(app.document.activeElement, search);
  search.value = '   '; search.dispatch('input'); assert.equal(titles().length, 3);
  assert.equal(app.calls.length, calls); assert.deepEqual(clone(app.state), before);
  app.controller.destroy();
});

test('search survives sorting, list refresh and late destination names while retaining cursor on catalog updates', async () => {
  const app = runtime({ user: person, plans: [
    planFixture({ id: 'later', title: '가족 나들이', cityId: 'busan', startDate: '2026-11-01' }),
    planFixture({ id: 'early', title: '가족 산책', cityId: 'busan' }), planFixture({ id: 'other', title: '혼자 여행' })
  ] }); await app.ready();
  const search = app.find('account-plan-search'); search.value = '부산'; search.dispatch('input');
  assert.equal(app.all('account-plan-card').length, 0);
  search.focus(); search.setSelectionRange(1, 2);
  const calls = app.calls.length;
  app.window.TRAVEL_DATA.cities.busan = { name: '부산' }; app.controller.refreshDestinations();
  assert.equal(app.calls.length, calls); assert.equal(app.all('account-plan-card').length, 2);
  assert.equal(app.document.activeElement, app.find('account-plan-search'));
  assert.equal(app.find('account-plan-search').selectionStart, 1); assert.equal(app.find('account-plan-search').selectionEnd, 2);
  const sort = app.find('account-sort-select'); sort.value = 'start'; sort.dispatch('change');
  assert.equal(app.find('account-plan-search').value, '부산');
  assert.deepEqual(app.all('account-plan-title').map(node => node.textContent), ['가족 산책', '가족 나들이']);
  await app.click('새로고침', app.roots.libraryRoot);
  assert.equal(app.find('account-plan-search').value, '부산'); assert.equal(app.find('account-sort-select').value, 'start');
  assert.equal(app.all('account-plan-card').length, 2); app.controller.destroy();
});

test('a filtered library does not replace a restored attachment and saves keep both the original owner and active search', async () => {
  const attached = planFixture({ id: 'attached', title: '가족 산책' });
  const app = runtime({ user: person, plans: [attached, planFixture({ id: 'other', title: '혼자 여행' })] });
  await app.ready();
  const search = app.find('account-plan-search'); search.value = '혼자'; search.dispatch('input');
  const result = await app.controller.restoreAttachment({ ownerId: person.id, plan: attached });
  assert.equal(result.ok, true); assert.equal(app.controller.getAttachment().plan.id, attached.id);
  assert.deepEqual(app.all('account-plan-title').map(node => node.textContent), ['혼자 여행']);
  await app.click('변경사항 저장', app.roots.saveRoot); await app.submit();
  const update = app.calls.find(call => call.method === 'PUT');
  assert.equal(update.path, '/api/plans/attached'); assert.equal(update.body.revision, 1);
  assert.equal(update.options.headers['X-Gil-Expected-User'], person.id);
  assert.equal(app.calls.some(call => call.method === 'POST'), false);
  assert.equal(app.controller.getAttachment().plan.revision, 2);
  assert.equal(app.find('account-plan-search').value, '혼자');
  assert.deepEqual(app.all('account-plan-title').map(node => node.textContent), ['혼자 여행']);
  app.controller.destroy();
});

test('filtered load and delete actions target the matching plan and account changes clear the former search', async () => {
  const app = runtime({ user: person, plans: [planFixture({ id: 'one', title: '가족 산책' }), planFixture({ id: 'two', title: '혼자 여행' })] });
  await app.ready();
  const search = app.find('account-plan-search'); search.value = '혼자'; search.dispatch('input');
  await app.click('불러오기', app.roots.libraryRoot); await app.click('불러오기', app.find('account-dialog-actions'));
  assert.equal(app.calls.filter(call => call.path === '/api/plans/two' && call.method === 'GET').length, 1);
  await app.click('삭제', app.roots.libraryRoot); await app.click('삭제', app.find('account-dialog-actions'));
  assert.equal(app.calls.filter(call => call.path === '/api/plans/two' && call.method === 'DELETE').length, 1);
  assert.equal(app.find('account-plan-search').value, '혼자'); assert.equal(app.all('account-plan-card').length, 0);
  app.state.user = { id: 'user-two', username: 'traveler_2' }; app.state.plans = [planFixture({ title: '새 계정 계획' })];
  app.window.dispatch('storage', { key: 'gil-account-session-change', newValue: 'changed' }); await settle();
  assert.equal(app.find('account-plan-search').value, '');
  assert.deepEqual(app.all('account-plan-title').map(node => node.textContent), ['새 계정 계획']);
  app.controller.destroy();
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
    assert.equal(app.state.savedDocuments.length,detach?0:1);
    if(!detach)assert.equal(app.state.savedDocuments[0].itinerary.note,undefined,'the callback receives only the snapshot actually saved');
    assert.equal(app.state.document.itinerary.note, 'new edits'); app.controller.destroy();
  }
});

test('revision conflicts offer explicit save-as or reload and never silently retry an update', async () => {
  const existing = planFixture(), app = runtime({ user: person, plans: [existing], handler: request => request.method === 'PUT' ? response({ error: { code: 'REVISION_CONFLICT' } }, 409) : undefined });
  await app.ready(); app.controller.setCurrentPlan(existing); app.controller.changed();
  await app.click('변경사항 저장', app.roots.saveRoot); await app.submit();
  assert.match(app.find('account-dialog-title').textContent, /다른 기기/);
  assert.equal(app.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(app.state.savedDocuments.length,0,'a rejected save must not clear pending highlights');
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

test('a visible guest tab reflects setup becoming ready or unavailable without an identity transition', async () => {
  const app = runtime({ configured: false, notice: true }); await app.ready();
  app.state.document.itinerary.memo = '계속 편집 중인 여행';
  const draft = clone(app.state.document), initialTransitions = app.state.users.length;
  await app.click('계정 저장 준비 중', app.roots.accountRoot);
  app.state.configured = true;
  app.document.visibilityState = 'visible'; app.document.dispatch('visibilitychange'); await settle();
  assert.match(app.roots.accountRoot.textContent, /로그인 · 회원가입/);
  assert.match(app.roots.saveRoot.textContent, /계획표 저장/);
  assert.equal(app.find('account-dialog-backdrop').hidden, true);
  await app.click('로그인 · 회원가입'); fillLogin(app);
  app.state.configured = false;
  app.document.dispatch('visibilitychange'); await settle();
  assert.match(app.roots.accountRoot.textContent, /계정 저장 준비 중/);
  assert.match(app.roots.noticeRoot.textContent, /계정 저장을 준비/);
  assert.equal(app.find('account-username'), null);
  await app.click('계정 저장 준비 중', app.roots.accountRoot);
  assert.equal(app.find('account-username'), null);
  assert.equal(app.state.users.length, initialTransitions);
  assert.deepEqual(app.state.document, draft); assert.equal(app.reads, 0);
  app.controller.destroy();
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


test('cloud load preserves the document owners local persistence warning', async () => {
  const warning='이 기기 자동저장에 실패했어요.';
  const app=runtime({user:person,plans:[planFixture()],loadDocument:()=>({ok:true,warning})});await app.ready();
  await app.click('불러오기',app.roots.libraryRoot);await app.click('불러오기',app.find('account-dialog-actions'));
  assert.equal(app.state.messages.at(-1).text,warning);assert.equal(app.state.messages.at(-1).kind,'error');
  assert.equal(app.find('account-dialog-backdrop').hidden,true);
  assert.match(app.roots.saveRoot.textContent,/변경사항 저장/);app.controller.destroy();
});

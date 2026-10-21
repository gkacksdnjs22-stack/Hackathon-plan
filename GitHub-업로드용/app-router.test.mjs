import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('app.js', import.meta.url), 'utf8');
const plannerCode = readFileSync(new URL('planner.js', import.meta.url), 'utf8');
const accountCode = readFileSync(new URL('account-ui.js', import.meta.url), 'utf8');
const noteToolsCode = readFileSync(new URL('note-tools.js', import.meta.url), 'utf8');
const storageKey = 'travel-weave-itinerary-v1';
const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Element {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase(); this.document = document; this.children = []; this.parentNode = null;
    this.className = ''; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
    this.hidden = false; this.disabled = false; this.open = false; this._text = ''; this._value = '';
    const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      contains: name => classes().has(name),
      add: (...names) => { const namesSet = classes(); names.forEach(name => namesSet.add(name)); this.className = [...namesSet].join(' '); },
      remove: (...names) => { const namesSet = classes(); names.forEach(name => namesSet.delete(name)); this.className = [...namesSet].join(' '); },
      toggle: (name, force) => {
        const namesSet = classes(), enabled = force === undefined ? !namesSet.has(name) : force;
        if (enabled) namesSet.add(name); else namesSet.delete(name);
        this.className = [...namesSet].join(' '); return enabled;
      }
    };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(value) { this.replaceChildren(); this._text = String(value); }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  get options() { return this.children; }
  get childNodes() { return this.children; }
  get isConnected() { return this.document.body.contains(this); }
  set selectedIndex(value) { this._value = this.children[value]?.value || ''; }
  append(...children) {
    for (const child of children) {
      child.remove();
      child.parentNode = this; this.children.push(child);
      if (this.tagName === 'SELECT' && this.children.length === 1) this._value = child.value;
    }
  }
  prepend(...children) { for (const child of [...children].reverse()) this.insertBefore(child, this.children[0] || null); }
  insertBefore(child, before) {
    child.remove(); child.parentNode = this;
    const at = this.children.indexOf(before);
    if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = []; this._text = '';
    if (this.tagName === 'SELECT') this._value = '';
    this.append(...children);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  contains(target) {
    for (let node = target; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, extra = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    const bubbles = !['pointerenter', 'pointerleave', 'mouseenter', 'mouseleave', 'focus', 'blur'].includes(type);
    if (bubbles) this.document.dispatch(type, this, event, 'capture');
    for (let node = this; node; node = bubbles ? node.parentNode : null)
      for (const listener of node.listeners.get(type) || []) listener(event);
    if (bubbles) this.document.dispatch(type, this, event, 'bubble');
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  scrollIntoView(options) { this.lastScrollIntoView = options; }
  focus() {
    if (this.disabled || this.document.activeElement === this) return;
    const previous = this.document.activeElement;
    this.document.activeElement = this;
    previous?.dispatch('focusout', { relatedTarget: this });
    this.dispatch('focusin', { relatedTarget: previous });
  }
  closest(selector) {
    const selectors = selector.split(',');
    for (let node = this; node; node = node.parentNode) {
      if (selectors.some(part => node.matches(part))) return node;
    }
    return null;
  }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector === 'details[open]') return this.tagName === 'DETAILS' && this.open;
    const data = selector.match(/^\[data-([a-z-]+)="([^"]*)"\]$/);
    if (data) return this.dataset[data[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] === data[2];
    const attribute = selector.match(/^(\w+)?\[([\w-]+)="([^"]*)"\]$/);
    if (attribute) return (!attribute[1] || this.tagName === attribute[1].toUpperCase())
      && (this.getAttribute(attribute[2]) ?? this[attribute[2]]) === attribute[3];
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) {
    const parts = selector.split(/\s+/);
    const matches = node => {
      if (!node.matches(parts.at(-1))) return false;
      let ancestor = node.parentNode;
      for (let index = parts.length - 2; index >= 0; index--) {
        while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentNode;
        if (!ancestor) return false;
        ancestor = ancestor.parentNode;
      }
      return true;
    };
    const results = [];
    const visit = node => { for (const child of node.children) { if (matches(child)) results.push(child); visit(child); } };
    visit(this); return results;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function itinerary(input = {}) {
  return {
    ok: true, cityId: 'test-city', countryName: '대한민국', cityName: '테스트시', dataSource: 'tourapi',
    startDate: input.startDate || '2026-10-20', dayCount: 1, dayAreaIds: ['area-a'],
    eventEdits: input.eventEdits || {}, dayStarts: input.dayStarts || {},
    days: [{ index: 1, date: '10월 20일', areaId: 'area-a', events: [], start: 540, end: 600 }]
  };
}
function savedNote(note = itinerary()) { return JSON.stringify({ version: 7, savedAt: '2026-10-20T00:00:00Z', itinerary: note }); }
function actualPlannerFixture() {
  const city = { id: 'test-city', name: '테스트시', country: 'KR', timezone: 'Asia/Seoul', supportedDays: 1, dataSource: 'tourapi',
    areas: [{ id: 'area-a', name: '남구 · 공원', places: [] }] };
  const area = city.areas[0];
  area.places = ['a', 'b', 'c', 'd'].map(id => ({ id, name: `추천 관광지 ${id}`, areaId: area.id, area: area.name, areaName: area.name,
    stayMinutes: 60, address: '광주광역시 남구 문화로 10', intro: '방문 전 확인', category: '관광지', latitude: 35.1, longitude: 126.9 }));
  const window = { TRAVEL_DATA: { countries: { KR: '대한민국' }, cities: { [city.id]: city } } };
  vm.runInContext(plannerCode, vm.createContext({ window, Intl, Date }), { filename: 'planner.js' });
  return { cityData: city, planner: window.TravelPlanner };
}

function timedNoteFixture(dayCount = 1) {
  const fixture = actualPlannerFixture(), city = fixture.cityData;
  const first = city.areas[0]; city.supportedDays = dayCount;
  for (let index = 1; index < dayCount; index++) {
    const area = { id: `area-${index}`, name: `남구 · 산책길 ${index}`, places: [] };
    area.places = first.places.map(place => ({ ...place, id: `${place.id}-${index}`, areaId: area.id, area: area.name, areaName: area.name }));
    city.areas.push(area);
  }
  const origin = { mode: 'car', id: 'osm-node-1', name: '출발할 숙소', address: '광주광역시 남구 문화로 1',
    latitude: 35.1, longitude: 126.9, source: 'OpenStreetMap', sourceUrl: 'https://www.openstreetmap.org/node/1' };
  const dayDepartures = {}, eventEdits = {};
  for (let index = 0; index < dayCount; index++) {
    dayDepartures[index] = origin;
    eventEdits[index] = { departure: { duration: 30 }, 'transfer-0': { duration: 20 }, 'transfer-1': { duration: 15 } };
  }
  const note = fixture.planner.createItinerary({ city, startDate: '2026-10-20', dayCount, dayDepartures, eventEdits });
  assert.equal(note.ok, true, note.reason);
  assert.ok(note.days.every(day => !day.timesProvisional));
  return { ...fixture, note };
}

function runtime({ hash = '', raw = null, destinationsPromise, ensureCity, loadError, storageError, cityData = null, planner = null, withAccount = false, accountUser = null, accountReady, accountHandler, currentDateTime='2026-10-20T12:00:00' } = {}) {
  const elements = new Map(), documentListeners = new Map(), documentCaptureListeners = new Map();
  const document = {
    title: '', activeElement: null,
    createElement: tag => new Element(tag, document),
    getElementById: id => elements.get(id) || document.body.querySelector(`#${id}`),
    querySelector: selector => document.body.querySelector(selector),
    querySelectorAll: selector => document.body.querySelectorAll(selector),
    addEventListener(type, listener, options = false) {
      const listeners = (typeof options === 'boolean' ? options : options.capture) ? documentCaptureListeners : documentListeners;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener, options = false) {
      const listeners = (typeof options === 'boolean' ? options : options.capture) ? documentCaptureListeners : documentListeners;
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, target, extra = {}, phase = 'all') {
      const event = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
      if (phase !== 'bubble') for (const listener of documentCaptureListeners.get(type) || []) listener(event);
      if (phase !== 'capture') for (const listener of documentListeners.get(type) || []) listener(event);
    }
  };
  document.body = document.createElement('body');
  const ids = ['country-select', 'city-select', 'start-date', 'day-count', 'trip-form', 'destinations-retry',
    'city-note', 'duration-note', 'data-status', 'app-message', 'date-trigger', 'itinerary-section',
    'empty-state', 'day-list', 'day-bookmarks', 'trip-summary', 'note-timing-notice', 'capacity-message', 'print-button', 'clear-button', 'undo-button', 'redo-button',
    'start-screen', 'screen-loading', 'resume-note', 'resume-summary', 'title', 'itinerary-title', 'loading-title', 'account-nav', 'account-notice', 'saved-plans', 'account-save'];
  for (const id of ids) {
    const tag = ['city-select', 'day-count'].includes(id) ? 'select' : id === 'trip-form' ? 'form' : ['print-button','clear-button','undo-button','redo-button'].includes(id) ? 'button' : 'div';
    const element = document.createElement(tag); element.id = id; elements.set(id, element);
  }
  const $ = id => elements.get(id);
  $('country-select').value = 'KR'; $('app-message').hidden = true; $('note-timing-notice').hidden = true;
  $('start-screen').append($('title'), $('trip-form'), $('resume-note'), $('empty-state'));
  $('resume-note').append($('resume-summary'));
  $('itinerary-section').append($('itinerary-title'), $('trip-summary'), $('undo-button'), $('redo-button'), $('note-timing-notice'), $('day-list'));
  $('screen-loading').append($('loading-title'));
  document.body.append($('app-message'), $('screen-loading'), $('start-screen'), $('itinerary-section'));
  const submit = document.createElement('button'); submit.type = 'submit'; submit.append(document.createElement('span'));
  $('trip-form').append(submit);
  const listeners = new Map(), history = [hash], scrolls = [], creations = [], mounts = [];
  let historyIndex = 0, currentHash = hash;
  const emitHash = () => { for (const listener of listeners.get('hashchange') || []) listener({ type: 'hashchange' }); };
  const location = {};
  Object.defineProperty(location, 'hash', {
    get: () => currentHash,
    set: value => {
      if (value === currentHash) return;
      currentHash = value; history.splice(++historyIndex); history.push(value); queueMicrotask(emitHash);
    }
  });
  const city = cityData || { id: 'test-city', country: 'KR', name: '테스트시', timezone: 'Asia/Seoul', supportedDays: 1,
    dataSource: 'tourapi', areas: [{ id: 'area-a', name: '중구 · 공원', places: [] }] };
  const behavior = { createError: null, confirmClear: true, confirmations: [] };
  const window = {
    location, history: {
      replaceState(_state, _title, value) { currentHash = value; history[historyIndex] = value; },
      back() { if (historyIndex > 0) { currentHash = history[--historyIndex]; emitHash(); } },
      forward() { if (historyIndex < history.length - 1) { currentHash = history[++historyIndex]; emitHash(); } }
    },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, event) { for (const listener of listeners.get(type) || []) listener(event); },
    scrollTo: options => scrolls.push(options), print() {},
    confirm(text) { behavior.confirmations.push(text); return behavior.confirmClear; },
    TRAVEL_DATA: { countries: { KR: '대한민국' }, cities: { [city.id]: city } },
    TourData: {
      async loadDestinations() { if (loadError) throw loadError; return destinationsPromise ? await destinationsPromise : [city]; },
      async ensureCity(id) { return ensureCity ? await ensureCity(id) : city; }
    },
    TravelPlanner: {
      ...planner,
      createItinerary(input) { creations.push(input); return behavior.createError ? { ok: false, reason: behavior.createError } : planner ? planner.createItinerary(input) : itinerary(input); },
      formatTime: minutes => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
    }
  };
  function mountStub(kind) {
    return { mount(host, options) {
      const details = document.createElement('details'); details.append(document.createElement('summary')); host.append(details);
      const record = { kind, host, options, destroyed: false }; mounts.push(record);
      return { set() {}, destroy() { record.destroyed = true; host.replaceChildren(); } };
    } };
  }
  window.TravelDeparture = mountStub('departure');
  window.TravelSchedule = mountStub('schedule');
  window.TravelRestaurants = { ...mountStub('restaurant'), mountManual: mountStub('manual-restaurant').mount, districtFromAddress: () => '남구' };
  const account={options:null,changes:0,detaches:0};
  if(withAccount&&!accountHandler)window.TravelAccount={mount(options){
    account.options=options;
    return {ready:Promise.resolve(accountReady).then(()=>options.onUserChange(accountUser,{initial:true})),changed(){account.changes++;},detach(){account.detaches++;}};
  }};
  const stored = new Map(raw === null ? [] : [[storageKey, raw]]), writes = [], removals = [];
  const localStorage = {
    getItem(key) { if (storageError?.get) throw Error('storage inaccessible'); return stored.get(key) ?? null; },
    setItem(key, value) { if (storageError?.set) throw Error('storage full'); writes.push([key, value]); stored.set(key, value); },
    removeItem(key) { if (storageError?.remove) throw Error('storage locked'); removals.push(key); stored.delete(key); }
  };
  let now = 0, timerId = 0;
  let dateTime=new Date(currentDateTime).getTime();
  class AppDate extends Date{
    constructor(...args){super(...(args.length?args:[dateTime]));}
    static now(){return dateTime;}
  }
  const pending = new Map(), scheduled = [];
  const clock = {
    pending, scheduled,
    setDate(value){dateTime=new Date(value).getTime();},
    setTimeout(callback, delay) {
      const timer = { id: ++timerId, callback, at: now + delay, delay };
      pending.set(timer.id, timer); scheduled.push(timer); return timer.id;
    },
    clearTimeout(id) { pending.delete(id); },
    advance(milliseconds) {
      const until = now + milliseconds;
      for (;;) {
        const next = [...pending.values()].filter(timer => timer.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        pending.delete(next.id); now = next.at; next.callback();
      }
      now = until;
    }
  };
  const context = vm.createContext({ window, document, localStorage, Date:AppDate, JSON, console, TextEncoder, AbortController,
    fetch: accountHandler, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  if(withAccount&&accountHandler){
    vm.runInContext(accountCode, context, { filename: 'account-ui.js' });
    const mountAccount = window.TravelAccount.mount;
    window.TravelAccount.mount = options => {
      account.options = options;
      account.controller = mountAccount(options);
      return account.controller;
    };
  }
  vm.runInContext(noteToolsCode, context, { filename: 'note-tools.js' });
  vm.runInContext(code, context, { filename: 'app.js' });
  return { $, window, document, stored, writes, removals, creations, behavior, scrolls, clock, mounts, account,
    async go(value) { location.hash = value; await settle(); },
    async create() { $('trip-form').dispatch('submit'); await settle(); },
    async clear() { $('clear-button').dispatch('click'); await settle(); }
  };
}
function screen(app, expected) {
  assert.equal(app.document.body.dataset.screen, expected);
  assert.equal(app.$('start-screen').hidden, expected !== 'start');
  assert.equal(app.$('itinerary-section').hidden, expected !== 'note');
  assert.equal(app.$('screen-loading').hidden, expected !== 'loading');
}

test('account storage exports only canonical editing parameters and restores them through the real planner',async()=>{
  const fixture=actualPlannerFixture(),app=runtime({...fixture,withAccount:true});
  await settle();await app.create();
  const document=app.account.options.getDocument();
  assert.equal(document.version,8);
  assert.equal(document.itinerary.days,undefined);
  assert.equal(document.itinerary.cityName,undefined);
  assert.equal(document.itinerary.routes,undefined);
  assert.deepEqual(Array.from(document.itinerary.selections[0]),['a','b','c']);
  document.itinerary.eventEdits={0:{finish:{title:'숙소로 돌아가기',duration:25,description:'내 메모'}}};
  assert.equal(await app.account.options.loadDocument(document),true);
  await settle();screen(app,'note');
  const stored=JSON.parse(app.stored.get(storageKey)).itinerary;
  assert.equal(stored.eventEdits[0].finish.title,'숙소로 돌아가기');
  assert.equal(stored.days[0].events.at(-1).duration,25);
  assert.ok(app.account.changes>=2);
});

test('a malformed remote document or a superseded account load keeps the current draft intact',async()=>{
  const fixture=actualPlannerFixture(),app=runtime({...fixture,withAccount:true});
  await settle();await app.create();
  const original=app.stored.get(storageKey),day=app.$('day-list').children[0];
  const invalid=app.account.options.getDocument();invalid.itinerary.dayAreaIds=[];
  assert.equal(await app.account.options.loadDocument(invalid),false);
  assert.equal(app.stored.get(storageKey),original);assert.equal(app.$('day-list').children[0],day);
  assert.equal(await app.account.options.loadDocument(app.account.options.getDocument(),{isCurrent:()=>false}),false);
  assert.equal(app.stored.get(storageKey),original);assert.equal(app.$('day-list').children[0],day);
});

test('new notes and clearing detach a prior account plan without deleting remote data',async()=>{
  const fixture=actualPlannerFixture(),app=runtime({...fixture,withAccount:true});
  await settle();await app.create();assert.equal(app.account.detaches,1);
  await app.create();assert.equal(app.account.detaches,2);
  await app.clear();assert.equal(app.account.detaches,3);
  assert.equal(app.account.options.getDocument(),null);
});

test('local drafts are moved into an account slot and hidden from sign-out and another account',async()=>{
  const fixture=actualPlannerFixture(),app=runtime({...fixture,withAccount:true});
  await settle();await app.create();
  const original=app.account.options.getDocument();
  await app.account.options.onUserChange({id:'owner-a',username:'alice'},{initial:false});
  assert.equal(app.stored.has(storageKey),false);
  assert.equal(JSON.parse(app.stored.get(`${storageKey}:owner-a`)).ownerId,'owner-a');
  await app.account.options.onUserChange(null,{initial:false});
  screen(app,'start');assert.equal(app.account.options.getDocument(),null);
  await app.account.options.onUserChange({id:'owner-b',username:'bob'},{initial:false});
  assert.equal(app.account.options.getDocument(),null);
  assert.equal(app.$('resume-note').hidden,true);
  await app.account.options.onUserChange(null,{initial:false});
  await app.account.options.onUserChange({id:'owner-a',username:'alice'},{initial:false});
  assert.deepEqual(JSON.parse(JSON.stringify(app.account.options.getDocument())),JSON.parse(JSON.stringify(original)));
  assert.equal(app.$('resume-note').hidden,false);
});

test('initial account verification finishes before any private browser draft restoration',async()=>{
  const auth=deferred(),fixture=actualPlannerFixture(),guestNote=fixture.planner.createItinerary({city:fixture.cityData,startDate:'2026-10-20',dayCount:1});
  const app=runtime({...fixture,withAccount:true,accountUser:{id:'owner-b',username:'bob'},accountReady:auth.promise,hash:'#/note',raw:savedNote(guestNote)});
  await settle();screen(app,'loading');assert.equal(app.account.options.getDocument(),null);
  auth.resolve();await settle();screen(app,'start');
  assert.equal(app.account.options.getDocument(),null);
  assert.equal(app.stored.get(storageKey),savedNote(guestNote));
});

for (const entry of ['notice', 'dialog']) {
  test(`a failed guest setup retry from the ${entry} preserves the real app note and edit history through recovery`, async () => {
    let failSession = false, configured = false;
    const app = runtime({ ...actualPlannerFixture(), withAccount: true, accountHandler: async path => {
      assert.equal(path, '/api/auth/session');
      if (failSession) throw Error('temporary connection failure');
      return { ok: true, status: 200, json: async () => ({ configured, user: null }) };
    } });
    await app.account.controller.ready; await settle(); await app.create();
    const original = noteParameters(app);
    assert.equal(manualMeal(app).options.onSave({ name: '게스트 식당', description: '다시 확인 중에도 남아야 할 메모' }).ok, true);
    const edited = noteParameters(app), saved = app.stored.get(storageKey), day = app.$('day-list').children[0];
    const click = async (root, text) => {
      const button = root.querySelectorAll('button').find(button => button.textContent === text);
      assert.ok(button, `button exists: ${text}`); button.click(); await settle();
    };
    if (entry === 'notice') await app.go('#/start');
    else await click(app.$('account-nav'), '계정 저장 준비 중');
    const route = app.window.location.hash;
    failSession = true;
    const retryRoot = () => entry === 'notice' ? app.$('account-notice') : app.document.querySelector('.account-dialog');
    await click(retryRoot(), '다시 확인');
    assert.equal(app.window.location.hash, route);
    assert.ok(app.account.options.getDocument(), 'a failed setup check must not clear the guest note');
    assert.deepEqual(noteParameters(app), edited);
    assert.equal(app.stored.get(storageKey), saved);
    assert.equal(app.$('day-list').children[0], day);
    assert.equal(app.$('undo-button').disabled, false);
    app.$('undo-button').click(); assert.deepEqual(noteParameters(app), original);
    app.$('redo-button').click(); assert.deepEqual(noteParameters(app), edited);
    failSession = false; configured = true;
    await click(retryRoot(), '다시 확인');
    assert.deepEqual(noteParameters(app), edited);
    assert.equal(app.$('undo-button').disabled, false);
    assert.match(app.$('account-nav').textContent, /로그인 · 회원가입/);
    app.account.controller.destroy();
  });
}

test('a failed cross-tab account check still hides the former owners real note and history', async () => {
  let failSession = false, user = { id: 'owner-a', username: 'alice' };
  const app = runtime({ ...actualPlannerFixture(), withAccount: true, accountHandler: async path => {
    if (path === '/api/plans') return { ok: true, status: 200, json: async () => ({ plans: [] }) };
    assert.equal(path, '/api/auth/session');
    if (failSession) throw Error('temporary connection failure');
    return { ok: true, status: 200, json: async () => ({ configured: true, user }) };
  } });
  await app.account.controller.ready; await settle(); await app.create();
  manualMeal(app).options.onSave({ name: '계정 A의 식당', description: '계정 A의 비공개 메모' });
  const saved = app.stored.get(`${storageKey}:owner-a`);
  assert.ok(saved); assert.equal(app.$('undo-button').disabled, false);
  failSession = true; user = { id: 'owner-b', username: 'bob' };
  app.window.dispatch('storage', { key: 'gil-account-session-change', newValue: 'changed' }); await settle();
  screen(app, 'start');
  assert.equal(app.account.options.getDocument(), null);
  assert.equal(app.$('undo-button').disabled, true);
  assert.equal(app.$('redo-button').disabled, true);
  assert.equal(app.stored.get(`${storageKey}:owner-a`), saved);
  failSession = false;
  app.$('account-nav').querySelector('button').click(); await settle();
  assert.match(app.$('account-nav').textContent, /bob/);
  assert.equal(app.account.options.getDocument(), null);
  assert.equal(app.stored.get(`${storageKey}:owner-a`), saved);
  app.account.controller.destroy();
});

test('bookmarks reopen and focus the target day while collapse survives another days edit without saving presentation state', async () => {
  const app = runtime({ ...timedNoteFixture(2), withAccount: true }); await settle();
  app.$('day-count').value = '2'; await app.create();
  let first = app.$('day-list').children[0];
  assert.equal(first.querySelector('.day-title strong').textContent, '10월 20일 (화)');
  assert.deepEqual(app.$('day-bookmarks').children.map(button => button.textContent), ['Day 01', 'Day 02']);
  const saved = app.stored.get(storageKey), writes = app.writes.length;
  first.querySelector('.day-collapse').click();
  assert.equal(first.querySelector('.day-card-body').hidden, true);
  assert.equal(first.querySelector('.day-collapse').getAttribute('aria-expanded'), 'false');
  assert.equal(app.stored.get(storageKey), saved); assert.equal(app.writes.length, writes);
  manualMeal(app).options.onSave({ name: '둘째 날 식당', description: '' });
  first = app.$('day-list').children[0]; assert.equal(first.querySelector('.day-card-body').hidden, true);
  const beforeJump = app.writes.length;
  app.$('day-bookmarks').children[0].click();
  assert.equal(first.querySelector('.day-card-body').hidden, false);
  assert.equal(app.document.activeElement, first); assert.equal(first.lastScrollIntoView.block, 'start');
  assert.equal(app.window.location.hash, '#/note'); assert.equal(app.writes.length, beforeJump);
  assert.equal(app.$('day-list').children[1].querySelector('.day-card-body').hidden, false);
});

test('undo and redo preserve each days current collapsed or expanded state', async () => {
  for (const collapsed of [[true, false], [false, true], [true, true]]) {
    const app = runtime({ ...timedNoteFixture(2), withAccount: true }); await settle();
    app.$('day-count').value = '2'; await app.create();
    const original = noteParameters(app);
    assert.equal(currentSchedule(app).options.onAdd({ type: 'free', title: '둘째 날 메모', duration: 30 }).ok, true);
    const edited = noteParameters(app);
    collapsed.forEach((hidden, index) => { if (hidden) app.$('day-list').children[index].querySelector('.day-collapse').click(); });
    for (const [action, expected] of [['undo', original], ['redo', edited]]) {
      app.$(`${action}-button`).click();
      assert.deepEqual(noteParameters(app), expected);
      assert.deepEqual(app.$('day-list').children.map(day => day.querySelector('.day-card-body').hidden), collapsed);
      assert.deepEqual(app.$('day-list').children.map(day => day.querySelector('.day-collapse').getAttribute('aria-expanded')),
        collapsed.map(hidden => String(!hidden)));
      assert.equal(app.account.options.getDocument().itinerary.collapsedDays, undefined);
    }
  }
});

test('collapse resets when loading another note or creating a new one, while a failed load preserves it', async () => {
  const app = runtime({ ...timedNoteFixture(2), withAccount: true }); await settle();
  app.$('day-count').value = '2'; await app.create();
  const saved = app.account.options.getDocument();
  app.$('day-list').children[0].querySelector('.day-collapse').click();
  const invalid = { ...saved, itinerary: { ...saved.itinerary, dayAreaIds: [] } };
  assert.equal(await app.account.options.loadDocument(invalid), false);
  assert.equal(app.$('day-list').children[0].querySelector('.day-card-body').hidden, true);
  assert.equal(await app.account.options.loadDocument(saved), true);
  assert.ok(app.$('day-list').children.every(day => !day.querySelector('.day-card-body').hidden));
  app.$('day-list').children[1].querySelector('.day-collapse').click();
  await app.create();
  assert.ok(app.$('day-list').children.every(day => !day.querySelector('.day-card-body').hidden));
});

test('daily summaries update after editing and note countdown reflects the actual trip start', async () => {
  const app = runtime({ ...actualPlannerFixture(), withAccount: true }); await settle(); await app.create();
  assert.match(app.$('trip-summary').textContent, /오늘 출발/);
  assert.match(app.$('day-list').querySelector('.day-summary').textContent, /관광지 3곳.*체류 3시간.*미정 3구간 별도/);
  currentSchedule(app).options.onAdd({ type: 'transfer', title: '숙소 이동', duration: 45 });
  assert.match(app.$('day-list').querySelector('.day-summary').textContent, /입력된 이동 45분.*미정 3구간 별도/);
  app.$('undo-button').click();
  assert.match(app.$('day-list').querySelector('.day-summary').textContent, /입력된 이동 0분/);
  app.clock.setDate('2026-10-21T12:00:00'); app.window.dispatch('focus', {});
  assert.match(app.$('trip-summary').textContent, /지난 여행/);
});

test('place address copy prevents duplicate requests and reports success, denial and unavailable clipboard safely', async () => {
  const app = runtime({ ...actualPlannerFixture(), withAccount: true }); await settle(); await app.create();
  const pending = deferred(), copied = [];
  app.window.navigator = { clipboard: { writeText(value) { copied.push(value); return pending.promise; } } };
  const button = app.$('day-list').querySelector('.address-copy-button'), status = app.$('day-list').querySelector('.address-copy-status');
  button.click(); button.click(); assert.equal(copied.length, 1); assert.equal(button.disabled, true);
  assert.equal(copied[0], '광주광역시 남구 문화로 10');
  pending.resolve(); await settle(); assert.equal(button.disabled, false); assert.match(status.textContent, /복사했어요/);
  app.window.navigator.clipboard.writeText = async () => { throw Error('private browser error'); };
  button.click(); await settle(); assert.match(status.textContent, /직접 선택/); assert.doesNotMatch(status.textContent, /private/);
  delete app.window.navigator.clipboard; button.click(); await settle(); assert.match(status.textContent, /직접 선택/);
});

test('memo counts show restored text and update during input without saving or changing the note', async () => {
  const app = runtime({ ...actualPlannerFixture(), withAccount: true }); await settle(); await app.create();
  const saved = app.stored.get(storageKey), row = app.$('day-list').querySelector('[data-event-id="place-0"]');
  row.querySelector('.event-edit-button').click();
  const memo = row.querySelector('textarea'), count = row.querySelector('.memo-counter');
  assert.equal(count.textContent, `${memo.value.length} / 500자`);
  memo.value = '한글 메모'; memo.dispatch('input'); assert.equal(count.textContent, '5 / 500자');
  assert.equal(memo.getAttribute('aria-describedby'), count.id); assert.equal(app.stored.get(storageKey), saved);
});

test('creating a note refuses a past start date without replacing the current note and permits today',async()=>{
  const app=runtime();await settle();await app.create();
  const saved=app.stored.get(storageKey),day=app.$('day-list').children[0];
  app.$('start-date').value='2026-10-19';app.$('start-date').dispatch('change');
  await app.create();
  assert.equal(app.creations.length,1);
  assert.match(app.$('app-message').textContent,/오늘 또는 이후/);
  assert.equal(app.document.activeElement.id,'date-trigger');
  assert.equal(app.stored.get(storageKey),saved);assert.equal(app.$('day-list').children[0],day);
  app.$('start-date').value='2026-10-20';await app.create();
  assert.equal(app.creations.length,2);
});

test('a new note rechecks today after an asynchronous tourism lookup crosses midnight',async()=>{
  const waiting=deferred();let pause=false;
  const app=runtime({ensureCity:()=>pause?waiting.promise:undefined});await settle();await app.create();
  const saved=app.stored.get(storageKey);pause=true;
  app.$('trip-form').dispatch('submit');await settle();
  app.clock.setDate('2026-10-21T00:00:01');waiting.resolve();await settle();
  assert.equal(app.creations.length,1);
  assert.equal(app.stored.get(storageKey),saved);
  assert.match(app.$('app-message').textContent,/오늘 또는 이후/);
});

test('an older saved travel note still restores while a new note cannot reuse its past start date',async()=>{
  const raw=savedNote(itinerary({startDate:'2026-10-19'}));
  const app=runtime({raw,hash:'#/note'});await settle();screen(app,'note');
  assert.match(app.$('trip-summary').textContent,/2026-10-19/);
  await app.create();
  assert.equal(app.creations.length,1);
  assert.equal(app.stored.get(storageKey),raw);
  assert.match(app.$('app-message').textContent,/오늘 또는 이후/);
});

test('successful creation opens an independent note; logo, resume and browser history preserve the same note', async () => {
  const app = runtime(); await settle(); screen(app, 'start');
  assert.equal(app.$('resume-note').hidden, true);
  await app.create(); screen(app, 'note');
  assert.equal(app.window.location.hash, '#/note');
  assert.equal(app.document.activeElement.id, 'itinerary-title');
  assert.equal(app.writes.length, 1);
  const stored = app.stored.get(storageKey), renderedDay = app.$('day-list').children[0];
  await app.go('#/start'); screen(app, 'start');
  assert.equal(app.document.activeElement.id, 'title');
  assert.equal(app.$('resume-note').hidden, false);
  assert.equal(app.$('empty-state').hidden, true);
  assert.match(app.$('resume-summary').textContent, /테스트시/);
  await app.go('#/note'); screen(app, 'note');
  app.window.history.back(); screen(app, 'start');
  app.window.history.forward(); screen(app, 'note');
  assert.equal(app.$('day-list').children[0], renderedDay);
  assert.equal(app.creations.length, 1);
  assert.equal(app.stored.get(storageKey), stored);
  assert.equal(app.writes.length, 1); assert.equal(app.removals.length, 0);
  assert.ok(app.scrolls.length >= 5);
});

test('transient messages belong to their screen and cannot follow logo or browser-history navigation', async () => {
  const app = runtime({ withAccount: true }); await settle(); await app.create(); screen(app, 'note');
  assert.match(app.$('app-message').textContent, /추천 장소를 여행 노트에 담았어요/);
  const creationTimer = app.clock.scheduled.at(-1);
  await app.go('#/start'); screen(app, 'start');
  assert.equal(app.$('app-message').hidden, true); assert.equal(app.$('app-message').textContent, '');
  assert.equal(app.clock.pending.has(creationTimer.id), false);
  app.window.history.back(); screen(app, 'note'); assert.equal(app.$('app-message').hidden, true);
  app.window.history.forward(); screen(app, 'start'); assert.equal(app.$('app-message').hidden, true);
  app.account.options.onMessage('선택한 여행 조건을 확인해 주세요.');
  assert.equal(app.$('app-message').hidden, false);
  await app.go('#/note'); screen(app, 'note'); assert.equal(app.$('app-message').hidden, true);
  app.window.history.back(); screen(app, 'start'); assert.equal(app.$('app-message').hidden, true);
});

test('same-screen route synchronization keeps its message and new redirect guidance survives the transition', async () => {
  const app = runtime(); await settle(); await app.create();
  const message = app.$('app-message').textContent, timer = app.clock.scheduled.at(-1);
  await app.go('#/note/'); screen(app, 'note');
  assert.equal(app.$('app-message').hidden, false); assert.equal(app.$('app-message').textContent, message);
  assert.equal(app.clock.pending.has(timer.id), true);
  app.clock.advance(5000); assert.equal(app.$('app-message').hidden, true);
  const missing = runtime({ hash: '#/note' }); await settle(); screen(missing, 'start');
  assert.match(missing.$('app-message').textContent, /먼저 여행 조건/);
  assert.equal(missing.$('app-message').hidden, false);
});

test('a screen transition preserves pending-load feedback and a subsequent restoration error', async () => {
  const waiting = deferred(); let firstLookup = true;
  const app = runtime({ hash: '#/note', raw: savedNote(), ensureCity: () => {
    if (firstLookup) { firstLookup = false; return waiting.promise; }
  } });
  await settle(); screen(app, 'loading');
  assert.match(app.$('app-message').textContent, /관광정보를 불러오고/);
  await app.go('#/start'); screen(app, 'start');
  assert.equal(app.$('app-message').hidden, false); assert.match(app.$('app-message').textContent, /관광정보를 불러오고/);
  waiting.reject(Error('연결을 다시 확인해 주세요.')); await settle();
  assert.equal(app.$('app-message').hidden, false); assert.match(app.$('app-message').textContent, /연결을 다시 확인/);
  assert.ok(app.$('app-message').classList.contains('is-error'));
  await app.go('#/note'); screen(app, 'start');
  assert.match(app.$('app-message').textContent, /연결을 다시 확인/);
  assert.equal(app.clock.pending.size, 0);
});

test('setup edits and a failed regeneration retain the previously saved note', async () => {
  const app = runtime(); await settle(); await app.create();
  const stored = app.stored.get(storageKey), renderedDay = app.$('day-list').children[0];
  await app.go('#/start');
  app.$('start-date').value = '2026-11-03'; app.$('start-date').dispatch('change');
  app.behavior.createError = '만들 수 있는 일정이 없어요.';
  await app.create(); screen(app, 'start');
  assert.equal(app.window.location.hash, '#/start');
  assert.match(app.$('app-message').textContent, /만들 수 있는 일정/);
  assert.equal(app.stored.get(storageKey), stored);
  await app.go('#/note'); screen(app, 'note');
  assert.equal(app.$('day-list').children[0], renderedDay);
  assert.match(app.$('trip-summary').textContent, /2026-/);
  assert.doesNotMatch(app.$('trip-summary').textContent, /2026-11-03/);
});

test('direct note reload waits for restoration and passes saved edits to the planner without rewriting storage', async () => {
  const loading = deferred(), note = itinerary({ eventEdits: { '0': { finish: { title: '내가 수정한 마무리' } } } });
  const raw = savedNote(note), app = runtime({ hash: '#/note', raw, destinationsPromise: loading.promise });
  screen(app, 'loading');
  assert.equal(app.window.location.hash, '#/note');
  loading.resolve([app.window.TRAVEL_DATA.cities['test-city']]); await settle(); screen(app, 'note');
  assert.equal(app.document.activeElement.id, 'itinerary-title');
  assert.equal(app.creations[0].eventEdits['0'].finish.title, '내가 수정한 마무리');
  assert.equal(app.stored.get(storageKey), raw);
  assert.equal(app.writes.length, 0); assert.equal(app.removals.length, 0);
});

test('version 8 restores added entries separately from the three recommended place selections', async () => {
  const note=itinerary();
  note.extraEvents={'0':[{id:'extra-1',beforeId:'finish',type:'place',placeId:'extra-place',duration:45}]};
  note.days[0].events=[...['a','b','c'].map((id,index)=>({id:`place-${index}`,type:'place',place:{id}})),
    {id:'extra-1',type:'place',place:{id:'extra-place'}}];
  const raw=JSON.stringify({version:8,itinerary:note});
  const app=runtime({hash:'#/note',raw});await settle();screen(app,'note');
  assert.deepEqual(Array.from(app.creations[0].selections[0]),['a','b','c']);
  assert.equal(app.creations[0].extraEvents[0][0].placeId,'extra-place');
  assert.equal(app.stored.get(storageKey),raw);assert.equal(app.writes.length,0);
});

test('an inconsistent extra entry list fails restoration without losing the saved note', async () => {
  const note=itinerary();note.days[0].events=[{id:'extra-1',type:'free'}];
  const raw=JSON.stringify({version:8,itinerary:note});
  const app=runtime({hash:'#/note',raw});await settle();screen(app,'start');
  assert.match(app.$('app-message').textContent,/추가 일정/);
  assert.equal(app.stored.get(storageKey),raw);assert.equal(app.removals.length,0);
});

test('removing a recommended tourist spot saves all three originals and reloads the exclusion for later restoration', async () => {
  const fixture = actualPlannerFixture(), app = runtime(fixture); await settle(); await app.create(); screen(app, 'note');
  app.$('day-list').querySelector('[data-event-id="place-1"]').querySelector('.event-remove-button').click();
  const raw = app.stored.get(storageKey), saved = JSON.parse(raw);
  assert.equal(saved.version, 8);
  assert.deepEqual(saved.itinerary.selections[0], ['a', 'b', 'c']);
  assert.deepEqual(saved.itinerary.excludedEvents[0], ['place-1']);
  assert.equal(saved.itinerary.days[0].events.filter(event => event.type === 'place').length, 2);
  const restored = runtime({ ...fixture, hash: '#/note', raw }); await settle(); screen(restored, 'note');
  assert.deepEqual(Array.from(restored.creations[0].selections[0]), ['a', 'b', 'c']);
  assert.deepEqual(Array.from(restored.creations[0].excludedEvents[0]), ['place-1']);
  assert.equal(restored.$('day-list').querySelector('[data-event-id="place-1"]'), null);
  assert.equal(restored.stored.get(storageKey), raw); assert.equal(restored.writes.length, 0);
  restored.$('day-list').querySelector('.schedule-restore-list').children[0].click();
  assert.ok(restored.$('day-list').querySelector('[data-event-id="place-1"]'));
  const afterRestore = JSON.parse(restored.stored.get(storageKey)).itinerary;
  assert.deepEqual(afterRestore.selections[0], ['a', 'b', 'c']);
  assert.equal(afterRestore.excludedEvents[0], undefined);
});

test('adding and moving an entry persists its full layout and passes that layout back to the real planner on reload', async () => {
  const fixture = actualPlannerFixture(), app = runtime(fixture); await settle(); await app.create();
  const add = app.mounts.findLast(record => record.kind === 'schedule' && !record.destroyed);
  const result = add.options.onAdd({ type: 'free', beforeId: 'lunch', title: '카페 들르기', description: '내가 고른 일정', duration: 40 });
  assert.equal(result.ok, true); assert.equal(add.destroyed, true);
  const row = app.$('day-list').querySelector('[data-event-id="extra-1"]');
  row.querySelector('.event-move-button').click();
  const raw = app.stored.get(storageKey), saved = JSON.parse(raw).itinerary;
  assert.equal(saved.extraEvents[0][0].title, '카페 들르기');
  assert.ok(saved.eventOrders[0].indexOf('extra-1') < saved.eventOrders[0].indexOf('free-0'));
  const restored = runtime({ ...fixture, hash: '#/note', raw }); await settle(); screen(restored, 'note');
  assert.equal(JSON.stringify(restored.creations[0].extraEvents), JSON.stringify(saved.extraEvents));
  assert.equal(JSON.stringify(restored.creations[0].eventOrders), JSON.stringify(saved.eventOrders));
  const ids = restored.$('day-list').querySelectorAll('.timeline-row').map(item => item.dataset.eventId);
  assert.ok(ids.indexOf('extra-1') < ids.indexOf('free-0'));
  assert.equal(restored.stored.get(storageKey), raw); assert.equal(restored.writes.length, 0);
});

test('restaurant selection updates a real meal, preserves its memo and replaces a previous restaurant address', async () => {
  const fixture = actualPlannerFixture();
  const initial = fixture.planner.createItinerary({ city: fixture.cityData, startDate: '2026-10-20', dayCount: 1 });
  const edited = fixture.planner.updateEvent({ city: fixture.cityData, itinerary: initial, dayIndex: 0, eventId: 'lunch', description: '알레르기 확인' });
  assert.equal(edited.ok, true);
  const app = runtime({ ...fixture, hash: '#/note', raw: JSON.stringify({ version: 8, itinerary: edited.itinerary }) }); await settle();
  function lunchWidget() {
    return app.mounts.findLast(record => record.kind === 'restaurant' && !record.destroyed
      && record.host.closest('.timeline-row').dataset.eventId === 'lunch');
  }
  const first = lunchWidget();
  assert.equal(first.options.onSelect({ name: '동네 밥집', address: '광주광역시 남구 첫길 1' }).ok, true);
  assert.equal(first.destroyed, true);
  let saved = JSON.parse(app.stored.get(storageKey)).itinerary;
  assert.match(saved.eventEdits[0].lunch.title, /동네 밥집/);
  assert.equal(saved.eventEdits[0].lunch.description, '식당 주소: 광주광역시 남구 첫길 1\n알레르기 확인');
  assert.equal(lunchWidget().options.onSelect({ name: '새 밥집', address: '광주광역시 남구 둘길 2' }).ok, true);
  saved = JSON.parse(app.stored.get(storageKey)).itinerary;
  assert.equal(saved.eventEdits[0].lunch.description, '식당 주소: 광주광역시 남구 둘길 2\n알레르기 확인');
  assert.doesNotMatch(saved.eventEdits[0].lunch.description, /첫길/);
});

test('editing an added entry keeps its position when its original base anchor has been excluded', async () => {
  const fixture = actualPlannerFixture(), app = runtime(fixture); await settle(); await app.create();
  const add = app.mounts.findLast(record => record.kind === 'schedule' && !record.destroyed);
  assert.equal(add.options.onAdd({ type: 'free', beforeId: 'lunch', title: '시장 구경', description: '기존 메모', duration: 30 }).ok, true);
  app.$('day-list').querySelector('[data-event-id="lunch"]').querySelector('.event-remove-button').click();
  const before = JSON.parse(app.stored.get(storageKey)).itinerary;
  const row = app.$('day-list').querySelector('[data-event-id="extra-1"]');
  row.querySelector('.event-edit-button').click();
  const editor = row.querySelector('.event-editor');
  assert.equal(editor.querySelector('select'), null);
  editor.querySelector('textarea').value = '바꾼 메모'; editor.dispatch('submit');
  const after = JSON.parse(app.stored.get(storageKey)).itinerary;
  assert.equal(after.extraEvents[0][0].description, '바꾼 메모');
  assert.equal(after.extraEvents[0][0].beforeId, 'lunch');
  assert.deepEqual(after.eventOrders[0], before.eventOrders[0]);
  assert.match(app.$('app-message').textContent, /수정한 내용을 저장/);
});

test('movable timeline dots start with hidden reorder controls and preserve protected rows and disabled boundaries', async () => {
  const app = runtime(actualPlannerFixture()); await settle(); await app.create();
  const rows = app.$('day-list').querySelectorAll('.timeline-row');
  for (const row of rows) {
    const protectedRow = ['departure', 'arrival', 'arrival-transfer', 'finish'].includes(row.dataset.eventId);
    const dot = row.querySelector('.timeline-dot');
    if (protectedRow) { assert.equal(dot, null); continue; }
    const group = row.querySelector('.timeline-move-controls');
    assert.ok(dot); assert.equal(dot.type, 'button'); assert.equal(dot.getAttribute('aria-expanded'), 'false');
    assert.equal(dot.getAttribute('aria-controls'), group.id); assert.equal(group.hidden, true);
    assert.equal(row.querySelector('.timeline-time').classList.contains('has-reorder'), true);
    assert.equal(row.querySelector('.event-footer').querySelector('.event-move-button'), null);
  }
  const first = app.$('day-list').querySelector('[data-event-id="place-0"]');
  const last = app.$('day-list').querySelector('[data-event-id="free-1"]');
  assert.equal(first.querySelectorAll('.event-move-button')[0].disabled, true);
  assert.equal(first.querySelectorAll('.event-move-button')[1].disabled, false);
  assert.equal(last.querySelectorAll('.event-move-button')[1].disabled, true);
  assert.equal(first.querySelectorAll('.event-move-button')[0].getAttribute('aria-label'), '추천 관광지 a 위로');
  assert.equal(app.writes.length, 1);
});

test('mouse hover keeps controls available while entering their panel and closes only after leaving the wrapper', async () => {
  const app = runtime(actualPlannerFixture()); await settle(); await app.create();
  const row = app.$('day-list').querySelector('[data-event-id="place-1"]');
  const wrapper = row.querySelector('.timeline-reorder'), dot = row.querySelector('.timeline-dot'), group = row.querySelector('.timeline-move-controls');
  wrapper.dispatch('pointerenter', { pointerType: 'mouse' });
  assert.equal(group.hidden, false); assert.equal(dot.getAttribute('aria-expanded'), 'true');
  dot.dispatch('pointerleave', { pointerType: 'mouse', relatedTarget: group });
  group.dispatch('pointerenter', { pointerType: 'mouse', relatedTarget: dot });
  assert.equal(group.hidden, false);
  wrapper.dispatch('pointerleave', { pointerType: 'mouse', relatedTarget: app.$('itinerary-title') });
  assert.equal(group.hidden, true); assert.equal(dot.getAttribute('aria-expanded'), 'false');
  assert.equal(app.writes.length, 1);
});

test('keyboard focus opens reorder controls, keeps them through child focus and closes with Escape or outside focus', async () => {
  const app = runtime(actualPlannerFixture()); await settle(); await app.create();
  const row = app.$('day-list').querySelector('[data-event-id="place-1"]');
  const wrapper = row.querySelector('.timeline-reorder'), dot = row.querySelector('.timeline-dot'), group = row.querySelector('.timeline-move-controls');
  dot.focus(); assert.equal(group.hidden, false);
  const down = group.querySelectorAll('.event-move-button')[1]; down.focus();
  assert.equal(group.hidden, false); assert.equal(app.document.activeElement, down);
  wrapper.dispatch('pointerleave', { pointerType: 'mouse' }); assert.equal(group.hidden, false);
  app.document.dispatch('keydown', down, { key: 'Escape' });
  assert.equal(app.document.activeElement, dot); assert.equal(group.hidden, true);
  app.$('itinerary-title').focus(); dot.focus(); assert.equal(group.hidden, false);
  app.$('itinerary-title').focus(); assert.equal(group.hidden, true);
  assert.equal(app.writes.length, 1);
});

test('touch pointerdown and click toggle controls despite focus opening, and outside pointerdown dismisses them', async () => {
  const app = runtime(actualPlannerFixture()); await settle(); await app.create();
  const row = app.$('day-list').querySelector('[data-event-id="place-1"]');
  const wrapper = row.querySelector('.timeline-reorder'), dot = row.querySelector('.timeline-dot'), group = row.querySelector('.timeline-move-controls');
  wrapper.dispatch('pointerenter', { pointerType: 'touch' }); assert.equal(group.hidden, true);
  const tap = () => { dot.dispatch('pointerdown', { pointerType: 'touch' }); dot.focus(); dot.click(); };
  tap(); assert.equal(group.hidden, false); assert.equal(dot.getAttribute('aria-expanded'), 'true');
  tap(); assert.equal(group.hidden, true); assert.equal(dot.getAttribute('aria-expanded'), 'false');
  tap(); assert.equal(group.hidden, false);
  app.$('itinerary-title').dispatch('pointerdown', { pointerType: 'touch' });
  assert.equal(group.hidden, true);
  assert.equal(app.writes.length, 1);
});

test('opening another dot or leaving the note closes prior controls without rebuilding or saving the itinerary', async () => {
  const app = runtime(actualPlannerFixture()); await settle(); await app.create();
  const first = app.$('day-list').querySelector('[data-event-id="place-0"]');
  const second = app.$('day-list').querySelector('[data-event-id="place-1"]');
  first.querySelector('.timeline-reorder').dispatch('pointerenter', { pointerType: 'mouse' });
  second.querySelector('.timeline-reorder').dispatch('pointerenter', { pointerType: 'mouse' });
  assert.equal(first.querySelector('.timeline-move-controls').hidden, true);
  assert.equal(second.querySelector('.timeline-move-controls').hidden, false);
  const rendered = app.$('day-list').children[0], raw = app.stored.get(storageKey);
  await app.go('#/start'); assert.equal(second.querySelector('.timeline-move-controls').hidden, true);
  await app.go('#/note'); assert.equal(app.$('day-list').children[0], rendered);
  assert.equal(second.querySelector('.timeline-move-controls').hidden, true);
  assert.equal(app.stored.get(storageKey), raw); assert.equal(app.writes.length, 1);
});

test('moving from the dot controls saves the real event order and focuses the new dot for another keyboard move', async () => {
  const app = runtime(actualPlannerFixture()); await settle(); await app.create();
  const oldRow = app.$('day-list').querySelector('[data-event-id="place-0"]');
  oldRow.querySelector('.timeline-dot').focus();
  oldRow.querySelectorAll('.event-move-button')[1].click();
  const saved = JSON.parse(app.stored.get(storageKey)).itinerary;
  assert.ok(saved.eventOrders[0].indexOf('place-0') > saved.eventOrders[0].indexOf('transfer-0'));
  const newRow = app.$('day-list').querySelector('[data-event-id="place-0"]'), newDot = newRow.querySelector('.timeline-dot');
  assert.notEqual(newRow, oldRow); assert.equal(app.document.activeElement, newDot);
  assert.equal(newRow.querySelector('.timeline-move-controls').hidden, false);
  assert.equal(newRow.querySelectorAll('.event-move-button')[0].disabled, false);
  assert.equal(app.writes.length, 2);
});

test('a direct note without a saved itinerary redirects before slower city preparation completes', async () => {
  const cityLoading = deferred(), app = runtime({ hash: '#/note', ensureCity: () => cityLoading.promise });
  await settle(); screen(app, 'start');
  assert.equal(app.window.location.hash, '#/start');
  assert.match(app.$('app-message').textContent, /먼저 여행 조건/);
  assert.equal(app.$('trip-form').getAttribute('aria-busy'), 'true');
  assert.equal(app.$('resume-note').hidden, true);
  cityLoading.resolve(); await settle(); screen(app, 'start');
});

test('malformed saved data returns to setup with its restoration error and original bytes intact', async () => {
  const raw = '{invalid-json', app = runtime({ hash: '#/note', raw }); await settle();
  screen(app, 'start');
  assert.equal(app.window.location.hash, '#/start');
  assert.match(app.$('app-message').textContent, /복원하지 못했어요/);
  assert.match(app.$('app-message').textContent, /삭제하지 않았습니다/);
  assert.equal(app.stored.get(storageKey), raw); assert.equal(app.removals.length, 0);
});

test('a failed tourism lookup preserves a saved note and retry can restore it on the note route', async () => {
  const lookup = deferred(), raw = savedNote(), app = runtime({ hash: '#/note', raw, destinationsPromise: lookup.promise });
  lookup.reject(Error('관광정보 연결이 잠시 끊겼어요.')); await settle(); screen(app, 'start');
  assert.match(app.$('app-message').textContent, /관광정보 연결/);
  assert.equal(app.$('destinations-retry').hidden, false);
  assert.equal(app.stored.get(storageKey), raw); assert.equal(app.removals.length, 0);
  app.window.TourData.loadDestinations = async () => [app.window.TRAVEL_DATA.cities['test-city']];
  app.$('destinations-retry').dispatch('click'); await settle(); screen(app, 'start');
  assert.equal(app.$('resume-note').hidden, false);
  await app.go('#/note'); screen(app, 'note');
  assert.equal(app.creations.length, 1); assert.equal(app.writes.length, 0);
});

test('leaving a note closes its expanded live lookup panels without rebuilding or deleting the note', async () => {
  const app = runtime({ raw: savedNote() }); await settle(); await app.go('#/note');
  const details = app.document.createElement('details'); details.open = true;
  app.$('day-list').append(details);
  await app.go('#/start');
  assert.equal(details.open, false);
  assert.equal(app.$('day-list').children.includes(details), true);
  assert.equal(app.writes.length, 0); assert.equal(app.removals.length, 0);
});

test('explicit clear removes the note and returns to setup; back navigation cannot resurrect the cleared note', async () => {
  const app = runtime(); await settle(); await app.create(); await app.clear(); screen(app, 'start');
  assert.equal(app.window.location.hash, '#/start');
  assert.equal(app.stored.has(storageKey), false);
  assert.equal(app.$('day-list').children.length, 0);
  assert.equal(app.$('resume-note').hidden, true);
  assert.equal(app.$('empty-state').hidden, false);
  assert.equal(app.removals.length, 1);
  await app.go('#/note'); screen(app, 'start');
  assert.equal(app.window.location.hash, '#/start');
});

test('a failed clear keeps the note displayed and preserves storage', async () => {
  const raw = savedNote(), app = runtime({ hash: '#/note', raw, storageError: { remove: true } }); await settle();
  await app.clear(); screen(app, 'note');
  assert.match(app.$('app-message').textContent, /지우지 못했어요/);
  assert.equal(app.stored.get(storageKey), raw);
  assert.equal(app.$('day-list').children.length, 1);
});

test('legacy empty and top hashes remain compatible setup entry points', async () => {
  for (const hash of ['', '#top']) {
    const app = runtime({ hash, raw: savedNote() }); await settle(); screen(app, 'start');
    assert.equal(app.$('resume-note').hidden, false);
    assert.equal(app.writes.length, 0); assert.equal(app.removals.length, 0);
  }
});

test('info and success notices expire after five seconds, and a superseded timer cannot hide a newer notice', async () => {
  const app = runtime(); await settle(); await app.create();
  assert.equal(app.$('app-message').hidden, false);
  const oldTimer = app.clock.scheduled.at(-1);
  assert.equal(oldTimer.delay, 5000);
  app.clock.advance(4999); assert.equal(app.$('app-message').hidden, false);
  await app.create();
  assert.equal(app.clock.pending.has(oldTimer.id), false);
  oldTimer.callback(); // A callback already queued before cancellation must also be harmless.
  assert.equal(app.$('app-message').hidden, false);
  app.clock.advance(1); assert.equal(app.$('app-message').hidden, false);
  app.clock.advance(4999);
  assert.equal(app.$('app-message').hidden, true);
  assert.equal(app.$('app-message').textContent, ''); assert.equal(app.clock.pending.size, 0);

  const emptyNote = runtime({ hash: '#/note' }); await settle();
  assert.match(emptyNote.$('app-message').textContent, /먼저 여행 조건/);
  emptyNote.clock.advance(5000); assert.equal(emptyNote.$('app-message').hidden, true);
});

test('typing or changing input dismisses notices immediately, while pointerdown retains notices until an interactive click', async () => {
  const app = runtime(); await settle();
  for (const type of ['input', 'change']) {
    await app.create(); assert.equal(app.$('app-message').hidden, false);
    app.document.dispatch(type, app.$('start-date'));
    assert.equal(app.$('app-message').hidden, true);
    assert.equal(app.clock.pending.size, 0);
  }
  await app.create();
  app.document.dispatch('pointerdown', app.$('itinerary-title'));
  assert.equal(app.$('app-message').hidden, false);
  const buttonLabel = app.$('trip-form').querySelector('button[type="submit"]').querySelector('span');
  app.document.dispatch('pointerdown', buttonLabel);
  assert.equal(app.$('app-message').hidden, false, 'pressing must not collapse a banner and move the click target');
  app.document.dispatch('click', buttonLabel);
  assert.equal(app.$('app-message').hidden, true);
  assert.equal(app.clock.pending.size, 0);
});

test('loading remains visible until completion, while errors persist until the next input', async () => {
  const restore = deferred(), app = runtime({ hash: '#/note', raw: savedNote(), ensureCity: () => restore.promise });
  await settle(); screen(app, 'loading');
  assert.match(app.$('app-message').textContent, /관광정보를 불러오고/);
  assert.equal(app.clock.pending.size, 0);
  app.clock.advance(20000);
  for (const type of ['input', 'change', 'pointerdown', 'click']) app.document.dispatch(type, app.$('trip-form').querySelector('button[type="submit"]'));
  assert.equal(app.$('app-message').hidden, false);
  restore.resolve(); await settle(); screen(app, 'note');
  assert.match(app.$('app-message').textContent, /불러왔어요/);
  assert.equal(app.clock.pending.size, 1);
  app.behavior.createError = '지금은 일정을 만들 수 없어요.';
  await app.create();
  assert.match(app.$('app-message').textContent, /만들 수 없어요/);
  assert.equal(app.clock.pending.size, 0);
  app.clock.advance(20000);
  app.document.dispatch('pointerdown', app.$('trip-form').querySelector('button[type="submit"]'));
  assert.equal(app.$('app-message').hidden, false);
  app.document.dispatch('input', app.$('start-date'));
  assert.equal(app.$('app-message').hidden, true);
});


test('built-in transfer editor saves a memo with pending zero duration and lets a known duration return to pending', async () => {
  const app = runtime(actualPlannerFixture()); await settle(); await app.create();
  for (const minutes of [0, 25, 0]) {
    const row = app.$('day-list').querySelector('[data-event-id="transfer-0"]');
    row.querySelector('.event-edit-button').click();
    const editor = row.querySelector('.event-editor');
    const inputs = editor.querySelectorAll('input');
    const hours = inputs.find(input => input.getAttribute('aria-label') === '이동시간: 시간');
    const minuteInput = inputs.find(input => input.getAttribute('aria-label') === '이동시간: 분');
    hours.value = '0'; minuteInput.value = String(minutes);
    editor.querySelector('textarea').value = '수동 이동시간 확인';
    editor.dispatch('submit');
    const saved = JSON.parse(app.stored.get(storageKey)).itinerary;
    assert.equal(saved.eventEdits[0]['transfer-0'].duration, minutes);
    assert.equal(saved.eventEdits[0]['transfer-0'].description, '수동 이동시간 확인');
    assert.match(app.$('app-message').textContent, /수정한 내용을 저장/);
  }
});

test('one persistent timing notice covers an unfinished later day and disappears after all travel times are entered', async () => {
  const fixture = timedNoteFixture(2);
  const pending = fixture.planner.updateEvent({ city: fixture.cityData, itinerary: fixture.note, dayIndex: 1, eventId: 'transfer-1', duration: 0 });
  assert.equal(pending.ok, true);
  pending.itinerary.days[1].timesProvisional = false; // A saved display snapshot is rebuilt from canonical edits.
  const raw = JSON.stringify({ version: 8, itinerary: pending.itinerary });
  const app = runtime({ ...fixture, hash: '#/note', raw }); await settle(); screen(app, 'note');
  const notice = app.$('note-timing-notice');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /미정은 실제 이동 0분이 아니며/);
  assert.doesNotMatch(notice.textContent, /공지|알림|안내/);
  assert.equal(app.document.querySelectorAll('#note-timing-notice').length, 1);
  assert.doesNotMatch(app.$('day-list').textContent, /미정은 실제 이동 0분이 아니며/);
  assert.equal(app.$('day-list').querySelectorAll('.departure-row .departure-hint').length, 0);
  assert.ok(app.$('day-list').querySelectorAll('.meal-row .departure-hint').length > 0, 'the specific restaurant travel reminder stays in meal cards');
  app.document.dispatch('input', app.$('start-date')); app.clock.advance(20000);
  assert.equal(notice.hidden, false, 'dismissing a transient message must not dismiss incomplete-plan status');
  assert.equal(app.writes.length, 0, 'rendering a derived notice does not change saved data');
  const day = app.$('day-list').querySelector('[data-day-index="1"]');
  const row = day.querySelector('[data-event-id="transfer-1"]'); row.querySelector('.event-edit-button').click();
  const editor = row.querySelector('.event-editor');
  for (const input of editor.querySelectorAll('input')) {
    if (input.getAttribute('aria-label') === '이동시간: 시간') input.value = '0';
    if (input.getAttribute('aria-label') === '이동시간: 분') input.value = '23';
  }
  editor.dispatch('submit');
  assert.equal(notice.hidden, true); assert.equal(notice.textContent, '');
  const restored = runtime({ ...fixture, hash: '#/note', raw: app.stored.get(storageKey) }); await settle();
  assert.equal(restored.$('note-timing-notice').hidden, true);
});

test('a new unknown transfer restores the single timing notice until its time is filled or the transfer is removed', async () => {
  const fixture = timedNoteFixture();
  const app = runtime({ ...fixture, hash: '#/note', raw: JSON.stringify({ version: 8, itinerary: fixture.note }) }); await settle();
  const notice = app.$('note-timing-notice'); assert.equal(notice.hidden, true);
  const schedule = app.mounts.findLast(record => record.kind === 'schedule' && !record.destroyed);
  const added = schedule.options.onAdd({ type: 'transfer', title: '숙소로 이동', duration: 0 });
  assert.equal(added.ok, true); assert.equal(notice.hidden, false);
  const row = app.$('day-list').querySelector('[data-event-id="extra-1"]'); row.querySelector('.event-edit-button').click();
  const editor = row.querySelector('.event-editor');
  for (const input of editor.querySelectorAll('input')) {
    if (input.getAttribute('aria-label') === '이동시간: 시간') input.value = '0';
    if (input.getAttribute('aria-label') === '이동시간: 분') input.value = '18';
  }
  editor.dispatch('submit'); assert.equal(notice.hidden, true);
  const saved = app.stored.get(storageKey);
  const restored = runtime({ ...fixture, hash: '#/note', raw: saved }); await settle();
  assert.equal(restored.$('note-timing-notice').hidden, true);
  const restoredRow = restored.$('day-list').querySelector('[data-event-id="extra-1"]'); restoredRow.querySelector('.event-edit-button').click();
  const restoredEditor = restoredRow.querySelector('.event-editor');
  for (const input of restoredEditor.querySelectorAll('input')) {
    if (input.getAttribute('aria-label') === '이동시간: 시간' || input.getAttribute('aria-label') === '이동시간: 분') input.value = '0';
  }
  restoredEditor.dispatch('submit'); assert.equal(restored.$('note-timing-notice').hidden, false);
  restored.$('day-list').querySelector('[data-event-id="extra-1"]').querySelector('.event-remove-button').click();
  assert.equal(restored.$('note-timing-notice').hidden, true);
  await restored.clear();
  assert.equal(restored.$('note-timing-notice').hidden, true); assert.equal(restored.$('note-timing-notice').textContent, '');
});


test('invalid JSON draft envelopes preserve storage and do not derail destination setup', async () => {
  for (const raw of ['null','true','7','"text"','[]']) {
    const app=runtime({raw});await settle();screen(app,'start');
    assert.equal(app.stored.get(storageKey),raw);assert.equal(app.removals.length,0);
    assert.equal(app.$('destinations-retry').hidden,true);
    assert.equal(app.$('day-count').disabled,false);
    assert.match(app.$('app-message').textContent,/저장 데이터 형식/);
  }
});

test('canceling clear preserves the local note and rendered itinerary', async () => {
  const raw=savedNote(),app=runtime({hash:'#/note',raw});await settle();
  const rendered=app.$('day-list').children[0];app.behavior.confirmClear=false;
  await app.clear();screen(app,'note');
  assert.equal(app.stored.get(storageKey),raw);assert.equal(app.removals.length,0);
  assert.equal(app.$('day-list').children[0],rendered);
  assert.match(app.behavior.confirmations[0],/되돌릴 수 없어요/);
});

test('cloud load reports local persistence failure without replacing it with success', async () => {
  const fixture=actualPlannerFixture(),app=runtime({...fixture,withAccount:true,storageError:{set:true}});await settle();
  const source=fixture.planner.createItinerary({city:fixture.cityData,startDate:'2026-10-20',dayCount:1});
  const result=await app.account.options.loadDocument({version:8,itinerary:source});await settle();
  assert.equal(result.ok,true);assert.match(result.warning,/자동저장에 실패/);
  screen(app,'note');assert.match(app.$('app-message').textContent,/자동저장에 실패/);
  assert.ok(app.$('app-message').classList.contains('is-error'));assert.equal(app.writes.length,0);
});


test('manual meal restaurant persists, replaces recommendations and clears without changing duration', async () => {
  const fixture=actualPlannerFixture(),app=runtime(fixture); await settle(); await app.create();
  const widget=(target,kind)=>target.mounts.findLast(record=>record.kind===kind&&!record.destroyed&&record.host.closest('.timeline-row').dataset.eventId==='lunch');
  assert.equal(widget(app,'manual-restaurant').options.name,'');
  assert.equal(widget(app,'manual-restaurant').options.onSave({name:'<우리 밥집>',description:'서울 골목 1\n예약 12시'}).ok,true);
  let saved=JSON.parse(app.stored.get(storageKey)).itinerary;
  const duration=saved.days[0].events.find(event=>event.id==='lunch').duration;
  assert.match(saved.eventEdits[0].lunch.title,/<우리 밥집>/);
  assert.equal(saved.eventEdits[0].lunch.description,'서울 골목 1\n예약 12시');
  const restored=runtime({...fixture,hash:'#/note',raw:app.stored.get(storageKey)});await settle();
  assert.equal(widget(restored,'manual-restaurant').options.name,'<우리 밥집>');
  assert.equal(widget(restored,'manual-restaurant').options.description,'서울 골목 1\n예약 12시');
  assert.equal(widget(restored,'restaurant').options.onSelect({name:'추천 밥집',address:'새 주소'}).ok,true);
  assert.equal(widget(restored,'manual-restaurant').options.name,'추천 밥집');
  assert.equal(widget(restored,'manual-restaurant').options.onSave({name:'직접 바꾼 식당',description:''}).ok,true);
  assert.equal(widget(restored,'manual-restaurant').options.onClear().ok,true);
  saved=JSON.parse(restored.stored.get(storageKey)).itinerary;
  assert.equal(saved.eventEdits[0].lunch.description,'');
  assert.equal(widget(restored,'manual-restaurant').options.name,'');
  assert.equal(saved.days[0].events.find(event=>event.id==='lunch').duration,duration);
  const again=runtime({...fixture,hash:'#/note',raw:restored.stored.get(storageKey)});await settle();
  assert.equal(widget(again,'manual-restaurant').options.name,'');
  const shifted=fixture.planner.setDayStart({city:fixture.cityData,itinerary:JSON.parse(restored.stored.get(storageKey)).itinerary,dayIndex:0,startTime:'17:00'});
  assert.equal(shifted.ok,true);
  const late=runtime({...fixture,hash:'#/note',raw:JSON.stringify({version:8,itinerary:shifted.itinerary})});await settle();
  assert.equal(widget(late,'manual-restaurant').options.name,'');
  const lateMeal=shifted.itinerary.days[0].events.find(event=>event.id==='lunch');
  assert.equal(lateMeal.title,lateMeal.meal);
  assert.equal(Object.hasOwn(shifted.itinerary.eventEdits[0].lunch,'title'),false);
});

test('manual restaurant input validates and supports added meal cards', async () => {
  const fixture=actualPlannerFixture(),app=runtime(fixture);await settle();await app.create();
  const schedule=app.mounts.findLast(record=>record.kind==='schedule'&&!record.destroyed);
  assert.equal(schedule.options.onAdd({type:'meal',beforeId:'finish',title:'식사',duration:45}).ok,true);
  const manual=()=>app.mounts.findLast(record=>record.kind==='manual-restaurant'&&!record.destroyed&&record.host.closest('.timeline-row').dataset.eventId==='extra-1');
  const before=app.stored.get(storageKey);
  for(const value of [{name:' ',description:''},{name:'x'.repeat(61),description:''},{name:'밥집',description:'x'.repeat(501)}])assert.equal(manual().options.onSave(value).ok,false);
  assert.equal(app.stored.get(storageKey),before);
  assert.equal(manual().options.onSave({name:'추가 식당',description:'창가 자리'}).ok,true);
  assert.equal(manual().options.name,'추가 식당');
  let saved=JSON.parse(app.stored.get(storageKey)).itinerary;
  assert.equal(saved.extraEvents[0][0].title,'식사 · 추가 식당');
  assert.equal(manual().options.onClear().ok,true);
  saved=JSON.parse(app.stored.get(storageKey)).itinerary;
  assert.equal(saved.extraEvents[0][0].duration,45);
  assert.equal(saved.extraEvents[0][0].description,'');
});


function noteParameters(app){return JSON.parse(JSON.stringify(app.account.options.getDocument().itinerary));}
function currentSchedule(app){return app.mounts.findLast(record=>record.kind==='schedule'&&!record.destroyed);}
function manualMeal(app,eventId='lunch'){
  return app.mounts.findLast(record=>record.kind==='manual-restaurant'&&!record.destroyed&&record.host.closest('.timeline-row').dataset.eventId===eventId);
}
function editEntry(app,eventId,{title,description,duration}={}){
  const row=app.$('day-list').querySelector(`[data-event-id="${eventId}"]`);
  row.querySelector('.event-edit-button').click();
  const editor=row.querySelector('.event-editor'),inputs=editor.querySelectorAll('input');
  if(title!==undefined)inputs.find(input=>input.type==='text').value=title;
  if(description!==undefined)editor.querySelector('textarea').value=description;
  if(duration!==undefined){
    const hours=inputs.find(input=>/시간$/.test(input.getAttribute('aria-label')||''));
    if(hours){hours.value=String(Math.floor(duration/60));inputs.find(input=>/분$/.test(input.getAttribute('aria-label')||'')).value=String(duration%60);}
    else inputs.find(input=>input.type==='number').value=String(duration);
  }
  editor.dispatch('submit');
  return editor;
}

test('editing history undoes and redoes title, memo, overnight times, ordering and removal as separate saved operations',async()=>{
  const app=runtime({...actualPlannerFixture(),withAccount:true});await settle();await app.create();
  assert.equal(app.$('undo-button').disabled,true);assert.equal(app.$('redo-button').disabled,true);
  const states=[noteParameters(app)];
  assert.equal(currentSchedule(app).options.onAdd({type:'free',title:'밤 산책',description:'입구에서 만나기',duration:30}).ok,true);
  states.push(noteParameters(app));
  editEntry(app,'extra-1',{title:'내가 고른 산책',description:'야간 개장 확인',duration:55});
  states.push(noteParameters(app));
  const start=app.document.getElementById('day-start-0');start.value='23:30';start.dispatch('change');
  states.push(noteParameters(app));
  const before=JSON.parse(app.stored.get(storageKey)).itinerary;
  assert.ok(before.days[0].end>1440,'the edited schedule crosses midnight');
  app.$('day-list').querySelector('[data-event-id="extra-1"]').querySelector('.event-move-button').click();
  states.push(noteParameters(app));
  app.$('day-list').querySelector('[data-event-id="place-1"]').querySelector('.event-remove-button').click();
  states.push(noteParameters(app));
  const edits=states.length-1,changes=app.account.changes;
  for(let index=states.length-2;index>=0;index--){
    app.$('undo-button').click();
    assert.deepEqual(noteParameters(app),states[index]);
    assert.equal(app.$('redo-button').disabled,false);
  }
  assert.equal(app.$('undo-button').disabled,true);
  for(let index=1;index<states.length;index++){
    app.$('redo-button').click();assert.deepEqual(noteParameters(app),states[index]);
  }
  assert.equal(app.$('redo-button').disabled,true);
  assert.equal(app.account.changes,changes+edits*2,'undo and redo each mark the account document changed');
  for(const replay of app.creations.slice(1)){
    assert.equal(replay.days,undefined);assert.equal(replay.routes,undefined);assert.equal(replay.restaurants,undefined);
    assert.equal(replay.cityName,undefined,'history restores parameters through the planner, without display snapshots');
  }
  assert.deepEqual(JSON.parse(app.stored.get(storageKey)).itinerary.eventOrders,states.at(-1).eventOrders);
});

test('tourist replacement and day area exchange remain reversible alongside manual restaurant choices',async()=>{
  const fixture=timedNoteFixture(2),app=runtime({...fixture,withAccount:true});await settle();
  app.$('day-count').value='2';await app.create();
  const original=noteParameters(app);
  const row=app.$('day-list').querySelector('[data-event-id="place-0"]');row.querySelector('.swap-button').click();
  const swap=row.querySelector('.swap-picker');swap.querySelector('select').value='d';swap.querySelector('button').click();
  const replaced=noteParameters(app);assert.notDeepEqual(replaced.selections,original.selections);
  const day=app.$('day-list').children[0];day.querySelector('.day-area-select').value='area-1';day.querySelector('.area-apply-button').click();
  const exchanged=noteParameters(app);assert.deepEqual(exchanged.dayAreaIds,['area-1','area-a']);
  assert.equal(manualMeal(app).options.onSave({name:'직접 고른 식당',description:'예약 확인'}).ok,true);
  const restaurant=noteParameters(app);
  for(const expected of [exchanged,replaced,original]){app.$('undo-button').click();assert.deepEqual(noteParameters(app),expected);}
  for(const expected of [replaced,exchanged,restaurant]){app.$('redo-button').click();assert.deepEqual(noteParameters(app),expected);}
});

test('failed edits and failed undo or redo preserve both the current note and usable history',async()=>{
  const faults={set:false},app=runtime({...actualPlannerFixture(),withAccount:true,storageError:faults});await settle();await app.create();
  const original=noteParameters(app);
  assert.equal(manualMeal(app).options.onSave({name:'유효한 식당',description:'원래 메모'}).ok,true);
  const edited=noteParameters(app),saved=app.stored.get(storageKey),changes=app.account.changes;
  assert.equal(manualMeal(app).options.onSave({name:'',description:''}).ok,false);
  faults.set=true;
  assert.equal(manualMeal(app).options.onSave({name:'저장 실패',description:''}).ok,false);
  app.$('undo-button').click();
  assert.deepEqual(noteParameters(app),edited);assert.equal(app.stored.get(storageKey),saved);
  assert.equal(app.$('undo-button').disabled,false);assert.equal(app.$('redo-button').disabled,true);
  assert.equal(app.account.changes,changes);
  assert.match(app.$('app-message').textContent,/현재 노트와 되돌리기 기록은 유지/);
  faults.set=false;app.behavior.createError='관광정보가 바뀌어 복원할 수 없어요.';
  app.$('undo-button').click();assert.deepEqual(noteParameters(app),edited);assert.equal(app.account.changes,changes);
  app.behavior.createError=null;app.$('undo-button').click();assert.deepEqual(noteParameters(app),original);
  assert.equal(app.$('undo-button').disabled,true,'neither failed edit created an extra step');
  faults.set=true;app.$('redo-button').click();assert.deepEqual(noteParameters(app),original);
  assert.equal(app.$('redo-button').disabled,false);
  faults.set=false;app.$('redo-button').click();assert.deepEqual(noteParameters(app),edited);
});

test('new successful edits clear redo while an unchanged save or a failed edit retains redo',async()=>{
  const app=runtime({...actualPlannerFixture(),withAccount:true});await settle();await app.create();
  assert.equal(manualMeal(app).options.onSave({name:'첫 식당',description:'메모'}).ok,true);
  const first=noteParameters(app);
  assert.equal(manualMeal(app).options.onSave({name:'두 번째 식당',description:'메모'}).ok,true);
  app.$('undo-button').click();assert.deepEqual(noteParameters(app),first);
  assert.equal(manualMeal(app).options.onSave({name:'첫 식당',description:'메모'}).ok,true);
  assert.equal(app.$('redo-button').disabled,false,'saving identical parameters does not create a new edit');
  assert.equal(manualMeal(app).options.onSave({name:'',description:''}).ok,false);
  assert.equal(app.$('redo-button').disabled,false);
  assert.equal(manualMeal(app).options.onSave({name:'다른 식당',description:'새 메모'}).ok,true);
  assert.equal(app.$('redo-button').disabled,true);app.$('undo-button').click();
  assert.deepEqual(noteParameters(app),first);
});

test('history keeps the latest twenty edits only and is not restored or added to browser documents',async()=>{
  const fixture=actualPlannerFixture(),app=runtime({...fixture,withAccount:true});await settle();await app.create();
  for(let index=1;index<=22;index++)assert.equal(manualMeal(app).options.onSave({name:`식당 ${index}`,description:''}).ok,true);
  const last=app.stored.get(storageKey);
  assert.equal(JSON.parse(last).history,undefined);assert.equal(JSON.parse(last).itinerary.editHistory,undefined);
  const reloaded=runtime({...fixture,raw:last,hash:'#/note'});await settle();
  assert.equal(reloaded.$('undo-button').disabled,true);assert.equal(reloaded.$('redo-button').disabled,true);
  for(let index=0;index<20;index++)app.$('undo-button').click();
  assert.equal(manualMeal(app).options.name,'식당 2');assert.equal(app.$('undo-button').disabled,true);
  const oldest=app.stored.get(storageKey);app.$('undo-button').click();assert.equal(app.stored.get(storageKey),oldest);
  for(let index=0;index<20;index++)app.$('redo-button').click();
  assert.equal(manualMeal(app).options.name,'식당 22');assert.equal(app.$('redo-button').disabled,true);
});

test('new notes, successful remote loads and deletion reset history, while failed loads and canceled deletion preserve it',async()=>{
  const app=runtime({...actualPlannerFixture(),withAccount:true});await settle();await app.create();
  const initial=app.account.options.getDocument();
  manualMeal(app).options.onSave({name:'식당',description:''});
  const invalid={...initial,itinerary:{...initial.itinerary,dayAreaIds:[]}};
  assert.equal(await app.account.options.loadDocument(invalid),false);assert.equal(app.$('undo-button').disabled,false);
  app.behavior.confirmClear=false;await app.clear();assert.equal(app.$('undo-button').disabled,false);
  assert.equal(await app.account.options.loadDocument(initial),true);
  assert.equal(app.$('undo-button').disabled,true);assert.equal(app.$('redo-button').disabled,true);
  manualMeal(app).options.onSave({name:'새 식당',description:''});
  app.behavior.createError='새 노트 생성 실패';await app.create();assert.equal(app.$('undo-button').disabled,false);
  app.behavior.createError=null;await app.create();
  assert.equal(app.$('undo-button').disabled,true);assert.equal(app.$('redo-button').disabled,true);
  manualMeal(app).options.onSave({name:'마지막 식당',description:''});
  app.behavior.confirmClear=true;await app.clear();
  assert.equal(app.$('undo-button').disabled,true);assert.equal(app.$('redo-button').disabled,true);
  assert.equal(app.account.options.getDocument(),null);
});

test('signing in, switching accounts and signing out cannot apply another owners editing history',async()=>{
  const app=runtime({...actualPlannerFixture(),withAccount:true});await settle();await app.create();
  manualMeal(app).options.onSave({name:'게스트 식당',description:''});assert.equal(app.$('undo-button').disabled,false);
  await app.account.options.onUserChange({id:'owner-a',username:'alice'},{initial:false});
  assert.equal(app.$('undo-button').disabled,true);assert.equal(app.$('redo-button').disabled,true);
  manualMeal(app).options.onSave({name:'계정 A 식당',description:''});
  app.$('undo-button').click();assert.equal(app.$('redo-button').disabled,false);
  const ownerA=app.stored.get(`${storageKey}:owner-a`);
  await app.account.options.onUserChange({id:'owner-b',username:'bob'},{initial:false});
  assert.equal(app.account.options.getDocument(),null);
  assert.equal(app.$('undo-button').disabled,true);assert.equal(app.$('redo-button').disabled,true);
  await app.create();manualMeal(app).options.onSave({name:'계정 B 식당',description:''});
  await app.account.options.onUserChange(null,{initial:false});
  assert.equal(app.account.options.getDocument(),null);assert.equal(app.$('undo-button').disabled,true);
  await app.account.options.onUserChange({id:'owner-a',username:'alice'},{initial:false});
  assert.equal(manualMeal(app).options.name,'게스트 식당');
  assert.equal(app.$('undo-button').disabled,true);assert.equal(app.$('redo-button').disabled,true);
  assert.equal(app.stored.get(`${storageKey}:owner-a`),ownerA);
});


test('undo and redo each respond to their first click, retaining the pressed layout and the new result message',async()=>{
  const app=runtime({...actualPlannerFixture(),withAccount:true});await settle();await app.create();
  const original=noteParameters(app);
  assert.equal(currentSchedule(app).options.onAdd({type:'free',title:'되돌리기 점검',duration:30}).ok,true);
  const edited=noteParameters(app),notice=app.$('app-message');
  assert.match(notice.textContent,/일정을 추가했어요/);
  const captures=[];
  app.document.addEventListener('click',event=>{
    if(['undo-button','redo-button'].includes(event.target.id))captures.push({button:event.target.id,hidden:notice.hidden});
  },true);
  for(const [action,expected,message] of [['undo',original,/직전 편집을 되돌리고/],['redo',edited,/되돌린 편집을 다시 실행하고/]]){
    const button=app.$(`${action}-button`),previous=notice.textContent;
    assert.equal(button.disabled,false);
    button.dispatch('pointerdown',{pointerType:'mouse'});
    assert.equal(notice.hidden,false);assert.equal(notice.textContent,previous);
    button.click();
    assert.deepEqual(noteParameters(app),expected,'the initial click must apply its action without a second click');
    assert.equal(notice.hidden,false);assert.match(notice.textContent,message,'capture must clear the old message before the target creates the new one');
  }
  assert.deepEqual(captures,[{button:'undo-button',hidden:true},{button:'redo-button',hidden:true}]);
});

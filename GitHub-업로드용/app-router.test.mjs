import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('app.js', import.meta.url), 'utf8');
const plannerCode = readFileSync(new URL('planner.js', import.meta.url), 'utf8');
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
    for (let node = this; node; node = bubbles ? node.parentNode : null)
      for (const listener of node.listeners.get(type) || []) listener(event);
    if (bubbles) this.document.dispatch(type, this, event);
  }
  click() { if (!this.disabled) this.dispatch('click'); }
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

function runtime({ hash = '', raw = null, destinationsPromise, ensureCity, loadError, storageError, cityData = null, planner = null, withAccount = false, accountUser = null, accountReady, currentDateTime='2026-10-20T12:00:00' } = {}) {
  const elements = new Map(), documentListeners = new Map();
  const document = {
    title: '', activeElement: null,
    createElement: tag => new Element(tag, document),
    getElementById: id => elements.get(id) || document.body.querySelector(`#${id}`),
    querySelector: selector => document.body.querySelector(selector),
    querySelectorAll: selector => document.body.querySelectorAll(selector),
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { documentListeners.get(type)?.delete(listener); },
    dispatch(type, target, extra = {}) {
      const event = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
      for (const listener of documentListeners.get(type) || []) listener(event);
    }
  };
  document.body = document.createElement('body');
  const ids = ['country-select', 'city-select', 'start-date', 'day-count', 'trip-form', 'destinations-retry',
    'city-note', 'duration-note', 'data-status', 'app-message', 'date-trigger', 'itinerary-section',
    'empty-state', 'day-list', 'trip-summary', 'capacity-message', 'print-button', 'clear-button',
    'start-screen', 'screen-loading', 'resume-note', 'resume-summary', 'title', 'itinerary-title', 'loading-title', 'account-nav', 'saved-plans', 'account-save'];
  for (const id of ids) {
    const tag = ['city-select', 'day-count'].includes(id) ? 'select' : id === 'trip-form' ? 'form' : 'div';
    const element = document.createElement(tag); element.id = id; elements.set(id, element);
  }
  const $ = id => elements.get(id);
  $('country-select').value = 'KR'; $('app-message').hidden = true;
  $('start-screen').append($('title'), $('trip-form'), $('resume-note'), $('empty-state'));
  $('resume-note').append($('resume-summary'));
  $('itinerary-section').append($('itinerary-title'), $('trip-summary'), $('day-list'));
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
  window.TravelRestaurants = { ...mountStub('restaurant'), districtFromAddress: () => '남구' };
  const account={options:null,changes:0,detaches:0};
  if(withAccount)window.TravelAccount={mount(options){
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
  vm.runInContext(code, vm.createContext({ window, document, localStorage, Date:AppDate, JSON, console,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }), { filename: 'app.js' });
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

test('typing or changing input dismisses notices immediately, and interactive pointer targets dismiss transient notices', async () => {
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
  assert.equal(app.$('app-message').hidden, true);
  assert.equal(app.clock.pending.size, 0);
});

test('loading remains visible until completion, while errors persist until the next input', async () => {
  const restore = deferred(), app = runtime({ hash: '#/note', raw: savedNote(), ensureCity: () => restore.promise });
  await settle(); screen(app, 'loading');
  assert.match(app.$('app-message').textContent, /관광정보를 불러오고/);
  assert.equal(app.clock.pending.size, 0);
  app.clock.advance(20000);
  for (const type of ['input', 'change', 'pointerdown']) app.document.dispatch(type, app.$('trip-form').querySelector('button[type="submit"]'));
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

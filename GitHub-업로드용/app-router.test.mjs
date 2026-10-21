import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { leafletFixture } from './leaflet-fixture.mjs';

const code = readFileSync(new URL('app.js', import.meta.url), 'utf8');
const plannerCode = readFileSync(new URL('planner.js', import.meta.url), 'utf8');
const accountCode = readFileSync(new URL('account-ui.js', import.meta.url), 'utf8');
const noteToolsCode = readFileSync(new URL('note-tools.js', import.meta.url), 'utf8');
const exportCode = readFileSync(new URL('itinerary-export.js', import.meta.url), 'utf8');
const personalCode = readFileSync(new URL('personalization-ui.js', import.meta.url), 'utf8');
const mapCode = readFileSync(new URL('day-map.js', import.meta.url), 'utf8');
const dragCode = readFileSync(new URL('timeline-drag.js', import.meta.url), 'utf8');
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
  getBoundingClientRect() { return typeof this.rect==='function'?this.rect():this.rect||{left:0,right:600,top:100,bottom:200,width:600,height:100}; }
  setPointerCapture(id) { this.capturedPointer=id; }
  hasPointerCapture(id) { return this.capturedPointer===id; }
  releasePointerCapture() { this.capturedPointer=null; }
  dispatch(type, extra = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation(){this.immediatePropagationStopped=true;this.propagationStopped=true;}, ...extra };
    const bubbles = !['pointerenter', 'pointerleave', 'mouseenter', 'mouseleave', 'focus', 'blur'].includes(type);
    if (bubbles) this.document.dispatch(type, this, event, 'capture');
    for (let node = this; node&&!event.propagationStopped; node = bubbles ? node.parentNode : null)
      for (const listener of node.listeners.get(type) || []) { if(event.immediatePropagationStopped)break;listener(event); }
    if (bubbles&&!event.propagationStopped) this.document.dispatch(type, this, event, 'bubble');
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  select() { this.selected = true; }
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

function runtime({ hash = '', search = '', socialReturn = false, raw = null, seedStorage = [], destinationsPromise, ensureCity, loadError, storageError, cityData = null, planner = null, withAccount = false, accountUser = null, accountReady, accountHandler, restoreAttachment, currentDateTime='2026-10-20T12:00:00' } = {}) {
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
      const event = extra.type===type?extra:{ type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation(){this.immediatePropagationStopped=true;this.propagationStopped=true;}, ...extra };
      if (phase !== 'bubble') for (const listener of documentCaptureListeners.get(type) || []) {if(event.immediatePropagationStopped)break;listener(event);}
      if (phase !== 'capture'&&!event.propagationStopped) for (const listener of documentListeners.get(type) || []) {if(event.immediatePropagationStopped)break;listener(event);}
    }
  };
  document.body = document.createElement('body');
  const ids = ['country-select', 'city-select', 'start-date', 'day-count', 'trip-form', 'destinations-retry',
    'city-note', 'duration-note', 'data-status', 'app-message', 'date-trigger', 'itinerary-section',
    'empty-state', 'day-list', 'day-bookmarks', 'day-bookmarks-bottom', 'trip-summary', 'note-timing-notice', 'pending-transfers', 'capacity-message', 'print-button', 'clear-button', 'undo-button', 'redo-button',
    'start-screen', 'screen-loading', 'resume-note', 'resume-summary', 'title', 'itinerary-title', 'loading-title', 'account-nav', 'account-notice', 'saved-plans', 'account-save', 'draft-recovery', 'note-export', 'personal-tools', 'day-map'];
  for (const id of ids) {
    const tag = ['city-select', 'day-count'].includes(id) ? 'select' : id === 'trip-form' ? 'form' : ['print-button','clear-button','undo-button','redo-button'].includes(id) ? 'button' : 'div';
    const element = document.createElement(tag); element.id = id; elements.set(id, element);
  }
  const $ = id => elements.get(id);
  $('country-select').value = 'KR'; $('app-message').hidden = true; $('note-timing-notice').hidden = true;
  $('start-screen').append($('title'), $('trip-form'), $('resume-note'), $('empty-state'));
  $('resume-note').append($('resume-summary'));
  $('itinerary-section').append($('itinerary-title'), $('trip-summary'), $('undo-button'), $('redo-button'), $('note-timing-notice'), $('pending-transfers'), $('note-export'), $('personal-tools'), $('day-map'), $('day-bookmarks'), $('day-list'), $('day-bookmarks-bottom'));
  $('screen-loading').append($('loading-title'));
  document.body.append($('app-message'), $('draft-recovery'), $('screen-loading'), $('start-screen'), $('itinerary-section'));
  const submit = document.createElement('button'); submit.type = 'submit'; submit.append(document.createElement('span'));
  $('trip-form').append(submit);
  const listeners = new Map(), history = [hash], scrolls = [], creations = [], mounts = [], downloads = [], revoked = [];
  let historyIndex = 0, currentHash = hash;
  const emitHash = () => { for (const listener of listeners.get('hashchange') || []) listener({ type: 'hashchange' }); };
  const location = { search, pathname: '/' };
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
    innerHeight:800,scrollY:0,scrollBy(options){this.scrollY+=options.top;scrolls.push(options);},
    crypto,
    URL: { createObjectURL(blob) { const url = `blob:test-${downloads.length}`; downloads.push({ url, blob }); return url; }, revokeObjectURL(url) { revoked.push(url); } },
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
      formatTime: planner?.formatTime || (minutes => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`)
    }
  };
  function mountStub(kind) {
    return { mount(host, options) {
      const details = document.createElement('details'); details.append(document.createElement('summary')); host.append(details);
      if (kind === 'transit') details.className = 'transit-route-lookup';
      const record = { kind, host, options, destroyed: false }; mounts.push(record);
      return { set() {}, destroy() {
        if (record.destroyed) return;
        record.destroyed = true;
        if (kind === 'transit') options.onPreviewDuration?.(null);
        if (kind === 'local-transfer') options.onPreviewTransitDuration?.(null);
        host.replaceChildren();
      } };
    } };
  }
  window.TravelDeparture = mountStub('departure');
  window.TravelTransitRouting = mountStub('transit');
  window.TravelLocalTransfer = mountStub('local-transfer');
  window.TravelTransport = mountStub('transport');
  window.TravelSchedule = mountStub('schedule');
  window.TravelRestaurants = { ...mountStub('restaurant'), mountManual: mountStub('manual-restaurant').mount, districtFromAddress: () => '남구' };
  const account={options:null,changes:0,detaches:0,attachment:null,attachmentVersion:0,restores:[]};
  if(withAccount&&!accountHandler)window.TravelAccount={mount(options){
    account.options=options;
    account.attach=snapshot=>{account.attachmentVersion++;account.attachment=snapshot;options.onAttachmentChange(snapshot);};
    return {ready:Promise.resolve(accountReady).then(()=>options.onUserChange(accountUser,{initial:true,socialReturn})),changed(){account.changes++;},detach(){account.detaches++;account.attachmentVersion++;account.attachment=null;},
      getAttachment(){return account.attachment;},
      async restoreAttachment(snapshot){const version=++account.attachmentVersion;account.restores.push(snapshot);const result=restoreAttachment?await restoreAttachment(snapshot):{ok:true};
        if(version===account.attachmentVersion)account.attachment=result.ok||['unavailable','conflict'].includes(result.reason)?snapshot:null;return result;}};
  }};
  const stored = new Map([...(raw === null ? [] : [[storageKey, raw]]), ...seedStorage]), writes = [], removals = [];
  const localStorage = {
    getItem(key) { if (storageError?.get) throw Error('storage inaccessible'); return stored.get(key) ?? null; },
    setItem(key, value) { if (typeof storageError?.set === 'function' ? storageError.set(key,value) : storageError?.set) throw Error('storage full'); writes.push([key, value]); stored.set(key, value); },
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
  const context = vm.createContext({ window, document, localStorage, Date:AppDate, JSON, console, TextEncoder, AbortController, Blob,
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
  vm.runInContext(exportCode, context, { filename: 'itinerary-export.js' });
  vm.runInContext(personalCode, context, { filename: 'personalization-ui.js' });
  vm.runInContext(mapCode, context, { filename: 'day-map.js' });
  vm.runInContext(dragCode, context, { filename: 'timeline-drag.js' });
  vm.runInContext(code, context, { filename: 'app.js' });
  return { $, window, document, stored, writes, removals, creations, behavior, scrolls, clock, mounts, account, downloads, revoked,
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
function selectedDay(app, index) {
  const days = app.$('day-list').children;
  assert.ok(days[index], `day ${index + 1} exists`);
  assert.deepEqual(days.map(day => day.hidden), days.map((_, at) => at !== index), 'only the requested day is visible');
  for (const id of ['day-bookmarks', 'day-bookmarks-bottom']) {
    assert.equal(app.$(id).children.length, days.length);
    assert.deepEqual(app.$(id).children.map(button => button.getAttribute('aria-current')),
      days.map((_, at) => at === index ? 'page' : 'false'), `${id} marks the same current day`);
  }
}

function editRow(app, eventId = 'place-0', dayIndex = 0) {
  const row = app.$('day-list').children[dayIndex].querySelector(`[data-event-id="${eventId}"]`);
  assert.ok(row, `editable row ${eventId}`);
  row.querySelector('.event-edit-button').click();
  assert.ok(row.querySelector('.event-editor'), `editor ${eventId} opened`);
  return row;
}
function inputMemo(row, text) { const field = row.querySelector('textarea'); field.value = text; field.dispatch('input'); }
function ownerNote(note, ownerId, extra = {}) {
  return JSON.stringify({ version: 8, ownerId, savedAt: '2026-10-20T00:00:00Z', itinerary: note, attachment: null, editorDrafts: {}, ...extra });
}
function noteWithMemo(fixture, text) {
  return fixture.planner.createItinerary({ city: fixture.cityData, startDate: '2026-10-20', dayCount: 1,
    eventEdits: { 0: { 'place-0': { description: text } } } });
}

test('editor drafts survive switching cards and reloading without entering cloud parameters or undo history', async () => {
  const fixture = actualPlannerFixture(), app = runtime({ ...fixture, withAccount: true }); await settle(); await app.create();
  const original = noteParameters(app), changes = app.account.changes;
  let first = editRow(app); inputMemo(first, 'A에서 아직 저장하지 않은 메모');
  const minutes = first.querySelector('input[type="number"]'); minutes.value = '75'; minutes.dispatch('input');
  const second = editRow(app, 'place-1'); inputMemo(second, 'B의 입력도 유지');
  assert.equal(first.querySelector('.event-editor'), null);
  first = editRow(app); assert.equal(first.querySelector('textarea').value, 'A에서 아직 저장하지 않은 메모');
  assert.equal(first.querySelector('input[type="number"]').value, '75');
  assert.deepEqual(noteParameters(app), original); assert.equal(app.account.changes, changes);
  assert.equal(app.$('undo-button').disabled, true);
  const restored = runtime({ ...fixture, withAccount: true, raw: app.stored.get(storageKey), hash: '#/note' }); await settle();
  const reopened = editRow(restored);
  assert.equal(reopened.querySelector('textarea').value, 'A에서 아직 저장하지 않은 메모');
  assert.equal(reopened.querySelector('input[type="number"]').value, '75');
  const other = editRow(restored, 'place-1'); assert.equal(other.querySelector('textarea').value, 'B의 입력도 유지');
  assert.deepEqual(noteParameters(restored), original); assert.equal(restored.$('undo-button').disabled, true);
});

test('an official tourist name longer than the editable title limit does not discard its unfinished memo on reload', async () => {
  const fixture = actualPlannerFixture(); fixture.cityData.areas[0].places[0].name = '긴 공식 관광지 이름 '.repeat(9).trim();
  assert.ok(fixture.cityData.areas[0].places[0].name.length > 80);
  const app = runtime({ ...fixture, withAccount: true }); await settle(); await app.create();
  inputMemo(editRow(app), '긴 관광지 이름과 관계없이 유지할 메모');
  const restored = runtime({ ...fixture, withAccount: true, raw: app.stored.get(storageKey), hash: '#/note' }); await settle();
  assert.equal(editRow(restored).querySelector('textarea').value, '긴 관광지 이름과 관계없이 유지할 메모');
  assert.equal(restored.$('undo-button').disabled, true);
});

test('changing a departure mode invalidates unfinished duration fields belonging to its former mode', async () => {
  const fixture = timedNoteFixture(), app = runtime({ ...fixture, withAccount: true, raw: savedNote(fixture.note), hash: '#/note' }); await settle();
  const departure = editRow(app, 'departure'); inputMemo(departure, '자가용에만 해당하는 입력');
  const hours = departure.querySelectorAll('input').find(input => input.getAttribute('aria-label') === '이동시간: 시간'); hours.value = '2'; hours.dispatch('input');
  const widget = app.mounts.findLast(item => item.kind === 'departure' && !item.destroyed && !item.options.role);
  widget.options.onChange({ ...fixture.note.days[0].departure, mode: 'local-bus' });
  const reopened = editRow(app, 'departure');
  assert.notEqual(reopened.querySelector('textarea').value, '자가용에만 해당하는 입력');
  assert.equal(reopened.querySelectorAll('input').find(input => input.getAttribute('aria-label') === '이동시간: 시간').value, '0');
  assert.equal(JSON.parse(app.stored.get(storageKey)).editorDrafts['0:departure'], undefined);
});

test('explicit editor cancel discards only that card draft while unrelated saved edits preserve another draft', async () => {
  const app = runtime({ ...actualPlannerFixture(), withAccount: true }); await settle(); await app.create();
  const first = editRow(app); inputMemo(first, 'A는 계속 작성 중');
  const second = editRow(app, 'place-1'); inputMemo(second, 'B는 취소할 입력'); second.querySelector('.editor-cancel').click();
  const reopened = editRow(app, 'place-1'); assert.notEqual(reopened.querySelector('textarea').value, 'B는 취소할 입력');
  inputMemo(reopened, 'B만 저장한 메모'); reopened.querySelector('.event-editor').dispatch('submit');
  assert.equal(noteParameters(app).eventEdits[0]['place-1'].description, 'B만 저장한 메모');
  const preserved = editRow(app); assert.equal(preserved.querySelector('textarea').value, 'A는 계속 작성 중');
  assert.equal(noteParameters(app).eventEdits[0]['place-0'], undefined);
  assert.equal(app.$('undo-button').disabled, false);
  preserved.querySelector('.editor-cancel').click();
  assert.equal(JSON.parse(app.stored.get(storageKey)).editorDrafts['0:place-0'], undefined);
});

test('new recommendations retain the previous personal note and unfinished fields for explicit recovery', async () => {
  const fixture = actualPlannerFixture(), note = noteWithMemo(fixture, '개인적으로 작성한 방문 메모');
  const app = runtime({ ...fixture, withAccount: true, raw: savedNote(note), hash: '#/note' }); await settle();
  const first = editRow(app); inputMemo(first, '이전 노트에서 계속 쓰던 입력');
  await app.create(); assert.notEqual(noteParameters(app).eventEdits[0]?.['place-0']?.description, '개인적으로 작성한 방문 메모');
  const previous = JSON.parse(app.stored.get(storageKey)).previous;
  assert.equal(previous.itinerary.eventEdits[0]['place-0'].description, '개인적으로 작성한 방문 메모');
  assert.equal(previous.editorDrafts['0:place-0'].description, '이전 노트에서 계속 쓰던 입력');
  assert.equal(app.$('draft-recovery').hidden, false);
  app.$('draft-recovery').querySelector('button').click(); await settle();
  assert.equal(noteParameters(app).eventEdits[0]['place-0'].description, '개인적으로 작성한 방문 메모');
  const restored = editRow(app); assert.equal(restored.querySelector('textarea').value, '이전 노트에서 계속 쓰던 입력');
  assert.equal(app.$('undo-button').disabled, true);
});

test('a failed previous-note write rejects regeneration or cloud replacement without replacing the note, storage or open map', async () => {
  const storageError = {}, app = runtime({ ...actualPlannerFixture(), withAccount: true, storageError }); await settle(); await app.create();
  const original = noteParameters(app), raw = app.stored.get(storageKey), card = app.$('day-list').children[0];
  const maps = leafletFixture(); app.window.L = maps.L;
  const panel = openDayMap(app), places = panel.querySelector('.day-map-places').textContent;
  const remote = app.account.options.getDocument();
  storageError.set = key => key === storageKey;
  await app.create();
  assert.deepEqual(noteParameters(app), original); assert.equal(app.stored.get(storageKey), raw);
  assert.equal(app.$('day-list').children[0], card); assert.equal(app.$('draft-recovery').hidden, true);
  assert.match(app.$('app-message').textContent, /새 노트로 바꾸지 않았어요/);
  assert.equal(await app.account.options.loadDocument(remote), false);
  assert.deepEqual(noteParameters(app), original); assert.equal(app.stored.get(storageKey), raw);
  assert.equal(app.$('day-list').children[0], card); assert.equal(panel.open, true);
  assert.equal(panel.querySelector('.day-map-places').textContent, places);
  assert.equal(maps.maps.length, 1); assert.equal(maps.maps[0].removed, false);
});

test('previous-note recovery is isolated to its account owner', async () => {
  const fixture = actualPlannerFixture(), app = runtime({ ...fixture, withAccount: true }); await settle(); await app.create();
  await app.account.options.onUserChange({ id: 'owner-a', username: 'alice' }, { initial: false });
  const row = editRow(app); inputMemo(row, 'Alice의 개인 메모'); row.querySelector('.event-editor').dispatch('submit');
  await app.create(); assert.equal(app.$('draft-recovery').hidden, false);
  await app.account.options.onUserChange({ id: 'owner-b', username: 'bob' }, { initial: false });
  assert.equal(app.$('draft-recovery').hidden, true); assert.equal(app.account.options.getDocument(), null);
  assert.equal(app.document.body.textContent.includes('Alice의 개인 메모'), false);
  await app.account.options.onUserChange({ id: 'owner-a', username: 'alice' }, { initial: false });
  assert.equal(app.$('draft-recovery').hidden, false);
  app.$('draft-recovery').querySelector('button').click(); await settle();
  assert.equal(noteParameters(app).eventEdits[0]['place-0'].description, 'Alice의 개인 메모');
});

test('sign-in preserves both the guest draft and an existing owner draft with explicit recovery', async () => {
  const fixture = actualPlannerFixture(), owner = { id: 'owner-a', username: 'alice' };
  const guestRaw = savedNote(noteWithMemo(fixture, '로그인 전에 쓰던 메모'));
  const existingRaw = ownerNote(noteWithMemo(fixture, '계정에 전에 쓰던 메모'), owner.id);
  const app = runtime({ ...fixture, withAccount: true, raw: guestRaw, seedStorage: [[`${storageKey}:${owner.id}`, existingRaw]], hash: '#/note' });
  await settle(); await app.account.options.onUserChange(owner, { initial: false });
  assert.equal(noteParameters(app).eventEdits[0]['place-0'].description, '로그인 전에 쓰던 메모');
  assert.equal(JSON.parse(app.stored.get(`${storageKey}:${owner.id}`)).ownerId, owner.id);
  assert.equal(JSON.parse(app.stored.get(`${storageKey}:${owner.id}`)).previous.itinerary.eventEdits[0]['place-0'].description, '계정에 전에 쓰던 메모');
  assert.equal(app.stored.has(storageKey), false);
  app.$('draft-recovery').querySelector('button').click(); await settle();
  assert.equal(noteParameters(app).eventEdits[0]['place-0'].description, '계정에 전에 쓰던 메모');
  assert.equal(JSON.parse(app.stored.get(`${storageKey}:${owner.id}`)).previous.itinerary.eventEdits[0]['place-0'].description, '로그인 전에 쓰던 메모');
});

test('a social callback adopts the guest note on initial account discovery and backs up the previous owner note', async () => {
  const fixture = actualPlannerFixture(), owner = { id: 'owner-a', username: 'alice' };
  const existingRaw = ownerNote(noteWithMemo(fixture, '이전 계정 노트'), owner.id);
  const app = runtime({ ...fixture, withAccount: true, accountUser: owner, socialReturn: true, search: '?social=success', hash: '#/note/day/1',
    raw: savedNote(noteWithMemo(fixture, '소셜 로그인 중 보존한 노트')), seedStorage: [[`${storageKey}:${owner.id}`, existingRaw]] });
  await settle();
  assert.equal(noteParameters(app).eventEdits[0]['place-0'].description, '소셜 로그인 중 보존한 노트');
  assert.equal(JSON.parse(app.stored.get(`${storageKey}:${owner.id}`)).previous.itinerary.eventEdits[0]['place-0'].description, '이전 계정 노트');
  assert.equal(JSON.parse(app.stored.get(`${storageKey}:${owner.id}`)).ownerId, owner.id);
  assert.equal(app.stored.has(storageKey), false); assert.equal(app.$('draft-recovery').hidden, false);
});

test('a social success query without an account-verified pending attempt cannot replace an existing owner draft', async () => {
  const fixture = actualPlannerFixture(), owner = { id: 'owner-a', username: 'alice' };
  const guestRaw = savedNote(noteWithMemo(fixture, '로그인 전 노트'));
  const existing = ownerNote(noteWithMemo(fixture, '원래 계정 노트'), owner.id);
  const app = runtime({ ...fixture, withAccount: true, accountUser: owner, search: '?social=success', hash: '#/note', raw: guestRaw,
    seedStorage: [[`${storageKey}:${owner.id}`, existing]] }); await settle();
  assert.equal(noteParameters(app).eventEdits[0]['place-0'].description, '원래 계정 노트');
  assert.equal(app.stored.get(storageKey), guestRaw); assert.equal(app.stored.get(`${storageKey}:${owner.id}`), existing);
});

test('recovering an unlinked note detaches the previously open cloud plan before another save', async () => {
  const fixture = actualPlannerFixture(), owner = { id: 'owner-a', username: 'alice' };
  const attachment = { ownerId: owner.id, plan: { id: 'plan-current', title: '현재 계정 계획', revision: 2 } };
  const previous = JSON.parse(ownerNote(noteWithMemo(fixture, '계정에 연결하지 않은 이전 메모'), owner.id));
  const app = runtime({ ...fixture, withAccount: true, accountUser: owner, hash: '#/note',
    seedStorage: [[`${storageKey}:${owner.id}`, ownerNote(noteWithMemo(fixture, '현재 계정 계획'), owner.id, { attachment, previous })]] });
  await settle(); assert.equal(app.account.attachment.plan.id, 'plan-current');
  app.$('draft-recovery').querySelector('button').click(); await settle();
  assert.equal(app.account.attachment, null); assert.equal(JSON.parse(app.stored.get(`${storageKey}:${owner.id}`)).attachment, null);
  assert.equal(noteParameters(app).eventEdits[0]['place-0'].description, '계정에 연결하지 않은 이전 메모');
});

test('a delayed recovery attachment result cannot clear the replacement account draft or its link', async () => {
  const fixture = actualPlannerFixture(), ownerA = { id: 'owner-a', username: 'alice' }, ownerB = { id: 'owner-b', username: 'bob' }, gate = deferred();
  const link = (owner, id) => ({ ownerId: owner.id, plan: { id, title: '계정 계획', revision: 2 } });
  const previous = JSON.parse(ownerNote(noteWithMemo(fixture, 'Alice 이전 노트'), ownerA.id, { attachment: link(ownerA, 'pending-plan') }));
  const app = runtime({ ...fixture, withAccount: true, accountUser: ownerA, hash: '#/note',
    seedStorage: [[`${storageKey}:${ownerA.id}`, ownerNote(noteWithMemo(fixture, 'Alice 현재 노트'), ownerA.id, { attachment: link(ownerA, 'current-plan'), previous })],
      [`${storageKey}:${ownerB.id}`, ownerNote(noteWithMemo(fixture, 'Bob의 새 노트'), ownerB.id, { attachment: link(ownerB, 'bob-plan') })]],
    restoreAttachment: snapshot => snapshot.plan.id === 'pending-plan' ? gate.promise : Promise.resolve({ ok: true }) });
  await settle(); app.$('draft-recovery').querySelector('button').click(); await settle();
  await app.account.options.onUserChange(ownerB, { initial: false });
  const raw = app.stored.get(`${storageKey}:${ownerB.id}`), messages = app.$('app-message').textContent;
  gate.resolve({ ok: false, reason: 'invalid' }); await settle();
  assert.equal(noteParameters(app).eventEdits[0]['place-0'].description, 'Bob의 새 노트');
  assert.equal(app.stored.get(`${storageKey}:${ownerB.id}`), raw); assert.equal(app.$('app-message').textContent, messages);
  assert.equal(JSON.parse(raw).attachment.plan.id, 'bob-plan'); assert.equal(app.account.attachment.plan.id, 'bob-plan');
});

test('restored plan attachments are verified and metadata callbacks persist without a committed edit or undo step', async () => {
  const fixture = actualPlannerFixture(), owner = { id: 'owner-a', username: 'alice' };
  const attachment = { ownerId: owner.id, plan: { id: 'plan-a', title: '기존 계획', revision: 3 } };
  const raw = ownerNote(noteWithMemo(fixture, '기존 계획의 메모'), owner.id, { attachment });
  const app = runtime({ ...fixture, withAccount: true, accountUser: owner, hash: '#/note', seedStorage: [[`${storageKey}:${owner.id}`, raw]] });
  await settle(); assert.equal(app.account.restores.length, 1); assert.deepEqual(app.account.restores[0], attachment);
  const parameters = noteParameters(app), changes = app.account.changes;
  const updated = { ownerId: owner.id, plan: { ...attachment.plan, revision: 4 } };
  app.account.attach(updated);
  assert.deepEqual(JSON.parse(app.stored.get(`${storageKey}:${owner.id}`)).attachment, updated);
  assert.deepEqual(noteParameters(app), parameters); assert.equal(app.account.changes, changes);
  assert.equal(app.$('undo-button').disabled, true);
  app.account.attach({ ownerId: 'owner-b', plan: { id: 'private-other-plan', revision: 1 } });
  assert.equal(JSON.parse(app.stored.get(`${storageKey}:${owner.id}`)).attachment, null);
  assert.deepEqual(noteParameters(app), parameters); assert.equal(app.account.changes, changes);
});

test('a real account controller reconnects a refreshed local draft and saves changes to its original cloud plan', async () => {
  const fixture = actualPlannerFixture(), owner = { id: 'owner-a', username: 'alice' }, requests = [];
  const plan = { id: 'original-plan', title: '기존 여행 노트', cityId: fixture.cityData.id, startDate: '2026-10-20', dayCount: 1,
    revision: 3, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };
  const attachment = { ownerId: owner.id, plan };
  const app = runtime({ ...fixture, withAccount: true, hash: '#/note',
    seedStorage: [[`${storageKey}:${owner.id}`, ownerNote(noteWithMemo(fixture, '다시 불러온 내 메모'), owner.id, { attachment })]],
    accountHandler: async (path, options) => {
      requests.push({ path, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      let data;
      if (path === '/api/auth/session') data = { configured: true, user: owner };
      else if (path === '/api/plans') data = { plans: [plan] };
      else if (path === '/api/plans/original-plan' && options.method === 'GET') data = { plan };
      else if (path === '/api/plans/original-plan' && options.method === 'PUT') data = { plan: { ...plan, revision: 4 } };
      else throw Error(`Unexpected request ${options.method} ${path}`);
      return { ok: true, status: 200, json: async () => data };
    } });
  await settle(); assert.ok(requests.some(request => request.path === '/api/plans/original-plan' && request.method === 'GET'));
  const save = app.$('account-save').querySelector('button'); assert.equal(save.textContent, '변경사항 저장');
  assert.equal(save.disabled, false); save.click();
  const form = app.document.body.querySelector('.account-dialog-form'); assert.ok(form); form.dispatch('submit'); await settle();
  const writes = requests.filter(request => ['POST', 'PUT'].includes(request.method));
  assert.equal(writes.length, 1); assert.equal(writes[0].method, 'PUT'); assert.equal(writes[0].body.revision, 3);
  assert.equal(writes[0].body.document.itinerary.eventEdits[0]['place-0'].description, '다시 불러온 내 메모');
  assert.equal(JSON.parse(app.stored.get(`${storageKey}:${owner.id}`)).attachment.plan.revision, 4);
  assert.equal(app.$('undo-button').disabled, true);
  app.account.controller.destroy();
});

test('attachment verification failures preserve retryable links and reject invalid owner metadata without creating history', async () => {
  for (const reason of ['unavailable', 'conflict', 'invalid', 'not-owned']) {
    const fixture = actualPlannerFixture(), owner = { id: 'owner-a', username: 'alice' };
    const attachment = { ownerId: owner.id, plan: { id: 'plan-a', title: '저장 연결', revision: 2 } };
    let app, changesAtVerification;
    app = runtime({ ...fixture, withAccount: true, accountUser: owner, hash: '#/note',
      seedStorage: [[`${storageKey}:${owner.id}`, ownerNote(noteWithMemo(fixture, '내 메모는 유지'), owner.id, { attachment })]],
      restoreAttachment: async () => { changesAtVerification = app.account.changes; return { ok: false, reason }; } });
    await settle();
    assert.deepEqual(JSON.parse(app.stored.get(`${storageKey}:${owner.id}`)).attachment,
      ['invalid', 'not-owned'].includes(reason) ? null : attachment);
    assert.equal(noteParameters(app).eventEdits[0]['place-0'].description, '내 메모는 유지');
    assert.equal(app.account.changes, changesAtVerification); assert.equal(app.$('undo-button').disabled, true);
  }
});

test('export toolbar follows the selected page and exports all committed days even when collapsed, without saving or disturbing history', async () => {
  const fixture = timedNoteFixture(3), app = runtime({ ...fixture, raw: savedNote(fixture.note), withAccount: true, hash: '#/note' });
  await settle();
  const host = app.$('note-export'), scope = host.querySelector('select'), [copy, download] = host.querySelectorAll('button');
  const files = [];
  app.document.addEventListener('click', event => { if (event.target.download) files.push(event.target.download); });
  const copied = []; app.window.navigator = { clipboard: { async writeText(value) { copied.push(value); } } };
  const writes = app.writes.length, changes = app.account.changes;
  app.$('day-bookmarks').querySelectorAll('button')[1].click();
  assert.match(scope.children[0].textContent, /Day 02/);
  copy.click(); copy.click(); await settle();
  assert.equal(copied.length, 1);
  assert.match(copied[0], /2026-10-21 · Day 02/);
  assert.doesNotMatch(copied[0], /Day 01|Day 03/);
  download.click();
  assert.match(files[0], /Day02\.ics$/);
  assert.equal(((await app.downloads[0].blob.text()).match(/BEGIN:VEVENT/g) || []).length, fixture.note.days[1].events.length);
  app.document.querySelector('#travel-day-1 .day-collapse').click();
  scope.value = 'all'; scope.dispatch('change');
  copy.click(); await settle();
  assert.match(copied[1], /Day 01[\s\S]*Day 02[\s\S]*Day 03/);
  download.click();
  assert.equal(app.downloads[1].blob.type, 'text/calendar;charset=utf-8');
  assert.match(files[1], /전체\.ics$/);
  const file = await app.downloads[1].blob.text();
  assert.equal((file.match(/BEGIN:VEVENT/g) || []).length, fixture.note.days.flatMap(day => day.events).length);
  assert.equal(app.document.querySelectorAll('a').filter(link => link.download).length, 0);
  app.clock.advance(30000);
  assert.deepEqual(app.revoked, app.downloads.map(item => item.url));
  assert.equal(app.document.querySelector('#travel-day-1 .day-card-body').hidden, true);
  assert.equal(app.writes.length, writes); assert.equal(app.account.changes, changes);
  assert.equal(app.$('undo-button').disabled, true);
});

test('blocked clipboard exposes selectable text and stale copy failures cannot reveal a previous note after account reset', async () => {
  const fixture = timedNoteFixture(2), app = runtime({ ...fixture, raw: savedNote(fixture.note), withAccount: true, hash: '#/note' });
  await settle();
  const host = app.$('note-export'), copy = host.querySelector('button'), fallback = host.querySelector('textarea');
  copy.click(); await settle();
  assert.equal(fallback.parentNode.hidden, false); assert.equal(fallback.selected, true);
  assert.match(fallback.value, /Day 01/);
  const request = deferred(); app.window.navigator = { clipboard: { writeText: () => request.promise } };
  copy.click();
  assert.equal(fallback.value, ''); assert.equal(fallback.parentNode.hidden, true);
  await app.account.options.onUserChange(undefined); request.reject(Error('Permission denied')); await settle();
  assert.equal(fallback.value, ''); assert.equal(fallback.parentNode.hidden, true);
  assert.equal(host.querySelector('.note-export-status').textContent, '');
});

test('a pending copy success cannot announce the wrong day, and export errors leave the note usable', async () => {
  const fixture = timedNoteFixture(2), app = runtime({ ...fixture, raw: savedNote(fixture.note), hash: '#/note' });
  await settle();
  const request = deferred(), host = app.$('note-export');
  app.window.navigator = { clipboard: { writeText: () => request.promise } };
  host.querySelector('button').click();
  app.$('day-bookmarks').querySelectorAll('button')[1].click(); request.resolve(); await settle();
  assert.equal(host.querySelector('.note-export-status').textContent, '');
  app.window.URL.createObjectURL = () => { throw Error('Downloads unavailable'); };
  host.querySelectorAll('button')[1].click();
  assert.match(host.querySelector('.note-export-status').textContent, /파일을 만들지 못했어요/);
  assert.equal(app.document.querySelector('#travel-day-1').hidden, false);
  assert.equal(host.querySelector('button').disabled, false);
});

function personalInput(app){return app.$('personal-tools').querySelector('.personal-checklist-form input');}
function addPersonalItem(app,text){personalInput(app).value=text;app.$('personal-tools').querySelector('.personal-checklist-form').dispatch('submit');}
function personalData(app){return app.account.options.getDocument().itinerary.personalization;}

test('personalization saves and previous-note recovery retain an unfinished editor through refresh', async () => {
  const fixture = actualPlannerFixture(), app = runtime({ ...fixture, withAccount: true });
  await settle(); await app.create();
  const row = editRow(app, 'lunch'), memo = row.querySelector('textarea');
  inputMemo(row, '아직 작성 중인 식사 예약 메모');
  addPersonalItem(app, '공연 입장권');
  const checkbox = app.$('personal-tools').querySelector('.personal-checklist-items input');
  checkbox.checked = true; checkbox.dispatch('change');
  const place = app.$('day-list').querySelector('[data-event-id="place-0"]');
  place.querySelector('.event-favorite-button').click();
  const tag = place.querySelector('.event-tag-select'); tag.value = 'booked'; tag.dispatch('change');
  const personal = JSON.parse(JSON.stringify(personalData(app)));
  assert.equal(row.querySelector('textarea'), memo);
  assert.equal(memo.value, '아직 작성 중인 식사 예약 메모');
  assert.equal(noteParameters(app).eventEdits[0]?.lunch?.description, undefined);
  const restored = runtime({ ...fixture, withAccount: true, raw: app.stored.get(storageKey), hash: '#/note' });
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(personalData(restored))), personal);
  assert.equal(editRow(restored, 'lunch').querySelector('textarea').value, '아직 작성 중인 식사 예약 메모');
  await restored.create();
  assert.equal(personalData(restored), undefined);
  restored.$('draft-recovery').querySelector('button').click(); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(personalData(restored))), personal);
  assert.equal(editRow(restored, 'lunch').querySelector('textarea').value, '아직 작성 중인 식사 예약 메모');
  assert.equal(noteParameters(restored).eventEdits[0]?.lunch?.description, undefined);
});

test('checklist add, check, delete and history persist locally and through account documents without replacing an unfinished memo', async()=>{
  const fixture=actualPlannerFixture(),app=runtime({...fixture,withAccount:true});await settle();await app.create();
  const row=app.$('day-list').querySelector('[data-event-id="lunch"]');row.querySelector('.event-edit-button').click();
  const memo=row.querySelector('textarea');memo.value='아직 저장하지 않은 메모';
  addPersonalItem(app,'  충전기  ');
  assert.deepEqual(JSON.parse(JSON.stringify(personalData(app).checklist)),[{id:'item-1',text:'충전기',done:false}]);
  assert.equal(row.querySelector('textarea'),memo);assert.equal(memo.value,'아직 저장하지 않은 메모');
  const checkbox=app.$('personal-tools').querySelector('.personal-checklist-items input');checkbox.checked=true;checkbox.dispatch('change');
  assert.equal(personalData(app).checklist[0].done,true);
  app.$('undo-button').click();assert.equal(personalData(app).checklist[0].done,false);
  app.$('redo-button').click();assert.equal(personalData(app).checklist[0].done,true);
  const document=JSON.parse(JSON.stringify(app.account.options.getDocument()));
  const restored=runtime({...fixture,withAccount:true,raw:app.stored.get(storageKey),hash:'#/note'});await settle();
  assert.equal(personalData(restored).checklist[0].done,true);
  assert.equal(await restored.account.options.loadDocument(document),true);assert.equal(personalData(restored).checklist[0].text,'충전기');
  restored.$('personal-tools').querySelector('.personal-checklist-items button').click();assert.equal(personalData(restored).checklist.length,0);
  restored.$('undo-button').click();assert.equal(personalData(restored).checklist.length,1);
  const checklist=restored.$('personal-tools').querySelector('.personal-checklist');checklist.open=false;
  restored.window.dispatch('beforeprint');assert.equal(checklist.open,true);restored.window.dispatch('afterprint');assert.equal(checklist.open,false);
});

test('favorites search the catalog, add to the selected day once and retain membership through reorder and reload', async()=>{
  const fixture=timedNoteFixture(2),app=runtime({...fixture,withAccount:true,raw:savedNote(fixture.note),hash:'#/note'});await settle();
  const host=app.$('personal-tools'),search=host.querySelector('.personal-place-search-label input');
  search.value='추천 관광지 d';search.dispatch('input');
  host.querySelector('.personal-place-results button').click();assert.equal(personalData(app).favoritePlaceIds[0],'d');
  app.$('day-bookmarks').querySelectorAll('button')[1].click();await settle();
  assert.match(host.querySelector('.personal-favorites .personal-hint').textContent,/Day 02/);
  host.querySelector('.personal-favorite-list button').click();
  let saved=JSON.parse(app.stored.get(storageKey)).itinerary;
  assert.equal(saved.extraEvents[1][0].placeId,'d');assert.equal(saved.extraEvents[0],undefined);
  assert.equal(host.querySelector('.personal-favorite-list button').disabled,true);
  const added=app.$('day-list').querySelector('[data-day-index="1"] [data-event-id="extra-1"]');
  assert.equal(added.querySelector('.event-favorite-button').getAttribute('aria-pressed'),'true');
  added.querySelector('.event-move-button').click();
  assert.equal(personalData(app).favoritePlaceIds[0],'d');
  const restored=runtime({...fixture,withAccount:true,raw:app.stored.get(storageKey),hash:'#/note/day/2'});await settle();
  assert.equal(personalData(restored).favoritePlaceIds[0],'d');
  restored.$('day-list').querySelector('[data-day-index="1"] [data-event-id="extra-1"] .event-favorite-button').click();
  assert.equal(personalData(restored).favoritePlaceIds.length,0);
});

test('tags survive editing, hide/restore and history while deleted or replaced places cannot inherit old reservation tags', async()=>{
  const fixture=actualPlannerFixture(),app=runtime({...fixture,withAccount:true});await settle();await app.create();
  const tag=app.$('day-list').querySelector('[data-event-id="place-0"] .event-tag-select');tag.value='booked';tag.dispatch('change');
  assert.equal(personalData(app).eventTags[0]['place-0'],'booked');
  assert.equal(app.$('day-list').querySelector('[data-event-id="place-0"] .event-tag-badge').textContent,'예약 완료');
  editEntry(app,'lunch',{description:'다른 일정 편집'});assert.equal(personalData(app).eventTags[0]['place-0'],'booked');
  app.$('day-list').querySelector('[data-event-id="place-0"] .event-remove-button').click();
  app.$('day-list').querySelector('.schedule-restore-list button').click();
  assert.equal(personalData(app).eventTags[0]['place-0'],'booked');
  const note=JSON.parse(app.stored.get(storageKey)).itinerary,placeId=note.selections[0][0];
  const replaced=fixture.planner.replacePlace({city:fixture.cityData,itinerary:note,dayIndex:0,placeId,replacementId:'d'});
  assert.equal(replaced.ok,true);assert.equal(replaced.itinerary.personalization.eventTags[0]?.['place-0'],undefined);
  assert.equal(personalData(app).eventTags[0]['place-0'],'booked','planner must not mutate the original');
  const added=currentSchedule(app).options.onAdd({type:'free',title:'개인 일정',duration:20});assert.equal(added.ok,true);
  const extraTag=app.$('day-list').querySelector('[data-event-id="extra-1"] .event-tag-select');extraTag.value='must';extraTag.dispatch('change');
  app.$('day-list').querySelector('[data-event-id="extra-1"] .event-remove-button').click();
  assert.equal(personalData(app).eventTags[0]?.['extra-1'],undefined);
  app.$('undo-button').click();assert.equal(personalData(app).eventTags[0]['extra-1'],'must');
});

test('personalization rejects invalid and oversized inputs, preserves failed saves, and clears drafts on owner or note changes', async()=>{
  const fixture=actualPlannerFixture(),app=runtime({...fixture,withAccount:true,storageError:{set:true}});await settle();await app.create();
  addPersonalItem(app,'저장 실패 준비물');assert.equal(personalData(app),undefined);
  assert.equal(personalInput(app).value,'저장 실패 준비물');assert.match(app.$('personal-tools').textContent,/저장하지 못했어요/);
  const tag=app.$('day-list').querySelector('[data-event-id="lunch"] .event-tag-select');tag.value='must';tag.dispatch('change');assert.equal(tag.value,'');
  const okay=runtime({...fixture,withAccount:true});await settle();await okay.create();addPersonalItem(okay,'내 준비물');
  const note=JSON.parse(okay.stored.get(storageKey)).itinerary;
  for(const bad of [null,{checklist:null},{checklist:[{id:'item-1',text:'x'.repeat(121),done:false}]},{favoritePlaceIds:['a','a']},{eventTags:{9:{lunch:'must'}}}]){
    assert.equal(fixture.planner.updatePersonalization({city:fixture.cityData,itinerary:note,personalization:bad}).ok,false);
  }
  personalInput(okay).value='미완성 입력';
  await okay.account.options.onUserChange(undefined);
  assert.equal(okay.$('personal-tools').hidden,true);assert.equal(personalInput(okay).value,'');assert.doesNotMatch(okay.$('personal-tools').textContent,/내 준비물|미완성 입력/);
  await okay.create();assert.equal(personalData(okay),undefined);
});

function openDayMap(app) { const panel=app.$('day-map');panel.open=true;panel.dispatch('toggle');return panel; }

test('recovering a previous note restores its visitor map and unfinished memo after recommendation replacement', async () => {
  const fixture = timedNoteFixture();
  const note = fixture.planner.createItinerary({ city: fixture.cityData, startDate: '2026-10-20', dayCount: 1,
    selections: { 0: ['d', 'b', 'c'] }, eventEdits: { 0: { 'place-0': { description: '이전 노트의 저장한 메모' } } } });
  const app = runtime({ ...fixture, withAccount: true, raw: savedNote(note), hash: '#/note' }); await settle();
  const maps = leafletFixture(); app.window.L = maps.L;
  const panel = openDayMap(app); assert.match(panel.querySelector('.day-map-places').textContent, /추천 관광지 d/);
  inputMemo(editRow(app), '지도에서 일정을 보며 아직 작성 중인 메모');
  await app.create(); assert.equal(maps.maps[0].removed, true); assert.equal(panel.open, false);
  openDayMap(app); assert.match(panel.querySelector('.day-map-places').textContent, /추천 관광지 a/);
  assert.doesNotMatch(panel.querySelector('.day-map-places').textContent, /추천 관광지 d/);
  app.$('draft-recovery').querySelector('button').click(); await settle();
  assert.equal(maps.maps[1].removed, true); assert.equal(panel.open, false);
  openDayMap(app); assert.match(panel.querySelector('.day-map-places').textContent, /추천 관광지 d/);
  assert.doesNotMatch(panel.querySelector('.day-map-places').textContent, /추천 관광지 a/);
  assert.equal(noteParameters(app).eventEdits[0]['place-0'].description, '이전 노트의 저장한 메모');
  assert.equal(editRow(app).querySelector('textarea').value, '지도에서 일정을 보며 아직 작성 중인 메모');
});

test('account switching clears former map places and callbacks while preserving each owner draft and recovery', async () => {
  const fixture = timedNoteFixture(), ownerA = { id: 'owner-a', username: 'alice' }, ownerB = { id: 'owner-b', username: 'bob' };
  const bobNote = fixture.planner.createItinerary({ city: fixture.cityData, startDate: '2026-10-20', dayCount: 1, selections: { 0: ['d', 'b', 'c'] } });
  const previous = JSON.parse(ownerNote(noteWithMemo(fixture, 'Alice 이전 노트'), ownerA.id));
  const app = runtime({ ...fixture, withAccount: true, accountUser: ownerA, hash: '#/note', seedStorage: [
    [`${storageKey}:${ownerA.id}`, ownerNote(fixture.note, ownerA.id, { previous })],
    [`${storageKey}:${ownerB.id}`, ownerNote(bobNote, ownerB.id)]
  ] }); await settle();
  const maps = leafletFixture(); app.window.L = maps.L;
  const panel = openDayMap(app), oldJump = maps.markers[0].popup.querySelector('button');
  inputMemo(editRow(app), 'Alice만 보관하는 미완성 메모');
  assert.equal(app.$('draft-recovery').hidden, false);
  await app.account.options.onUserChange(ownerB, { initial: false }); await app.go('#/note');
  assert.equal(maps.maps[0].removed, true); assert.equal(panel.open, false);
  assert.equal(app.$('draft-recovery').hidden, true);
  openDayMap(app); assert.match(panel.querySelector('.day-map-places').textContent, /추천 관광지 d/);
  assert.doesNotMatch(panel.querySelector('.day-map-places').textContent, /추천 관광지 a/);
  assert.doesNotMatch(app.document.body.textContent, /Alice만 보관하는 미완성 메모|Alice 이전 노트/);
  const focused = app.document.activeElement, status = panel.querySelector('.day-map-status').textContent, raw = app.stored.get(`${storageKey}:${ownerB.id}`);
  oldJump.click(); maps.tiles[0].emit('tileerror'); maps.tiles[0].emit('loading');
  assert.equal(app.document.activeElement, focused); assert.equal(panel.querySelector('.day-map-status').textContent, status);
  assert.equal(app.stored.get(`${storageKey}:${ownerB.id}`), raw);
  assert.equal(JSON.parse(app.stored.get(`${storageKey}:${ownerA.id}`)).editorDrafts['0:place-0'].description, 'Alice만 보관하는 미완성 메모');
  await app.account.options.onUserChange(ownerA, { initial: false }); await app.go('#/note'); openDayMap(app);
  assert.equal(maps.maps[1].removed, true); assert.match(panel.querySelector('.day-map-places').textContent, /추천 관광지 a/);
  assert.doesNotMatch(panel.querySelector('.day-map-places').textContent, /추천 관광지 d/);
  assert.equal(app.$('draft-recovery').hidden, false);
  assert.equal(editRow(app).querySelector('textarea').value, 'Alice만 보관하는 미완성 메모');
});

test('the map stays dormant until opened, groups coincident visits, and popup links reveal the exact collapsed event without saving', async()=>{
  const fixture=timedNoteFixture(2),app=runtime({...fixture,raw:savedNote(fixture.note),hash:'#/note',withAccount:true});await settle();
  const maps=leafletFixture();app.window.L=maps.L;
  assert.equal(maps.maps.length,0);assert.match(app.$('day-map').querySelector('summary').textContent,/Day 01.*3곳/);
  const panel=openDayMap(app);assert.equal(maps.maps.length,1);assert.equal(maps.tiles.length,1);
  assert.equal(maps.markers.length,1);assert.match(maps.markers[0].options.icon.html,/1·2·3/);
  const day=app.document.getElementById('travel-day-0'),row=day.querySelector('[data-event-id="place-1"]');
  day.querySelector('[data-event-id="lunch"] .event-edit-button').click();
  const memo=day.querySelector('textarea');memo.value='지도 이동 중에도 유지할 메모';day.querySelector('.day-collapse').click();
  const before=app.stored.get(storageKey),writes=app.writes.length,changes=app.account.changes;
  maps.markers[0].popup.querySelectorAll('button')[1].click();await settle();
  assert.equal(day.querySelector('.day-card-body').hidden,false);assert.equal(app.document.activeElement,row.querySelector('.event-edit-button'));
  assert.equal(row.lastScrollIntoView.block,'center');assert.equal(memo.value,'지도 이동 중에도 유지할 메모');
  assert.equal(app.stored.get(storageKey),before);assert.equal(app.writes.length,writes);assert.equal(app.account.changes,changes);
  panel.querySelector('.day-map-places button').click();assert.equal(maps.markers[0].opens,1);
});

test('day bookmarks and browser history synchronize marker order while harmless edits retain the map view', async()=>{
  const fixture=timedNoteFixture(2),app=runtime({...fixture,raw:savedNote(fixture.note),hash:'#/note'});await settle();
  const maps=leafletFixture();app.window.L=maps.L;const panel=openDayMap(app);
  const first=maps.markers[0],views=maps.maps[0].views.length;
  editEntry(app,'lunch',{description:'시간과 무관한 메모'});
  assert.equal(maps.markers.length,1);assert.equal(maps.maps[0].views.length,views);
  app.$('day-bookmarks').querySelectorAll('button')[1].click();await settle();
  assert.match(panel.querySelector('summary').textContent,/Day 02/);assert.equal(maps.maps.length,1);assert.equal(maps.markers.length,2);
  assert.match(maps.markers[1].options.title,/추천 관광지 a/);
  const current=app.document.activeElement;first.popup.querySelector('button').click();assert.equal(app.document.activeElement,current,'a detached former-day popup cannot navigate');
  app.window.history.back();await settle();assert.match(panel.querySelector('summary').textContent,/Day 01/);
  const day=app.document.getElementById('travel-day-0');
  day.querySelector('[data-event-id="place-1"] .event-remove-button').click();
  assert.equal(panel.querySelector('.day-map-places').children.length,2);
  app.$('undo-button').click();assert.equal(panel.querySelector('.day-map-places').children.length,3);
});

test('map numbers follow manual place ordering, adding a catalog visit and restoring the saved note', async()=>{
  const fixture=timedNoteFixture(),app=runtime({...fixture,raw:savedNote(fixture.note),hash:'#/note'});await settle();
  const maps=leafletFixture();app.window.L=maps.L;const panel=openDayMap(app);
  for(let index=0;index<3;index++)app.$('day-list').querySelector('[data-event-id="place-2"] .event-move-button').click();
  const expected=JSON.parse(app.stored.get(storageKey)).itinerary.days[0].events.filter(event=>event.type==='place').map(event=>event.place.name);
  assert.deepEqual(panel.querySelectorAll('.day-map-place-copy strong').map(item=>item.textContent),expected.map((name,index)=>`${index+1}. ${name}`));
  assert.equal(currentSchedule(app).options.onAdd({type:'place',placeId:'d'}).ok,true);
  assert.equal(panel.querySelector('.day-map-places').children.length,4);
  const restored=runtime({...fixture,raw:app.stored.get(storageKey),hash:'#/note'});await settle();
  assert.equal(restored.$('day-map').querySelector('.day-map-places').children.length,4);
  assert.equal(restored.$('day-map').open,false);
});

test('tile errors and timeouts expose a usable list, retry is explicit, and hidden maps ignore obsolete tile events', async()=>{
  const fixture=timedNoteFixture(),app=runtime({...fixture,raw:savedNote(fixture.note),hash:'#/note'});await settle();
  const maps=leafletFixture();app.window.L=maps.L;const panel=openDayMap(app),status=panel.querySelector('.day-map-status');
  maps.tiles[0].emit('loading');app.clock.advance(15000);assert.match(status.textContent,/배경 지도를 불러오지 못한/);
  assert.equal(maps.tiles.length,1,'no automatic tile retry');maps.tiles[0].emit('load');assert.equal(status.textContent,'');
  maps.tiles[0].emit('tileerror');maps.tiles[0].emit('load');assert.match(status.textContent,/아래 장소 목록/);
  panel.querySelector('.day-map-actions').children[1].click();assert.equal(maps.maps[0].removed,true);assert.equal(maps.tiles.length,2);
  const retryStatus=status.textContent;maps.tiles[0].emit('tileerror');assert.equal(status.textContent,retryStatus);
  app.window.dispatch('resize');assert.ok(maps.maps[1].sizes.length>=2);
  await app.go('#/start');assert.equal(maps.maps[1].removed,true);const timers=app.clock.pending.size;maps.tiles[1].emit('loading');assert.equal(app.clock.pending.size,timers);
  await app.go('#/note');assert.equal(maps.maps.length,3);
  app.window.dispatch('beforeprint');assert.equal(maps.maps[2].removed,true);app.window.dispatch('afterprint');assert.equal(maps.maps.length,4);
  await app.clear();assert.equal(panel.hidden,true);assert.equal(panel.textContent.includes('추천 관광지'),false);
});

for(const failure of ['tileerror','timeout'])test(`map ${failure} status survives marker-only reorder and coincident-place removal until a new tile load or explicit retry`,async()=>{
  const fixture=timedNoteFixture(),app=runtime({...fixture,raw:savedNote(fixture.note),hash:'#/note'});await settle();
  const maps=leafletFixture();app.window.L=maps.L;
  const panel=openDayMap(app),status=panel.querySelector('.day-map-status'),retry=panel.querySelector('.day-map-actions').children[1];
  maps.tiles[0].emit('loading');
  if(failure==='tileerror'){maps.tiles[0].emit('tileerror');maps.tiles[0].emit('load');}
  else app.clock.advance(15000);
  const failureMessage=status.textContent;assert.match(failureMessage,/배경 지도를 불러오지 못한/);assert.equal(retry.hidden,false);
  const originalPoint=Array.from(maps.markers[0].point);
  for(let count=0;count<3;count++)app.$('day-list').querySelector('[data-event-id="place-2"] .event-move-button').click();
  assert.equal(status.textContent,failureMessage);assert.equal(retry.hidden,false);
  assert.equal(maps.maps.length,1);assert.equal(maps.tiles.length,1,'marker changes do not start a fresh tile layer');
  app.$('day-list').querySelector('[data-event-id="place-0"] .event-remove-button').click();
  assert.equal(panel.querySelector('.day-map-places').children.length,2);
  assert.deepEqual(Array.from(maps.groups[0].markers[0].point),originalPoint);
  assert.equal(status.textContent,failureMessage);assert.equal(retry.hidden,false);assert.equal(maps.tiles.length,1);
  // A real new loading cycle owns the next status update, even on the same map.
  maps.tiles[0].emit('loading');assert.match(status.textContent,/불러오는 중/);assert.equal(retry.hidden,true);
  maps.tiles[0].emit('tileerror');maps.tiles[0].emit('load');assert.equal(retry.hidden,false);
  retry.click();assert.equal(maps.maps[0].removed,true);assert.equal(maps.tiles.length,2);assert.equal(retry.hidden,true);
  const retryMessage=status.textContent;maps.tiles[0].emit('tileerror');maps.tiles[0].emit('load');
  assert.equal(status.textContent,retryMessage,'late callbacks from the retired tile layer stay ignored');
  maps.tiles[1].emit('loading');maps.tiles[1].emit('load');assert.equal(status.textContent,'');assert.equal(retry.hidden,true);
  panel.querySelector('.day-map-jump').click();await settle();
  assert.equal(app.document.activeElement,app.$('day-list').querySelector('[data-event-id="place-2"] .event-edit-button'));
});

test('missing map library does not break the itinerary and the list still focuses its event', async()=>{
  const fixture=timedNoteFixture(),app=runtime({...fixture,raw:savedNote(fixture.note),hash:'#/note',withAccount:true});await settle();
  const panel=openDayMap(app);assert.match(panel.querySelector('.day-map-status').textContent,/지도를 시작하지 못했어요/);
  panel.querySelectorAll('.day-map-jump')[1].click();await settle();
  assert.equal(app.document.activeElement,app.$('day-list').querySelector('[data-event-id="place-1"] .event-edit-button'));
  await app.account.options.onUserChange(undefined);assert.equal(panel.hidden,true);assert.equal(panel.querySelector('.day-map-places').children.length,0);
});

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
  assert.deepEqual(app.$('day-bookmarks-bottom').children.map(button => button.textContent), ['Day 01', 'Day 02']);
  const saved = app.stored.get(storageKey), writes = app.writes.length;
  first.querySelector('.day-collapse').click();
  assert.equal(first.querySelector('.day-card-body').hidden, true);
  assert.equal(first.querySelector('.day-collapse').getAttribute('aria-expanded'), 'false');
  assert.equal(app.stored.get(storageKey), saved); assert.equal(app.writes.length, writes);
  app.$('day-bookmarks').children[1].click(); await settle();
  manualMeal(app).options.onSave({ name: '둘째 날 식당', description: '' });
  first = app.$('day-list').children[0]; assert.equal(first.querySelector('.day-card-body').hidden, true);
  const beforeJump = app.writes.length;
  app.$('day-bookmarks').children[0].click(); await settle();
  assert.equal(first.querySelector('.day-card-body').hidden, false);
  assert.equal(app.document.activeElement, first); assert.equal(app.$('day-bookmarks').lastScrollIntoView.block, 'start');
  assert.equal(app.window.location.hash, '#/note/day/1'); assert.equal(app.writes.length, beforeJump);
  assert.equal(app.$('day-list').children[1].querySelector('.day-card-body').hidden, false);
  app.$('day-bookmarks').children[1].click(); await settle();
  const second=app.$('day-list').children[1];second.querySelector('.day-collapse').click();
  app.$('day-bookmarks-bottom').children[1].click(); await settle();
  assert.equal(second.querySelector('.day-card-body').hidden,false);
  assert.equal(app.document.activeElement,second);
  assert.equal(app.$('day-bookmarks').lastScrollIntoView.block,'start');
  assert.equal(app.writes.length,beforeJump);
  app.$('clear-button').click();
  assert.equal(app.$('day-bookmarks').children.length,0);
  assert.equal(app.$('day-bookmarks-bottom').children.length,0);
});

test('top and bottom day bookmarks show separate day pages while preserving every saved editing parameter', async () => {
  const app = runtime({ ...timedNoteFixture(3), withAccount: true }); await settle();
  app.$('day-count').value = '3'; await app.create();
  selectedDay(app, 0);
  const cards = [...app.$('day-list').children], raw = app.stored.get(storageKey), parameters = noteParameters(app);
  const writes = app.writes.length, changes = app.account.changes;
  for (const [id, index] of [['day-bookmarks-bottom', 1], ['day-bookmarks', 2], ['day-bookmarks-bottom', 0]]) {
    app.$(id).children[index].click(); await settle();
    screen(app, 'note'); selectedDay(app, index);
    assert.equal(app.window.location.hash, `#/note/day/${index + 1}`);
    assert.deepEqual(app.$('day-list').children, cards, 'day navigation preserves existing cards and widgets');
    assert.equal(cards[index].querySelector('.day-card-body').hidden, false);
    assert.equal(app.document.activeElement, cards[index]); assert.equal(app.$('day-bookmarks').lastScrollIntoView.block, 'start');
    assert.equal(app.$('day-bookmarks').lastScrollIntoView.behavior, 'instant');
    assert.equal(app.stored.get(storageKey), raw); assert.equal(app.writes.length, writes);
    assert.deepEqual(noteParameters(app), parameters); assert.equal(app.account.changes, changes);
    assert.equal(app.$('undo-button').disabled, true); assert.equal(app.$('redo-button').disabled, true);
  }
});

test('a direct day permalink waits for note restoration and opens the requested day without rewriting its draft', async () => {
  const fixture = timedNoteFixture(3), pending = deferred(), raw = JSON.stringify({ version: 8, itinerary: fixture.note });
  const app = runtime({ ...fixture, raw, hash: '#/note/day/2', destinationsPromise: pending.promise });
  screen(app, 'loading');
  assert.equal(app.window.location.hash, '#/note/day/2');
  pending.resolve([fixture.cityData]); await settle();
  screen(app, 'note'); selectedDay(app, 1);
  assert.equal(app.window.location.hash, '#/note/day/2');
  assert.equal(app.stored.get(storageKey), raw); assert.equal(app.writes.length, 0);
  const defaultPage = runtime({ ...fixture, raw, hash: '#/note' }); await settle();
  screen(defaultPage, 'note'); selectedDay(defaultPage, 0);
});

test('day permalinks clamp to available days and browser back and forward restore the visible day', async () => {
  const fixture = timedNoteFixture(2), raw = JSON.stringify({ version: 8, itinerary: fixture.note });
  const clamped = runtime({ ...fixture, raw, hash: '#/note/day/7' }); await settle();
  screen(clamped, 'note'); selectedDay(clamped, 1);
  assert.equal(clamped.stored.get(storageKey), raw); assert.equal(clamped.writes.length, 0);
  const app = runtime({ ...fixture, raw, hash: '#/note' }); await settle();
  await app.go('#/note/day/2'); selectedDay(app, 1);
  await app.go('#/note/day/1'); selectedDay(app, 0);
  app.window.history.back(); await settle();
  assert.equal(app.window.location.hash, '#/note/day/2'); selectedDay(app, 1);
  app.window.history.back(); await settle();
  assert.equal(app.window.location.hash, '#/note'); selectedDay(app, 0);
  app.window.history.forward(); await settle(); selectedDay(app, 1);
  assert.equal(app.stored.get(storageKey), raw); assert.equal(app.writes.length, 0);
});

test('a day permalink without a saved note redirects to setup after startup completes', async () => {
  const pending = deferred(), app = runtime({ hash: '#/note/day/2', destinationsPromise: pending.promise });
  screen(app, 'loading');
  pending.resolve([{ id: 'test-city' }]); await settle();
  screen(app, 'start'); assert.equal(app.window.location.hash, '#/start');
  assert.match(app.$('app-message').textContent, /먼저 여행 조건/);
  assert.equal(app.$('day-bookmarks').children.length, 0);
  assert.equal(app.$('day-bookmarks-bottom').children.length, 0);
  assert.equal(app.writes.length, 0);
});

test('loading or creating another note resets the current day without persisting day page presentation state', async () => {
  const app = runtime({ ...timedNoteFixture(2), withAccount: true }); await settle();
  app.$('day-count').value = '2'; await app.create();
  const saved = app.account.options.getDocument();
  app.$('day-bookmarks-bottom').children[1].click(); await settle(); selectedDay(app, 1);
  assert.equal(await app.account.options.loadDocument(saved), true); await settle(); selectedDay(app, 0);
  const document = app.account.options.getDocument();
  assert.equal(document.itinerary.activeDayIndex, undefined); assert.equal(document.itinerary.selectedDay, undefined);
  app.$('day-bookmarks').children[1].click(); await settle(); selectedDay(app, 1);
  await app.create(); selectedDay(app, 0);
});

test('top and bottom bookmarks keep an unfinished memo outside the committed itinerary and edit history', async () => {
  const app = runtime({ ...timedNoteFixture(3), withAccount: true }); await settle();
  app.$('day-count').value = '3'; await app.create();
  const cards = [...app.$('day-list').children], parameters = noteParameters(app), changes = app.account.changes;
  const visible = () => app.$('day-list').children.filter(day => !day.hidden).map(day => day.dataset.dayIndex);
  const current = id => app.$(id).children.filter(button => button.getAttribute('aria-current') === 'page').map(button => button.textContent);
  assert.deepEqual(visible(), ['0']);
  assert.equal(cards[0].querySelector('.day-index-label').textContent, 'Day 01');
  app.$('day-bookmarks').children[1].click();
  assert.deepEqual(visible(), ['1']);
  const row = cards[1].querySelector('[data-event-id="place-0"]'); row.querySelector('.event-edit-button').click();
  const memo = row.querySelector('textarea'); memo.value = '저장하기 전 둘째 날 메모'; memo.dispatch('input');
  const details = app.document.createElement('details'); details.open = true; cards[1].append(details);
  app.$('day-bookmarks-bottom').children[2].click();
  assert.deepEqual(visible(), ['2']); assert.equal(details.open, false);
  assert.deepEqual(current('day-bookmarks'), ['Day 03']); assert.deepEqual(current('day-bookmarks-bottom'), ['Day 03']);
  assert.equal(app.document.activeElement, cards[2]); assert.equal(app.$('day-bookmarks').lastScrollIntoView.behavior, 'instant');
  app.$('day-bookmarks-bottom').children[1].click();
  assert.deepEqual(visible(), ['1']); assert.equal(row.querySelector('textarea'), memo);
  assert.equal(memo.value, '저장하기 전 둘째 날 메모');
  assert.deepEqual(app.$('day-list').children, cards); assert.deepEqual(noteParameters(app), parameters);
  assert.equal(app.account.changes, changes); assert.equal(app.$('undo-button').disabled, true);
  assert.equal(JSON.parse(app.stored.get(storageKey)).editorDrafts['1:place-0'].description, memo.value);
  assert.equal(app.window.location.hash, '#/note/day/2');
});

test('the selected page and collapsed day remain selected through editing, undo and redo', async () => {
  const app = runtime({ ...timedNoteFixture(2), withAccount: true }); await settle();
  app.$('day-count').value = '2'; await app.create();
  app.$('day-bookmarks-bottom').children[1].click();
  const original = noteParameters(app);
  assert.equal(currentSchedule(app).options.onAdd({ type: 'free', title: '둘째 날 일정', duration: 30 }).ok, true);
  const edited = noteParameters(app);
  app.$('day-list').children[1].querySelector('.day-collapse').click();
  for (const [action, expected] of [['undo', original], ['redo', edited]]) {
    app.$(`${action}-button`).click();
    assert.deepEqual(noteParameters(app), expected);
    assert.deepEqual(app.$('day-list').children.map(day => day.hidden), [true, false]);
    assert.equal(app.$('day-list').children[1].querySelector('.day-card-body').hidden, true);
    assert.equal(app.$('day-bookmarks-bottom').children[1].getAttribute('aria-current'), 'page');
    assert.equal(app.account.options.getDocument().itinerary.activeDayIndex, undefined);
  }
});

test('page selection resets for a new or successfully loaded note and survives a failed load', async () => {
  const app = runtime({ ...timedNoteFixture(2), withAccount: true }); await settle();
  app.$('day-count').value = '2'; await app.create();
  const saved = app.account.options.getDocument();
  app.$('day-bookmarks').children[1].click();
  const invalid = { ...saved, itinerary: { ...saved.itinerary, dayAreaIds: [] } };
  assert.equal(await app.account.options.loadDocument(invalid), false);
  assert.deepEqual(app.$('day-list').children.map(day => day.hidden), [true, false]);
  assert.equal(await app.account.options.loadDocument(saved), true);
  assert.deepEqual(app.$('day-list').children.map(day => day.hidden), [false, true]);
  app.$('day-bookmarks-bottom').children[1].click(); await app.create();
  assert.deepEqual(app.$('day-list').children.map(day => day.hidden), [false, true]);
});

test('a seven-day trip retains every day while paging exposes exactly one at either end', async () => {
  const app = runtime({ ...timedNoteFixture(7), withAccount: true }); await settle();
  app.$('day-count').value = '7'; await app.create();
  assert.equal(app.$('day-list').children.length, 7);
  assert.equal(app.$('day-bookmarks').children.length, 7); assert.equal(app.$('day-bookmarks-bottom').children.length, 7);
  app.$('day-bookmarks-bottom').children[6].click();
  assert.deepEqual(app.$('day-list').children.filter(day => !day.hidden).map(day => day.dataset.dayIndex), ['6']);
  assert.equal(app.account.options.getDocument().itinerary.dayCount, 7);
  app.$('day-bookmarks').children[0].click();
  assert.deepEqual(app.$('day-list').children.filter(day => !day.hidden).map(day => day.dataset.dayIndex), ['0']);
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

test('memo counts update while the local editor draft stays separate from the committed note', async () => {
  const app = runtime({ ...actualPlannerFixture(), withAccount: true }); await settle(); await app.create();
  const parameters = noteParameters(app), changes = app.account.changes, row = app.$('day-list').querySelector('[data-event-id="place-0"]');
  row.querySelector('.event-edit-button').click();
  const memo = row.querySelector('textarea'), count = row.querySelector('.memo-counter');
  assert.equal(count.textContent, `${memo.value.length} / 500자`);
  memo.value = '한글 메모'; memo.dispatch('input'); assert.equal(count.textContent, '5 / 500자');
  assert.equal(memo.getAttribute('aria-describedby'), count.id); assert.deepEqual(noteParameters(app), parameters);
  assert.equal(app.account.changes, changes); assert.equal(app.$('undo-button').disabled, true);
  assert.equal(JSON.parse(app.stored.get(storageKey)).editorDrafts['0:place-0'].description, '한글 메모');
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

function dragGeometry(app,eventId='place-0',dayIndex=0){
  const card=app.$('day-list').children[dayIndex],timeline=card.querySelector('.timeline');
  const rows=timeline.querySelectorAll('.timeline-row').filter(row=>row.querySelector('.timeline-dot'));
  rows.forEach((row,index)=>{row.rect=()=>({left:0,right:600,top:100+index*100-app.window.scrollY,height:80});});
  const row=rows.find(row=>row.dataset.eventId===eventId),dot=row.querySelector('.timeline-dot');
  const pointer={pointerId:7,pointerType:'touch',button:0,isPrimary:true,clientX:20,clientY:row.getBoundingClientRect().top+40};
  return {card,timeline,rows,row,dot,pointer,
    start(){dot.dispatch('pointerdown',pointer);},
    move(y,x=20,id=7){dot.dispatch('pointermove',{...pointer,pointerId:id,clientY:y,clientX:x});},
    drop(y,x=20){dot.dispatch('pointerup',{...pointer,clientY:y,clientX:x});}
  };
}

for(const pointerType of ['mouse','touch','pen'])test(`${pointerType} dragging moves several slots with one save and one undo step`,async()=>{
  const app=runtime({...timedNoteFixture(2),withAccount:true});await settle();app.$('day-count').value='2';await app.create();
  const before=noteParameters(app),writes=app.writes.length,drag=dragGeometry(app);
  drag.pointer.pointerType=pointerType;drag.start();drag.move(645);
  assert.equal(drag.row.dataset.dragging,'true');assert.equal(drag.rows[6].dataset.drop,'before');
  assert.match(drag.timeline.querySelector('.timeline-drag-status').textContent,/6번째/);
  assert.equal(app.writes.length,writes);assert.deepEqual(noteParameters(app),before);
  drag.drop(645);
  const edited=noteParameters(app),ids=edited.eventOrders[0];
  assert.equal(ids.indexOf('place-0'),5);assert.equal(new Set(ids).size,ids.length);
  assert.equal(app.writes.length,writes+1);assert.deepEqual(edited.eventEdits[1],before.eventEdits[1]);
  assert.equal(app.document.activeElement.closest('.timeline-row').dataset.eventId,'place-0');
  assert.equal(app.$('day-list').querySelector('[data-event-id="place-0"]').dataset.moved,'true');
  // Ignore only the synthesized pointer click; a later deliberate tap still opens the panel.
  app.document.activeElement.dispatch('click',{detail:1});
  app.$('undo-button').click();assert.deepEqual(noteParameters(app),before);assert.equal(app.$('undo-button').disabled,true);
  assert.equal(app.$('day-list').querySelector('[data-event-id="place-0"]').dataset.moved,undefined);
  app.$('redo-button').click();assert.deepEqual(noteParameters(app),edited);
  assert.equal(app.$('day-list').querySelector('[data-event-id="place-0"]').dataset.moved,'true');
});

for(const reason of ['same position','outside','Escape','pointercancel','lostcapture','blur','day switch','rerender'])test(`drag cancellation: ${reason} leaves order, storage and history intact`,async()=>{
  const app=runtime({...timedNoteFixture(2),withAccount:true});await settle();app.$('day-count').value='2';await app.create();
  const original=noteParameters(app),writes=app.writes.length,drag=dragGeometry(app);drag.start();drag.move(645);
  if(reason==='same position')drag.drop(140);
  else if(reason==='outside')drag.drop(645,900);
  else if(reason==='Escape')app.document.dispatch('keydown',drag.dot,{key:'Escape'});
  else if(reason==='pointercancel')drag.dot.dispatch('pointercancel',{pointerId:7});
  else if(reason==='lostcapture')drag.dot.dispatch('lostpointercapture',{pointerId:7});
  else if(reason==='blur')app.window.dispatch('blur',{});
  else if(reason==='day switch')await app.go('#/note/day/2');
  else await app.account.options.loadDocument(app.account.options.getDocument());
  drag.drop(645);app.clock.advance(1000);
  assert.deepEqual(noteParameters(app),original);assert.equal(app.$('undo-button').disabled,true);
  if(reason!=='rerender')assert.equal(app.writes.length,writes);
  assert.equal(drag.row.dataset.dragging,undefined);assert.equal(drag.timeline.querySelectorAll('[data-drop="after"]').length,0);
});

test('short taps, non-primary pointers and unrelated pointers do not reorder; edge dragging scrolls and cleans up',async()=>{
  const app=runtime(actualPlannerFixture());await settle();await app.create();
  const writes=app.writes.length,drag=dragGeometry(app);
  drag.start();drag.move(drag.pointer.clientY+3);drag.drop(drag.pointer.clientY+3);drag.dot.click();
  assert.equal(drag.row.querySelector('.timeline-move-controls').hidden,false);assert.equal(app.writes.length,writes);
  drag.dot.dispatch('pointerdown',{...drag.pointer,isPrimary:false});drag.move(650);drag.drop(650);
  assert.equal(app.writes.length,writes);
  drag.start();drag.move(760,20,99);assert.equal(drag.row.dataset.dragging,undefined);
  drag.move(760);app.clock.advance(64);assert.ok(app.window.scrollY>0);assert.equal(app.writes.length,writes);
  drag.dot.dispatch('pointercancel',{pointerId:7});const scrolls=app.scrolls.length;
  app.clock.advance(1000);assert.equal(app.scrolls.length,scrolls);assert.equal(app.writes.length,writes);
});

test('a failed drag save preserves the original note, pending markers and undo history',async()=>{
  const storageError={},app=runtime({...actualPlannerFixture(),withAccount:true,storageError});await settle();await app.create();
  const before=app.stored.get(storageKey),drag=dragGeometry(app);storageError.set=true;
  drag.start();drag.move(645);drag.drop(645);
  assert.equal(app.stored.get(storageKey),before);assert.equal(app.$('undo-button').disabled,true);
  assert.equal(app.$('day-list').querySelector('[data-event-id="place-0"]').dataset.moved,undefined);
  assert.match(app.$('app-message').textContent,/저장하지 못했어요/);
});

test('dragging to either end never crosses departure or finish and preserves an added event',async()=>{
  const app=runtime({...actualPlannerFixture(),withAccount:true});await settle();await app.create();
  const added=currentSchedule(app).options.onAdd({type:'free',title:'예약 확인',duration:10});assert.equal(added.ok,true);
  const id=JSON.parse(app.stored.get(storageKey)).itinerary.extraEvents[0][0].id;
  let drag=dragGeometry(app,id);drag.start();drag.move(30);drag.drop(30);
  let ids=JSON.parse(app.stored.get(storageKey)).itinerary.days[0].events.map(event=>event.id);
  assert.deepEqual(ids.slice(0,2),['departure',id]);assert.equal(ids.at(-1),'finish');
  drag=dragGeometry(app,id);drag.start();drag.move(1800);drag.drop(1800);
  ids=JSON.parse(app.stored.get(storageKey)).itinerary.days[0].events.map(event=>event.id);
  assert.equal(ids.at(-2),id);assert.equal(ids.at(-1),'finish');assert.equal(new Set(ids).size,ids.length);
});

test('real account save failures retain highlights and a successful response clears only its saved order',async()=>{
  let request=null;
  const reply=(data,status=200)=>({ok:status===200,status,json:async()=>data});
  const app=runtime({...actualPlannerFixture(),withAccount:true,accountHandler:async(path,options)=>{
    if(path==='/api/auth/session')return reply({configured:true,user:{id:'owner-a',username:'alice'}});
    if(path==='/api/plans'&&options.method==='GET')return reply({plans:[]});
    if(path==='/api/plans'&&options.method==='POST'){request=deferred();return request.promise;}
    throw Error('Unexpected request '+path);
  }});await app.account.controller.ready;await settle();await app.create();
  const row=()=>app.$('day-list').querySelector('[data-event-id="place-0"]');
  const move=()=>row().querySelectorAll('.event-move-button')[1].click();
  const save=()=>{app.$('account-save').querySelector('button').click();app.document.querySelector('.account-dialog form').dispatch('submit');};
  move();save();request.resolve(reply({error:{code:'NETWORK_ERROR'}},500));await settle();
  assert.equal(row().dataset.moved,'true');
  app.document.querySelector('.account-dialog form').dispatch('submit');move();
  request.resolve(reply({plan:{id:'plan-one',title:'내 계획',cityId:'test-city',startDate:'2026-10-20',dayCount:1,revision:1,
    createdAt:'2026-10-20T00:00:00Z',updatedAt:'2026-10-20T00:00:00Z'}}));await settle();
  assert.equal(row().dataset.moved,'true');assert.match(app.$('account-save').textContent,/저장하지 않은 수정/);
  app.account.options.onSaved(app.account.options.getDocument());assert.equal(row().dataset.moved,undefined);
  app.account.controller.destroy();
});

test('moved highlights survive redraw and local reload, compare against the saved snapshot, and reset for another note',async()=>{
  const app=runtime({...actualPlannerFixture(),withAccount:true});await settle();await app.create();
  const row=()=>app.$('day-list').querySelector('[data-event-id="place-0"]');
  row().querySelectorAll('.event-move-button')[1].click();
  assert.equal(row().dataset.moved,'true');assert.match(row().querySelector('.event-moved-status').textContent,/계정 저장 전/);
  const saved=app.account.options.getDocument();
  row().querySelectorAll('.event-move-button')[1].click();
  app.account.options.onSaved(saved);assert.equal(row().dataset.moved,'true','an older response must not clear a later move');
  const reloaded=runtime({...actualPlannerFixture(),withAccount:true,raw:app.stored.get(storageKey),hash:'#/note'});await settle();
  assert.equal(reloaded.$('day-list').querySelector('[data-event-id="place-0"]').dataset.moved,'true');
  const savedNow=app.account.options.getDocument();app.account.options.onSaved(savedNow);
  assert.equal(row().dataset.moved,undefined);assert.equal(row().querySelector('.event-moved-status'),null);
  app.$('undo-button').click();assert.equal(row().dataset.moved,'true');
  app.$('redo-button').click();assert.equal(row().dataset.moved,undefined);
  row().querySelectorAll('.event-move-button')[1].click();
  assert.equal(await app.account.options.loadDocument(savedNow),true);
  assert.equal(row().dataset.moved,undefined);
  await app.create();assert.equal(row().dataset.moved,undefined);
  assert.equal(app.account.options.getDocument().itinerary.pendingReorders,undefined);
});

for(const saved of [false,true])for(const title of ['새 자유 일정','원래 자유 일정'])test(`recreated extra does not inherit moved identity (saved=${saved}, title=${title}) through history and reload`,async()=>{
  const app=runtime({...actualPlannerFixture(),withAccount:true});await settle();await app.create();
  const row=(runtime,id)=>runtime.$('day-list').querySelector(`[data-event-id="${id}"]`);
  const extraIds=runtime=>(JSON.parse(runtime.stored.get(storageKey)).itinerary.extraEvents[0]||[]).map(event=>event.id);
  currentSchedule(app).options.onAdd({type:'free',title:'원래 자유 일정',duration:20});
  const originalId=extraIds(app)[0];row(app,originalId).querySelectorAll('.event-move-button')[0].click();
  assert.equal(row(app,originalId).dataset.moved,'true');
  if(saved)app.account.options.onSaved(app.account.options.getDocument());
  row(app,originalId).querySelector('.event-remove-button').click();
  const deletedRaw=app.stored.get(storageKey);
  currentSchedule(app).options.onAdd({type:'free',title,duration:20});
  const newId=extraIds(app)[0];assert.equal(row(app,newId).dataset.moved,undefined);
  app.$('undo-button').click();assert.equal(extraIds(app).length,0);
  app.$('undo-button').click();assert.equal(row(app,originalId).dataset.moved,saved?undefined:'true');
  assert.equal(row(app,originalId).querySelector('.event-title').textContent,'원래 자유 일정');
  app.$('redo-button').click();assert.equal(extraIds(app).length,0);
  app.$('redo-button').click();assert.equal(row(app,newId).dataset.moved,undefined);
  const reload=runtime({...actualPlannerFixture(),withAccount:true,raw:app.stored.get(storageKey),hash:'#/note'});await settle();
  assert.equal(row(reload,newId).dataset.moved,undefined);
  const deletedReload=runtime({...actualPlannerFixture(),withAccount:true,raw:deletedRaw,hash:'#/note'});await settle();
  currentSchedule(deletedReload).options.onAdd({type:'free',title,duration:20});
  assert.equal(row(deletedReload,extraIds(deletedReload)[0]).dataset.moved,undefined);
});

for(const key of ['Enter',' '])test(`first ${key===' '?'Space':key} activation opens the menu after Escape cancels a drag`,async()=>{
  const app=runtime({...actualPlannerFixture(),withAccount:true});await settle();await app.create();
  const drag=dragGeometry(app);drag.pointer.pointerType='mouse';
  const host=drag.dot.closest('.timeline-reorder'),menu=drag.row.querySelector('.timeline-move-controls');
  host.dispatch('pointerenter',{pointerType:'mouse'});drag.dot.focus();assert.equal(menu.hidden,false);
  drag.start();drag.move(645);assert.equal(menu.hidden,true);
  app.document.dispatch('keydown',drag.dot,{key:'Escape'});drag.drop(645);
  drag.dot.dispatch('click',{detail:1});assert.equal(menu.hidden,true,'the synthesized pointer click stays blocked');
  drag.dot.dispatch('keydown',{key});drag.dot.dispatch('click',{detail:0});
  assert.equal(menu.hidden,false,'the first keyboard activation must open the menu');
  assert.equal(app.document.activeElement,drag.dot);assert.equal(app.$('undo-button').disabled,true);
});

test('real account save then deletion cannot transfer moved highlights to a favorite added as a new event',async()=>{
  const reply=data=>({ok:true,status:200,json:async()=>data});
  const app=runtime({...actualPlannerFixture(),withAccount:true,accountHandler:async(path,options)=>{
    if(path==='/api/auth/session')return reply({configured:true,user:{id:'owner-a',username:'alice'}});
    if(path==='/api/plans'&&options.method==='GET')return reply({plans:[]});
    if(path==='/api/plans'&&options.method==='POST')return reply({plan:{id:'plan-one',title:'내 계획',cityId:'test-city',startDate:'2026-10-20',dayCount:1,revision:1,
      createdAt:'2026-10-20T00:00:00Z',updatedAt:'2026-10-20T00:00:00Z'}});
    throw Error('Unexpected request '+path);
  }});await app.account.controller.ready;await settle();await app.create();
  const row=id=>app.$('day-list').querySelector(`[data-event-id="${id}"]`);
  currentSchedule(app).options.onAdd({type:'free',title:'원래 일정',duration:20});
  row('extra-1').querySelectorAll('.event-move-button')[0].click();assert.equal(row('extra-1').dataset.moved,'true');
  app.$('account-save').querySelector('button').click();app.document.querySelector('.account-dialog form').dispatch('submit');await settle();
  assert.match(app.$('account-save').textContent,/계정에 저장했어요/);assert.equal(row('extra-1').dataset.moved,undefined);
  row('extra-1').querySelector('.event-remove-button').click();
  const personal=app.$('personal-tools'),search=personal.querySelector('.personal-place-search-label input');
  search.value='추천 관광지 d';search.dispatch('input');personal.querySelector('.personal-place-results button').click();
  personal.querySelector('.personal-favorite-list button').click();
  assert.ok(row('extra-2'));assert.equal(row('extra-2').dataset.moved,undefined);assert.equal(row('extra-1'),null);
  app.account.controller.destroy();
});

test('an unmoved deleted extra restored from undo keeps its identity after a replacement is moved',async()=>{
  const app=runtime({...actualPlannerFixture(),withAccount:true});await settle();await app.create();
  const row=id=>app.$('day-list').querySelector(`[data-event-id="${id}"]`);
  currentSchedule(app).options.onAdd({type:'free',title:'원래 일정',duration:20,beforeId:'place-0'});
  row('extra-1').querySelector('.event-remove-button').click();
  currentSchedule(app).options.onAdd({type:'free',title:'새 일정',duration:20});
  row('extra-2').querySelectorAll('.event-move-button')[0].click();
  app.$('undo-button').click();app.$('undo-button').click();app.$('undo-button').click();
  assert.equal(row('extra-1').querySelector('.event-title').textContent,'원래 일정');assert.equal(row('extra-1').dataset.moved,undefined);
  assert.equal(row('extra-2'),null);
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


test('pending transfer links switch to a collapsed later day, focus its input and scroll to the row without changing data', async () => {
  const fixture = timedNoteFixture(3);
  const pending = fixture.planner.updateEvent({ city: fixture.cityData, itinerary: fixture.note, dayIndex: 2, eventId: 'transfer-1', duration: 0 });
  assert.equal(pending.ok, true);
  const app = runtime({ ...fixture, raw: savedNote(pending.itinerary), hash: '#/note', withAccount: true }); await settle();
  const panel = app.$('pending-transfers'), day = app.document.getElementById('travel-day-2');
  assert.equal(panel.hidden, false); assert.match(panel.querySelector('summary').textContent, /1구간/);
  assert.match(panel.querySelector('button').textContent, /Day 03.*이동시간 미정/);
  day.querySelector('.day-collapse').click();
  const before = app.stored.get(storageKey), writes = app.writes.length, changes = app.account.changes;
  panel.querySelector('button').click(); await settle();
  const row = day.querySelector('[data-event-id="transfer-1"]');
  assert.equal(app.window.location.hash, '#/note/day/3'); assert.equal(day.hidden, false);
  assert.equal(day.querySelector('.day-card-body').hidden, false);
  assert.equal(app.document.activeElement, row.querySelector('.event-edit-button'));
  assert.equal(row.lastScrollIntoView.block, 'center');
  assert.equal(app.stored.get(storageKey), before); assert.equal(app.writes.length, writes); assert.equal(app.account.changes, changes);
  await app.clear(); assert.equal(panel.hidden, true); assert.equal(panel.textContent, '');
});

test('pending links distinguish missing departure and arrival fields and recompute after saves, undo, redo and reload', async () => {
  const app = runtime({ ...actualPlannerFixture(), withAccount: true }); await settle(); await app.create();
  const panel = app.$('pending-transfers');
  assert.match(panel.querySelector('summary').textContent, /3구간/);
  panel.querySelector('button').click(); await settle();
  assert.equal(app.document.activeElement, app.document.getElementById('day-origin-0').querySelector('summary'));
  editEntry(app, 'transfer-0', { duration: 25 }); assert.match(panel.querySelector('summary').textContent, /2구간/);
  app.$('undo-button').click(); assert.match(panel.querySelector('summary').textContent, /3구간/);
  app.$('redo-button').click(); assert.match(panel.querySelector('summary').textContent, /2구간/);
  const reloaded = runtime({ ...actualPlannerFixture(), raw: app.stored.get(storageKey), hash: '#/note' }); await settle();
  assert.match(reloaded.$('pending-transfers').querySelector('summary').textContent, /2구간/);
  const fixture = transitPreviewFixture({ arrival: true, duration: 90 });
  const noArrival = fixture.planner.setDayArrival({ city: fixture.cityData, itinerary: fixture.note, dayIndex: 0, arrival: null });
  assert.equal(noArrival.ok, true);
  const arrivalApp = runtime({ ...fixture, raw: savedNote(noArrival.itinerary), hash: '#/note' }); await settle();
  const arrivalLink = arrivalApp.$('pending-transfers').querySelector('button'); assert.match(arrivalLink.textContent, /도착지 미정/);
  arrivalLink.click(); await settle();
  assert.equal(arrivalApp.document.activeElement, arrivalApp.document.getElementById('day-arrival-0').querySelector('summary'));
});

test('pending moves include added transfers and remain pending during unsaved transit previews', async () => {
  const fixture = transitPreviewFixture({ arrival: true, duration: 90 }), app = previewRuntime(fixture); await settle();
  const panel = app.$('pending-transfers'), before = panel.textContent;
  previewMount(app, 'local-transfer', 'arrival-transfer').options.onPreviewTransitDuration(53);
  assert.equal(panel.textContent, before);
  assert.match(panel.querySelector('summary').textContent, /1구간/);
  const added = currentSchedule(app).options.onAdd({ type: 'transfer', title: '숙소로 이동', duration: 0 });
  assert.equal(added.ok, true); assert.match(panel.querySelector('summary').textContent, /2구간/);
  app.$('day-list').querySelector('[data-event-id="extra-1"]').querySelector('.event-remove-button').click();
  assert.match(panel.querySelector('summary').textContent, /1구간/);
  editEntry(app, 'arrival-transfer', { duration: 18 });
  assert.match(panel.querySelector('summary').textContent, /미정 이동 구간 없음/);
  await app.account.options.onUserChange(undefined);
  assert.equal(panel.hidden, true); assert.equal(panel.textContent, '');
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

function transitPreviewFixture({ dayCount = 1, arrival = false, startTime = '09:00', duration = 0 } = {}) {
  const fixture = timedNoteFixture(dayCount), base = fixture.note;
  const dayDepartures = Object.fromEntries(Object.entries(base.dayDepartures).map(([key, point]) => [key, {
    ...point, mode: arrival ? 'train' : 'local-bus'
  }]));
  const dayArrivals = arrival ? { 0: {
    ...dayDepartures[0], id: 'osm-node-2', name: '서울역', address: '서울특별시 용산구 한강대로',
    latitude: 37.5547, longitude: 126.9707, sourceUrl: 'https://www.openstreetmap.org/node/2'
  } } : {};
  const eventEdits = JSON.parse(JSON.stringify(base.eventEdits));
  eventEdits[0].departure.duration = duration;
  if (arrival) eventEdits[0]['arrival-transfer'] = { duration: 0 };
  const note = fixture.planner.createItinerary({ city: fixture.cityData, startDate: base.startDate,
    dayCount, dayAreaIds: base.dayAreaIds, selections: base.selections,
    dayDepartures, dayArrivals, eventEdits, dayStarts: { 0: startTime } });
  assert.equal(note.ok, true, note.reason);
  return { ...fixture, note };
}
function previewRow(app, eventId, dayIndex = 0) {
  return app.$('day-list').querySelector(`[data-day-index="${dayIndex}"]`).querySelector(`[data-event-id="${eventId}"]`);
}
function previewClock(app, eventId, dayIndex = 0) {
  const labels = previewRow(app, eventId, dayIndex).querySelector('.timeline-time-labels');
  assert.ok(labels, 'timeline times have their own wrapper without replacing reorder controls');
  return labels.textContent.replace(/<\/small>/g, ' ').replace(/<[^>]*>/g, '');
}
function previewMount(app, kind, eventId, dayIndex = 0) {
  const record = app.mounts.findLast(item => item.kind === kind && !item.destroyed
    && item.host.closest('.timeline-row')?.dataset.eventId === eventId
    && item.host.closest('.day-card')?.dataset.dayIndex === String(dayIndex));
  assert.ok(record, `${kind} lookup mounted for day ${dayIndex}, event ${eventId}`);
  return record;
}
function previewRuntime(fixture) {
  return runtime({ ...fixture, withAccount: true, hash: '#/note',
    raw: JSON.stringify({ version: 8, itinerary: fixture.note }) });
}

for(const kind of ['checklist','favorite','tag'])test(`personal ${kind} saves preserve transit preview replacement, clearing and later queries without rebuilding the note`,async()=>{
  for(const alreadyPreviewed of [false,true]){
    const app=previewRuntime(transitPreviewFixture({duration:30}));await settle();
    const lookup=previewMount(app,'transit','departure'),day=app.$('day-list').children[0];
    previewRow(app,'lunch').querySelector('.event-edit-button').click();
    const memo=previewRow(app,'lunch').querySelector('textarea');memo.value='입력 중 메모 유지';
    if(alreadyPreviewed){lookup.options.onPreviewDuration(53);assert.match(previewClock(app,'place-0'),/09:53/);}
    if(kind==='checklist')addPersonalItem(app,'휴대용 충전기');
    else if(kind==='favorite')previewRow(app,'place-0').querySelector('.event-favorite-button').click();
    else{const select=previewRow(app,'place-0').querySelector('.event-tag-select');select.value='must';select.dispatch('change');}
    assert.equal(app.$('day-list').children[0],day);assert.equal(lookup.destroyed,false);assert.equal(memo.value,'입력 중 메모 유지');
    const raw=app.stored.get(storageKey),writes=app.writes.length,changes=app.account.changes;
    lookup.options.onPreviewDuration(70);assert.match(previewClock(app,'place-0'),/10:10/);
    lookup.options.onPreviewDuration(null);assert.match(previewClock(app,'place-0'),/09:30/);
    lookup.options.onPreviewDuration(80);assert.match(previewClock(app,'place-0'),/10:20/);
    assert.equal(app.stored.get(storageKey),raw);assert.equal(app.writes.length,writes);assert.equal(app.account.changes,changes);
    assert.equal(JSON.parse(raw).itinerary.eventEdits[0].departure.duration,30);
    await app.account.options.onUserChange(undefined);
    lookup.options.onPreviewDuration(90);lookup.options.onPreviewDuration(null);
    assert.equal(app.$('day-list').children.length,0,'former account callbacks remain invalid');
  }
});

test('a live arrival transfer moves the first visit from a 09:00 station arrival to 09:53 without saving API values', async () => {
  const fixture = transitPreviewFixture({ arrival: true, startTime: '07:30', duration: 90 });
  const app = previewRuntime(fixture); await settle();
  const lookup = previewMount(app, 'local-transfer', 'arrival-transfer');
  assert.equal(lookup.options.origin.name, '서울역');
  assert.equal(lookup.options.destination.id, fixture.note.days[0].events.find(event => event.type === 'place').place.id);
  const raw = app.stored.get(storageKey), parameters = noteParameters(app), writes = app.writes.length;
  const changes = app.account.changes, undo = app.$('undo-button').disabled, redo = app.$('redo-button').disabled;
  const day = app.$('day-list').children[0], footnote = day.querySelector('.day-footnote'), originalFootnote = footnote.textContent;
  assert.match(previewClock(app, 'arrival'), /09:00/);
  lookup.options.onPreviewTransitDuration(53);
  assert.match(previewClock(app, 'arrival'), /09:00/);
  assert.match(previewClock(app, 'arrival-transfer'), /09:00.*09:53/);
  assert.match(previewClock(app, 'place-0'), /09:53/);
  assert.match(previewRow(app, 'arrival-transfer').querySelector('.event-duration').textContent, /53분/);
  assert.match(footnote.textContent, /미리보기/);
  assert.match(footnote.textContent, new RegExp(fixture.planner.formatTime(fixture.note.days[0].end + 53)));
  assert.equal(app.$('day-list').children[0], day, 'live projection keeps the queried widget mounted');
  assert.equal(app.stored.get(storageKey), raw); assert.equal(app.writes.length, writes);
  assert.deepEqual(noteParameters(app), parameters); assert.equal(app.account.changes, changes);
  assert.equal(app.$('undo-button').disabled, undo); assert.equal(app.$('redo-button').disabled, redo);
  lookup.options.onPreviewTransitDuration(null);
  assert.match(previewClock(app, 'place-0'), /09:00/);
  assert.equal(footnote.textContent, originalFootnote);
});

test('departure route changes replace the original duration and preserve working reorder controls', async () => {
  const fixture = transitPreviewFixture({ duration: 30 }), app = previewRuntime(fixture); await settle();
  const lookup = previewMount(app, 'transit', 'departure');
  const row = previewRow(app, 'place-0'), reorder = row.querySelector('.timeline-dot');
  const originalFootnote = app.$('day-list').children[0].querySelector('.day-footnote').textContent;
  assert.match(previewClock(app, 'place-0'), /09:30/);
  lookup.options.onPreviewDuration(53); assert.match(previewClock(app, 'place-0'), /09:53/);
  lookup.options.onPreviewDuration(40); assert.match(previewClock(app, 'place-0'), /09:40/);
  assert.equal(previewRow(app, 'place-0'), row); assert.equal(row.querySelector('.timeline-dot'), reorder);
  reorder.click(); assert.equal(row.querySelector('.timeline-move-controls').hidden, false);
  lookup.options.onPreviewDuration(null); assert.match(previewClock(app, 'place-0'), /09:30/);
  assert.equal(app.$('day-list').children[0].querySelector('.day-footnote').textContent, originalFootnote);
});

test('simultaneous live transit durations compose per day and clearing one keeps the remaining preview', async () => {
  const fixture = transitPreviewFixture({ dayCount: 2 }), app = previewRuntime(fixture); await settle();
  const departure = previewMount(app, 'transit', 'departure');
  const transfer = previewMount(app, 'local-transfer', 'transfer-0');
  const untouchedDay = app.$('day-list').children[1].textContent;
  departure.options.onPreviewDuration(53); transfer.options.onPreviewTransitDuration(40);
  assert.match(previewClock(app, 'place-0'), /09:53/);
  const originalSecond = fixture.note.days[0].events.find(event => event.id === 'place-1').start;
  assert.match(previewClock(app, 'place-1'), new RegExp(fixture.planner.formatTime(originalSecond + 53 + 20)));
  departure.options.onPreviewDuration(null);
  assert.match(previewClock(app, 'place-0'), /09:00/);
  assert.match(previewClock(app, 'place-1'), new RegExp(fixture.planner.formatTime(originalSecond + 20)));
  assert.equal(app.$('day-list').children[1].textContent, untouchedDay);
  transfer.options.onPreviewTransitDuration(null);
  assert.match(previewClock(app, 'place-1'), new RegExp(fixture.planner.formatTime(originalSecond)));
});

test('manual editing keeps canonical time and a later saved edit invalidates live callbacks without adding a history step', async () => {
  const fixture = transitPreviewFixture({ duration: 30 }), app = previewRuntime(fixture); await settle();
  const lookup = previewMount(app, 'transit', 'departure'), canonical = noteParameters(app);
  lookup.options.onPreviewDuration(53);
  previewRow(app, 'departure').querySelector('.event-edit-button').click();
  const editor = previewRow(app, 'departure').querySelector('.event-editor');
  const minuteInput = editor.querySelectorAll('input').find(input => /분$/.test(input.getAttribute('aria-label') || ''));
  assert.equal(minuteInput.value, '30', 'the API preview never prepopulates persisted duration fields');
  editor.querySelector('textarea').value = '직접 남긴 메모'; editor.dispatch('submit');
  const saved = JSON.parse(app.stored.get(storageKey)).itinerary;
  assert.equal(saved.eventEdits[0].departure.duration, 30);
  assert.match(previewClock(app, 'place-0'), /09:30/);
  lookup.options.onPreviewDuration(90); assert.match(previewClock(app, 'place-0'), /09:30/);
  app.$('undo-button').click(); assert.deepEqual(noteParameters(app), canonical);
  assert.equal(app.$('undo-button').disabled, true, 'only the manual memo edit created an undo step');
});

test('leaving the note clears its live transit preview and closes the lookup without changing saved times', async () => {
  const fixture = transitPreviewFixture(), app = previewRuntime(fixture); await settle();
  const lookup = previewMount(app, 'transit', 'departure'), raw = app.stored.get(storageKey);
  const details = lookup.host.querySelector('.transit-route-lookup'); details.open = true;
  lookup.options.onPreviewDuration(53); assert.match(previewClock(app, 'place-0'), /09:53/);
  await app.go('#/start'); lookup.options.onPreviewDuration(90);
  assert.equal(details.open, false);
  await app.go('#/note');
  assert.match(previewClock(app, 'place-0'), /09:00/);
  assert.doesNotMatch(app.$('day-list').children[0].querySelector('.day-footnote').textContent, /미리보기/);
  assert.equal(app.stored.get(storageKey), raw);
});

test('collapsing a day closes its lookup and clears its live preview while hidden dates ignore route callbacks', async () => {
  const fixture=transitPreviewFixture({dayCount:2}),app=previewRuntime(fixture);await settle();
  const first=app.$('day-list').children[0],lookup=previewMount(app,'transit','departure');
  const other=previewMount(app,'transit','departure',1),raw=app.stored.get(storageKey);
  const details=lookup.host.querySelector('.transit-route-lookup');details.open=true;
  const otherClock=previewClock(app,'place-0',1);
  lookup.options.onPreviewDuration(53);other.options.onPreviewDuration(40);
  assert.equal(previewClock(app,'place-0',1),otherClock);
  first.querySelector('.day-collapse').click();
  assert.equal(details.open,false);assert.equal(first.querySelector('.day-card-body').hidden,true);
  assert.match(previewClock(app,'place-0'),/09:00/);
  assert.equal(previewClock(app,'place-0',1),otherClock);
  app.$('day-bookmarks-bottom').children[0].click();await settle();
  assert.equal(first.querySelector('.day-card-body').hidden,false);
  assert.equal(app.document.activeElement,first);assert.equal(details.open,false);
  assert.equal(app.stored.get(storageKey),raw);
});

test('switching day pages clears the old live preview and permits route projection only on the visible date', async () => {
  const fixture = transitPreviewFixture({ dayCount: 2 }), app = previewRuntime(fixture); await settle();
  const first = previewMount(app, 'transit', 'departure'), second = previewMount(app, 'transit', 'departure', 1);
  const details = first.host.querySelector('.transit-route-lookup'); details.open = true;
  const raw = app.stored.get(storageKey), writes = app.writes.length, parameters = noteParameters(app);
  const secondOriginal = previewClock(app, 'place-0', 1);
  first.options.onPreviewDuration(53); second.options.onPreviewDuration(40);
  assert.match(previewClock(app, 'place-0'), /09:53/);
  assert.equal(previewClock(app, 'place-0', 1), secondOriginal);
  app.$('day-bookmarks-bottom').children[1].click(); await settle(); selectedDay(app, 1);
  assert.equal(details.open, false); assert.match(previewClock(app, 'place-0'), /09:00/);
  first.options.onPreviewDuration(90); assert.match(previewClock(app, 'place-0'), /09:00/);
  second.options.onPreviewDuration(40); assert.match(previewClock(app, 'place-0', 1), /09:40/);
  app.$('day-bookmarks').children[0].click(); await settle(); selectedDay(app, 0);
  assert.equal(previewClock(app, 'place-0', 1), secondOriginal);
  assert.equal(app.stored.get(storageKey), raw); assert.equal(app.writes.length, writes);
  assert.deepEqual(noteParameters(app), parameters);
});

test('bookmark and browser-history navigation preserve a local editor draft while clearing outgoing transit previews', async () => {
  const app = previewRuntime(transitPreviewFixture({ dayCount: 2 })); await settle();
  const cards = [...app.$('day-list').children];
  const parameters = noteParameters(app), changes = app.account.changes;
  const row = previewRow(app, 'place-0'); row.querySelector('.event-edit-button').click();
  const memo = row.querySelector('textarea'); memo.value = '날짜를 오가며 작성 중인 메모'; memo.dispatch('input');
  const first = previewMount(app, 'transit', 'departure'), second = previewMount(app, 'transit', 'departure', 1);
  const firstDetails = first.host.querySelector('.transit-route-lookup'), secondDetails = second.host.querySelector('.transit-route-lookup');
  const firstOriginal = previewClock(app, 'place-0'), secondOriginal = previewClock(app, 'place-0', 1);
  firstDetails.open = true; first.options.onPreviewDuration(53);
  assert.match(previewClock(app, 'place-0'), /09:53/);
  app.$('day-bookmarks-bottom').children[1].click(); await settle(); selectedDay(app, 1);
  assert.equal(app.window.location.hash, '#/note/day/2'); assert.equal(firstDetails.open, false);
  secondDetails.open = true; second.options.onPreviewDuration(40);
  assert.match(previewClock(app, 'place-0', 1), /09:40/);
  app.window.history.back(); await settle(); selectedDay(app, 0);
  assert.equal(secondDetails.open, false); assert.equal(previewClock(app, 'place-0'), firstOriginal);
  assert.equal(previewClock(app, 'place-0', 1), secondOriginal);
  second.options.onPreviewDuration(90); assert.equal(previewClock(app, 'place-0', 1), secondOriginal);
  assert.equal(row.querySelector('textarea'), memo); assert.equal(memo.value, '날짜를 오가며 작성 중인 메모');
  app.window.history.forward(); await settle(); selectedDay(app, 1);
  assert.equal(app.window.location.hash, '#/note/day/2');
  assert.equal(app.$('day-bookmarks').lastScrollIntoView.behavior, 'instant');
  assert.deepEqual(app.$('day-list').children, cards); assert.deepEqual(noteParameters(app), parameters);
  assert.equal(app.account.changes, changes); assert.equal(app.$('undo-button').disabled, true);
  const draft = JSON.parse(app.stored.get(storageKey));
  assert.equal(draft.editorDrafts['0:place-0'].description, memo.value);
  assert.equal(draft.itinerary.eventEdits[0].departure.duration, 0, 'a live route duration never enters the stored itinerary');
});

test('browser printing restores canonical times and closes the active transit lookup', async () => {
  const fixture = transitPreviewFixture({ duration: 30 }), app = previewRuntime(fixture); await settle();
  const lookup = previewMount(app, 'transit', 'departure'), raw = app.stored.get(storageKey);
  const details = lookup.host.querySelector('.transit-route-lookup'); details.open = true;
  lookup.options.onPreviewDuration(53); assert.match(previewClock(app, 'place-0'), /09:53/);
  app.window.dispatch('beforeprint', { type: 'beforeprint' });
  assert.match(previewClock(app, 'place-0'), /09:30/);
  assert.equal(details.open, false, 'the transit widget cancels and clears its live response when closed');
  assert.doesNotMatch(app.$('day-list').children[0].querySelector('.day-footnote').textContent, /미리보기/);
  assert.equal(app.stored.get(storageKey), raw);
});

test('live time projection supports crossing midnight and a valid route longer than the manual transfer limit', async () => {
  const fixture = transitPreviewFixture({ startTime: '23:50' }), app = previewRuntime(fixture); await settle();
  const departure = previewMount(app, 'transit', 'departure');
  departure.options.onPreviewDuration(53);
  assert.match(previewClock(app, 'place-0'), /다음 날.*00:43/);
  const transfer = previewMount(app, 'local-transfer', 'transfer-0');
  transfer.options.onPreviewTransitDuration(1200);
  const originalSecond = fixture.note.days[0].events.find(event => event.id === 'place-1').start;
  const expected = fixture.planner.formatTime(originalSecond + 53 + 1200 - 20);
  assert.match(previewClock(app, 'place-1'), new RegExp(expected));
  assert.equal(JSON.parse(app.stored.get(storageKey)).itinerary.eventEdits[0]['transfer-0'].duration, 20);
});

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

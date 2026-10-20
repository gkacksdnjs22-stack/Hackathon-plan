import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sources = Object.fromEntries(['select-ui.js', 'time-picker.js'].map(name => [name, readFileSync(new URL(name, import.meta.url), 'utf8')]));

function runtime(kind, { searchable = true } = {}) {
  let document;
  const anchor = { left: 220, top: 650, width: 124, height: 44, right: 344, bottom: 694 };
  class Element {
    constructor(tagName = 'div', nodeType = 1) {
      this.tagName = tagName.toUpperCase(); this.nodeType = nodeType; this.children = []; this.parentElement = null;
      this.className = ''; this.id = ''; this.dataset = {}; this.style = { setProperty(name, value) { this[name] = value; } };
      this.attributes = new Map(); this.events = new Map(); this.hidden = false; this.disabled = false; this.multiple = false;
      this.labels = []; this.selectedIndex = 0; this.scrollTop = 0; this.tabIndex = 0; this.type = ''; this._text = ''; this.value = '';
      this.classList = { contains: name => this.className.split(/\s+/).includes(name), add: name => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
        toggle: (name, force) => { const set = new Set(this.className.split(/\s+/).filter(Boolean)); const on = force ?? !set.has(name); if (on) set.add(name); else set.delete(name); this.className = [...set].join(' '); } };
    }
    get isConnected() { let root = this; while (root.parentElement) root = root.parentElement; return root === document.body; }
    get options() { return this.children; }
    get label() { return this._label || this.textContent; }
    get title() { return this._title || ''; }
    set title(value) { this._title = value; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    set innerHTML(value) {
      this.replaceChildren();
      if (value.includes('time-trigger-value')) { const label = new Element('span'); label.className = 'time-trigger-value'; this.append(label); }
      if (value.includes('time-columns')) for (const part of ['hour', 'minute']) {
        const list = new Element('div'); list.className = 'time-list'; list.dataset.part = part; this.append(list);
      }
    }
    append(...nodes) {
      for (const node of nodes) {
        if (node.nodeType === 11) { this.append(...[...node.children]); continue; }
        if (node.parentElement) node.parentElement.children.splice(node.parentElement.children.indexOf(node), 1);
        node.parentElement = this; this.children.push(node);
      }
    }
    before(node) { const parent = this.parentElement; node.parentElement = parent; parent.children.splice(parent.children.indexOf(this), 0, node); }
    replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this._text = ''; this.append(...nodes); }
    matches(selector) {
      return selector.split(',').some(raw => {
        const value = raw.trim();
        if (value.startsWith('.day-start-form ')) return this.tagName === 'INPUT' && Boolean(this.parentElement?.closest('.day-start-form')) && (this.type === 'time' || this.classList.contains('time-picker-native'));
        if (value.startsWith('#')) return this.id === value.slice(1);
        if (value.startsWith('.')) return this.classList.contains(value.slice(1));
        const data = /^\[data-(index|part)="([^"]+)"\]$/.exec(value); if (data) return this.dataset[data[1]] === data[2];
        return this.tagName.toLowerCase() === value;
      });
    }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    contains(node) { for (let current = node; current; current = current.parentElement) if (current === this) return true; return false; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, handler) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(handler); }
    emit(type, event = {}) { for (const handler of this.events.get(type) || []) handler({ type, target: this, preventDefault() {}, stopPropagation() {}, ...event }); }
    dispatchEvent(event) { this.emit(event.type, event); }
    focus(options) { this.focusOptions = options; document.activeElement = this; }
    scrollIntoView() { throw new Error('must not scroll the page to reveal an option'); }
    get offsetHeight() { return 40; }
    get offsetTop() { return this.parentElement ? this.parentElement.children.indexOf(this) * 42 + 4 : 0; }
    get clientHeight() {
      if (this.classList.contains('time-list')) return Number.parseFloat(this.closest('.time-popover').style['--time-list-height']) || 170;
      return this.getBoundingClientRect().height;
    }
    getBoundingClientRect() {
      if (this.classList.contains('custom-select') || this.classList.contains('time-picker')) return { ...anchor };
      if (this.classList.contains('select-popover') || this.classList.contains('time-popover')) {
        const time = this.classList.contains('time-popover');
        const width = Math.min(time ? 280 : 240, Number.parseFloat(this.style.maxWidth) || Infinity);
        const naturalHeight = time ? 145 + (Number.parseFloat(this.style['--time-list-height']) || 170) : 240;
        const height = Math.min(naturalHeight, Number.parseFloat(this.style.maxHeight) || Infinity);
        const left = anchor.left + (Number.parseFloat(this.style.left) || 0), top = anchor.top + (Number.parseFloat(this.style.top) || 51);
        return { left, top, width, height, right: left + width, bottom: top + height };
      }
      if (this.classList.contains('select-options')) {
        const parent = this.closest('.select-popover').getBoundingClientRect();
        return { ...parent, top: parent.top + 56, height: Math.max(0, parent.height - 62), bottom: parent.bottom - 6 };
      }
      if (this.classList.contains('select-option')) {
        const parent = this.parentElement.getBoundingClientRect(), top = parent.top + this.offsetTop - this.parentElement.scrollTop;
        return { ...parent, top, height: 40, bottom: top + 40 };
      }
      return { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 };
    }
  }
  const body = new Element('body'), documentElement = new Element('html');
  document = new Element('document'); document.nodeType = 9; document.body = body; document.documentElement = documentElement; document.activeElement = body;
  document.createElement = tag => new Element(tag); document.createDocumentFragment = () => new Element('fragment', 11);
  document.getElementById = id => body.querySelector(`#${id}`);
  const window = new Element('window'); window.innerWidth = 360; window.innerHeight = 800;
  window.visualViewport = { events: new Map(), width: 360, height: 800, offsetTop: 0, offsetLeft: 0,
    addEventListener: Element.prototype.addEventListener, emit: Element.prototype.emit };
  const native = new Element(kind === 'select' ? 'select' : 'input');
  if (kind === 'select') {
    native.id = searchable ? 'area' : 'city-select'; native.className = searchable ? 'day-area-select' : '';
    for (let index = 0; index < 24; index++) { const option = new Element('option'); option.textContent = `선택 ${index + 1}`; option.value = String(index); native.append(option); }
    body.append(native);
  } else { const form = new Element('form'); form.className = 'day-start-form'; native.type = 'time'; native.value = '09:45'; form.append(native); body.append(form); }
  vm.runInNewContext(sources[kind === 'select' ? 'select-ui.js' : 'time-picker.js'], {
    window, document, Event, Date, setTimeout, MutationObserver: class { observe() {} }
  });
  const wrapper = native.parentElement;
  const trigger = wrapper.querySelector(kind === 'select' ? '.select-trigger' : '.time-trigger');
  const popup = wrapper.querySelector(kind === 'select' ? '.select-popover' : '.time-popover');
  return { window, document, native, wrapper, trigger, popup, open: () => trigger.emit('click'), anchor };
}

test('search dropdown remains open and within the visible viewport when the mobile keyboard resizes or pans it', () => {
  const app = runtime('select'); app.open();
  assert.equal(app.popup.hidden, false); assert.equal(app.document.activeElement.className, 'select-search-input');
  assert.equal(app.document.activeElement.focusOptions.preventScroll, true);
  app.window.visualViewport.height = 320; app.window.visualViewport.offsetTop = 70; app.window.innerHeight = 390;
  app.window.emit('resize'); app.window.visualViewport.emit('resize'); app.window.visualViewport.emit('scroll');
  const bounds = app.popup.getBoundingClientRect();
  assert.equal(app.popup.hidden, false); assert.equal(app.trigger.getAttribute('aria-expanded'), 'true');
  assert.ok(bounds.left >= 16 && bounds.right <= 344); assert.ok(bounds.top >= 86 && bounds.bottom <= 374);
  assert.equal(app.native.selectedIndex, 0);
});

test('select keyboard navigation scrolls only its own options and transient touch blur does not dismiss it', async () => {
  const app = runtime('select', { searchable: false }); app.open();
  app.wrapper.emit('keydown', { key: 'End', target: app.popup.children[0] });
  assert.ok(app.popup.scrollTop > 0); assert.equal(app.document.activeElement.focusOptions.preventScroll, true);
  app.document.activeElement = app.document.body; app.wrapper.emit('focusout', { relatedTarget: null });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(app.popup.hidden, false);
  app.wrapper.emit('focusout', { relatedTarget: { parentElement: null } }); assert.equal(app.popup.hidden, true);
});

test('time picker repositions without discarding an uncommitted choice when viewport space changes', async () => {
  const app = runtime('time'); app.open();
  const minute = app.popup.querySelector('[data-part="minute"]').children[50];
  app.popup.emit('click', { target: minute }); assert.equal(minute.getAttribute('aria-selected'), 'true');
  app.window.visualViewport.height = 290; app.window.visualViewport.offsetTop = 80;
  app.window.emit('resize'); app.window.visualViewport.emit('resize');
  const bounds = app.popup.getBoundingClientRect();
  assert.equal(app.popup.hidden, false); assert.ok(bounds.left >= 16 && bounds.right <= 344);
  assert.ok(bounds.top >= 96 && bounds.bottom <= 354); assert.equal(minute.getAttribute('aria-selected'), 'true');
  assert.equal(app.native.value, '09:45');
  app.document.activeElement = app.document.body; app.wrapper.emit('focusout', { relatedTarget: app.document.body });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(app.popup.hidden, false);
  app.document.emit('pointerdown', { target: app.document.body }); assert.equal(app.popup.hidden, true); assert.equal(app.native.value, '09:45');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./date-picker.js', import.meta.url), 'utf8');

// Exercise the picker through its DOM events without a browser dependency.
function setup(value = '2024-02-29', viewport = null, initialNow = '2023-01-01T12:00:00') {
  let instant = new Date(initialNow).getTime();
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
  }
  let document;
  const element = (id, parent = null) => ({
    id, parent, value: '', hidden: false, textContent: '', innerHTML: '',
    dataset: {}, attributes: {}, events: {}, style: {},
    classList: { toggle() {} },
    addEventListener(type, listener) { (this.events[type] ||= []).push(listener); },
    dispatchEvent(event) { for (const listener of this.events[event.type] || []) listener(event); return true; },
    setAttribute(name, content) { this.attributes[name] = content; },
    focus(options) { document.activeElement = this; this.focusOptions = options; },
    contains(target) { for (let node = target; node; node = node.parent) if (node === this) return true; return false; },
    closest(selector) {
      if (selector === '.date-picker') return picker;
      if (selector === '[data-date]') return this.dataset.date ? this : null;
      return selector === 'button' && this.tag === 'button' ? this : null;
    }
  });
  const picker = element('picker');
  const input = element('start-date', picker);
  input.value = value;
  const trigger = element('date-trigger', picker);
  const label = element('date-label', trigger);
  const calendar = element('date-calendar', picker);
  calendar.hidden = true;
  const ids = Object.fromEntries([input, trigger, label, calendar].map(node => [node.id, node]));
  const buttonTag = dataset => {
    const [key, value] = Object.entries(dataset)[0];
    return (calendar.innerHTML.match(/<button\b[^>]*>/g) || []).find(tag => tag.includes(`data-${key}="${value}"`)) || '';
  };
  const button = dataset => Object.assign(element('', calendar), { tag: 'button', dataset, disabled: /\sdisabled(?:\s|>|=)/.test(buttonTag(dataset)) });
  calendar.querySelector = selector => {
    const match = /^\[data-(date|month)="([^"]+)"\]$/.exec(selector);
    if (!match || !calendar.innerHTML.includes(`data-${match[1]}="${match[2]}"`)) return null;
    return button({ [match[1]]: match[2] });
  };
  document = { ...element('document'), getElementById: id => ids[id], activeElement: null };
  const window = element('window');
  if (viewport) {
    window.innerWidth = viewport.width; window.innerHeight = viewport.height;
    window.visualViewport = Object.assign(element('visualViewport'), { width: viewport.width, height: viewport.height, offsetTop: 0, offsetLeft: 0 });
    const anchor = { left: viewport.anchorLeft, top: viewport.anchorTop, width: 180, height: 51,
      right: viewport.anchorLeft + 180, bottom: viewport.anchorTop + 51 };
    picker.getBoundingClientRect = () => anchor;
    calendar.getBoundingClientRect = () => {
      const left = anchor.left + (parseFloat(calendar.style.left) || 0), top = anchor.top + (parseFloat(calendar.style.top) || 60);
      const width = Math.min(320, parseFloat(calendar.style.maxWidth) || 320), height = Math.min(370, parseFloat(calendar.style.maxHeight) || 370);
      return { left, top, width, height, right: left + width, bottom: top + height };
    };
  }
  runInNewContext(source, { document, window, Date: FixtureDate, Event, queueMicrotask, setTimeout });
  const emit = (target, type, event = {}) => {
    const detail = { type, target, preventDefault() {}, stopPropagation() {}, ...event };
    target.dispatchEvent(detail);
  };
  return { input, trigger, label, calendar, document, window, emit,
    setNow(value) { instant = new Date(value).getTime(); },
    buttonTag,
    open() { emit(trigger, 'click'); },
    click(dataset) { emit(calendar, 'click', { target: button(dataset) }); },
    key(date, key) { emit(calendar, 'keydown', { target: button({ date }), key }); },
    focusedDate() { return document.activeElement?.dataset.date; }
  };
}

test('sync shows a valid saved date and rejects impossible dates', () => {
  const app = setup();
  assert.equal(app.label.textContent, '2024. 02. 29. (목)');
  assert.equal(app.trigger.attributes['aria-expanded'], 'false');
  for (const invalid of ['2023-02-29', '2024-04-31', '2024-13-01', '2024-00-01', '0000-01-01', '2024-2-01']) {
    app.input.value = invalid;
    app.window.TravelDatePicker.sync();
    assert.equal(app.label.textContent, '날짜를 선택해 주세요');
  }
});

test('February renders leap day and opens focused on the selected date', () => {
  const app = setup();
  app.open();
  assert.equal(app.calendar.hidden, false);
  assert.equal(app.trigger.attributes['aria-expanded'], 'true');
  assert.equal(app.focusedDate(), '2024-02-29');
  assert.equal((app.calendar.innerHTML.match(/data-date=/g) || []).length, 29);
  assert.match(app.calendar.innerHTML, /aria-label="2024년 2월 29일 목요일, 선택됨"/);
  assert.doesNotMatch(app.calendar.innerHTML, /data-date="2024-02-30"/);
});

test('selection updates the canonical field, bubbles change, and restores trigger focus', () => {
  const app = setup();
  const changes = [];
  app.input.addEventListener('change', event => changes.push(event));
  app.open();
  app.click({ date: '2024-02-20' });
  assert.equal(app.input.value, '2024-02-20');
  assert.equal(app.label.textContent, '2024. 02. 20. (화)');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].bubbles, true);
  assert.equal(app.calendar.hidden, true);
  assert.equal(app.document.activeElement, app.trigger);
});

test('arrow keys cross leap day and year boundaries correctly', () => {
  const app = setup();
  app.open();
  app.key('2024-02-29', 'ArrowRight');
  assert.equal(app.focusedDate(), '2024-03-01');
  assert.match(app.calendar.innerHTML, /2024년 3월/);
  app.key('2024-03-01', 'ArrowLeft');
  assert.equal(app.focusedDate(), '2024-02-29');
  app.key('2024-01-01', 'ArrowLeft');
  assert.equal(app.focusedDate(), '2023-12-31');
  assert.match(app.calendar.innerHTML, /2023년 12월/);
});

test('month navigation clamps the focused day to the end of February', () => {
  const leapYear = setup('2024-01-31');
  leapYear.open();
  leapYear.click({ month: '1' });
  assert.match(leapYear.calendar.innerHTML, /data-date="2024-02-29" tabindex="0"/);
  assert.equal(leapYear.input.value, '2024-01-31');
  const ordinaryYear = setup('2023-01-31');
  ordinaryYear.open();
  ordinaryYear.key('2023-01-31', 'PageDown');
  assert.equal(ordinaryYear.focusedDate(), '2023-02-28');
});

test('past dates are disabled and cannot be selected while today and future dates remain available', () => {
  const app = setup('2024-02-20', null, '2024-02-20T09:30:00');
  const changes = [];
  app.input.addEventListener('change', event => changes.push(event));
  app.open();
  assert.equal(app.input.min, '2024-02-20');
  assert.match(app.buttonTag({ date: '2024-02-19' }), /\sdisabled(?:\s|>|=)/);
  assert.match(app.buttonTag({ date: '2024-02-19' }), /aria-disabled="true"/);
  assert.doesNotMatch(app.buttonTag({ date: '2024-02-20' }), /\sdisabled(?:\s|>|=)/);
  assert.doesNotMatch(app.buttonTag({ date: '2024-02-21' }), /\sdisabled(?:\s|>|=)/);
  assert.equal(app.window.TravelDatePicker.isSelectable('2024-02-19'), false);
  assert.equal(app.window.TravelDatePicker.isSelectable('2024-02-20'), true);
  assert.equal(app.window.TravelDatePicker.isSelectable('2024-02-21'), true);
  assert.equal(app.window.TravelDatePicker.isSelectable('2024-02-30'), false);
  app.click({ date: '2024-02-19' });
  assert.equal(app.input.value, '2024-02-20');
  assert.equal(changes.length, 0);
  assert.equal(app.calendar.hidden, false);
  app.click({ date: '2024-02-20' });
  assert.equal(app.input.value, '2024-02-20');
  assert.equal(changes.length, 1);
  app.open();
  app.click({ date: '2024-02-21' });
  assert.equal(app.input.value, '2024-02-21');
  assert.equal(changes.length, 2);
});

test('opening an old saved date focuses today without rewriting the saved selection', () => {
  const app = setup('2023-12-31', null, '2024-02-20T09:30:00');
  assert.equal(app.label.textContent, '2023. 12. 31. (일)');
  app.open();
  assert.equal(app.input.value, '2023-12-31');
  assert.equal(app.focusedDate(), '2024-02-20');
  assert.match(app.calendar.innerHTML, /2024년 2월/);
  app.window.TravelDatePicker.sync();
  assert.equal(app.input.value, '2023-12-31');
  assert.equal(app.focusedDate(), '2024-02-20');
});

test('keyboard and month navigation cannot move before today', () => {
  const app = setup('2024-02-20', null, '2024-02-20T09:30:00');
  app.open();
  for (const key of ['ArrowLeft', 'ArrowUp', 'Home', 'PageUp']) {
    app.key('2024-02-20', key);
    assert.equal(app.focusedDate(), '2024-02-20', key);
    assert.match(app.calendar.innerHTML, /2024년 2월/);
  }
  assert.match(app.buttonTag({ month: '-1' }), /\sdisabled(?:\s|>|=)/);
  app.click({ month: '-1' });
  assert.match(app.calendar.innerHTML, /2024년 2월/);
  app.key('2024-02-20', 'ArrowRight');
  assert.equal(app.focusedDate(), '2024-02-21');
  app.key('2024-02-21', 'ArrowUp');
  assert.equal(app.focusedDate(), '2024-02-20');
  app.click({ month: '1' });
  assert.match(app.calendar.innerHTML, /2024년 3월/);
  assert.doesNotMatch(app.buttonTag({ month: '-1' }), /\sdisabled(?:\s|>|=)/);
  app.key('2024-03-20', 'PageUp');
  assert.equal(app.focusedDate(), '2024-02-20');
});

test('the lower date boundary remains correct on leap day and the first day of a year', () => {
  const leap = setup('2024-03-31', null, '2024-02-29T23:59:00');
  leap.open();
  leap.key('2024-03-31', 'PageUp');
  assert.equal(leap.focusedDate(), '2024-02-29');
  leap.key('2024-02-29', 'ArrowLeft');
  assert.equal(leap.focusedDate(), '2024-02-29');
  assert.equal(leap.window.TravelDatePicker.isSelectable('2024-02-28'), false);
  const newYear = setup('2025-01-01', null, '2025-01-01T00:01:00');
  newYear.open();
  newYear.key('2025-01-01', 'ArrowLeft');
  assert.equal(newYear.focusedDate(), '2025-01-01');
  assert.match(newYear.buttonTag({ month: '-1' }), /\sdisabled(?:\s|>|=)/);
  newYear.click({ month: '-1' });
  assert.match(newYear.calendar.innerHTML, /2025년 1월/);
});

test('an open calendar refreshes its boundary when a formerly valid date becomes past at midnight', () => {
  const app = setup('2024-02-29', null, '2024-02-29T23:59:00');
  let changes = 0;
  app.input.addEventListener('change', () => { changes++; });
  app.open();
  assert.equal(app.window.TravelDatePicker.isSelectable('2024-02-29'), true);
  app.setNow('2024-03-01T00:01:00');
  app.click({ date: '2024-02-29' });
  assert.equal(changes, 0);
  assert.equal(app.input.value, '2024-02-29');
  assert.equal(app.calendar.hidden, false);
  assert.equal(app.input.min, '2024-03-01');
  assert.equal(app.window.TravelDatePicker.isSelectable('2024-02-29'), false);
  assert.match(app.calendar.innerHTML, /2024년 3월/);
  app.click({ date: '2024-03-01' });
  assert.equal(app.input.value, '2024-03-01');
  assert.equal(changes, 1);
});

test('Escape and outside click dismiss without changing the selected date', () => {
  const app = setup();
  app.open();
  app.emit(app.trigger.closest('.date-picker'), 'keydown', { key: 'Escape' });
  assert.equal(app.calendar.hidden, true);
  assert.equal(app.document.activeElement, app.trigger);
  app.open();
  app.emit(app.document, 'pointerdown', { target: { parent: null } });
  assert.equal(app.calendar.hidden, true);
  assert.equal(app.input.value, '2024-02-29');
  assert.equal(app.trigger.attributes['aria-expanded'], 'false');
});

test('month navigation stays open when internal focus briefly passes through the body', async () => {
  const app = setup('2026-12-20');
  app.open();
  const picker = app.trigger.closest('.date-picker');
  const nextMonth = app.calendar.querySelector('[data-month="1"]');

  // A browser may report body as activeElement before the internal target focuses.
  app.document.activeElement = { id: 'body', parent: null };
  app.emit(picker, 'focusout', { relatedTarget: nextMonth });
  await Promise.resolve();
  assert.equal(app.calendar.hidden, false);

  app.click({ month: '1' });
  assert.match(app.calendar.innerHTML, /2027년 1월/);

  // Replacing a focused month button may also produce a null relatedTarget.
  app.document.activeElement = { id: 'body', parent: null };
  app.emit(picker, 'focusout', { relatedTarget: null });
  await Promise.resolve();
  assert.equal(app.calendar.hidden, false);
  app.click({ month: '1' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(app.calendar.hidden, false);
  assert.equal(app.trigger.attributes['aria-expanded'], 'true');
  assert.match(app.calendar.innerHTML, /2027년 2월/);

  // Some browsers use the body itself as relatedTarget during a re-render.
  app.document.body = { id: 'body', parent: null };
  app.document.activeElement = app.document.body;
  app.emit(picker, 'focusout', { relatedTarget: app.document.body });
  assert.equal(app.calendar.hidden, false);
  app.click({ month: '1' });
  assert.match(app.calendar.innerHTML, /2027년 3월/);

  app.emit(picker, 'focusout', { relatedTarget: { id: 'outside-control', parent: null } });
  assert.equal(app.calendar.hidden, true);
});

test('calendar stays within a narrow visible viewport and repositions on keyboard or browser chrome resize', () => {
  const app = setup('2026-10-20', { width: 360, height: 640, anchorLeft: 190, anchorTop: 530 });
  app.open();
  let bounds = app.calendar.getBoundingClientRect();
  assert.ok(bounds.left >= 16 && bounds.right <= 344);
  assert.ok(bounds.top >= 16 && bounds.bottom <= 624);
  assert.equal(app.document.activeElement.focusOptions.preventScroll, true);
  app.window.visualViewport.height = 320; app.window.visualViewport.offsetTop = 90;
  app.emit(app.window.visualViewport, 'resize');
  bounds = app.calendar.getBoundingClientRect();
  assert.ok(bounds.top >= 106 && bounds.bottom <= 394);
  assert.equal(app.calendar.hidden, false); assert.equal(app.input.value, '2026-10-20');
  app.emit(app.window, 'resize'); assert.equal(app.calendar.hidden, false);
});

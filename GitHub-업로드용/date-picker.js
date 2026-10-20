(function () {
  'use strict';

  const input = document.getElementById('start-date');
  const trigger = document.getElementById('date-trigger');
  const label = document.getElementById('date-label');
  const calendar = document.getElementById('date-calendar');
  if (!input || !trigger || !label || !calendar) return;
  const picker = trigger.closest('.date-picker');
  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  let view;
  let focusedDate;

  // Local noon keeps calendar arithmetic independent of UTC and DST offsets.
  function dateAt(year, month, day) {
    const date = new Date(0);
    date.setHours(12, 0, 0, 0);
    date.setFullYear(year, month, day);
    return date;
  }
  function today() {
    const now = new Date();
    return dateAt(now.getFullYear(), now.getMonth(), now.getDate());
  }
  function format(date) {
    return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function parse(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = dateAt(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
  }
  function fullLabel(date) {
    return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 ${weekdays[date.getDay()]}요일`;
  }
  function sameMonth(first, second) {
    return first.getFullYear() === second.getFullYear() && first.getMonth() === second.getMonth();
  }
  function earliestFocus(date) {
    const minimum=today();
    return !date||date<minimum?minimum:date;
  }
  function isSelectable(value) {
    const date=parse(value);
    return Boolean(date&&date>=today());
  }
  function close(returnFocus = true) {
    calendar.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus) trigger.focus({ preventScroll: true });
  }
  function sync() {
    input.min=format(today());
    const selected = parse(input.value);
    label.textContent = selected
      ? `${selected.getFullYear()}. ${String(selected.getMonth() + 1).padStart(2, '0')}. ${String(selected.getDate()).padStart(2, '0')}. (${weekdays[selected.getDay()]})`
      : '날짜를 선택해 주세요';
    trigger.classList.toggle('has-date', Boolean(selected));
    trigger.setAttribute('aria-label', selected ? `여행 시작일 ${fullLabel(selected)}, 날짜 변경` : '여행 시작일 선택');
    trigger.setAttribute('aria-expanded', String(!calendar.hidden));
    if (!calendar.hidden) {
      focusedDate = earliestFocus(selected);
      view = dateAt(focusedDate.getFullYear(), focusedDate.getMonth(), 1);
      render();
    }
  }
  function focusDay() {
    const button = calendar.querySelector(`[data-date="${format(focusedDate)}"]`);
    button?.focus({ preventScroll: true });
    if (typeof button?.getBoundingClientRect === 'function') {
      const bounds = calendar.getBoundingClientRect(), day = button.getBoundingClientRect();
      if (day.top < bounds.top) calendar.scrollTop -= bounds.top - day.top;
      else if (day.bottom > bounds.bottom) calendar.scrollTop += day.bottom - bounds.bottom;
    }
  }
  function position() {
    if (calendar.hidden || typeof picker.getBoundingClientRect !== 'function') return;
    const viewport = window.visualViewport;
    const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const anchor = picker.getBoundingClientRect();
    const below = top + height - 16 - anchor.bottom - 9, above = anchor.top - top - 16 - 9;
    calendar.style.maxWidth = `${Math.max(0, width - 32)}px`;
    calendar.style.maxHeight = `${Math.max(0, Math.min(height - 32, Math.max(above, below)))}px`;
    const bounds = calendar.getBoundingClientRect();
    const popupLeft = Math.max(left + 16, Math.min(anchor.left, left + width - 16 - bounds.width));
    const preferredTop = bounds.height > below && above > below ? anchor.top - 9 - bounds.height : anchor.bottom + 9;
    const popupTop = Math.max(top + 16, Math.min(preferredTop, top + height - 16 - bounds.height));
    calendar.style.left = `${popupLeft - anchor.left}px`; calendar.style.right = 'auto';
    calendar.style.top = `${popupTop - anchor.top}px`; calendar.style.bottom = 'auto';
  }
  function render() {
    const minimum=today();
    input.min=format(minimum);
    focusedDate=earliestFocus(focusedDate);
    if(view<dateAt(minimum.getFullYear(),minimum.getMonth(),1))view=dateAt(minimum.getFullYear(),minimum.getMonth(),1);
    const year = view.getFullYear(), month = view.getMonth();
    const selected = input.value, currentDay = format(minimum);
    const firstWeekday = view.getDay();
    const daysInMonth = dateAt(year, month + 1, 0).getDate();
    const cells = [];
    for (let index = 0; index < Math.ceil((firstWeekday + daysInMonth) / 7) * 7; index++) {
      const day = index - firstWeekday + 1;
      if (day < 1 || day > daysInMonth) {
        cells.push('<div class="calendar-blank" role="gridcell"></div>');
        continue;
      }
      const date = dateAt(year, month, day), value = format(date);
      const isPast=date<minimum;
      const isSelected = value === selected&&!isPast, isToday = value === currentDay;
      const classes = `calendar-day${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}${isPast?' is-past':''}`;
      cells.push(`<div role="gridcell" aria-selected="${isSelected}"><button class="${classes}" type="button" data-date="${value}" tabindex="${!isPast&&value === format(focusedDate) ? '0' : '-1'}" aria-label="${fullLabel(date)}${isPast?', 선택할 수 없는 지난 날짜':isSelected ? ', 선택됨' : ''}"${isPast?' disabled aria-disabled="true"':''}${isToday ? ' aria-current="date"' : ''}>${day}</button></div>`);
    }
    let weeks = '';
    for (let index = 0; index < cells.length; index += 7) weeks += `<div class="calendar-week" role="row">${cells.slice(index, index + 7).join('')}</div>`;
    calendar.innerHTML = `
      <div class="calendar-heading">
        <button class="calendar-nav" type="button" data-month="-1" aria-label="이전 달"${sameMonth(view,minimum) ? ' disabled' : ''}><span aria-hidden="true">‹</span></button>
        <h3 id="date-calendar-title" aria-live="polite" aria-atomic="true">${year}년 ${month + 1}월</h3>
        <button class="calendar-nav" type="button" data-month="1" aria-label="다음 달"${year === 9999 && month === 11 ? ' disabled' : ''}><span aria-hidden="true">›</span></button>
      </div>
      <div class="calendar-grid" role="grid" aria-labelledby="date-calendar-title">
        <div class="calendar-week calendar-weekdays" role="row">${weekdays.map(day => `<span role="columnheader" aria-label="${day}요일">${day}</span>`).join('')}</div>
        ${weeks}
      </div>
      <div class="calendar-footer"><button class="calendar-today" type="button" data-action="today">오늘</button><span>오늘부터 선택할 수 있어요</span><button class="calendar-close" type="button" data-action="close">닫기</button></div>`;
    position();
  }
  function open() {
    focusedDate = earliestFocus(parse(input.value));
    view = dateAt(focusedDate.getFullYear(), focusedDate.getMonth(), 1);
    calendar.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    render();
    focusDay();
  }
  function select(date) {
    if(!date||date<today()){
      if(!calendar.hidden){render();focusDay();}
      return;
    }
    input.value = format(date);
    close();
    sync();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function shiftMonth(amount) {
    const target = dateAt(view.getFullYear(), view.getMonth() + amount, 1);
    const minimum=today();
    if (target.getFullYear() < 1 || target.getFullYear() > 9999||target<dateAt(minimum.getFullYear(),minimum.getMonth(),1)){render();return;}
    view = target;
    focusedDate = earliestFocus(dateAt(view.getFullYear(), view.getMonth(), Math.min(focusedDate.getDate(), dateAt(view.getFullYear(), view.getMonth() + 1, 0).getDate())));
    render();
  }
  trigger.setAttribute('aria-controls', calendar.id);
  trigger.addEventListener('click', () => calendar.hidden ? open() : close());
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); open(); }
  });
  calendar.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || !calendar.contains(button)) return;
    if (button.dataset.date) select(parse(button.dataset.date));
    else if (button.dataset.month) {
      const direction = button.dataset.month;
      shiftMonth(Number(direction));
      const nav=calendar.querySelector(`[data-month="${direction}"]`);
      if(nav&&!nav.disabled)nav.focus({preventScroll:true});else focusDay();
    } else if (button.dataset.action === 'today') select(today());
    else if (button.dataset.action === 'close') close();
  });
  calendar.addEventListener('keydown', event => {
    const button = event.target.closest('[data-date]');
    if (!button) return;
    const date = parse(button.dataset.date);
    if(!date)return;
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -date.getDay(), End: 6 - date.getDay() };
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      shiftMonth(event.key === 'PageUp' ? -1 : 1);
      focusDay();
    } else if (Object.prototype.hasOwnProperty.call(offsets, event.key)) {
      event.preventDefault();
      const next = earliestFocus(dateAt(date.getFullYear(), date.getMonth(), date.getDate() + offsets[event.key]));
      if (next.getFullYear() < 1 || next.getFullYear() > 9999) return;
      focusedDate = next;
      if (!sameMonth(view, focusedDate)) view = dateAt(next.getFullYear(), next.getMonth(), 1);
      render();
      focusDay();
    }
  });
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !calendar.hidden) { event.preventDefault(); event.stopPropagation(); close(); }
  });
  picker.addEventListener('focusout', event => {
    const target=event.relatedTarget;
    // Replacing the month's buttons can briefly move focus to the document.
    // Only dismiss for a concrete control outside the picker.
    if(target&&target!==document.body&&target!==document.documentElement&&!picker.contains(target))close(false);
  });
  document.addEventListener('pointerdown', event => {
    if (!calendar.hidden && !picker.contains(event.target)) close(false);
  });
  window.addEventListener?.('resize', position);
  window.addEventListener?.('scroll', event => { if (event.target === window || !picker.contains(event.target)) position(); }, true);
  window.visualViewport?.addEventListener('resize', position);
  window.visualViewport?.addEventListener('scroll', position);
  input.addEventListener('change', sync);
  window.TravelDatePicker = { sync, isSelectable };
  sync();
})();

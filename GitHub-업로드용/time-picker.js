(function () {
  'use strict';
  const selector = '.day-start-form input[type="time"],.day-start-form input.time-picker-native';
  const components = new Map();
  let sequence = 0;
  let active = null;
  const two = number => String(number).padStart(2, '0');
  function parse(value) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
    return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
  }
  function enhance(input) {
    if (input.tagName !== 'INPUT' || components.has(input)) return;
    const id = `travel-time-${++sequence}`;
    const labels = [...input.labels];
    const wrapper = document.createElement('div');
    wrapper.className = 'time-picker';
    const trigger = document.createElement('button');
    trigger.id = `${id}-trigger`;
    trigger.type = 'button';
    trigger.className = 'time-trigger';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `${id}-popover`);
    trigger.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10 5.5v4.8l3 1.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="time-trigger-value"></span><span class="time-trigger-arrow" aria-hidden="true"></span>';
    const valueLabel = trigger.querySelector('.time-trigger-value');
    const popup = document.createElement('div');
    popup.id = `${id}-popover`;
    popup.className = 'time-popover';
    popup.hidden = true;
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-labelledby', `${id}-title`);
    popup.innerHTML = `<div class="time-popover-heading"><h3 id="${id}-title">시간 선택</h3><span>시 · 분</span></div><div class="time-columns"><div class="time-column"><span class="time-column-label" id="${id}-hour-label">시</span><div class="time-list" data-part="hour" role="listbox" aria-labelledby="${id}-hour-label" aria-orientation="vertical"></div></div><div class="time-column"><span class="time-column-label" id="${id}-minute-label">분</span><div class="time-list" data-part="minute" role="listbox" aria-labelledby="${id}-minute-label" aria-orientation="vertical"></div></div></div><div class="time-popover-footer"><button class="time-commit" type="button" data-action="commit">선택 완료</button><button class="time-cancel" type="button" data-action="cancel">취소</button></div>`;
    const lists = { hour: popup.querySelector('[data-part="hour"]'), minute: popup.querySelector('[data-part="minute"]') };
    const options = { hour: [], minute: [] };
    let draft = { hour: 9, minute: 0 };
    for (const part of ['hour', 'minute']) {
      for (let number = 0; number < (part === 'hour' ? 24 : 60); number++) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'time-option';
        button.dataset.part = part;
        button.dataset.value = String(number);
        button.setAttribute('role', 'option');
        button.setAttribute('aria-label', `${two(number)}${part === 'hour' ? '시' : '분'}`);
        button.textContent = two(number);
        lists[part].append(button);
        options[part].push(button);
      }
    }
    input.before(wrapper);
    wrapper.append(input, trigger, popup);
    input.classList.add('time-picker-native');
    input.type = 'hidden';
    for (const label of labels) label.htmlFor = trigger.id;

    function close(restoreFocus = false) {
      popup.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (active === component) active = null;
      if (restoreFocus && trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
    }
    function paint() {
      for (const part of ['hour', 'minute']) options[part].forEach((button, index) => {
        const selected = index === draft[part];
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
      });
    }
    function reveal(part, center = false) {
      const list = lists[part], option = options[part][draft[part]];
      const top = option.offsetTop;
      if (center) list.scrollTop = Math.max(0, top - (list.clientHeight - option.offsetHeight) / 2);
      else if (top < list.scrollTop) list.scrollTop = top;
      else if (top + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + option.offsetHeight - list.clientHeight;
    }
    function focusPart(part) { options[part][draft[part]].focus({ preventScroll: true }); reveal(part); }
    function sync() {
      const selected = parse(input.value);
      valueLabel.textContent = selected ? `${two(selected.hour)}:${two(selected.minute)}` : '시간 선택';
      const name = input.getAttribute('aria-label') || labels.map(label => label.textContent.trim()).join(' ') || '출발 시간';
      trigger.setAttribute('aria-label', `${name}, ${valueLabel.textContent}`);
      trigger.disabled = input.disabled;
      if (input.disabled) close();
      if (!popup.hidden) { draft = selected || { hour: 9, minute: 0 }; paint(); }
    }
    function position() {
      if (popup.hidden) return;
      const viewport = window.visualViewport;
      const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
      const anchor = wrapper.getBoundingClientRect();
      const below = top + height - 16 - anchor.bottom - 8, above = anchor.top - top - 16 - 8;
      const available = Math.max(0, Math.min(height - 32, Math.max(above, below)));
      popup.style.maxWidth = `${Math.max(0, width - 32)}px`; popup.style.maxHeight = `${available}px`;
      popup.style.setProperty('--time-list-height', `${Math.min(170, Math.max(44, available - 145))}px`);
      const bounds = popup.getBoundingClientRect();
      const popupLeft = Math.max(left + 16, Math.min(anchor.left, left + width - 16 - bounds.width));
      const preferredTop = bounds.height > below && above > below ? anchor.top - 8 - bounds.height : anchor.bottom + 8;
      const popupTop = Math.max(top + 16, Math.min(preferredTop, top + height - 16 - bounds.height));
      popup.style.left = `${popupLeft - anchor.left}px`; popup.style.right = 'auto';
      popup.style.top = `${popupTop - anchor.top}px`; popup.style.bottom = 'auto';
      for (const part of ['hour', 'minute']) reveal(part);
    }
    function open() {
      if (input.disabled) return;
      if (active && active !== component) active.close();
      sync();
      draft = parse(input.value) || { hour: 9, minute: 0 };
      paint();
      popup.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      active = component;
      position();
      for (const part of ['hour', 'minute']) reveal(part, true);
      focusPart('hour');
    }
    function commit() {
      const value = `${two(draft.hour)}:${two(draft.minute)}`;
      const changed = input.value !== value;
      input.value = value;
      close(true);
      sync();
      if (changed) input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    trigger.addEventListener('click', () => popup.hidden ? open() : close(true));
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); open(); }
    });
    popup.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || !popup.contains(button)) return;
      if (button.dataset.part) { draft[button.dataset.part] = Number(button.dataset.value); paint(); }
      else if (button.dataset.action === 'commit') commit();
      else if (button.dataset.action === 'cancel') close(true);
    });
    popup.addEventListener('keydown', event => {
      const button = event.target.closest('.time-option');
      if (!button) return;
      const part = button.dataset.part, maximum = part === 'hour' ? 23 : 59;
      const steps = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 };
      if (Object.prototype.hasOwnProperty.call(steps, event.key)) {
        event.preventDefault();
        draft[part] = Math.max(0, Math.min(maximum, draft[part] + steps[event.key]));
        paint();
        focusPart(part);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); draft[part] = event.key === 'Home' ? 0 : maximum; paint(); focusPart(part);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); focusPart(event.key === 'ArrowLeft' ? 'hour' : 'minute');
      }
    });
    wrapper.addEventListener('keydown', event => {
      if (!popup.hidden && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    });
    wrapper.addEventListener('focusout', event => {
      if (event.relatedTarget && wrapper.contains(event.relatedTarget)) return;
      if (event.relatedTarget && event.relatedTarget !== document.body && event.relatedTarget !== document.documentElement) { close(); return; }
      // Touch scrolling can temporarily blur an option to body/null without leaving.
    });
    input.addEventListener('change', sync);
    const component = { input, wrapper, trigger, sync, close, position };
    components.set(input, component);
    sync();
  }
  function discover(root) {
    if (root.nodeType !== 1 || root.closest('.time-popover')) return;
    if (root.matches(selector)) enhance(root);
    root.querySelectorAll(selector).forEach(enhance);
  }
  function cleanup() {
    for (const [input, component] of components) if (!input.isConnected || !component.wrapper.isConnected) {
      component.close(); components.delete(input);
    }
  }
  function refresh() { discover(document.body); cleanup(); for (const component of components.values()) component.sync(); }
  new MutationObserver(records => {
    const changed = new Set();
    let removed = false;
    for (const record of records) {
      if (record.type === 'attributes' && components.has(record.target)) changed.add(record.target);
      if (record.type === 'childList' && !record.target.closest?.('.time-picker')) {
        record.addedNodes.forEach(discover);
        if (record.removedNodes.length) removed = true;
      }
    }
    for (const input of changed) components.get(input)?.sync();
    if (removed) cleanup();
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'value', 'aria-label'] });
  document.addEventListener('pointerdown', event => { if (active && !active.wrapper.contains(event.target)) active.close(); });
  window.addEventListener('resize', () => active?.position());
  window.addEventListener('scroll', event => { if (active && (event.target === window || !active.wrapper.contains(event.target))) active.position(); }, true);
  window.visualViewport?.addEventListener('resize', () => active?.position());
  window.visualViewport?.addEventListener('scroll', () => active?.position());
  window.TravelTimePicker = {
    refresh,
    focus(id) {
      const component = components.get(document.getElementById(id));
      if (!component || component.trigger.disabled) return false;
      component.trigger.focus();
      return true;
    }
  };
  refresh();
})();

(function () {
  'use strict';
  const selector = '#city-select,#day-count,.departure-mode-select,.day-area-select,.swap-picker select';
  const components = new Map();
  let sequence = 0;
  let active = null;

  function enhance(native) {
    if (native.tagName !== 'SELECT' || components.has(native)) return;
    const id = `travel-select-${++sequence}`;
    const searchable = native.classList.contains('day-area-select');
    const wrapper = document.createElement('div');
    wrapper.className = `custom-select${native.classList.contains('day-area-select') ? ' custom-select-area' : ''}${native.closest('.swap-picker') ? ' custom-select-swap' : ''}`;
    const trigger = document.createElement('button');
    trigger.id = `${id}-trigger`;
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    trigger.setAttribute('aria-haspopup', searchable ? 'dialog' : 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', searchable ? `${id}-popup` : `${id}-list`);
    const value = document.createElement('span');
    value.id = `${id}-value`;
    value.className = 'select-value';
    const arrow = document.createElement('span');
    arrow.className = 'select-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    trigger.append(value, arrow);
    const popup = document.createElement('div');
    popup.id = searchable ? `${id}-popup` : `${id}-list`;
    popup.className = `select-popover${searchable ? ' select-popover-searchable' : ''}`;
    popup.hidden = true;
    popup.setAttribute('role', searchable ? 'dialog' : 'listbox');
    popup.setAttribute('aria-labelledby', trigger.id);
    let searchInput = null;
    let empty = null;
    let optionsHost = popup;
    if (searchable) {
      const searchBar = document.createElement('div');
      searchBar.className = 'select-search-bar';
      searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.className = 'select-search-input';
      searchInput.placeholder = '지역·장소 이름 검색';
      searchInput.autocomplete = 'off';
      searchInput.setAttribute('aria-controls', `${id}-list`);
      searchBar.append(searchInput);
      optionsHost = document.createElement('div');
      optionsHost.id = `${id}-list`;
      optionsHost.className = 'select-options';
      optionsHost.setAttribute('role', 'listbox');
      optionsHost.setAttribute('aria-labelledby', trigger.id);
      empty = document.createElement('p');
      empty.className = 'select-empty';
      empty.setAttribute('role', 'status');
      empty.textContent = '검색 결과가 없어요.';
      empty.hidden = true;
      popup.append(searchBar, optionsHost, empty);
    }
    const labels = [...native.labels];
    const originalTabindex = native.getAttribute('tabindex');
    const originalAriaHidden = native.getAttribute('aria-hidden');
    let focusIndex = -1;
    let search = '';
    let searchAt = 0;
    let query = '';
    native.before(wrapper);
    wrapper.append(native, trigger, popup);

    function close(restoreFocus = false) {
      popup.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      query = '';
      if (searchInput) searchInput.value = '';
      search = '';
      searchAt = 0;
      if (active === component) active = null;
      if (restoreFocus && trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
    }
    function optionText(option) { return option?.label.trim() || ''; }
    function optionTitle(option) { return option?.title || optionText(option); }
    function matchesQuery(option) {
      if (!searchable || !query.trim()) return true;
      const haystack = `${optionText(option)} ${optionTitle(option)} ${option.dataset.search || ''}`.toLocaleLowerCase('ko').replace(/\s+/g, '');
      return query.toLocaleLowerCase('ko').trim().split(/\s+/).every(term => haystack.includes(term));
    }
    function available() { return [...native.options].map((option, index) => option.disabled || !matchesQuery(option) ? -1 : index).filter(index => index !== -1); }
    function focusOption() {
      const button = optionsHost.querySelector(`[data-index="${focusIndex}"]`);
      if (!button) return;
      for (const option of optionsHost.children) option.tabIndex = option === button ? 0 : -1;
      button.focus({ preventScroll: true });
      const top = button.getBoundingClientRect().top, bounds = optionsHost.getBoundingClientRect();
      if (top < bounds.top) optionsHost.scrollTop -= bounds.top - top;
      else if (top + button.offsetHeight > bounds.bottom) optionsHost.scrollTop += top + button.offsetHeight - bounds.bottom;
    }
    function renderOptions() {
      const fragment = document.createDocumentFragment();
      let count = 0;
      [...native.options].forEach((option, index) => {
        if (!matchesQuery(option)) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'select-option';
        button.dataset.index = String(index);
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(index === native.selectedIndex));
        button.tabIndex = index === focusIndex ? 0 : -1;
        button.disabled = option.disabled;
        button.textContent = optionText(option);
        button.title = optionTitle(option);
        fragment.append(button);
        count += 1;
      });
      optionsHost.replaceChildren(fragment);
      if (empty) empty.hidden = count !== 0;
    }
    function sync() {
      const hadFocus = popup.contains(document.activeElement);
      const hadSearchFocus = searchInput === document.activeElement;
      const fallback = native.multiple;
      native.classList.toggle('custom-select-native', !fallback);
      wrapper.classList.toggle('custom-select-fallback', fallback);
      trigger.hidden = fallback;
      if (fallback) {
        close();
        if (originalAriaHidden === null) native.removeAttribute('aria-hidden'); else native.setAttribute('aria-hidden', originalAriaHidden);
        if (originalTabindex === null) native.removeAttribute('tabindex'); else native.setAttribute('tabindex', originalTabindex);
      } else {
        if (native.getAttribute('aria-hidden') !== 'true') native.setAttribute('aria-hidden', 'true');
        if (native.tabIndex !== -1) native.tabIndex = -1;
      }
      labels.forEach(label => { label.htmlFor = fallback ? native.id : trigger.id; });
      const selected = native.options[native.selectedIndex];
      value.textContent = optionText(selected) || '선택해 주세요';
      trigger.title = optionTitle(selected);
      trigger.disabled = native.disabled || !native.options.length;
      const accessibleLabel = native.getAttribute('aria-label');
      if (searchInput) {
        const searchLabel = accessibleLabel || labels.map(label => label.textContent.trim()).join(' ') || '권역';
        searchInput.setAttribute('aria-label', `${searchLabel.replace(/\s*선택\s*$/, '')} 검색`);
      }
      if (accessibleLabel) {
        trigger.setAttribute('aria-label', `${accessibleLabel}, ${value.textContent}`);
      } else if (labels.length) {
        const labelIds = labels.map((label, index) => {
          if (!label.id) label.id = `${id}-label-${index}`;
          return label.id;
        });
        trigger.setAttribute('aria-labelledby', `${labelIds.join(' ')} ${value.id}`);
      }
      if (trigger.disabled) close();
      if (!popup.hidden) {
        const enabled = available();
        if (!enabled.includes(focusIndex)) focusIndex = enabled.includes(native.selectedIndex) ? native.selectedIndex : (enabled[0] ?? -1);
        renderOptions();
        if (hadFocus && !hadSearchFocus) focusOption();
      }
    }
    function position() {
      if (popup.hidden) return;
      const viewport = window.visualViewport;
      const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
      const anchor = wrapper.getBoundingClientRect();
      const below = top + height - 16 - anchor.bottom - 7, above = anchor.top - top - 16 - 7;
      popup.style.maxWidth = `${Math.max(0, width - 32)}px`;
      popup.style.maxHeight = `${Math.max(0, Math.min(240, height - 32, Math.max(above, below)))}px`;
      const bounds = popup.getBoundingClientRect();
      const popupLeft = Math.max(left + 16, Math.min(anchor.left, left + width - 16 - bounds.width));
      const preferredTop = bounds.height > below && above > below ? anchor.top - 7 - bounds.height : anchor.bottom + 7;
      const popupTop = Math.max(top + 16, Math.min(preferredTop, top + height - 16 - bounds.height));
      popup.style.left = `${popupLeft - anchor.left}px`; popup.style.right = 'auto';
      popup.style.top = `${popupTop - anchor.top}px`; popup.style.bottom = 'auto';
    }
    function open() {
      query = '';
      if (searchInput) searchInput.value = '';
      sync();
      if (native.disabled || native.multiple || !native.options.length) return;
      if (active && active !== component) active.close();
      active = component;
      const enabled = available();
      focusIndex = enabled.includes(native.selectedIndex) ? native.selectedIndex : (enabled[0] ?? -1);
      renderOptions();
      popup.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      position();
      if (searchInput) searchInput.focus({ preventScroll: true }); else focusOption();
    }
    function choose(index) {
      const option = native.options[index];
      if (!option || option.disabled || native.disabled) return;
      const changed = native.selectedIndex !== index;
      native.selectedIndex = index;
      close(true);
      sync();
      if (changed) native.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function move(step, boundary) {
      const enabled = available();
      if (!enabled.length) return;
      focusIndex = boundary === 'first' ? enabled[0] : boundary === 'last' ? enabled[enabled.length - 1] : enabled[(enabled.indexOf(focusIndex) + step + enabled.length) % enabled.length];
      focusOption();
    }
    trigger.addEventListener('click', () => popup.hidden ? open() : close(true));
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (searchable) event.stopPropagation();
        open();
      }
    });
    if (searchInput) searchInput.addEventListener('input', () => {
      query = searchInput.value;
      const enabled = available();
      if (!enabled.includes(focusIndex)) focusIndex = enabled[0] ?? -1;
      renderOptions();
    });
    popup.addEventListener('click', event => {
      const option = event.target.closest('[data-index]');
      if (option && popup.contains(option)) choose(Number(option.dataset.index));
    });
    wrapper.addEventListener('keydown', event => {
      if (popup.hidden) return;
      if (event.target === searchInput) {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(0, event.key === 'ArrowDown' ? 'first' : 'last'); }
        else if (event.key === 'Enter') {
          event.preventDefault();
          const first = available()[0];
          if (first !== undefined) choose(first);
        }
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); move(0, event.key === 'Home' ? 'first' : 'last'); }
      else if (event.key === 'Enter' || event.key === ' ') {
        if (popup.contains(event.target)) { event.preventDefault(); choose(focusIndex); }
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
        event.preventDefault();
        const now = Date.now();
        search = now - searchAt > 700 ? event.key : search + event.key;
        searchAt = now;
        const query = search.toLocaleLowerCase('ko');
        const enabled = available();
        const index = enabled.find(index => optionText(native.options[index]).toLocaleLowerCase('ko').startsWith(query));
        if (index !== undefined) { focusIndex = index; focusOption(); }
      }
    });
    wrapper.addEventListener('focusout', event => {
      if (event.relatedTarget && wrapper.contains(event.relatedTarget)) return;
      if (event.relatedTarget && event.relatedTarget !== document.body && event.relatedTarget !== document.documentElement) { close(); return; }
      // Touch scrolling and the virtual keyboard can transiently report body/null.
      // A concrete outside focus target or outside pointer will dismiss the popup.
    });
    native.addEventListener('change', sync);
    const component = { native, wrapper, close, sync, position };
    components.set(native, component);
    sync();
  }

  function discover(root) {
    if (root.nodeType !== 1 || root.closest('.select-popover')) return;
    if (root.matches(selector)) enhance(root);
    root.querySelectorAll(selector).forEach(enhance);
  }
  function refresh() {
    discover(document.body);
    for (const [native, component] of components) {
      if (!native.isConnected || !component.wrapper.isConnected) {
        component.close();
        components.delete(native);
      } else component.sync();
    }
  }
  new MutationObserver(records => {
    const changed = new Set();
    let removed = false;
    for (const record of records) {
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const native = element?.closest('select');
      if (native && components.has(native)) changed.add(native);
      if (record.type === 'childList' && !element?.closest('.custom-select')) {
        record.addedNodes.forEach(discover);
        if (record.removedNodes.length) removed = true;
      }
    }
    for (const native of changed) components.get(native)?.sync();
    if (removed) for (const [native, component] of components) {
      if (!native.isConnected || !component.wrapper.isConnected) { component.close(); components.delete(native); }
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'multiple', 'selected', 'label', 'value', 'aria-label', 'title', 'data-search'] });
  document.addEventListener('pointerdown', event => { if (active && !active.wrapper.contains(event.target)) active.close(); });
  window.addEventListener('resize', () => active?.position());
  window.addEventListener('scroll', event => { if (active && (event.target === window || !active.wrapper.contains(event.target))) active.position(); }, true);
  window.visualViewport?.addEventListener('resize', () => active?.position());
  window.visualViewport?.addEventListener('scroll', () => active?.position());
  window.TravelSelect = { refresh };
  refresh();
})();

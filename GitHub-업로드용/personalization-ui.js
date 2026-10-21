(function () {
  'use strict';
  const TAGS = { must: '꼭 가기', booked: '예약 완료', flex: '여유롭게' };
  const data = note => note?.personalization || { checklist: [], favoritePlaceIds: [], eventTags: {} };
  const node = (tag, className = '', text = '') => {
    const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
  };
  const button = (text, action) => {
    const element = node('button', 'personal-button', text); element.type = 'button'; element.addEventListener('click', action); return element;
  };
  function mount(host, { onChange, onAdd }) {
    const checklist = node('details', 'personal-checklist'), checkSummary = node('summary');
    const checkBody = node('div', 'personal-panel-body'), checkList = node('ul', 'personal-checklist-items');
    const form = node('form', 'personal-checklist-form'); form.noValidate = true;
    const label = node('label', '', '준비물 추가'), input = node('input'); input.type = 'text'; input.maxLength = 120;
    input.placeholder = '예: 보조 배터리'; input.setAttribute('aria-label', '새 준비물'); label.append(input);
    const add = button('추가', () => {}); add.type = 'submit'; form.append(label, add);
    checkBody.append(form, node('p', 'personal-hint', '노트마다 최대 100개 · 준비물 이름 120자 이내'), checkList); checklist.append(checkSummary, checkBody);
    const favorites = node('details', 'personal-favorites'), favoriteSummary = node('summary');
    const favoriteBody = node('div', 'personal-panel-body'), dayHint = node('p', 'personal-hint');
    const favoriteList = node('ul', 'personal-favorite-list');
    const searchLabel = node('label', 'personal-place-search-label', '관심 관광지 찾기');
    const search = node('input'); search.type = 'search'; search.maxLength = 120; search.placeholder = '관광지 이름·주소';
    search.setAttribute('aria-label', '즐겨찾기할 관광지 검색'); searchLabel.append(search);
    const searchResult = node('p', 'personal-hint'), results = node('ul', 'personal-place-results'); searchResult.setAttribute('role', 'status');
    const status = node('p', 'personal-status'); status.setAttribute('role', 'status');
    favoriteBody.append(dayHint, favoriteList, searchLabel, searchResult, results); favorites.append(favoriteSummary, favoriteBody);
    host.append(checklist, favorites, status);
    let state = { itinerary: null, places: [], usedPlaceIds: new Set(), dayIndex: 0 };
    let printOpen = null;
    const current = () => data(state.itinerary);
    function change(next, message) {
      const result = onChange(next);
      status.textContent = result.ok ? message : result.reason;
      return result.ok;
    }
    function toggleFavorite(id) {
      const value = current(), selected = value.favoritePlaceIds.includes(id);
      return change({ ...value, favoritePlaceIds: selected ? value.favoritePlaceIds.filter(item => item !== id) : [...value.favoritePlaceIds, id] }, selected ? '즐겨찾기를 해제했어요.' : '즐겨찾기에 모아뒀어요.');
    }
    form.addEventListener('submit', event => {
      event.preventDefault(); const text = input.value.trim(), value = current();
      if (!text) { status.textContent = '준비물을 입력해 주세요.'; input.focus(); return; }
      const id = `item-${Math.max(0, ...value.checklist.map(item => Number(item.id.slice(5)))) + 1}`;
      if (change({ ...value, checklist: [...value.checklist, { id, text, done: false }] }, '준비물을 추가했어요.')) input.value = '';
      input.focus();
    });
    function renderChecklist() {
      const value = current(); checkSummary.textContent = `여행 준비물 · ${value.checklist.filter(item => item.done).length}/${value.checklist.length} 완료`;
      checkList.replaceChildren();
      if (!value.checklist.length) checkList.append(node('li', 'personal-hint', '필요한 준비물을 추가해 보세요.'));
      value.checklist.forEach(item => {
        const row = node('li'), label = node('label', 'personal-check-item'), checkbox = node('input');
        checkbox.type = 'checkbox'; checkbox.checked = item.done; checkbox.dataset.itemId = item.id;
        checkbox.addEventListener('change', () => {
          const value = current(), done = checkbox.checked;
          if (!change({ ...value, checklist: value.checklist.map(entry => entry.id === item.id ? { ...entry, done } : entry) }, done ? '준비 완료로 표시했어요.' : '준비 완료 표시를 해제했어요.')) checkbox.checked = item.done;
          [...checkList.querySelectorAll('input')].find(input => input.dataset.itemId === item.id)?.focus({ preventScroll: true });
        });
        const text = node('span', item.done ? 'is-done' : '', item.text); label.append(checkbox, text);
        const remove = button('삭제', () => {
          const value = current();
          if (change({ ...value, checklist: value.checklist.filter(entry => entry.id !== item.id) }, '준비물을 삭제했어요.')) input.focus();
        });
        remove.setAttribute('aria-label', `${item.text} 준비물 삭제`); row.append(label, remove); checkList.append(row);
      });
      add.disabled = value.checklist.length >= 100;
    }
    function renderFavorites() {
      const value = current(), byId = new Map(state.places.map(place => [place.id, place]));
      favoriteSummary.textContent = `관광지 즐겨찾기 · ${value.favoritePlaceIds.length}곳`;
      dayHint.textContent = `‘이 날짜에 담기’는 현재 보고 있는 Day ${String(state.dayIndex + 1).padStart(2, '0')} 일정에 추가해요. 뺀 추천 장소는 원래 날짜의 복구 목록에서 다시 담아 주세요. 즐겨찾기는 노트마다 최대 100곳이에요.`;
      favoriteList.replaceChildren();
      if (!value.favoritePlaceIds.length) favoriteList.append(node('li', 'personal-hint', '일정의 별 버튼이나 아래 검색으로 관심 장소를 모아보세요.'));
      value.favoritePlaceIds.forEach(id => {
        const place = byId.get(id), row = node('li', 'personal-place-row'), copy = node('div', 'personal-place-copy');
        copy.append(node('strong', '', place?.name || '현재 관광정보에서 찾을 수 없는 장소'), node('span', '', place?.address || id));
        const actions = node('div', 'personal-place-actions');
        const add = button(state.excludedPlaceIds?.has(id) ? '뺀 일정에서 복구' : state.usedPlaceIds.has(id) ? '일정에 담김' : '이 날짜에 담기', () => {
          const result = onAdd(id); status.textContent = result.ok ? '현재 날짜 일정에 담았어요.' : result.reason;
        });
        add.disabled = !place || state.usedPlaceIds.has(id);
        add.setAttribute('aria-label', `${place?.name || id} 현재 날짜 일정에 담기`);
        const remove = button('즐겨찾기 해제', () => toggleFavorite(id)); remove.setAttribute('aria-label', `${place?.name || id} 즐겨찾기 해제`);
        actions.append(add, remove); row.append(copy, actions); favoriteList.append(row);
      });
      renderResults();
    }
    function renderResults() {
      results.replaceChildren();
      const query = search.value.normalize('NFKC').trim().toLowerCase();
      if (!query) { searchResult.textContent = '현재 여행 지역의 관광지 이름이나 주소를 검색해 보세요.'; return; }
      const matches = state.places.filter(place => `${place.name} ${place.address || ''}`.normalize('NFKC').toLowerCase().includes(query));
      searchResult.textContent = matches.length ? `${matches.length}곳${matches.length > 20 ? ' 중 앞의 20곳 표시' : ''}` : '검색 결과가 없어요.';
      matches.slice(0, 20).forEach(place => {
        const row = node('li', 'personal-place-row'), title = node('span', 'personal-place-copy', place.name);
        const selected = current().favoritePlaceIds.includes(place.id), star = button(selected ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기', () => {
          toggleFavorite(place.id);
          [...results.querySelectorAll('button')].find(button => button.dataset.placeId === place.id)?.focus({ preventScroll: true });
        });
        star.dataset.placeId = place.id; star.setAttribute('aria-pressed', String(selected)); star.setAttribute('aria-label', `${place.name} 즐겨찾기`);
        row.append(title, star); results.append(row);
      });
    }
    search.addEventListener('input', renderResults);
    return {
      render(next) { state = next; host.hidden = !state.itinerary; status.textContent = ''; renderChecklist(); renderFavorites(); },
      reset() { state = { itinerary: null, places: [], usedPlaceIds: new Set(), dayIndex: 0 }; printOpen = null; input.value = ''; search.value = ''; status.textContent = ''; checkList.replaceChildren(); favoriteList.replaceChildren(); results.replaceChildren(); checkSummary.textContent = ''; favoriteSummary.textContent = ''; dayHint.textContent = ''; searchResult.textContent = ''; checklist.open = favorites.open = false; host.hidden = true; },
      preparePrint() { if (printOpen === null) printOpen = checklist.open; checklist.open = true; },
      finishPrint() { if (printOpen !== null) checklist.open = printOpen; printOpen = null; },
      toggleFavorite
    };
  }
  function mountEvent(content, row, event, dayIndex, { onTag, onFavorite }) {
    const controls = node('div', 'event-personal-controls'), label = node('label');
    const select = node('select', 'event-tag-select'); select.setAttribute('aria-label', `${dayIndex + 1}일차 ${event.place?.name || event.title || '일정'} 색상 태그`);
    for (const [value, caption] of [['', '태그 없음'], ...Object.entries(TAGS)]) { const option = node('option', '', caption); option.value = value; select.append(option); }
    const badge = node('span', 'event-tag-badge'); content.prepend(badge); label.append(select); controls.append(label);
    const favorite = event.type === 'place' ? button('☆ 즐겨찾기', () => onFavorite(event.place.id)) : null;
    if (favorite) { favorite.className += ' event-favorite-button'; favorite.setAttribute('aria-label', `${event.place.name} 즐겨찾기`); controls.append(favorite); }
    content.append(controls);
    let current = {};
    select.addEventListener('change', () => { if (!onTag(dayIndex, event.id, select.value).ok) sync(current); });
    function sync(value) {
      current = value; const tag = value.eventTags?.[dayIndex]?.[event.id] || '';
      select.value = tag; row.dataset.personalTag = tag; badge.textContent = TAGS[tag] || ''; badge.hidden = !tag;
      if (favorite) { const selected = value.favoritePlaceIds?.includes(event.place.id) || false; favorite.textContent = selected ? '★ 즐겨찾기' : '☆ 즐겨찾기'; favorite.setAttribute('aria-pressed', String(selected)); }
    }
    return { sync };
  }
  window.TravelPersonalization = { mount, mountEvent, data, TAGS };
})();

(function () {
  'use strict';
  const sourceUrl = 'https://www.culture.go.kr/data/openapi/openapiView.do?id=603';
  const tourSourceUrl = 'https://www.data.go.kr/data/15101578/openapi.do';
  const text = (value, maximum, required = true) => typeof value === 'string' && (!required || value.trim().length > 0)
    && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
  const point = (latitude, longitude) => Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= 33 && latitude <= 39.5 && longitude >= 124 && longitude <= 132;
  const provinces = new Set([
    '서울', '서울특별시', '서울시', '부산', '부산광역시', '부산시', '대구', '대구광역시', '대구시',
    '인천', '인천광역시', '인천시', '광주', '광주광역시', '전남광주통합특별시', '대전', '대전광역시', '대전시',
    '울산', '울산광역시', '울산시', '세종', '세종특별자치시', '세종시', '경기', '경기도',
    '강원', '강원특별자치도', '강원도', '충북', '충청북도', '충남', '충청남도',
    '전북', '전북특별자치도', '전라북도', '전남', '전라남도', '경북', '경상북도',
    '경남', '경상남도', '제주', '제주특별자치도', '제주도'
  ]);
  function districtFromAddress(address) {
    if (typeof address !== 'string' || address.length > 500) return '';
    const tokens = address.normalize('NFKC').trim().replace(/^대한민국\s+/, '').split(/\s+/);
    if (!provinces.has(tokens[0]) || !/^[가-힣]+[시군구]$/.test(tokens[1] || '')) return '';
    const district = /시$/.test(tokens[1]) && /^[가-힣]+구$/.test(tokens[2] || '') ? `${tokens[1]} ${tokens[2]}` : tokens[1];
    return district.length <= 60 ? district : '';
  }

  function mount(host, { area = '', district = '', latitude = null, longitude = null, onSelect = null } = {}) {
    const region = typeof area === 'string' ? area.trim() : '';
    const selectedDistrict = typeof district === 'string' ? district.trim().replace(/ +/g, ' ') : '';
    const districtReady = typeof district === 'string' && (selectedDistrict === '' || (selectedDistrict.length >= 2
      && selectedDistrict.length <= 60 && /^[가-힣]+[시군구](?: [가-힣]+구)?$/.test(selectedDistrict)));
    const ready = region.length >= 2 && region.length <= 80 && /^[가-힣0-9 ·.-]+$/.test(region) && districtReady;
    const scopeLabel = [region, selectedDistrict].filter(Boolean).join(' ');
    const hasPoint = point(latitude, longitude);
    const canSelect = typeof onSelect === 'function';
    const details = document.createElement('details'); details.className = 'restaurant-lookup';
    const summary = document.createElement('summary');
    const heading = document.createElement('strong'); heading.className = 'restaurant-heading'; heading.textContent = '지역 맛집 보기';
    const preview = document.createElement('span'); preview.className = 'restaurant-preview'; preview.textContent = ready ? `${scopeLabel} · 음식점 전체` : '여행 지역을 먼저 선택해 주세요';
    const action = document.createElement('span'); action.className = 'restaurant-summary-action'; action.textContent = '목록';
    summary.append(heading, preview, action);
    const body = document.createElement('div'); body.className = 'restaurant-body';
    const controls = document.createElement('div'); controls.className = 'restaurant-controls';
    const introduction = document.createElement('span'); introduction.className = 'restaurant-introduction'; introduction.textContent = '음식 종류 구분 없이 모았어요.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'restaurant-refresh'; retry.textContent = '다시 찾기'; retry.disabled = !ready;
    controls.append(introduction, retry);
    const message = document.createElement('p'); message.className = 'restaurant-message'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const results = document.createElement('ul'); results.className = 'restaurant-results'; results.setAttribute('aria-label', '지역 음식점 목록');
    const more = document.createElement('button'); more.type = 'button'; more.className = 'restaurant-more'; more.hidden = true;
    const note = document.createElement('p'); note.className = 'restaurant-note';
    note.textContent = `${scopeLabel} 안의 음식점을 보여드려요.${hasPoint ? ' 거리는 주변 관광지에서의 직선거리예요.' : ''} 방문 전 위치와 영업 여부를 확인해 주세요.`;
    body.append(controls, message, results, more, note); details.append(summary, body); host.replaceChildren(details);
    let destroyed = false, token = 0, pending = null, timeout = null, progress = null, loaded = false, items = [], shown = 0;
    let selecting = false, selectionVersion = 0, selectedId = null;
    const selectionButtons = new Map();

    function showMessage(value, error = false) { message.textContent = value; message.classList.toggle('is-error', error); }
    function valid(item) {
      if (!item || typeof item.id !== 'string') return false;
      const knownSource = (/^culture-[a-f0-9]{24}$/.test(item.id) && item.source === '한국문화정보원' && item.sourceUrl === sourceUrl)
        || (/^tour-food-[1-9]\d{0,19}$/.test(item.id) && item.source === '한국관광공사 TourAPI' && item.sourceUrl === tourSourceUrl);
      if (!knownSource || !text(item.name, 160) || !text(item.address, 300)
        || !text(item.branch, 120, false) || !text(item.category, 40)
        || !text(item.updatedAt, 40, false)) return false;
      if (!(item.latitude === null && item.longitude === null) && !point(item.latitude, item.longitude)) return false;
      return item.distanceKm === undefined || (hasPoint && point(item.latitude, item.longitude)
        && Number.isFinite(item.distanceKm) && item.distanceKm >= 0 && item.distanceKm <= 2000);
    }
    function updateSelectionButtons(active = null) {
      for (const [button, item] of selectionButtons) {
        button.disabled = selecting || item.id === selectedId;
        button.textContent = selecting && button === active ? '담는 중…' : item.id === selectedId ? '담은 식당' : '식사 일정에 담기';
        button.setAttribute('aria-busy', String(selecting && button === active));
      }
    }
    async function selectItem(item, button, listVersion) {
      if (destroyed || selecting || pending || listVersion !== token || !items.includes(item) || item.id === selectedId) return;
      selecting = true;
      const version = ++selectionVersion;
      updateSelectionButtons(button); retry.disabled = true; more.disabled = true;
      showMessage('식사 일정에 담고 있어요.');
      const selected = Object.freeze({
        id: item.id, name: item.name, branch: item.branch, category: item.category, address: item.address,
        latitude: item.latitude, longitude: item.longitude, updatedAt: item.updatedAt,
        source: item.source, sourceUrl: item.sourceUrl,
        ...(item.distanceKm === undefined ? {} : { distanceKm: item.distanceKm })
      });
      try {
        const outcome = await onSelect(selected);
        if (destroyed || version !== selectionVersion || listVersion !== token) return;
        if (outcome?.ok === true) {
          selectedId = item.id;
          showMessage('선택한 식당을 담았어요. 식당까지 오가는 이동시간은 포함되지 않으니 이동 일정을 직접 추가해 주세요.');
        } else showMessage(text(outcome?.reason, 500) ? outcome.reason : '식사 일정에 담지 못했어요. 다시 시도해 주세요.', true);
      } catch (_error) {
        if (!destroyed && version === selectionVersion && listVersion === token)
          showMessage('식사 일정에 담지 못했어요. 다시 시도해 주세요.', true);
      } finally {
        if (!destroyed && version === selectionVersion && listVersion === token) {
          selecting = false; updateSelectionButtons(); retry.disabled = !ready; more.disabled = false;
        }
      }
    }
    function addItems() {
      if (destroyed || selecting) return;
      const end = Math.min(shown === 0 ? 5 : shown + 10, items.length);
      for (let index = shown; index < end; index++) {
        const item = items[index];
        const card = document.createElement('li'); card.className = 'restaurant-card';
        const copy = document.createElement('div'); copy.className = 'restaurant-copy';
        const name = document.createElement('strong'); name.className = 'restaurant-name';
        name.textContent = item.branch && !item.name.includes(item.branch) ? `${item.name} ${item.branch}` : item.name;
        const meta = document.createElement('span'); meta.className = 'restaurant-meta';
        meta.textContent = [item.category, item.distanceKm === undefined ? '' : `직선 ${item.distanceKm < 1 ? `${Math.round(item.distanceKm * 1000)}m` : `${item.distanceKm.toFixed(1)}km`}`].filter(Boolean).join(' · ');
        const address = document.createElement('p'); address.className = 'restaurant-address'; address.textContent = item.address;
        const map = document.createElement('a'); map.className = 'restaurant-map'; map.target = '_blank'; map.rel = 'noopener noreferrer';
        map.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name.textContent} ${item.address}`)}`;
        map.textContent = '지도 보기 ↗'; map.setAttribute('aria-label', `${name.textContent} 지도 보기 (새 창)`);
        copy.append(name, meta, address);
        if (window.TravelNoteTools) copy.append(window.TravelNoteTools.addressCopy(item.address, name.textContent));
        if (canSelect) {
          const actions = document.createElement('div'); actions.className = 'restaurant-actions';
          const select = document.createElement('button'); select.type = 'button'; select.className = 'restaurant-select';
          select.setAttribute('aria-label', `${name.textContent} 식사 일정에 담기`);
          const listVersion = token;
          select.addEventListener('click', () => selectItem(item, select, listVersion));
          selectionButtons.set(select, item); actions.append(map, select); card.append(copy, actions);
        } else card.append(copy, map);
        results.append(card);
      }
      updateSelectionButtons();
      shown = end; more.hidden = shown >= items.length;
      more.textContent = `음식점 더 보기 (${shown}/${items.length})`;
    }
    async function search() {
      if (destroyed || !ready || selecting) return;
      pending?.abort(); if (timeout !== null) clearTimeout(timeout);
      if (progress !== null) clearTimeout(progress);
      const version = ++token, controller = new AbortController(); pending = controller;
      const timer = setTimeout(() => controller.abort(), 70000); timeout = timer;
      loaded = false; items = []; shown = 0; selectionButtons.clear(); results.replaceChildren(); results.setAttribute('aria-busy', 'true'); more.hidden = true;
      retry.disabled = true; retry.setAttribute('aria-busy', 'true'); preview.textContent = `${scopeLabel} · 음식점 전체`;
      showMessage('이 지역의 음식점을 찾고 있어요.');
      const progressTimer=setTimeout(()=>{if(!destroyed&&version===token)showMessage('제공기관의 응답을 기다리고 있어요. 첫 조회에는 시간이 조금 걸릴 수 있어요.');},10000);progress=progressTimer;
      try {
        const query = new URLSearchParams({ area: region });
        if (selectedDistrict) query.set('district', selectedDistrict);
        if (hasPoint) { query.set('latitude', String(latitude)); query.set('longitude', String(longitude)); }
        const response = await fetch(`/api/restaurants?${query}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
        const data = await response.json();
        if (destroyed || version !== token) return;
        if (!response.ok) {
          showMessage(response.status === 429 ? '조회가 많아 잠시 쉬고 있어요. 조금 뒤 다시 찾아주세요.'
            : response.status === 503 ? '맛집 정보를 준비 중이에요. 잠시 후 다시 확인해 주세요.'
              : response.status === 504 ? '음식점 정보 응답이 늦어지고 있어요. 잠시 후 다시 찾아주세요.'
              : '음식점 정보를 불러오지 못했어요. 잠시 후 다시 찾아주세요.', true);
          return;
        }
        if (!Array.isArray(data.items) || data.items.length > 50 || data.items.some(item => !valid(item))) throw new Error('Invalid restaurants');
        const seen = new Set(); items = data.items.filter(item => !seen.has(item.id) && seen.add(item.id)); loaded = true;
        if (!items.length) showMessage('이 지역에는 조회된 음식점이 없어요.');
        else { showMessage(`${items.length}곳${data.truncated ? ' · 조회된 후보 중 일부를 보여드려요.' : '을 찾았어요.'}`); addItems(); }
      } catch (error) {
        if (destroyed || version !== token) return;
        showMessage(error?.name === 'AbortError' ? '음식점 조회가 늦어지고 있어요. 잠시 후 다시 찾아주세요.' : '음식점 정보에 연결하지 못했어요. 잠시 후 다시 찾아주세요.', true);
      } finally {
        clearTimeout(timer);
        clearTimeout(progressTimer);
        if (!destroyed && version === token) { timeout = null; progress = null; pending = null; retry.disabled = !ready; retry.setAttribute('aria-busy', 'false'); results.setAttribute('aria-busy', 'false'); }
      }
    }
    retry.addEventListener('click', search); more.addEventListener('click', addItems);
    details.addEventListener('toggle', () => { if (details.open && !loaded && !pending) search(); });
    if (!ready) showMessage('여행 지역을 선택하면 음식점을 찾아드릴게요.');
    return { destroy() { if (destroyed) return; destroyed = true; token++; selectionVersion++; selectionButtons.clear(); pending?.abort(); if (timeout !== null) clearTimeout(timeout); if(progress!==null)clearTimeout(progress); if (details.parentNode === host) host.replaceChildren(); } };
  }
  function mountManual(host, { name = '', description = '', onSave = null, onClear = null } = {}) {
    const validDescription = value => typeof value === 'string' && value.length <= 500 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
    const details = document.createElement('details'); details.className = 'restaurant-lookup restaurant-manual';
    const summary = document.createElement('summary');
    const heading = document.createElement('strong'); heading.className = 'restaurant-heading'; heading.textContent = '식당 직접 입력';
    const preview = document.createElement('span'); preview.className = 'restaurant-preview'; preview.textContent = text(name, 60) ? name : '가고 싶은 식당을 적어 주세요';
    const action = document.createElement('span'); action.className = 'restaurant-summary-action'; action.textContent = '입력';
    summary.append(heading, preview, action);
    const body = document.createElement('div'); body.className = 'restaurant-body restaurant-manual-body';
    const nameLabel = document.createElement('label'); nameLabel.className = 'restaurant-manual-label'; nameLabel.textContent = '식당 이름 (필수, 최대 60자)';
    const nameInput = document.createElement('input'); nameInput.type = 'text'; nameInput.className = 'restaurant-manual-name'; nameInput.maxLength = 60; nameInput.required = true; nameInput.autocomplete = 'off'; nameInput.value = typeof name === 'string' ? name : ''; nameLabel.append(nameInput);
    const memoLabel = document.createElement('label'); memoLabel.className = 'restaurant-manual-label'; memoLabel.textContent = '주소·메모 (선택, 최대 500자)';
    const memoInput = document.createElement('textarea'); memoInput.rows = 3; memoInput.className = 'restaurant-manual-description'; memoInput.maxLength = 500; memoInput.autocomplete = 'off'; memoInput.value = typeof description === 'string' ? description : ''; memoLabel.append(memoInput);
    const updateMemoCount = window.TravelNoteTools?.memoCounter(memoInput);
    const actions = document.createElement('div'); actions.className = 'restaurant-manual-actions';
    const save = document.createElement('button'); save.type = 'button'; save.className = 'restaurant-manual-save'; save.textContent = '식사 일정에 저장'; save.disabled = typeof onSave !== 'function';
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'restaurant-manual-clear'; clear.textContent = '식당 정보 지우기'; clear.disabled = typeof onClear !== 'function'; actions.append(save, clear);
    const message = document.createElement('p'); message.className = 'restaurant-message'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const note = document.createElement('p'); note.className = 'restaurant-note'; note.textContent = '직접 입력한 정보는 따로 조회하지 않아요. 위치·영업시간과 오가는 이동시간을 확인해 주세요.';
    body.append(nameLabel, memoLabel, actions, message, note); details.append(summary, body); host.replaceChildren(details);
    let destroyed = false, pending = false, version = 0;
    const current = () => !destroyed && details.parentNode === host;
    function show(value, error = false) { message.textContent = value; message.classList.toggle('is-error', error); }
    function busy(value) {
      save.disabled = value || typeof onSave !== 'function'; clear.disabled = value || typeof onClear !== 'function';
      nameInput.disabled = value; memoInput.disabled = value; body.setAttribute('aria-busy', String(value));
    }
    async function perform(clearing) {
      if (!current() || pending || typeof (clearing ? onClear : onSave) !== 'function') return;
      const rawName = nameInput.value, rawMemo = memoInput.value;
      const validName = text(rawName, 60), validMemo = validDescription(rawMemo);
      if (!clearing) {
        nameInput.setAttribute('aria-invalid', String(!validName)); memoInput.setAttribute('aria-invalid', String(!validMemo));
        if (!validName || !validMemo) { show(!validName ? '식당 이름을 1~60자로 입력해 주세요. 줄바꿈이나 제어문자는 사용할 수 없어요.' : '주소·메모는 500자 이내로 입력해 주세요. 특수 제어문자는 사용할 수 없어요.', true); return; }
      }
      pending = true; const operation = ++version; busy(true); show(clearing ? '입력한 식당을 지우고 있어요.' : '식당을 저장하고 있어요.');
      try {
        const value = clearing ? undefined : Object.freeze({ name: rawName.trim(), description: rawMemo.trim() });
        const outcome = await (clearing ? onClear() : onSave(value));
        if (!current() || operation !== version) return;
        if (outcome?.ok === true) {
          if (clearing) { nameInput.value = ''; memoInput.value = ''; updateMemoCount?.(); nameInput.setAttribute('aria-invalid', 'false'); memoInput.setAttribute('aria-invalid', 'false'); }
          preview.textContent = clearing ? '가고 싶은 식당을 적어 주세요' : value.name;
          show(clearing ? '입력한 식당을 지웠어요.' : '식사 일정에 저장했어요. 식당까지 오가는 이동시간은 직접 확인해 주세요.');
        } else show(text(outcome?.reason, 500) ? outcome.reason : '변경 내용을 저장하지 못했어요. 다시 시도해 주세요.', true);
      } catch (_error) {
        if (current() && operation === version) show('변경 내용을 저장하지 못했어요. 다시 시도해 주세요.', true);
      } finally { if (current() && operation === version) { pending = false; busy(false); } }
    }
    const saveClick = () => perform(false), clearClick = () => perform(true);
    save.addEventListener('click', saveClick); clear.addEventListener('click', clearClick);
    return { destroy() { if (destroyed) return; destroyed = true; version++; save.removeEventListener('click', saveClick); clear.removeEventListener('click', clearClick); if (details.parentNode === host) host.replaceChildren(); } };
  }
  window.TravelRestaurants = { mount, mountManual, districtFromAddress };
})();

(function () {
  'use strict';
  const mounts = new WeakMap();
  const modes = { train: '기차', bus: '시외·고속버스', flight: '비행기', ferry: '배', car: '차량', 'local-bus': '시내·마을버스', subway: '지하철', walk: '도보' };
  const localModes = ['local-bus', 'subway', 'walk'];
  const regionalModes = ['train', 'bus', 'flight', 'ferry'];
  const transportServices = {
    train: { mode: 'train', label: '기차', sourceUrl: 'https://www.data.go.kr/data/15098552/openapi.do' },
    express: { mode: 'bus', label: '고속버스', sourceUrl: 'https://www.data.go.kr/data/15098522/openapi.do' },
    intercity: { mode: 'bus', label: '시외버스', sourceUrl: 'https://www.data.go.kr/data/15098541/openapi.do' },
    flight: { mode: 'flight', label: '항공', sourceUrl: 'https://www.data.go.kr/data/15098526/openapi.do' },
    ferry: { mode: 'ferry', label: '여객선', sourceUrl: 'https://www.data.go.kr/data/15098523/openapi.do' }
  };
  const placeholders = { train: '예: 서울역', bus: '예: 서울고속버스터미널', flight: '예: 김포국제공항', ferry: '예: 부산항여객터미널', car: '예: 도로명 주소 또는 장소 이름' };
  const arrivals = {
    train: { heading: '도착역', empty: '도착역을 골라주세요', placeholder: '예: 부산역', intro: '기차에서 내릴 도착역을 검색해 주세요.' },
    bus: { heading: '도착터미널', empty: '도착터미널을 골라주세요', placeholder: '예: 부산종합버스터미널', intro: '버스에서 내릴 도착 터미널을 검색해 주세요.' },
    flight: { heading: '도착공항', empty: '도착공항을 골라주세요', placeholder: '예: 제주국제공항', intro: '비행기에서 내릴 도착 공항을 검색해 주세요.' },
    ferry: { heading: '도착항구', empty: '도착항구를 골라주세요', placeholder: '예: 제주항여객터미널', intro: '배에서 내릴 여객터미널이나 항구를 검색해 주세요.' }
  };
  let sequence = 0;

  function normalize(item) {
    if (!item || typeof item !== 'object') return null;
    const id = typeof item.id === 'string' ? item.id : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const address = typeof item.address === 'string' ? item.address.trim() : '';
    if (!name || name.length > 120 || typeof item.address !== 'string' || item.address.length > 300) return null;
    if (item.source === 'TAGO') {
      const service = typeof item.service === 'string' && Object.prototype.hasOwnProperty.call(transportServices, item.service) ? item.service : null;
      const config = service && transportServices[service];
      const providerId = typeof item.providerId === 'string' ? item.providerId : '';
      if (!config || !providerId || providerId.length > 80 || !/^[A-Za-z0-9_-]+$/.test(providerId)
          || id !== `tago-${service}-${providerId}` || item.mode !== config.mode || item.sourceUrl !== config.sourceUrl
          || item.latitude !== null || item.longitude !== null) return null;
      return { id, providerId, service, mode: config.mode, name, address, latitude: null, longitude: null, source: 'TAGO', sourceUrl: config.sourceUrl };
    }
    if (item.source !== 'OpenStreetMap') return null;
    const osm = /^osm-(node|way|relation)-([1-9]\d*)$/.exec(id);
    if (!osm || id.length > 100) return null;
    const latitude = item.latitude, longitude = item.longitude;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < 33 || latitude > 39.5 || longitude < 124 || longitude > 132) return null;
    const sourceUrl = `https://www.openstreetmap.org/${osm[1]}/${osm[2]}`;
    if (item.sourceUrl !== sourceUrl) return null;
    return { id, name, address, latitude, longitude, source: 'OpenStreetMap', sourceUrl };
  }

  function mount(host, { departure = null, onChange, role = 'departure', mode: externalMode = null, service: externalService = null, heading = null } = {}) {
    if (!host || typeof host.replaceChildren !== 'function') throw new TypeError('출발지 입력창을 넣을 요소가 필요합니다.');
    mounts.get(host)?.destroy();
    const isArrival = role === 'arrival';
    const headingLabel = isArrival && ['환승역', '환승터미널', '환승공항', '환승항구'].includes(heading) ? heading : null;
    const noun = isArrival ? headingLabel ? '환승지' : '도착지' : '출발지';
    let arrivalMode = Object.prototype.hasOwnProperty.call(arrivals, externalMode) ? externalMode : '';
    const id = `day-origin-${++sequence}`;
    const details = document.createElement('details');
    details.className = `day-origin${isArrival ? ' day-origin-arrival' : ''}`;
    details.innerHTML = `
      <summary class="day-origin-summary"><span class="day-origin-heading">${noun}</span><span class="day-origin-preview"><strong class="day-origin-name">${noun}를 골라주세요</strong><small class="day-origin-mode" hidden></small></span><span class="day-origin-action">선택·변경</span></summary>
      <fieldset class="departure-settings" aria-label="이 날의 ${noun}">
        <p class="departure-intro"></p>
        <div class="departure-grid">
          <div class="field origin-mode-field"${isArrival ? ' hidden' : ''}><label for="${id}-mode">이동 수단</label><select id="${id}-mode" class="departure-mode-select"${isArrival ? ' disabled' : ''}><option value="">이동 수단 선택</option><option value="car">차량</option><option value="group-local" disabled>여행지 안에서 이동</option>${localModes.map(value => `<option value="${value}">${modes[value]}</option>`).join('')}<option value="group-regional" disabled>지역 간 이동</option>${regionalModes.map(value => `<option value="${value}">${modes[value]}</option>`).join('')}</select></div>
          <div class="field"><label for="${id}-query">${headingLabel ? '환승' : isArrival ? '도착' : '출발'} 장소</label><div class="origin-searchbar"><input id="${id}-query" class="origin-query" type="text" autocomplete="off" autocapitalize="off" enterkeyhint="search" spellcheck="false"><button class="origin-search" type="button" data-departure-action="search">검색</button></div></div>
        </div>
        <p class="origin-message" role="status" aria-live="polite" aria-atomic="true"></p>
        <div class="origin-results" role="group" aria-label="${noun} 검색 결과"></div>
        <div class="origin-selected" hidden></div>
      </fieldset>`;
    host.replaceChildren(details);
    const fieldset = details.querySelector('.departure-settings');
    const mode = details.querySelector('.departure-mode-select');
    const query = details.querySelector('.origin-query');
    const searchButton = details.querySelector('.origin-search');
    const results = details.querySelector('.origin-results');
    const selectedBox = details.querySelector('.origin-selected');
    const message = details.querySelector('.origin-message');
    const summary = details.querySelector('.day-origin-summary');
    const summaryName = details.querySelector('.day-origin-name');
    const summaryMode = details.querySelector('.day-origin-mode');
    const summaryHeading = details.querySelector('.day-origin-heading');
    const intro = details.querySelector('.departure-intro');
    const listeners = [];
    let selected = null;
    let found = [];
    let requestToken = 0;
    let pending = null;
    let timeout = null;
    let destroyed = false;
    let composing = false;

    function currentMode() { return isArrival ? arrivalMode : mode.value; }
    function matchesContext(item, requestedMode) {
      if (item.source !== 'TAGO') return true;
      return item.mode === requestedMode && (!isArrival || !externalService || item.service === externalService);
    }
    function arrivalCopy() {
      const copy = arrivals[arrivalMode] || { heading: '도착지', empty: '도착지를 골라주세요', placeholder: '출발지의 이동 수단을 먼저 선택해 주세요', intro: '출발지에서 기차·버스·비행기·배를 고르면 도착 장소를 검색할 수 있어요.' };
      return headingLabel ? { ...copy, heading: headingLabel, empty: '환승할 장소를 골라주세요', intro: '다음 교통편으로 갈아탈 장소를 검색해 주세요.' } : copy;
    }

    function listen(element, type, handler) { element.addEventListener(type, handler); listeners.push(() => element.removeEventListener(type, handler)); }
    function get() { return selected ? { ...selected } : null; }
    function notify() { if (!destroyed && typeof onChange === 'function') onChange(get(), { mode: currentMode() }); }
    function setMessage(text, error = false) { message.textContent = text; message.classList.toggle('is-error', error); }
    function setBusy(busy) { searchButton.disabled = busy || (isArrival && !arrivals[arrivalMode]); searchButton.setAttribute('aria-busy', String(busy)); }
    function invalidate() {
      requestToken++;
      if (pending) { pending.abort(); pending = null; }
      if (timeout !== null) { clearTimeout(timeout); timeout = null; }
      setBusy(false);
      found = [];
      results.replaceChildren();
    }
    function serviceInfo(item) {
      const row = document.createElement('div');
      row.className = 'origin-service-info';
      const badge = document.createElement('span');
      badge.className = 'origin-service-badge';
      badge.textContent = transportServices[item.service].label;
      row.append(badge);
      return row;
    }
    function renderSelected() {
      selectedBox.replaceChildren();
      selectedBox.hidden = !selected;
      details.classList.toggle('has-origin', Boolean(selected));
      summaryHeading.textContent = isArrival ? arrivalCopy().heading : '출발지';
      summaryName.textContent = selected?.name || (isArrival ? arrivalCopy().empty : '출발지를 골라주세요');
      summaryMode.hidden = !selected;
      summaryMode.textContent = selected ? selected.source === 'TAGO' ? transportServices[selected.service].label : modes[selected.mode] : '';
      summary.title = selected ? [selected.name, selected.address].filter(Boolean).join(' · ') : `이 날의 ${noun}를 선택해 주세요`;
      if (!selected) return;
      const copy = document.createElement('div');
      copy.className = 'origin-selection-copy';
      const name = document.createElement('strong');
      name.textContent = selected.name;
      copy.append(name);
      if (selected.source === 'TAGO') copy.append(serviceInfo(selected));
      if (selected.address) {
        const address = document.createElement('span');
        if (selected.source === 'TAGO') address.className = 'origin-stop-note';
        address.textContent = selected.source === 'TAGO' ? `안내: ${selected.address}` : selected.address;
        copy.append(address);
      }
      if (selected.source === 'OpenStreetMap' && regionalModes.includes(selected.mode)) {
        const legacy = document.createElement('span');
        legacy.className = 'origin-legacy-note';
        legacy.textContent = '저장된 지도 장소예요. 실제 시간표를 확인하려면 정류장을 다시 선택해 주세요.';
        copy.append(legacy);
      }
      const clear = document.createElement('button');
      clear.className = 'origin-clear';
      clear.type = 'button';
      clear.dataset.departureAction = 'clear';
      clear.textContent = '지우기';
      clear.setAttribute('aria-label', `선택한 ${noun} 지우기`);
      selectedBox.append(copy, clear);
    }
    function placeholder() {
      query.placeholder = isArrival ? arrivalCopy().placeholder : localModes.includes(mode.value) ? '예: 숙소 이름 또는 도로명 주소' : placeholders[mode.value] || '이동 수단을 고른 뒤 출발지를 검색해 주세요';
      query.disabled = isArrival && !arrivals[arrivalMode];
      intro.textContent = isArrival ? arrivalCopy().intro : localModes.includes(mode.value) ? '숙소나 역, 주소에서 출발해 첫 관광지로 이동해요.' : '역·터미널·공항이나 도로명 주소를 검색해 보세요.';
      if (!isArrival && regionalModes.includes(mode.value)) intro.textContent = mode.value === 'bus' ? '시간표에 연결할 고속·시외버스 터미널을 검색해 주세요. 결과에서 종류를 확인해요.' : '실제 시간표에 연결할 역·공항·여객터미널을 검색해 주세요.';
      if (isArrival && !headingLabel && arrivalMode === 'bus' && transportServices[externalService]?.mode === 'bus') intro.textContent = `${transportServices[externalService].label}에서 내릴 도착 터미널을 검색해 주세요.`;
      setBusy(false);
    }
    function choose(item, searchMode) {
      if (destroyed || currentMode() !== searchMode || !matchesContext(item, searchMode)) return;
      invalidate();
      selected = { ...item, mode: searchMode };
      query.value = item.name;
      renderSelected();
      setMessage(`${noun}를 선택했어요.`);
      details.open = false;
      notify();
      if (!destroyed && summary.isConnected) summary.focus();
    }
    function renderResults(items, searchMode) {
      found = items.map(item => ({ item, searchMode }));
      results.replaceChildren();
      items.forEach((item, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'origin-result';
        button.dataset.resultIndex = String(index);
        button.title = [item.name, item.address].filter(Boolean).join(' · ');
        const name = document.createElement('strong');
        name.textContent = item.name;
        button.append(name);
        if (item.source === 'TAGO') button.append(serviceInfo(item));
        if (item.address) {
          const address = document.createElement('span');
          if (item.source === 'TAGO') address.className = 'origin-stop-note';
          address.textContent = item.source === 'TAGO' ? `안내: ${item.address}` : item.address;
          button.append(address);
        }
        results.append(button);
      });
    }
    async function search() {
      if (destroyed) return;
      const term = query.value.trim();
      invalidate();
      if (!Object.prototype.hasOwnProperty.call(isArrival ? arrivals : modes, currentMode())) {
        setMessage(isArrival ? '출발지의 이동 수단을 먼저 선택해 주세요.' : '먼저 이동 수단을 선택해 주세요.', true);
        if (isArrival) summary.focus();
        else (mode.closest('.custom-select')?.querySelector('.select-trigger') || mode).focus();
        return;
      }
      if (term.length < 2 || term.length > 100) {
        setMessage(term.length < 2 ? '검색어를 2자 이상 입력해 주세요.' : '검색어는 100자 이내로 입력해 주세요.', true);
        query.focus(); return;
      }
      const token = requestToken, searchMode = currentMode();
      if (isArrival && externalService && transportServices[externalService]?.mode !== searchMode) {
        setMessage('출발지와 같은 교통수단의 도착지를 다시 선택해 주세요.', true);
        return;
      }
      const useTransportStops = regionalModes.includes(searchMode);
      const searchUrl = useTransportStops
        ? `/api/transport/stops?mode=${encodeURIComponent(searchMode)}&q=${encodeURIComponent(term)}${isArrival && externalService ? `&service=${encodeURIComponent(externalService)}` : ''}`
        : `/api/departures/search?q=${encodeURIComponent(term)}`;
      const controller = new AbortController();
      pending = controller;
      // A cold TAGO station search loads multiple regional catalogs before it
      // can reply. Leave room beyond its per-upstream-request timeout.
      const requestTimeout = setTimeout(() => controller.abort(), useTransportStops ? 25000 : 15000);
      timeout = requestTimeout;
      setBusy(true);
      setMessage(`${noun}를 찾고 있어요.`);
      try {
        const response = await fetch(searchUrl, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (destroyed || token !== requestToken) return;
        if (controller.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        if (!response.ok) {
          setMessage(response.status === 429 ? '검색 요청이 잠시 몰렸어요. 잠시 후 다시 시도해 주세요.' : `${noun}를 불러오지 못했어요. 잠시 후 다시 검색해 주세요.`, true);
          return;
        }
        const body = await response.json();
        if (destroyed || token !== requestToken || currentMode() !== searchMode || query.value.trim() !== term) return;
        if (controller.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        if (!Array.isArray(body.items)) throw new Error('Invalid search response');
        const items = body.items.map(normalize).filter(item => item && item.source === (useTransportStops ? 'TAGO' : 'OpenStreetMap') && matchesContext(item, searchMode)).slice(0, 10);
        if (!items.length) { setMessage('검색 결과가 없어요. 장소 이름이나 주소를 더 구체적으로 입력해 주세요.'); return; }
        renderResults(items, searchMode);
        setMessage(`${items.length}개의 검색 결과에서 ${noun}를 선택해 주세요.`);
      } catch (error) {
        if (destroyed || token !== requestToken) return;
        setMessage(error.name === 'AbortError' ? '검색 시간이 길어지고 있어요. 잠시 후 다시 검색해 주세요.' : `${noun} 검색에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.`, true);
      } finally {
        clearTimeout(requestTimeout);
        if (!destroyed && token === requestToken) { timeout = null; pending = null; setBusy(false); }
      }
    }
    listen(mode, 'change', () => {
      if (isArrival) return;
      invalidate();
      const hadSelection = Boolean(selected);
      selected = null;
      query.value = '';
      renderSelected(); placeholder(); setMessage('');
      if (hadSelection) notify();
    });
    listen(query, 'input', () => { invalidate(); setMessage(''); });
    listen(query, 'compositionstart', () => { composing = true; });
    listen(query, 'compositionend', () => { composing = false; });
    listen(query, 'keydown', event => {
      if (event.key === 'Enter' && !composing && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); search(); }
    });
    listen(fieldset, 'click', event => {
      const button = event.target.closest('button');
      if (!button || !fieldset.contains(button)) return;
      if (button.dataset.departureAction === 'search') search();
      else if (button.dataset.departureAction === 'clear') {
        invalidate(); selected = null; query.value = ''; renderSelected();
        setMessage(isArrival ? '도착지 선택을 지웠어요.' : '이 날은 출발지 없이 일정을 만들 수 있어요.');
        notify();
        if (!destroyed) query.focus();
      } else if (button.dataset.resultIndex !== undefined) {
        const result = found[Number(button.dataset.resultIndex)];
        if (result) choose(result.item, result.searchMode);
      }
    });
    const api = {
      get,
      set(next) {
        if (destroyed) return null;
        invalidate();
        const item = normalize(next);
        const previousMode = next?.mode || externalMode;
        const requestedMode = previousMode === 'rental-car' || previousMode === 'taxi' ? 'car' : previousMode;
        if (isArrival) arrivalMode = Object.prototype.hasOwnProperty.call(arrivals, requestedMode) ? requestedMode : '';
        selected = item && Object.prototype.hasOwnProperty.call(isArrival ? arrivals : modes, requestedMode) && matchesContext(item, requestedMode) ? { ...item, mode: requestedMode } : null;
        mode.value = isArrival ? arrivalMode : selected?.mode || (Object.prototype.hasOwnProperty.call(modes, requestedMode) ? requestedMode : '');
        query.value = selected?.name || '';
        renderSelected(); placeholder(); setMessage('');
        window.TravelSelect?.refresh();
        return get();
      },
      read() {
        if (query.value.trim() && selected && query.value.trim() !== selected.name) return { ok: false, reason: `새 검색 결과에서 ${noun}를 선택하거나 검색어를 지워주세요.` };
        if (query.value.trim() && !selected) return { ok: false, reason: currentMode() ? `검색한 목록에서 ${noun}를 선택하거나 검색어를 지워주세요.` : isArrival ? '출발지의 이동 수단을 고른 뒤 검색 목록에서 도착지를 선택해 주세요.' : '이동 수단을 고르고 검색 목록에서 출발지를 선택해 주세요.' };
        return { ok: true, departure: get() };
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        invalidate();
        listeners.forEach(remove => remove());
        selected = null;
        if (details.parentNode === host) host.replaceChildren();
        if (mounts.get(host) === api) mounts.delete(host);
      }
    };
    mounts.set(host, api);
    api.set(departure);
    return api;
  }
  window.TravelDeparture = { mount };
})();

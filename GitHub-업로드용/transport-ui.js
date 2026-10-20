(function () {
  'use strict';
  const sourceUrls = {
    train: 'https://www.data.go.kr/data/15098552/openapi.do', express: 'https://www.data.go.kr/data/15098522/openapi.do',
    intercity: 'https://www.data.go.kr/data/15098541/openapi.do', flight: 'https://www.data.go.kr/data/15098526/openapi.do',
    ferry: 'https://www.data.go.kr/data/15098523/openapi.do'
  };
  const labels = { train: '열차', express: '고속버스', intercity: '시외버스', flight: '항공편', ferry: '여객선' };
  const durationLabel = minutes => [Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}시간` : '', minutes % 60 ? `${minutes % 60}분` : ''].filter(Boolean).join(' ');
  function mount(host, { date, departure, arrival, startTime = '09:00', transport = null, onApply, onClear, draft = false } = {}) {
    const details = document.createElement('details');
    details.className = 'transport-lookup';
    const summary = document.createElement('summary');
    const heading = document.createElement('span'); heading.className = 'transport-heading'; heading.textContent = '예상시간';
    const preview = document.createElement('strong'); preview.className = 'transport-preview';
    preview.textContent = transport ? `${labels[transport.service]} ${durationLabel(transport.durationMinutes)} · ${draft ? '환승 후보 선택됨' : '선택됨'}` : '교통편 시간표에서 가져오기';
    const action = document.createElement('span'); action.className = 'transport-summary-action'; action.textContent = '조회·변경';
    summary.append(heading, preview, action);
    const body = document.createElement('div'); body.className = 'transport-body';
    const note = document.createElement('p'); note.className = 'transport-note';
    const ready = departure?.source === 'TAGO' && arrival?.source === 'TAGO' && departure.service === arrival.service && Boolean(sourceUrls[departure.service]);
    note.textContent = ready ? `${date} · ${departure.name} → ${arrival.name}` : departure?.source === 'OpenStreetMap' || arrival?.source === 'OpenStreetMap'
      ? '교통기관 목록에서 출발·도착지를 다시 선택하면 시간표를 가져올 수 있어요.' : '출발·도착지를 선택하면 교통편 시간표를 가져올 수 있어요.';
    const message = document.createElement('p'); message.className = 'transport-message'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const controls = document.createElement('div'); controls.className = 'transport-controls';
    const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = '시간표 다시 조회'; refresh.disabled = !ready;
    controls.append(refresh);
    if (transport) {
      const manual = document.createElement('button'); manual.type = 'button'; manual.textContent = draft ? '이 구간 선택 취소' : '직접 입력으로 전환';
      manual.addEventListener('click', () => {
        const result = onClear?.();
        if (!destroyed && result?.ok === false) showMessage(result.reason || '변경 내용을 저장하지 못했어요.', true);
      });
      controls.append(manual);
    }
    const results = document.createElement('div'); results.className = 'transport-results'; results.setAttribute('role', 'group'); results.setAttribute('aria-label', '조회된 교통편');
    const more = document.createElement('button'); more.type = 'button'; more.className = 'transport-more'; more.textContent = '다른 시간 더 보기'; more.hidden = true;
    const help = document.createElement('p'); help.className = 'transport-footnote';
    help.textContent = draft ? '두 구간의 실제 교통편을 고른 뒤 ‘환승 일정 적용’을 눌러 주세요. 그때 출발 시각과 뒤 일정이 함께 조정돼요.'
      : '운행시간표 기준 예상이에요. 교통편을 선택하면 출발 시각과 뒤 일정이 함께 조정돼요.';
    if (departure?.service === 'ferry') {
      const ferryNotice = document.createElement('p'); ferryNotice.className = 'transport-ferry-notice';
      ferryNotice.textContent = '여객선 시각·소요시간은 제공기관 원본 기준이에요. 실제 운항·입출항 시간은 선사에 확인하고, 지나치게 짧거나 맞지 않는 값은 그대로 적용하지 마세요.';
      body.append(ferryNotice);
    }
    body.append(note, controls, message, results, more, help); details.append(summary, body); host.replaceChildren(details);
    let destroyed = false, pending = null, token = 0, loaded = false, items = [], shown = 0, timeout = null;
    const threshold = /^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) ? Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3)) : 0;
    function showMessage(text, error = false) { message.textContent = text; message.classList.toggle('is-error', error); }
    function valid(item) {
      return item && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 300 && item.service === departure.service
        && item.departureId === departure.providerId && item.arrivalId === arrival.providerId && item.date === date
        && item.source === 'TAGO' && item.sourceUrl === sourceUrls[item.service] && Number.isInteger(item.departureMinutes)
        && item.departureMinutes >= 0 && item.departureMinutes < 1440 && Number.isInteger(item.arrivalMinutes)
        && Number.isInteger(item.durationMinutes) && item.durationMinutes > 0 && item.durationMinutes <= 4320
        && item.arrivalMinutes - item.departureMinutes === item.durationMinutes;
    }
    function addItems() {
      const end = Math.min(shown + 20, items.length);
      for (let i = shown; i < end; i++) {
        const item = items[i];
        const button = document.createElement('button'); button.type = 'button'; button.className = 'transport-trip';
        const times = document.createElement('strong'); times.textContent = `${window.TravelPlanner.formatTime(item.departureMinutes)} → ${window.TravelPlanner.formatTime(item.arrivalMinutes)}`;
        const detail = document.createElement('span'); detail.textContent = [labels[item.service], item.grade, item.tripNo, durationLabel(item.durationMinutes)].filter(Boolean).join(' · ');
        const choose = document.createElement('small'); choose.textContent = '선택'; button.append(times, detail, choose);
        button.addEventListener('click', () => {
          if (destroyed) return;
          const result = onApply?.(item);
          if (!destroyed && result?.ok === false) showMessage(result.reason || '교통편을 적용하지 못했어요.', true);
        });
        results.append(button);
      }
      shown = end; more.hidden = shown >= items.length;
    }
    async function search() {
      if (destroyed || !ready) return;
      pending?.abort(); if (timeout !== null) clearTimeout(timeout);
      const version = ++token, controller = new AbortController(); pending = controller;
      const timer = setTimeout(() => controller.abort(), 20000); timeout = timer;
      refresh.disabled = true; refresh.setAttribute('aria-busy', 'true'); results.replaceChildren(); more.hidden = true;
      showMessage('운행시간표를 가져오고 있어요.');
      try {
        const query = new URLSearchParams({ service: departure.service, from: departure.providerId, to: arrival.providerId, date });
        const response = await fetch(`/api/transport/trips?${query}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
        const data = await response.json();
        if (destroyed || version !== token) return;
        if (controller.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        if (!response.ok) { showMessage(data.error?.message || (draft ? '시간표를 불러오지 못했어요. 잠시 후 다시 조회해 주세요.' : '시간표를 불러오지 못했어요. 직접 시간을 입력하거나 다시 시도해 주세요.'), true); return; }
        if (!Array.isArray(data.items)) throw new Error('Invalid timetable');
        const validItems = data.items.filter(valid);
        if (validItems.length !== data.items.length) throw new Error('Invalid timetable');
        items = validItems.filter(item => item.departureMinutes >= threshold).sort((a, b) => a.departureMinutes - b.departureMinutes || a.arrivalMinutes - b.arrivalMinutes);
        shown = 0; loaded = true;
        if (!items.length) showMessage(draft ? validItems.length ? '조회 기준 시각 이후에 연결할 편이 없어요. 환승 여유시간·앞 구간의 도착 시각이나 조회 날짜를 확인해 주세요.' : '이 날짜와 구간에는 조회된 교통편이 없어요. 날짜·환승 장소를 확인해 주세요.'
          : validItems.length ? '선택한 출발 시각 이후에 조회된 편이 없어요. 출발 시각을 앞당기거나 직접 입력해 주세요.' : '이 날짜와 구간에는 조회된 교통편이 없어요. 날짜·출발·도착지를 확인하거나 직접 입력해 주세요.');
        else { showMessage(draft ? `조회 기준 시각 이후 ${items.length}편 · 환승 후보로 선택해요.${data.truncated ? ' 조회 가능한 시간표 일부를 표시하고 있어요.' : ''}`
          : `출발 시각 이후 ${items.length}편 · 선택해서 예상시간을 반영해요.${data.truncated ? ' 조회 가능한 시간표 일부를 표시하고 있어요.' : ''}`); addItems(); }
      } catch (error) {
        if (destroyed || version !== token) return;
        showMessage(draft ? error.name === 'AbortError' ? '시간표 조회가 지연되고 있어요. 잠시 후 다시 조회해 주세요.' : '시간표에 연결하지 못했어요. 잠시 후 다시 조회해 주세요.'
          : error.name === 'AbortError' ? '시간표 조회가 지연되고 있어요. 잠시 후 다시 시도하거나 시간을 직접 입력해 주세요.' : '시간표에 연결하지 못했어요. 잠시 후 다시 시도하거나 시간을 직접 입력해 주세요.', true);
      } finally {
        clearTimeout(timer);
        if (!destroyed && version === token) { timeout = null; pending = null; refresh.disabled = !ready; refresh.setAttribute('aria-busy', 'false'); }
      }
    }
    refresh.addEventListener('click', search); more.addEventListener('click', addItems);
    details.addEventListener('toggle', () => { if (details.open && !loaded && !pending) search(); });
    return { destroy() { if (destroyed) return; destroyed = true; token++; pending?.abort(); if (timeout !== null) clearTimeout(timeout); if (details.parentNode === host) host.replaceChildren(); } };
  }
  window.TravelTransport = { mount };
})();

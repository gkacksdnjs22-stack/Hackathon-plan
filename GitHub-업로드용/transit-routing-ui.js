(function () {
  'use strict';

  const routeTypes = { BUS: '버스', SUBWAY: '지하철', BUS_AND_SUBWAY: '버스+지하철' };
  const stepTypes = { BUS: '버스', SUBWAY: '지하철', WALKING: '도보' };
  const validText = (value, maximum, required = true) => typeof value === 'string' && value.length <= maximum
    && (!required || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/.test(value);
  const validPoint = point => point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
    && point.latitude >= 33 && point.latitude <= 39.5 && point.longitude >= 124 && point.longitude <= 132;
  const validDate = value => typeof value === 'string' && value.length <= 35
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
  const durationLabel = minutes => {
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return hours ? `${hours}시간${rest ? ` ${rest}분` : ''}` : `${rest}분`;
  };
  const distanceLabel = meters => meters < 1000 ? `${meters}m` : `${(meters / 1000).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}km`;

  function mount(host, { origin = null, destination = null, mode = null, compact = false, onEdit = null, onPreviewDuration = null } = {}) {
    const ready = Boolean(validPoint(origin) && validPoint(destination) && ['local-bus', 'subway'].includes(mode));
    const from = ready ? { latitude: origin.latitude, longitude: origin.longitude } : null;
    const to = ready ? { latitude: destination.latitude, longitude: destination.longitude } : null;
    const originName = validText(origin?.name, 160) ? origin.name.trim() : '출발지';
    const destinationName = validText(destination?.name, 160) ? destination.name.trim() : '도착지';
    const canEdit = typeof onEdit === 'function';
    const details = document.createElement('details'); details.className = `transit-route-lookup${compact ? ' transit-route-compact' : ''}`;
    const summary = document.createElement('summary');
    const heading = document.createElement('strong'); heading.className = 'transit-route-heading'; heading.textContent = '대중교통 예상시간';
    const preview = document.createElement('span'); preview.className = 'transit-route-preview'; preview.textContent = `${originName} → ${destinationName}`;
    const action = document.createElement('span'); action.className = 'transit-route-summary-action'; action.textContent = '경로 조회';
    if (compact) summary.append(heading, action); else summary.append(heading, preview, action);
    const body = document.createElement('div'); body.className = 'transit-route-body';
    const controls = document.createElement('div'); controls.className = 'transit-route-controls';
    const introduction = document.createElement('p'); introduction.className = 'transit-route-introduction';
    introduction.textContent = '현재 조회 기준 · 여행 당일의 배차 상황에 따라 달라질 수 있어요.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'transit-route-refresh'; retry.textContent = '조회하기'; retry.disabled = !ready;
    controls.append(introduction, retry);
    const message = document.createElement('p'); message.className = 'transit-route-message'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const choices = document.createElement('label'); choices.className = 'transit-route-choices'; choices.hidden = true;
    const choicesLabel = document.createElement('span'); choicesLabel.textContent = '경로 선택';
    const select = document.createElement('select'); select.className = 'transit-route-select'; select.setAttribute('aria-label', '조회된 대중교통 경로 선택'); choices.append(choicesLabel, select);
    const result = document.createElement('div'); result.className = 'transit-route-result'; result.hidden = true;
    const metrics = document.createElement('div'); metrics.className = 'transit-route-metrics';
    const duration = document.createElement('strong'); duration.className = 'transit-route-duration';
    const distance = document.createElement('span'); distance.className = 'transit-route-distance';
    const type = document.createElement('span'); type.className = 'transit-route-type';
    const transfers = document.createElement('span'); transfers.className = 'transit-route-transfers'; metrics.append(duration, distance, type, transfers);
    const stepsDetails = document.createElement('details'); stepsDetails.className = 'transit-route-steps';
    const stepsSummary = document.createElement('summary'); stepsSummary.textContent = '이용 노선 간단히 보기';
    const steps = document.createElement('ol'); steps.className = 'transit-route-step-list'; stepsDetails.append(stepsSummary, steps);
    result.append(metrics, stepsDetails);
    const manual = document.createElement('button'); manual.type = 'button'; manual.className = 'transit-route-edit'; manual.textContent = '일정 시간 수정'; manual.hidden = !canEdit;
    const note = document.createElement('p'); note.className = 'transit-route-note';
    note.textContent = typeof onPreviewDuration === 'function'
      ? '선택한 경로의 시간은 현재 타임라인에만 미리 보여줘요. 조회를 닫으면 원래 시간으로 돌아오며, 저장할 일정 시간은 직접 수정해 주세요.'
      : '조회한 시간은 참고용이에요. 일정 시간은 직접 수정해 주세요.';
    body.append(controls, message, choices, result, manual, note); details.append(summary, body); host.replaceChildren(details);

    const fallback = document.createElement('a'); fallback.className = 'transit-route-fallback';
    fallback.textContent = '카카오맵에서 대중교통 경로 확인 ↗'; fallback.hidden = true;
    fallback.target = '_blank'; fallback.rel = 'noopener noreferrer';
    if (ready) fallback.href = `https://map.kakao.com/link/by/traffic/${encodeURIComponent('출발지')},${from.latitude},${from.longitude}/${encodeURIComponent('도착지')},${to.latitude},${to.longitude}`;
    body.append(fallback);

    let destroyed = false, userIntent = false, version = 0, editing = false, routes = [], pending = null, timeout = null, previewing = false;
    function clearPreview() {
      if (!previewing) return;
      previewing = false;
      if (typeof onPreviewDuration === 'function') onPreviewDuration(null);
    }
    function showMessage(value, error = false) { fallback.hidden = !error || !ready; message.textContent = value; message.classList.toggle('is-error', error); }
    function initialMessage() {
      showMessage(ready ? '펼쳐서 현재 대중교통 경로를 조회해 보세요.' : '좌표가 있는 출발지와 도착지를 선택해 주세요.');
    }
    function resetResults() {
      clearPreview();
      routes = []; select.replaceChildren(); choices.hidden = true; result.hidden = true;
      duration.textContent = ''; distance.textContent = ''; type.textContent = ''; transfers.textContent = '';
      steps.replaceChildren(); stepsDetails.open = false;
    }
    function cancel() {
      version++; pending?.abort(); pending = null;
      if (timeout !== null) clearTimeout(timeout); timeout = null;
      retry.disabled = !ready; retry.setAttribute('aria-busy', 'false'); result.setAttribute('aria-busy', 'false');
    }
    function samePoint(first, second) {
      return validPoint(first) && Math.abs(first.latitude - second.latitude) <= 0.000001 && Math.abs(first.longitude - second.longitude) <= 0.000001;
    }
    function validStep(step) {
      return step && Object.hasOwn(stepTypes, step.type) && validText(step.guidance, 500, false)
        && integer(step.durationSeconds, 0, 86400) && integer(step.distanceMeters, 0, 1500000)
        && Array.isArray(step.stops) && step.stops.length <= 200 && step.stops.every(name => validText(name, 120))
        && Array.isArray(step.vehicles) && step.vehicles.length <= 100
        && step.vehicles.every(vehicle => vehicle && validText(vehicle.name, 120) && validText(vehicle.type, 80, false));
    }
    function validRoute(route) {
      return route && validText(route.id, 120) && Object.hasOwn(routeTypes, route.type)
        && (route.type === 'BUS_AND_SUBWAY' || route.type === (mode === 'subway' ? 'SUBWAY' : 'BUS'))
        && integer(route.durationSeconds, 1, 86400) && route.durationMinutes === Math.ceil(route.durationSeconds / 60)
        && integer(route.distanceMeters, 1, 1500000) && integer(route.transfers, 0, 30)
        && Array.isArray(route.steps) && route.steps.length >= 1 && route.steps.length <= 64 && route.steps.every(validStep);
    }
    function validData(data) {
      return data && data.provider === '카카오맵' && validDate(data.fetchedAt) && data.mode === mode
        && samePoint(data.origin, from) && samePoint(data.destination, to)
        && Array.isArray(data.routes) && data.routes.length <= 5 && data.routes.every(validRoute)
        && new Set(data.routes.map(route => route.id)).size === data.routes.length;
    }
    function renderRoute() {
      if (destroyed || !details.open || pending) return;
      const selected = routes[Number(select.value)]; if (!selected) { clearPreview(); return; }
      duration.textContent = `예상 ${durationLabel(selected.durationMinutes)}`;
      distance.textContent = `거리 ${distanceLabel(selected.distanceMeters)}`;
      type.textContent = routeTypes[selected.type]; transfers.textContent = selected.transfers === 0 ? '환승 없음' : `환승 ${selected.transfers}회`;
      steps.replaceChildren(); stepsDetails.open = false;
      for (const step of selected.steps) {
        const row = document.createElement('li');
        const heading = document.createElement('strong');
        const vehicles = step.vehicles.slice(0, 3).map(vehicle => `${vehicle.name}${vehicle.type ? ` (${vehicle.type})` : ''}`).join(', ')
          + (step.vehicles.length > 3 ? ` 외 ${step.vehicles.length - 3}개 노선` : '');
        heading.textContent = [stepTypes[step.type], vehicles, durationLabel(Math.ceil(step.durationSeconds / 60))].filter(Boolean).join(' · ');
        const stops = document.createElement('span');
        stops.textContent = step.stops.length > 1 ? `${step.stops[0]} → ${step.stops.at(-1)}` : step.stops[0] || (step.type === 'WALKING' ? distanceLabel(step.distanceMeters) : '승하차 위치는 노선을 확인해 주세요.');
        row.append(heading, stops); steps.append(row);
      }
      result.hidden = false; showMessage('');
      if (typeof onPreviewDuration === 'function') {
        previewing = true;
        onPreviewDuration(selected.durationMinutes);
      }
    }
    async function search() {
      if (destroyed || !details.open || !ready || pending || editing) return;
      resetResults();
      const requestVersion = ++version, controller = new AbortController(); pending = controller;
      const timer = setTimeout(() => controller.abort(), 25000); timeout = timer;
      retry.disabled = true; retry.textContent = '다시 조회'; retry.setAttribute('aria-busy', 'true'); result.setAttribute('aria-busy', 'true');
      showMessage('현재 이용할 수 있는 대중교통 경로를 조회하고 있어요.');
      try {
        const query = new URLSearchParams({ originLatitude: String(from.latitude), originLongitude: String(from.longitude),
          destinationLatitude: String(to.latitude), destinationLongitude: String(to.longitude), mode });
        const response = await fetch(`/api/transit-routes?${query}`, { signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (destroyed || requestVersion !== version) return;
        if (controller.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        if (!response.ok) {
          let code; try { code = (await response.json())?.error?.code; } catch {}
          if (destroyed || requestVersion !== version) return;
          if (controller.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
          const setupMessage = code === 'KEY_MISSING' ? '이 사이트의 경로 API 설정이 아직 없어요. 카카오맵에서 경로를 확인하고 일정 시간을 직접 입력해 주세요.'
            : code === 'AUTH_ERROR' ? '경로 API 인증·사용 권한을 확인해야 해요. 카카오맵에서 경로를 확인하거나 시간을 직접 입력해 주세요.' : null;
          showMessage(setupMessage || (response.status === 422 ? '조회된 대중교통 경로가 없어요. 출발지·도착지나 이동수단을 확인해 주세요.'
            : response.status === 401 || response.status === 403 || response.status === 503 ? '대중교통 경로 연결을 준비 중이에요. 잠시 후 다시 확인해 주세요.'
              : response.status === 429 ? '조회가 많아 잠시 쉬고 있어요. 조금 뒤 다시 조회해 주세요.'
                : response.status === 504 ? '대중교통 응답이 늦어지고 있어요. 다시 조회해 주세요.' : '대중교통 경로를 불러오지 못했어요. 다시 조회해 주세요.'), true);
          return;
        }
        const data = await response.json();
        if (destroyed || requestVersion !== version) return;
        if (controller.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        if (!validData(data)) throw new Error('Invalid transit response');
        routes = data.routes.sort((first, second) => first.durationSeconds - second.durationSeconds || first.distanceMeters - second.distanceMeters);
        if (!routes.length) { showMessage('조회된 대중교통 경로가 없어요. 일정 시간은 직접 수정해 주세요.'); return; }
        routes.forEach((route, index) => {
          const option = document.createElement('option'); option.value = String(index);
          option.textContent = `${index === 0 ? '추천 · ' : ''}${routeTypes[route.type]} · ${durationLabel(route.durationMinutes)} · ${distanceLabel(route.distanceMeters)}`; select.append(option);
        });
        select.value = '0'; choices.hidden = routes.length < 2;
      } catch (error) {
        if (destroyed || requestVersion !== version) return;
        showMessage(error?.name === 'AbortError' ? '대중교통 조회가 지연됐어요. 다시 조회해 주세요.' : '대중교통 경로에 연결하지 못했어요. 다시 조회해 주세요.', true);
      } finally {
        clearTimeout(timer);
        if (!destroyed && requestVersion === version) {
          timeout = null; pending = null; retry.disabled = !ready; retry.setAttribute('aria-busy', 'false'); result.setAttribute('aria-busy', 'false');
          if (routes.length) renderRoute();
        }
      }
    }
    async function editTime() {
      if (destroyed || editing || !canEdit) return;
      editing = true; manual.disabled = true;
      try {
        const outcome = await onEdit();
        if (!destroyed && outcome?.ok === false) showMessage(validText(outcome.reason, 500) ? outcome.reason : '일정 수정 화면을 열지 못했어요. 다시 시도해 주세요.', true);
      } catch (_error) {
        if (!destroyed) showMessage('일정 수정 화면을 열지 못했어요. 다시 시도해 주세요.', true);
      } finally { if (!destroyed) { editing = false; manual.disabled = false; } }
    }
    function activate(event) { if (event.type === 'click' || event.key === 'Enter' || event.key === ' ') userIntent = true; }
    function toggle(event) {
      if (event.target && event.target !== details) return;
      action.textContent = details.open ? '접기' : '경로 조회';
      if (details.open) { if (userIntent && !pending) search(); }
      else { cancel(); resetResults(); initialMessage(); }
      userIntent = false;
    }
    summary.addEventListener('click', activate); summary.addEventListener('keydown', activate); details.addEventListener('toggle', toggle);
    retry.addEventListener('click', search); select.addEventListener('change', renderRoute); manual.addEventListener('click', editTime); initialMessage();
    return { destroy() {
      if (destroyed) return;
      destroyed = true; cancel(); resetResults();
      summary.removeEventListener('click', activate); summary.removeEventListener('keydown', activate); details.removeEventListener('toggle', toggle);
      retry.removeEventListener('click', search); select.removeEventListener('change', renderRoute); manual.removeEventListener('click', editTime);
      if (details.parentNode === host) host.replaceChildren();
    } };
  }

  window.TravelTransitRouting = { mount };
})();

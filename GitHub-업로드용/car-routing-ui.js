(function () {
  'use strict';

  const validText = (value, maximum) => typeof value === 'string' && value.trim().length > 0
    && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
  const validPoint = point => point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
    && point.latitude >= 33 && point.latitude <= 39.5 && point.longitude >= 124 && point.longitude <= 132;
  const validDate = value => typeof value === 'string' && value.length <= 35
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
  function durationLabel(minutes) {
    const hours = Math.floor(minutes / 60), remaining = minutes % 60;
    return hours ? `${hours}시간${remaining ? ` ${remaining}분` : ''}` : `${remaining}분`;
  }
  function distanceLabel(meters) {
    return meters < 1000 ? `${meters}m` : `${(meters / 1000).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}km`;
  }
  function mount(host, { origin = null, destination = null, onApply = null, compact = false } = {}) {
    const ready = Boolean(validPoint(origin) && validPoint(destination));
    // Keep this lookup tied to the two locations that were present when mounted.
    const from = ready ? { latitude: origin.latitude, longitude: origin.longitude } : null;
    const to = ready ? { latitude: destination.latitude, longitude: destination.longitude } : null;
    const originName = validText(origin?.name, 160) ? origin.name.trim() : '출발지';
    const destinationName = validText(destination?.name, 160) ? destination.name.trim() : '도착지';
    const canApply = typeof onApply === 'function';
    const details = document.createElement('details'); details.className = `car-route-lookup${compact ? ' car-route-compact' : ''}`;
    const summary = document.createElement('summary');
    const heading = document.createElement('strong'); heading.className = 'car-route-heading'; heading.textContent = compact ? '예상시간 조회' : '차량 예상 이동시간';
    const preview = document.createElement('span'); preview.className = 'car-route-preview';
    preview.textContent = `${originName} → ${destinationName}`;
    const action = document.createElement('span'); action.className = 'car-route-summary-action'; action.textContent = '조회';
    if (compact) summary.append(heading, action); else summary.append(heading, preview, action);
    const body = document.createElement('div'); body.className = 'car-route-body';
    const controls = document.createElement('div'); controls.className = 'car-route-controls';
    const introduction = document.createElement('p'); introduction.className = 'car-route-introduction';
    introduction.textContent = '현재 교통 기준 · 여행 당일 예측과 다를 수 있어요.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'car-route-refresh';
    retry.textContent = '조회하기'; retry.disabled = !ready;
    controls.append(introduction, retry);
    const message = document.createElement('p'); message.className = 'car-route-message';
    message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    message.textContent = ready ? '펼쳐서 차량 이동시간을 조회해 보세요.' : '좌표가 있는 출발지와 도착지를 선택해 주세요.';
    const result = document.createElement('div'); result.className = 'car-route-result'; result.hidden = true;
    const duration = document.createElement('strong'); duration.className = 'car-route-duration';
    const distance = document.createElement('span'); distance.className = 'car-route-distance';
    const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'car-route-apply';
    apply.textContent = '일정에 적용'; apply.hidden = true; apply.disabled = true;
    result.append(duration, distance, apply); body.append(controls, message, result); details.append(summary, body); host.replaceChildren(details);

    const fallback = document.createElement('a'); fallback.className = 'car-route-fallback';
    fallback.textContent = '카카오맵에서 차량 경로 확인 ↗'; fallback.hidden = true;
    fallback.target = '_blank'; fallback.rel = 'noopener noreferrer';
    if (ready) fallback.href = `https://map.kakao.com/link/by/car/${encodeURIComponent('출발지')},${from.latitude},${from.longitude}/${encodeURIComponent('도착지')},${to.latitude},${to.longitude}`;
    body.append(fallback);

    let destroyed = false, attempted = false, userIntent = false, version = 0;
    let pending = null, timeout = null, route = null, applying = false, applied = false;

    function showMessage(value, error = false) {
      fallback.hidden = !error || !ready;
      message.textContent = value; message.classList.toggle('is-error', error);
    }
    function samePoint(first, second) {
      return validPoint(first) && Math.abs(first.latitude - second.latitude) <= 0.000001
        && Math.abs(first.longitude - second.longitude) <= 0.000001;
    }
    function validRoute(data) {
      return data && data.provider === '카카오모빌리티' && data.reference === '현재 교통 기준'
        && validDate(data.fetchedAt) && samePoint(data.origin, from) && samePoint(data.destination, to)
        && Number.isSafeInteger(data.durationSeconds) && data.durationSeconds >= 1 && data.durationSeconds <= 86400
        && Number.isSafeInteger(data.durationMinutes) && data.durationMinutes === Math.ceil(data.durationSeconds / 60)
        && Number.isSafeInteger(data.distanceMeters) && data.distanceMeters >= 1 && data.distanceMeters <= 1500000;
    }
    function safeRoute(data) {
      return Object.freeze({
        provider: data.provider, fetchedAt: data.fetchedAt, reference: data.reference,
        origin: Object.freeze({ latitude: data.origin.latitude, longitude: data.origin.longitude }),
        destination: Object.freeze({ latitude: data.destination.latitude, longitude: data.destination.longitude }),
        durationMinutes: data.durationMinutes, durationSeconds: data.durationSeconds, distanceMeters: data.distanceMeters
      });
    }

    async function search() {
      if (destroyed || !ready || pending || applying) return;
      attempted = true;
      const requestVersion = ++version, controller = new AbortController(); pending = controller;
      const timer = setTimeout(() => controller.abort(), 25000); timeout = timer;
      route = null; applied = false; result.hidden = true; apply.hidden = true; apply.disabled = true; apply.textContent = '일정에 적용';
      result.setAttribute('aria-busy', 'true'); retry.disabled = true; retry.textContent = '다시 조회'; retry.setAttribute('aria-busy', 'true');
      showMessage('두 지점 사이의 차량 이동시간을 조회하고 있어요.');
      try {
        const query = new URLSearchParams({
          originLatitude: String(from.latitude), originLongitude: String(from.longitude),
          destinationLatitude: String(to.latitude), destinationLongitude: String(to.longitude)
        });
        const response = await fetch(`/api/car-route?${query}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (destroyed || requestVersion !== version) return;
        if (controller.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        if (!response.ok) {
          let code; try { code = (await response.json())?.error?.code; } catch {}
          if (destroyed || requestVersion !== version) return;
          if (controller.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
          const setupMessage = code === 'KEY_MISSING' ? '이 사이트의 경로 API 설정이 아직 없어요. 카카오맵에서 경로를 확인하고 일정 시간을 직접 입력해 주세요.'
            : code === 'AUTH_ERROR' ? '경로 API 인증·사용 권한을 확인해야 해요. 카카오맵에서 경로를 확인하거나 시간을 직접 입력해 주세요.' : null;
          showMessage(setupMessage || (response.status === 422 ? '두 지점 사이에 조회할 수 있는 차량 경로가 없어요. 출발지와 도착지를 확인해 주세요.'
            : response.status === 503 ? '차량 이동시간 연결을 준비 중이에요. 잠시 후 다시 확인해 주세요.'
              : response.status === 401 || response.status === 403 ? '차량 이동시간을 조회할 수 없어요. 잠시 후 다시 확인해 주세요.'
                : response.status === 429 ? '조회가 많아 잠시 쉬고 있어요. 조금 뒤 다시 조회해 주세요.'
                  : response.status === 504 ? '차량 이동시간 응답이 늦어지고 있어요. 다시 조회해 주세요.'
                    : '차량 이동시간을 불러오지 못했어요. 다시 조회해 주세요.'), true);
          return;
        }
        const data = await response.json();
        if (destroyed || requestVersion !== version) return;
        if (controller.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        if (!validRoute(data)) throw new Error('Invalid route response');
        route = safeRoute(data);
        duration.textContent = `예상 ${durationLabel(route.durationMinutes)}`;
        distance.textContent = `거리 ${distanceLabel(route.distanceMeters)}`;
        result.hidden = false; apply.hidden = !canApply; apply.disabled = !canApply;
        showMessage('');
      } catch (error) {
        if (destroyed || requestVersion !== version) return;
        showMessage(error?.name === 'AbortError' ? '차량 이동시간 조회가 지연됐어요. 다시 조회해 주세요.'
          : '차량 이동시간에 연결하지 못했어요. 다시 조회해 주세요.', true);
      } finally {
        clearTimeout(timer);
        if (!destroyed && requestVersion === version) {
          timeout = null; pending = null; retry.disabled = !ready;
          retry.setAttribute('aria-busy', 'false'); result.setAttribute('aria-busy', 'false');
        }
      }
    }

    async function applyRoute() {
      if (destroyed || pending || applying || applied || !route || !canApply) return;
      const applyVersion = version, selectedRoute = route;
      applying = true; apply.disabled = true; retry.disabled = true; apply.setAttribute('aria-busy', 'true');
      try {
        const outcome = await onApply(selectedRoute);
        if (destroyed || applyVersion !== version) return;
        if (outcome?.ok === true) {
          applied = true; apply.textContent = '적용 완료'; showMessage('차량 이동시간을 일정에 적용했어요.');
        } else {
          showMessage(validText(outcome?.reason, 500) ? outcome.reason : '일정에 적용하지 못했어요. 일정을 확인한 뒤 다시 시도해 주세요.', true);
        }
      } catch (_error) {
        if (!destroyed && applyVersion === version) showMessage('일정에 적용하지 못했어요. 다시 시도해 주세요.', true);
      } finally {
        if (!destroyed && applyVersion === version) {
          applying = false; apply.disabled = applied; retry.disabled = !ready; apply.setAttribute('aria-busy', 'false');
        }
      }
    }

    function activate(event) {
      if (event.type === 'click' || event.key === 'Enter' || event.key === ' ') userIntent = true;
    }
    function toggle() {
      if (details.open && userIntent && !attempted) search();
      userIntent = false;
    }
    summary.addEventListener('click', activate); summary.addEventListener('keydown', activate);
    details.addEventListener('toggle', toggle); retry.addEventListener('click', search); apply.addEventListener('click', applyRoute);
    return {
      destroy() {
        if (destroyed) return;
        destroyed = true; version++; pending?.abort(); if (timeout !== null) clearTimeout(timeout);
        summary.removeEventListener('click', activate); summary.removeEventListener('keydown', activate);
        details.removeEventListener('toggle', toggle); retry.removeEventListener('click', search); apply.removeEventListener('click', applyRoute);
        if (details.parentNode === host) host.replaceChildren();
      }
    };
  }

  window.TravelCarRouting = { mount };
})();

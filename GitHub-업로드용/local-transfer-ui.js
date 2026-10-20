(function () {
  'use strict';

  const modes = [
    ['walk', '도보'], ['local-bus', '시내·마을버스'], ['subway', '지하철'],
    ['car', '차량']
  ];
  const knownModes = new Set(modes.map(([value]) => value));
  const vehicleModes = new Set(['car']);
  const validText = (value, maximum) => typeof value === 'string' && value.trim().length > 0
    && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);

  function copyPoint(point, fallback) {
    return {
      latitude: point?.latitude, longitude: point?.longitude,
      name: validText(point?.name, 160) ? point.name.trim() : fallback
    };
  }

  function mount(host, { origin = null, destination = null, mode = null, onModeChange = null, onApplyRoute = null, onEditTime = null } = {}) {
    const from = copyPoint(origin, '출발지'), to = copyPoint(destination, '도착지');
    const canChange = typeof onModeChange === 'function';
    const restoredMode = mode === 'rental-car' || mode === 'taxi' ? 'car' : mode;
    let selectedMode = knownModes.has(restoredMode) ? restoredMode : null;
    const wrapper = document.createElement('div'); wrapper.className = 'local-transfer-controls';
    const context = document.createElement('p'); context.className = 'local-transfer-context';
    context.textContent = `${from.name} → ${to.name}`;
    const row = document.createElement('div'); row.className = 'local-transfer-row';
    const recommendation = document.createElement('span'); recommendation.className = 'local-transfer-recommendation'; recommendation.hidden = true;
    const basis = document.createElement('span'); basis.className = 'local-transfer-basis'; basis.textContent = '직선거리 기준'; basis.hidden = true;
    try {
      const suggestion = window.TravelPlanner?.getTransferSuggestion?.({ origin: from, destination: to });
      if (suggestion && (suggestion.mode === null || suggestion.mode === 'walk') && validText(suggestion.label, 80)
        && validText(suggestion.reason, 160) && Number.isFinite(suggestion.distanceMeters)
        && suggestion.distanceMeters >= 0 && suggestion.distanceMeters <= 2000000) {
        recommendation.textContent = suggestion.label; recommendation.title = suggestion.reason;
        recommendation.hidden = false; basis.hidden = false;
      }
    } catch (_error) { /* A missing suggestion does not prevent a manual choice. */ }
    const field = document.createElement('label'); field.className = 'local-transfer-field';
    const label = document.createElement('span'); label.textContent = '이동수단';
    const select = document.createElement('select'); select.className = 'local-transfer-select'; select.setAttribute('aria-label', '이동수단');
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '이동수단 선택'; placeholder.disabled = true;
    select.append(placeholder);
    for (const [value, name] of modes) {
      const option = document.createElement('option'); option.value = value; option.textContent = name; select.append(option);
    }
    select.value = selectedMode || ''; select.disabled = !canChange;
    field.append(label, select); row.append(recommendation, basis, field);
    const message = document.createElement('p'); message.className = 'local-transfer-message'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const hint = document.createElement('p'); hint.className = 'local-transfer-hint';
    const routeHost = document.createElement('div'); routeHost.className = 'local-transfer-route';
    wrapper.append(context, row, message, hint, routeHost); host.replaceChildren(wrapper);

    let destroyed = false, changing = false, version = 0, routeWidget = null;

    function showMessage(value, error = false) {
      message.textContent = value; message.classList.toggle('is-error', error);
    }
    function clearRoute() {
      routeWidget?.destroy(); routeWidget = null; routeHost.replaceChildren();
    }
    function renderMode() {
      clearRoute(); hint.textContent = '';
      if (destroyed) return;
      if (vehicleModes.has(selectedMode)) {
        if (typeof window.TravelCarRouting?.mount === 'function') {
          const routeMode = selectedMode;
          routeWidget = window.TravelCarRouting.mount(routeHost, {
            origin: from, destination: to, compact: true,
            onApply: typeof onApplyRoute === 'function' ? route => {
              if (destroyed || changing || routeMode !== selectedMode) return { ok: false, reason: '이동수단을 다시 확인해 주세요.' };
              return onApplyRoute(route);
            } : null
          });
        } else hint.textContent = '예상시간은 일정 수정에서 입력해 주세요.';
      } else if (selectedMode === 'local-bus' || selectedMode === 'subway') {
        if (typeof window.TravelTransitRouting?.mount === 'function') {
          const routeMode = selectedMode;
          routeWidget = window.TravelTransitRouting.mount(routeHost, {
            origin: from, destination: to, mode: selectedMode, compact: true,
            onEdit: typeof onEditTime === 'function' ? () => {
              if (destroyed || changing || routeMode !== selectedMode) return { ok: false, reason: '이동수단을 다시 확인해 주세요.' };
              return onEditTime();
            } : null
          });
        } else hint.textContent = '예상시간은 일정 수정에서 입력해 주세요.';
      } else if (selectedMode !== null) hint.textContent = '예상시간은 일정 수정에서 입력해 주세요.';
    }
    async function changeMode() {
      const nextMode = select.value;
      if (destroyed || changing || !canChange) return;
      if (!knownModes.has(nextMode) || nextMode === selectedMode) { select.value = selectedMode || ''; return; }
      changing = true; select.disabled = true; select.setAttribute('aria-busy', 'true'); clearRoute();
      const changeVersion = ++version;
      showMessage('이동수단을 변경하고 있어요.');
      try {
        const outcome = await onModeChange(nextMode);
        if (destroyed || changeVersion !== version) return;
        if (outcome?.ok === true) { selectedMode = nextMode; showMessage(''); }
        else showMessage(validText(outcome?.reason, 500) ? outcome.reason : '이동수단을 변경하지 못했어요. 다시 선택해 주세요.', true);
      } catch (_error) {
        if (!destroyed && changeVersion === version) showMessage('이동수단을 변경하지 못했어요. 다시 선택해 주세요.', true);
      } finally {
        if (!destroyed && changeVersion === version) {
          changing = false; select.disabled = !canChange; select.value = selectedMode || ''; select.setAttribute('aria-busy', 'false'); renderMode();
        }
      }
    }
    select.addEventListener('change', changeMode); renderMode();
    return {
      destroy() {
        if (destroyed) return;
        destroyed = true; version++; select.removeEventListener('change', changeMode); clearRoute();
        if (wrapper.parentNode === host) host.replaceChildren();
      }
    };
  }

  window.TravelLocalTransfer = { mount };
})();

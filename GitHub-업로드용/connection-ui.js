(function () {
  'use strict';

  const services = {
    train: { mode: 'train', heading: '환승역', source: '15098552' },
    express: { mode: 'bus', heading: '환승터미널', source: '15098522' },
    intercity: { mode: 'bus', heading: '환승터미널', source: '15098541' },
    flight: { mode: 'flight', heading: '환승공항', source: '15098526' },
    ferry: { mode: 'ferry', heading: '환승항구', source: '15098523' }
  };
  const validText = (value, maximum, required = true) => typeof value === 'string' && value.length <= maximum
    && (!required || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/.test(value);
  const tripFields = ['id', 'service', 'departureId', 'arrivalId', 'departureName', 'arrivalName', 'date', 'departureMinutes', 'arrivalMinutes', 'durationMinutes', 'tripNo', 'grade', 'source', 'sourceUrl', 'fetchedAt'];
  function dayNumber(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const time = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time / 86400000 : null;
  }
  const dayLabel = number => new Date(number * 86400000).toISOString().slice(0, 10);
  const clock = minutes => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const durationLabel = minutes => {
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return hours ? `${hours}시간${rest ? ` ${rest}분` : ''}` : `${rest}분`;
  };
  function tripTime(date, minutes) {
    return `${dayLabel(dayNumber(date) + Math.floor(minutes / 1440)).replace(/-/g, '.')} ${clock(minutes)}`;
  }
  function stop(value, service = null) {
    const config = value && services[value.service];
    if (!config || (service && value.service !== service) || value.source !== 'TAGO' || value.mode !== config.mode
      || !validText(value.providerId, 80) || !/^[A-Za-z0-9_-]+$/.test(value.providerId)
      || value.id !== `tago-${value.service}-${value.providerId}` || !validText(value.name, 120)
      || !validText(value.address, 300, false) || value.latitude !== null || value.longitude !== null
      || value.sourceUrl !== `https://www.data.go.kr/data/${config.source}/openapi.do`) return null;
    return { id: value.id, providerId: value.providerId, service: value.service, mode: value.mode, name: value.name,
      address: value.address, latitude: null, longitude: null, source: 'TAGO', sourceUrl: value.sourceUrl };
  }
  function trip(value, from, to, date) {
    if (!value || !from || !to || tripFields.some(field => !Object.hasOwn(value, field)) || Object.keys(value).some(field => !tripFields.includes(field))
      || !validText(value.id, 300) || !validText(value.departureName, 120) || !validText(value.arrivalName, 120)
      || !validText(value.tripNo, 100, false) || !validText(value.grade, 100, false)
      || typeof value.fetchedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.fetchedAt) || !Number.isFinite(Date.parse(value.fetchedAt))
      || value.service !== from.service
      || value.departureId !== from.providerId || value.arrivalId !== to.providerId || value.date !== date
      || value.source !== 'TAGO' || value.sourceUrl !== from.sourceUrl || !Number.isInteger(value.departureMinutes)
      || value.departureMinutes < 0 || value.departureMinutes >= 1440 || !Number.isInteger(value.arrivalMinutes)
      || !Number.isInteger(value.durationMinutes) || value.durationMinutes < 1 || value.durationMinutes > 4320
      || value.arrivalMinutes - value.departureMinutes !== value.durationMinutes) return null;
    return { ...value };
  }

  function mount(host, { date = '', departure = null, arrival = null, transport = null, onApply = null } = {}) {
    const from = stop(departure), to = stop(arrival, from?.service);
    const ready = Boolean(from && to && from.providerId !== to.providerId && dayNumber(date) !== null);
    let via = null, first = null, second = null, minimum = 15, secondDate = '';
    let destroyed = false, applying = false, version = 0, viaWidget = null, legWidgets = [];

    const details = document.createElement('details'); details.className = 'connection-lookup';
    const summary = document.createElement('summary');
    const heading = document.createElement('strong'); heading.className = 'connection-heading'; heading.textContent = '환승편 조회';
    const summaryPreview = document.createElement('span'); summaryPreview.className = 'connection-summary-preview';
    const action = document.createElement('span'); action.className = 'connection-summary-action'; action.textContent = '1회 환승';
    summary.append(heading, summaryPreview, action);
    const body = document.createElement('div'); body.className = 'connection-body';
    const note = document.createElement('p'); note.className = 'connection-note';
    note.textContent = ready ? `${from.name} → 환승 장소 → ${to.name} · 두 편을 고른 뒤 한 번에 적용해요.`
      : '교통기관 목록에서 같은 종류의 출발·도착 장소를 먼저 선택해 주세요.';
    const viaHost = document.createElement('div'); viaHost.className = 'connection-via';
    const settings = document.createElement('div'); settings.className = 'connection-settings'; settings.hidden = !ready;
    const gapLabel = document.createElement('label'); gapLabel.className = 'connection-gap-label';
    const gapText = document.createElement('span'); gapText.textContent = '환승 여유';
    const gap = document.createElement('input'); gap.className = 'connection-gap'; gap.type = 'number'; gap.min = '0'; gap.max = '180'; gap.step = '1'; gap.value = '15'; gap.setAttribute('aria-label', '최소 환승 여유시간 (분)');
    const gapUnit = document.createElement('span'); gapUnit.textContent = '분'; gapLabel.append(gapText, gap, gapUnit); settings.append(gapLabel);
    const legsHost = document.createElement('div'); legsHost.className = 'connection-legs';
    const preview = document.createElement('div'); preview.className = 'connection-preview';
    const message = document.createElement('p'); message.className = 'connection-message'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'connection-apply'; apply.textContent = '환승 일정 적용'; apply.hidden = true; apply.disabled = true;
    body.append(note, viaHost, settings, legsHost, preview, message, apply); details.append(summary, body); host.replaceChildren(details);

    function showMessage(value, error = false) { message.textContent = value; message.classList.toggle('is-error', error); }
    function clearLegWidgets() { legWidgets.forEach(widget => widget?.destroy()); legWidgets = []; legsHost.replaceChildren(); }
    function bounds() {
      if (!first) return null;
      const arrivalDay = dayNumber(first.date) + Math.floor(first.arrivalMinutes / 1440);
      const earliest = dayNumber(first.date) * 1440 + first.arrivalMinutes + minimum;
      return { arrivalDay, minDate: dayLabel(arrivalDay), maxDate: dayLabel(arrivalDay + 1),
        earliest, earliestDate: dayLabel(Math.floor(earliest / 1440)) };
    }
    function waitMinutes(firstTrip = first, secondTrip = second) {
      return (dayNumber(secondTrip.date) - dayNumber(firstTrip.date)) * 1440 + secondTrip.departureMinutes - firstTrip.arrivalMinutes;
    }
    function secondFits(item) {
      if (!first || !via || !item || dayNumber(item.date) === null) return false;
      const range = bounds();
      return item.date >= range.minDate && item.date <= range.maxDate && Boolean(trip(item, via, to, item.date)) && waitMinutes(first, item) >= minimum;
    }
    function combination() {
      if (!via || !first || !second || !secondFits(second)) return { ok: false, reason: '환승 여유시간을 확보할 수 있는 두 편을 선택해 주세요.' };
      if (typeof window.TravelPlanner?.buildConnection === 'function') {
        return window.TravelPlanner.buildConnection({ departure: from, arrival: to, via, legs: [first, second], minimumTransferMinutes: minimum, date });
      }
      return { ok: true };
    }
    function renderPreview() {
      preview.replaceChildren();
      summaryPreview.textContent = via ? `${via.name} 경유${first && second ? ' · 두 편 선택됨' : ''}` : '환승 장소와 두 교통편 선택';
      if (first) {
        const line = document.createElement('p'); line.textContent = `1구간 ${from.name} → ${via.name} · ${tripTime(first.date, first.departureMinutes)} → ${tripTime(first.date, first.arrivalMinutes)}`; preview.append(line);
      }
      if (second) {
        const line = document.createElement('p'); line.textContent = `2구간 ${via.name} → ${to.name} · ${tripTime(second.date, second.departureMinutes)} → ${tripTime(second.date, second.arrivalMinutes)}`; preview.append(line);
        const timing = document.createElement('strong');
        const wait = waitMinutes(), total = first.durationMinutes + wait + second.durationMinutes;
        timing.textContent = `환승 대기 ${durationLabel(wait)} · 총 이동 ${durationLabel(total)}`; preview.append(timing);
      }
      let complete = false;
      try { complete = Boolean(first && second && combination()?.ok); } catch (_error) { complete = false; }
      apply.hidden = !complete; apply.disabled = !complete || applying || typeof onApply !== 'function';
    }
    function selectFirst(value) {
      if (destroyed || applying) return { ok: false, reason: '환승 편을 다시 확인해 주세요.' };
      const next = trip(value, from, via, date);
      if (!next) return { ok: false, reason: '출발지와 환승 장소에 맞는 첫 번째 교통편을 선택해 주세요.' };
      const changed = !first || first.id !== next.id || first.date !== next.date || first.departureMinutes !== next.departureMinutes || first.arrivalMinutes !== next.arrivalMinutes;
      first = next;
      if (changed || (second && !secondFits(second))) second = null;
      const range = bounds();
      if (!secondDate || secondDate < range.earliestDate || secondDate > range.maxDate) secondDate = range.earliestDate;
      showMessage(''); renderLegs(); return { ok: true };
    }
    function selectSecond(value) {
      if (destroyed || applying) return { ok: false, reason: '환승 편을 다시 확인해 주세요.' };
      const next = trip(value, via, to, secondDate);
      if (!next || !secondFits(next)) {
        showMessage('첫 번째 편의 도착 후 환승 여유시간을 확보할 수 있는 두 번째 편을 선택해 주세요.', true);
        return { ok: false, reason: message.textContent };
      }
      const previous = second; second = next;
      let result;
      try { result = combination(); } catch (_error) { result = { ok: false }; }
      if (!result?.ok) {
        second = previous;
        showMessage(validText(result?.reason, 500) ? result.reason : '선택한 두 편을 연결할 수 없어요. 다른 교통편을 선택해 주세요.', true);
        return { ok: false, reason: message.textContent };
      }
      showMessage(''); renderLegs(); return { ok: true };
    }
    function changeSecondDate(event) {
      if (destroyed || applying || !first) return;
      const next = event.target.value, range = bounds();
      if (dayNumber(next) === null || next < range.minDate || next > range.maxDate) {
        event.target.value = secondDate; showMessage('첫 번째 편이 도착하는 날이나 다음 날을 선택해 주세요.', true); return;
      }
      if (next === secondDate) return;
      secondDate = next; second = null; showMessage(''); renderLegs();
    }
    function renderLegs() {
      clearLegWidgets();
      if (destroyed || !ready || !via) { renderPreview(); return; }
      const mountTransport = window.TravelTransport?.mount;
      if (typeof mountTransport !== 'function') { showMessage('시간표를 준비 중이에요. 잠시 후 다시 확인해 주세요.', true); renderPreview(); return; }
      const firstLabel = document.createElement('p'); firstLabel.className = 'connection-leg-label'; firstLabel.textContent = `1구간 · ${from.name} → ${via.name}`;
      const firstHost = document.createElement('div'); firstHost.className = 'connection-first-leg'; legsHost.append(firstLabel, firstHost);
      legWidgets.push(mountTransport(firstHost, { date, departure: from, arrival: via, startTime: '00:00', transport: first, draft: true,
        onApply: selectFirst, onClear: () => { if (destroyed || applying) return { ok: false }; first = null; second = null; secondDate = ''; showMessage(''); renderLegs(); return { ok: true }; } }));
      if (first) {
        const range = bounds();
        const secondLabel = document.createElement('p'); secondLabel.className = 'connection-leg-label'; secondLabel.textContent = `2구간 · ${via.name} → ${to.name}`;
        const dateLabel = document.createElement('label'); dateLabel.className = 'connection-date-label';
        const dateText = document.createElement('span'); dateText.textContent = '환승 후 출발일';
        const dateInput = document.createElement('input'); dateInput.type = 'date'; dateInput.className = 'connection-date'; dateInput.min = range.minDate; dateInput.max = range.maxDate; dateInput.value = secondDate;
        dateInput.disabled = applying; dateInput.addEventListener('change', changeSecondDate); dateLabel.append(dateText, dateInput);
        // Date inputs are replaced with their section; retain their cleanup with the nested widgets.
        legWidgets.push({ destroy: () => dateInput.removeEventListener('change', changeSecondDate) });
        legsHost.append(secondLabel, dateLabel);
        const selectedDay = dayNumber(secondDate);
        if (selectedDay * 1440 + 1439 < range.earliest) {
          const unavailable = document.createElement('p'); unavailable.className = 'connection-date-hint';
          unavailable.textContent = `${range.earliestDate.replace(/-/g, '.')} ${clock(range.earliest % 1440)} 이후에 출발하는 편을 선택해 주세요.`; legsHost.append(unavailable);
        } else {
          const secondHost = document.createElement('div'); secondHost.className = 'connection-second-leg'; legsHost.append(secondHost);
          const threshold = Math.max(0, range.earliest - selectedDay * 1440);
          legWidgets.push(mountTransport(secondHost, { date: secondDate, departure: via, arrival: to, startTime: clock(threshold), transport: second, draft: true,
            onApply: selectSecond, onClear: () => { if (destroyed || applying) return { ok: false }; second = null; showMessage(''); renderLegs(); return { ok: true }; } }));
        }
      }
      renderPreview();
    }
    function selectVia(value) {
      if (destroyed || applying) return;
      const next = value === null ? null : stop(value, from?.service);
      if (value !== null && (!next || next.providerId === from.providerId || next.providerId === to.providerId)) {
        viaWidget?.set(via); showMessage('출발지·최종 도착지와 다른 환승 장소를 같은 교통기관 목록에서 선택해 주세요.', true); return;
      }
      if (via?.id === next?.id) return;
      via = next; first = null; second = null; secondDate = ''; showMessage(''); renderLegs();
    }
    function changeGap() {
      if (destroyed || applying) return;
      const next = Number(gap.value);
      if (!/^\d{1,3}$/.test(gap.value) || !Number.isInteger(next) || next < 0 || next > 180) {
        gap.value = String(minimum); showMessage('환승 여유시간은 0~180분으로 입력해 주세요.', true); return;
      }
      if (next === minimum) return;
      minimum = next;
      const hadSecond = Boolean(second);
      if (second && !secondFits(second)) second = null;
      if (first) {
        const range = bounds();
        if (!secondDate || secondDate < range.earliestDate || secondDate > range.maxDate) secondDate = range.earliestDate;
      }
      showMessage(hadSecond && !second ? '환승 여유시간이 달라져 두 번째 편을 다시 선택해 주세요.' : ''); renderLegs();
    }
    async function applyConnection() {
      if (destroyed || applying || typeof onApply !== 'function') return;
      let result;
      try { result = combination(); } catch (_error) { result = { ok: false }; }
      if (!result?.ok) { showMessage(validText(result?.reason, 500) ? result.reason : '환승할 두 편을 다시 확인해 주세요.', true); return; }
      const requestVersion = ++version;
      applying = true; gap.disabled = true; viaHost.inert = true; legsHost.inert = true; apply.disabled = true; apply.setAttribute('aria-busy', 'true');
      try {
        const outcome = await onApply({ via: { ...via }, legs: [{ ...first }, { ...second }], minimumTransferMinutes: minimum });
        if (destroyed || requestVersion !== version) return;
        showMessage(outcome?.ok === true ? '환승 일정을 적용했어요.' : validText(outcome?.reason, 500) ? outcome.reason : '환승 일정을 적용하지 못했어요. 다시 확인해 주세요.', outcome?.ok !== true);
      } catch (_error) {
        if (!destroyed && requestVersion === version) showMessage('환승 일정을 적용하지 못했어요. 다시 시도해 주세요.', true);
      } finally {
        if (!destroyed && requestVersion === version) { applying = false; gap.disabled = false; viaHost.inert = false; legsHost.inert = false; apply.setAttribute('aria-busy', 'false'); renderPreview(); }
      }
    }

    if (ready) {
      const saved = transport?.connection;
      if (saved && Number.isInteger(saved.minimumTransferMinutes) && saved.minimumTransferMinutes >= 0 && saved.minimumTransferMinutes <= 180) {
        const savedVia = stop(saved.via, from.service);
        if (savedVia && savedVia.providerId !== from.providerId && savedVia.providerId !== to.providerId && Array.isArray(saved.legs) && saved.legs.length === 2) {
          via = savedVia; minimum = saved.minimumTransferMinutes; gap.value = String(minimum);
          first = trip(saved.legs[0], from, via, date);
          secondDate = typeof saved.legs[1]?.date === 'string' ? saved.legs[1].date : '';
          second = trip(saved.legs[1], via, to, secondDate);
          let valid = false; try { valid = Boolean(combination()?.ok); } catch (_error) { valid = false; }
          if (!valid) { via = null; first = null; second = null; secondDate = ''; minimum = 15; gap.value = '15'; }
        }
      }
      if (typeof window.TravelDeparture?.mount === 'function') viaWidget = window.TravelDeparture.mount(viaHost, {
        departure: via, role: 'arrival', mode: from.mode, service: from.service, heading: services[from.service].heading, onChange: selectVia
      });
      else showMessage('환승 장소 선택을 준비 중이에요. 잠시 후 다시 확인해 주세요.', true);
    }
    gap.addEventListener('change', changeGap); apply.addEventListener('click', applyConnection); renderLegs();
    return { destroy() {
      if (destroyed) return;
      destroyed = true; version++; viaWidget?.destroy(); clearLegWidgets();
      gap.removeEventListener('change', changeGap); apply.removeEventListener('click', applyConnection);
      if (details.parentNode === host) host.replaceChildren();
    } };
  }

  window.TravelConnections = { mount };
})();

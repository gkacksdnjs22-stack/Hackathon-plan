(function () {
  'use strict';
  const kinds = [['free', '직접 입력'], ['place', '관광지'], ['meal', '식사'], ['rest', '휴식'], ['transfer', '이동']];
  const validLine = (value, maximum) => typeof value === 'string' && value.trim().length > 0
    && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
  const validMemo = value => typeof value === 'string' && value.length <= 500
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  const defaultDraft = type => ({ title: ({ meal: '식사', rest: '휴식', transfer: '이동' })[type] || '',
    description: '', hours: '0', minutes: type === 'rest' ? '30' : type === 'transfer' ? '0' : '60' });

  function mount(host, { day = null, dayIndex = 0, city = null, usedPlaceIds = [], onAdd = null } = {}) {
    const used = new Set(Array.isArray(usedPlaceIds) ? usedPlaceIds.filter(id => typeof id === 'string') : []);
    const places = new Map();
    const candidates = Array.isArray(city?.catalogPlaces) ? city.catalogPlaces.map(place => ({ place, area: null }))
      : (Array.isArray(city?.areas) ? city.areas : []).flatMap(area => (Array.isArray(area?.places) ? area.places : []).map(place => ({ place, area })));
    for (const { place, area } of candidates) {
        if (!place || !validLine(place.id, 160) || !validLine(place.name, 160) || places.has(place.id)) continue;
        const areaName = place.areaName || place.area || area?.name || city?.name;
        places.set(place.id, { id: place.id, name: place.name,
          area: validLine(areaName, 200) ? areaName : '',
          address: typeof place.address === 'string' ? place.address.slice(0, 500) : '',
          stayMinutes: Number.isInteger(place.stayMinutes) && place.stayMinutes > 0 ? Math.min(720, place.stayMinutes) : 60 });
    }
    const availablePlaces = [...places.values()].filter(place => !used.has(place.id));
    const details = document.createElement('details'); details.className = 'schedule-add';
    const summary = document.createElement('summary');
    const heading = document.createElement('strong'); heading.textContent = '일정 추가';
    const mark = document.createElement('span'); mark.className = 'schedule-summary-mark'; mark.textContent = '+'; mark.setAttribute('aria-hidden', 'true');
    summary.append(heading, mark);
    const form = document.createElement('form'); form.className = 'schedule-form'; form.noValidate = true;
    form.setAttribute('aria-label', `${Number.isInteger(dayIndex) && dayIndex >= 0 ? dayIndex + 1 : 1}일차 일정 추가`);
    const help = document.createElement('p'); help.className = 'schedule-help';
    help.textContent = '새 일정은 맨 마지막(마무리 앞)에 추가돼요. 순서는 시간표의 점에서 바꾸고, 필요한 이동 구간도 추가해 주세요.';
    const grid = document.createElement('div'); grid.className = 'schedule-grid';
    function field(caption, input, className = '') {
      const label = document.createElement('label'); label.className = `schedule-field ${className}`.trim();
      const text = document.createElement('span'); text.textContent = caption; label.append(text, input); grid.append(label);
      return { label, caption: text };
    }
    const type = document.createElement('select'); type.className = 'schedule-type-select';
    type.setAttribute('aria-label', '추가할 일정 종류');
    for (const [value, name] of kinds) {
      const option = document.createElement('option'); option.value = value; option.textContent = name; type.append(option);
    }
    type.value = 'free'; const typeField = field('일정 종류', type);
    const place = document.createElement('select'); place.className = 'schedule-place-select day-area-select';
    place.setAttribute('aria-label', '추가할 관광지 검색과 선택');
    for (const candidate of availablePlaces) {
      const option = document.createElement('option'); option.value = candidate.id; option.textContent = candidate.name;
      option.title = [candidate.name, candidate.area, candidate.address].filter(Boolean).join(' · ');
      option.dataset.search = `${candidate.name} ${candidate.area} ${candidate.address}`; place.append(option);
    }
    if (!availablePlaces.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = '추가할 관광지가 없어요'; option.disabled = true; place.append(option);
    }
    const placeField = field('관광지 찾기', place, 'schedule-place-field schedule-wide').label;
    const placeHint = document.createElement('p'); placeHint.className = 'schedule-place-hint schedule-wide';
    placeHint.textContent = availablePlaces.length ? '이미 일정에 담은 관광지는 목록에서 제외했어요.'
      : places.size ? '이미 담은 관광지를 제외하면 추가할 후보가 없어요. 다른 종류를 선택해 주세요.' : '추가할 관광지 후보가 없어요. 다른 종류를 선택해 주세요.';
    grid.append(placeHint);
    const title = document.createElement('input'); title.type = 'text'; title.className = 'schedule-title-input';
    title.maxLength = 80; title.required = true; title.placeholder = '예: 숙소 체크인, 카페 들르기';
    const titleField = field('일정 이름', title);
    const duration = document.createElement('fieldset'); duration.className = 'schedule-duration';
    const legend = document.createElement('legend'); legend.textContent = '소요시간';
    const durationRow = document.createElement('div'); durationRow.className = 'schedule-duration-row';
    const hours = document.createElement('input'), minutes = document.createElement('input');
    for (const [input, unit, maximum, name] of [[hours, '시간', '12', 'hours'], [minutes, '분', '59', 'minutes']]) {
      input.type = 'number'; input.className = `schedule-${name}-input`; input.min = '0'; input.max = maximum; input.step = '1'; input.required = true; input.inputMode = 'numeric';
      input.setAttribute('aria-label', `추가할 일정 소요시간: ${unit}`);
      const label = document.createElement('label'); label.className = 'schedule-duration-part';
      const text = document.createElement('span'); text.textContent = unit; label.append(input, text); durationRow.append(label);
    }
    const durationHint = document.createElement('span'); durationHint.className = 'schedule-duration-hint';
    duration.append(legend, durationRow, durationHint); grid.append(duration);
    const description = document.createElement('textarea'); description.className = 'schedule-description-input';
    description.rows = 2; description.maxLength = 500; description.placeholder = '예약 정보나 하고 싶은 일을 적어보세요.';
    const memoField = field('내 메모', description);
    grid.replaceChildren(typeField.label, titleField.label, placeField, placeHint, duration, memoField.label);
    const actions = document.createElement('div'); actions.className = 'schedule-actions';
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'schedule-save'; save.textContent = '일정에 추가';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'schedule-cancel'; cancel.textContent = '닫기';
    const message = document.createElement('p'); message.className = 'schedule-message'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    actions.append(save, cancel); form.append(help, grid, actions, message); details.append(summary, form); host.replaceChildren(details);

    let destroyed = false, pending = false, version = 0, currentType = 'free', added = false;
    const drafts = new Map();
    const controls = [type, place, title, hours, minutes, description, cancel];
    function refreshSelects() { window.TravelSelect?.refresh(); }
    function showMessage(value, error = false) { message.textContent = value; message.classList.toggle('is-error', error); }
    function updateSubmit() {
      save.disabled = pending || added || typeof onAdd !== 'function' || currentType === 'place' && !availablePlaces.length;
      save.textContent = pending ? '추가하는 중…' : added ? '추가 완료' : '일정에 추가';
    }
    function updateControls() {
      for (const control of controls) control.disabled = pending;
      place.disabled = pending || currentType !== 'place' || !availablePlaces.length;
      updateSubmit();
      form.setAttribute('aria-busy', String(pending)); refreshSelects();
    }
    function setRecommendedDuration(candidate) {
      const total = candidate?.stayMinutes || 60;
      hours.value = String(Math.floor(total / 60)); minutes.value = String(total % 60);
    }
    function captureDraft() {
      drafts.set(currentType, { title: title.value, description: description.value, hours: hours.value, minutes: minutes.value, placeId: place.value });
    }
    function renderType(next) {
      currentType = next;
      const draft = drafts.get(next) || defaultDraft(next);
      title.value = draft.title; description.value = draft.description; hours.value = draft.hours; minutes.value = draft.minutes;
      if (!drafts.has(next)) {
        const total = Number(draft.minutes); hours.value = String(Math.floor(total / 60)); minutes.value = String(total % 60);
      }
      title.readOnly = next === 'place'; title.maxLength = next === 'place' ? 160 : 80;
      titleField.caption.textContent = next === 'place' ? '관광지 이름' : '일정 이름';
      placeField.hidden = next !== 'place'; placeHint.hidden = next !== 'place';
      durationHint.textContent = next === 'transfer' ? '미정인 이동시간은 0시간 0분으로 두세요.' : '최대 12시간까지 입력할 수 있어요.';
      if (next === 'place') {
        place.value = availablePlaces.some(candidate => candidate.id === draft.placeId) ? draft.placeId : availablePlaces[0]?.id || '';
        const candidate = places.get(place.value); title.value = candidate?.name || '';
        if (!drafts.has(next)) setRecommendedDuration(candidate);
      }
      updateControls();
    }
    function edited() {
      if (destroyed || pending) return;
      added = false; showMessage(''); updateSubmit();
    }
    function changeType() {
      if (destroyed || pending) return;
      if (!kinds.some(([value]) => value === type.value)) { type.value = currentType; return; }
      captureDraft(); renderType(type.value);
      if (currentType === 'free') title.focus({ preventScroll: true });
    }
    function changePlace() {
      if (destroyed || pending || currentType !== 'place') return;
      const candidate = availablePlaces.find(candidate => candidate.id === place.value);
      title.value = candidate?.name || ''; setRecommendedDuration(candidate);
    }
    async function submit(event) {
      event.preventDefault();
      if (destroyed || pending || added || typeof onAdd !== 'function') return;
      const selected = availablePlaces.find(candidate => candidate.id === place.value);
      if (currentType === 'place' && !selected) { showMessage('이미 일정에 담았거나 선택할 수 없는 관광지예요. 다른 관광지를 선택해 주세요.', true); return; }
      if (currentType !== 'place' && !validLine(title.value, 80)) { showMessage('일정 이름을 1~80자로 입력해 주세요.', true); title.focus(); return; }
      if (!validMemo(description.value)) { showMessage('메모는 500자 이내로 입력해 주세요.', true); description.focus(); return; }
      const hourPart = Number(hours.value), minutePart = Number(minutes.value), total = hourPart * 60 + minutePart;
      if (!/^\d{1,2}$/.test(hours.value) || !/^\d{1,2}$/.test(minutes.value) || !Number.isInteger(hourPart)
        || !Number.isInteger(minutePart) || hourPart > 12 || minutePart > 59 || total > 720 || total < (currentType === 'transfer' ? 0 : 1)) {
        showMessage(currentType === 'transfer' ? '이동시간은 0분부터 최대 12시간까지, 분은 0~59로 입력해 주세요.' : '소요시간은 1분부터 최대 12시간까지, 분은 0~59로 입력해 주세요.', true);
        hours.focus(); return;
      }
      const payload = Object.freeze({ beforeId: 'finish', type: currentType,
        ...(currentType === 'place' ? { placeId: selected.id } : { title: title.value.trim() }), description: description.value.trim(), duration: total });
      const submission = ++version;
      pending = true; showMessage(''); updateControls();
      try {
        const outcome = await onAdd(payload);
        if (destroyed || submission !== version) return;
        if (outcome?.ok === true) { added = true; showMessage('일정에 추가했어요.'); }
        else showMessage(validLine(outcome?.reason, 500) ? outcome.reason : '일정을 추가하지 못했어요. 다시 시도해 주세요.', true);
      } catch (_error) {
        if (!destroyed && submission === version) showMessage('일정을 추가하지 못했어요. 다시 시도해 주세요.', true);
      } finally {
        if (!destroyed && submission === version) { pending = false; updateControls(); }
      }
    }
    function close() { if (destroyed || pending) return; details.open = false; summary.focus({ preventScroll: true }); }
    function keydown(event) { if (event.key === 'Escape' && !pending) { event.preventDefault(); close(); } }
    function opened() {
      if (destroyed || !details.open) return;
      refreshSelects();
      if (currentType === 'free') title.focus({ preventScroll: true });
    }
    type.addEventListener('change', changeType); place.addEventListener('change', changePlace);
    form.addEventListener('input', edited); form.addEventListener('change', edited);
    form.addEventListener('submit', submit); form.addEventListener('keydown', keydown);
    cancel.addEventListener('click', close); details.addEventListener('toggle', opened);
    renderType('free');
    return { destroy() {
      if (destroyed) return;
      destroyed = true; version++; drafts.clear();
      type.removeEventListener('change', changeType); place.removeEventListener('change', changePlace);
      form.removeEventListener('input', edited); form.removeEventListener('change', edited);
      form.removeEventListener('submit', submit); form.removeEventListener('keydown', keydown);
      cancel.removeEventListener('click', close); details.removeEventListener('toggle', opened);
      if (details.parentNode === host) host.replaceChildren();
    } };
  }
  window.TravelSchedule = { mount };
})();

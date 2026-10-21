(function () {
  'use strict';
  const pendingNotice = '이동시간 또는 출발지가 미정이라 표시된 시각은 임시예요. 미정인 이동은 실제 0분을 뜻하지 않아요.';
  const pad = value => String(value).padStart(2, '0');
  function dayDate(startDate, index) {
    const base = Date.parse(`${startDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isFinite(base) || new Date(base).toISOString().slice(0, 10) !== startDate)
      throw Error('여행 날짜를 확인해 주세요.');
    return new Date(base + index * 86400000).toISOString().slice(0, 10);
  }
  function selectedDays(itinerary, dayIndex = null) {
    if (!itinerary?.days?.length) throw Error('내보낼 일정이 없어요.');
    if (dayIndex !== null && (!Number.isInteger(dayIndex) || !itinerary.days[dayIndex])) throw Error('날짜를 다시 선택해 주세요.');
    return itinerary.days.map((day, index) => ({ day, index, date: dayDate(itinerary.startDate, index) }))
      .filter(item => dayIndex === null || item.index === dayIndex);
  }
  function title(event) {
    if (event.type === 'place') return event.place.name;
    if (event.type === 'departure') return event.departure ? `${event.departure.name}에서 출발` : '출발지 미정';
    return event.title || event.meal || '일정';
  }
  function address(event) { return event.place?.address || event.location?.address || event.departure?.address || event.arrival?.address || ''; }
  function memo(event) {
    const text = event.description || '';
    return text === address(event) || text === event.place?.intro ? '' : text;
  }
  function pending(event) { return (event.type === 'transfer' || event.type === 'departure') && event.duration === 0; }
  function clock(minutes) {
    const offset = Math.floor(minutes / 1440), time = minutes % 1440;
    return `${offset === 1 ? '다음 날 ' : offset > 1 ? `${offset}일 후 ` : ''}${pad(Math.floor(time / 60))}:${pad(time % 60)}`;
  }
  function text(itinerary, dayIndex = null) {
    const days = selectedDays(itinerary, dayIndex);
    const lines = [`${itinerary.cityName} 여행 · ${itinerary.startDate}부터 ${itinerary.dayCount}일`, '시각 기준: 한국 시간 (Asia/Seoul)'];
    for (const { day, index, date } of days) {
      lines.push('', `${date} · Day ${pad(index + 1)}`);
      if (day.timesProvisional) lines.push(`※ ${pendingNotice}`);
      for (const event of day.events) {
        lines.push(`${clock(event.start)}${event.end > event.start ? `–${clock(event.end)}` : ''} ${title(event)}${pending(event) ? ' [이동시간 미정]' : ''}`);
        if (address(event)) lines.push(`  주소: ${address(event)}`);
        if (memo(event)) lines.push(`  ${memo(event).replace(/\r\n|\r/g, '\n').replace(/\n/g, '\n  ')}`);
      }
    }
    return lines.join('\n');
  }
  function escapeText(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n')
      .replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  }
  function fold(line) {
    const encoder = new TextEncoder();
    let output = '', size = 0;
    for (const character of line) {
      const length = encoder.encode(character).length;
      if (size + length > 75) { output += '\r\n '; size = 1; }
      output += character; size += length;
    }
    return output;
  }
  const utc = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  function calendar(itinerary, dayIndex = null, { now = new Date(), exportId = window.crypto.randomUUID(), timeZone = 'Asia/Seoul' } = {}) {
    if (timeZone !== 'Asia/Seoul') throw Error('캘린더 내보내기는 한국 시간 일정만 지원해요.');
    const days = selectedDays(itinerary, dayIndex);
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gil//Travel Planner//KO', 'CALSCALE:GREGORIAN'];
    let sequence = 0;
    for (const { day, index, date } of days) {
      // Seoul has used UTC+09:00 without daylight saving since 1988. Export UTC
      // so importing in another device time zone preserves the actual instant.
      const midnight = Date.parse(`${date}T00:00:00+09:00`);
      for (const event of day.events) {
        if (!Number.isInteger(event.start) || !Number.isInteger(event.end) || event.start < 0 || event.end < event.start)
          throw Error('일정 시각을 확인해 주세요.');
        const description = [`${itinerary.cityName} 여행 · ${date} · Day ${pad(index + 1)}`, '한국 시간 (Asia/Seoul)',
          day.timesProvisional ? pendingNotice : '', pending(event) ? '이 구간의 이동시간을 먼저 정해 주세요.' : '', memo(event)].filter(Boolean).join('\n');
        lines.push('BEGIN:VEVENT', `UID:${escapeText(exportId)}-${++sequence}@gil`, `DTSTAMP:${utc(now)}`,
          `DTSTART:${utc(midnight + event.start * 60000)}`);
        // A DATE-TIME event without DTEND is an instant, not an invented duration.
        if (event.end > event.start) lines.push(`DTEND:${utc(midnight + event.end * 60000)}`);
        lines.push(`SUMMARY:${escapeText(`${day.timesProvisional ? '[임시 시각] ' : ''}${title(event)}${pending(event) ? ' [이동시간 미정]' : ''}`)}`,
          `DESCRIPTION:${escapeText(description)}`);
        if (address(event)) lines.push(`LOCATION:${escapeText(address(event))}`);
        if (day.timesProvisional) lines.push('STATUS:TENTATIVE');
        lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
      }
    }
    lines.push('END:VCALENDAR');
    return `${lines.map(fold).join('\r\n')}\r\n`;
  }
  function filename(itinerary, dayIndex = null) {
    const city = itinerary.cityName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 60);
    return `길_${city}_${itinerary.startDate}_${dayIndex === null ? '전체' : `Day${pad(dayIndex + 1)}`}.ics`;
  }
  function mount(host, { getSelection }) {
    const controls = document.createElement('div'); controls.className = 'note-export-controls';
    const label = document.createElement('label'); label.textContent = '일정 내보내기';
    const scope = document.createElement('select'); scope.setAttribute('aria-label', '내보낼 일정 범위');
    for (const [value, caption] of [['current', '현재 날짜'], ['all', '전체 여행']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = caption; scope.append(option);
    }
    label.append(scope);
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'button button-quiet'; copy.textContent = '일정 텍스트 복사';
    const download = document.createElement('button'); download.type = 'button'; download.className = 'button button-quiet'; download.textContent = '캘린더 파일 (.ics)';
    const hint = document.createElement('p'); hint.className = 'note-export-hint'; hint.textContent = '편집 중인 내용은 먼저 저장해 주세요. 캘린더 앱의 가져오기에서 .ics 파일을 선택할 수 있어요. 이후 수정은 자동 동기화되지 않아요.';
    const status = document.createElement('p'); status.className = 'note-export-status'; status.setAttribute('role', 'status');
    const fallbackLabel = document.createElement('label'); fallbackLabel.className = 'note-export-fallback'; fallbackLabel.hidden = true;
    fallbackLabel.textContent = '복사용 일정 텍스트';
    const fallback = document.createElement('textarea'); fallback.readOnly = true; fallback.rows = 8; fallbackLabel.append(fallback);
    controls.append(label, copy, download); host.append(controls, hint, status, fallbackLabel);
    let generation = 0;
    const selection = () => { const state = getSelection(); return { ...state, dayIndex: scope.value === 'all' ? null : state.dayIndex }; };
    function refresh() {
      generation++; copy.disabled = download.disabled = false;
      status.textContent = ''; fallback.value = ''; fallbackLabel.hidden = true;
      const { itinerary, dayIndex } = getSelection();
      scope.children[0].textContent = itinerary ? `현재 날짜 · Day ${pad(dayIndex + 1)}` : '현재 날짜';
    }
    scope.addEventListener('change', refresh);
    copy.addEventListener('click', async () => {
      if (copy.disabled) return;
      refresh(); const version = generation;
      const { itinerary, dayIndex } = selection();
      let content;
      try { content = text(itinerary, dayIndex); } catch (error) { status.textContent = error.message; return; }
      copy.disabled = true;
      try {
        if (!window.navigator?.clipboard?.writeText) throw Error('Clipboard unavailable');
        await window.navigator.clipboard.writeText(content);
        if (version === generation) status.textContent = '일정을 복사했어요.';
      } catch (_error) {
        if (version === generation) {
          status.textContent = '자동 복사를 사용할 수 없어요. 아래 텍스트를 선택해 직접 복사해 주세요.';
          fallback.value = content; fallbackLabel.hidden = false; fallback.focus(); fallback.select();
        }
      } finally { if (version === generation) copy.disabled = false; }
    });
    download.addEventListener('click', () => {
      refresh();
      try {
        const { itinerary, dayIndex, timeZone } = selection();
        const content = calendar(itinerary, dayIndex, { timeZone });
        const url = window.URL.createObjectURL(new Blob([content], { type: 'text/calendar;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = filename(itinerary, dayIndex);
        try { document.body.append(link); link.click(); } finally { link.remove(); setTimeout(() => window.URL.revokeObjectURL(url), 30000); }
        status.textContent = '캘린더 파일을 만들었어요. 다운로드한 파일을 캘린더 앱에서 가져와 주세요.';
      } catch (error) { status.textContent = `파일을 만들지 못했어요. ${error.message}`; }
    });
    refresh();
    return { refresh };
  }
  window.TravelItineraryExport = { text, calendar, filename, mount };
})();

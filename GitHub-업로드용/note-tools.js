(function () {
  'use strict';
  let sequence = 0;
  function memoCounter(input) {
    const count = document.createElement('span'); count.className = 'memo-counter'; count.id = `memo-count-${++sequence}`;
    const describedBy = input.getAttribute('aria-describedby');
    input.setAttribute('aria-describedby', [describedBy, count.id].filter(Boolean).join(' '));
    input.parentNode.append(count);
    const update = () => { count.textContent = `${input.value.length} / ${input.maxLength}자`; };
    input.addEventListener('input', update); update();
    return update;
  }
  function addressCopy(address, name = '') {
    const wrapper = document.createElement('span'); wrapper.className = 'address-copy';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'address-copy-button'; button.textContent = '주소 복사';
    button.setAttribute('aria-label', `${name ? `${name} ` : ''}주소 복사`);
    const status = document.createElement('span'); status.className = 'address-copy-status'; status.setAttribute('role', 'status');
    button.disabled = typeof address !== 'string' || !address.trim();
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true; status.textContent = '';
      try {
        if (!window.navigator?.clipboard?.writeText) throw Error('Clipboard unavailable');
        await window.navigator.clipboard.writeText(address.trim());
        status.textContent = '주소를 복사했어요.';
      } catch (_error) {
        status.textContent = '복사하지 못했어요. 표시된 주소를 직접 선택해 복사해 주세요.';
      } finally { button.disabled = false; }
    });
    wrapper.append(button, status); return wrapper;
  }
  function countdown(startDate, dayCount = 1, timeZone = 'Asia/Seoul', now = new Date()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return '';
    const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const part = type => parts.find(item => item.type === type).value;
    const today = Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day')));
    const [year, month, date] = startDate.split('-').map(Number);
    const difference = Math.round((Date.UTC(year, month - 1, date) - today) / 86400000);
    return difference > 0 ? `D-${difference}` : difference === 0 ? '오늘 출발' : difference + dayCount > 0 ? '여행 중' : '지난 여행';
  }
  function daySummary(day) {
    const places = day.events.filter(event => event.type === 'place');
    const travel = day.events.filter(event => event.type === 'departure' || event.type === 'transfer');
    return {
      places: places.length,
      stay: places.reduce((sum, event) => sum + event.duration, 0),
      travel: travel.reduce((sum, event) => sum + event.duration, 0),
      pending: travel.filter(event => event.duration === 0).length
    };
  }
  function pendingTransfers(itinerary) {
    return itinerary.days.flatMap((day, dayIndex) => day.events.flatMap((event, position) => {
      if (event.type !== 'departure' && event.type !== 'transfer') return [];
      const reasons = [], origin = day.departure || event.departure;
      const needsArrival = event.type === 'departure' && ['train', 'bus', 'flight', 'ferry'].includes(origin?.mode);
      let target = 'time';
      if (event.type === 'departure') {
        if (!origin) { reasons.push('출발지 미정'); target = 'departure'; }
        else if (needsArrival && !day.arrival) { reasons.push('도착지 미정'); target = 'arrival'; }
      }
      if (event.duration === 0) reasons.push('이동시간 미정');
      if (!reasons.length) return [];
      const before = day.events.slice(0, position).reverse().find(item => item.type === 'place' || item.type === 'arrival');
      const after = day.events.slice(position + 1).find(item => item.type === 'place');
      const from = event.type === 'departure' ? origin?.name || '출발지' : before?.place?.name || before?.arrival?.name;
      const to = needsArrival ? day.arrival?.name || '도착지' : after?.place?.name;
      const title = from && to ? `${from} → ${to}` : event.title || '이동';
      return [{ dayIndex, eventId: event.id, title, reason: reasons.join(' · '), target }];
    }));
  }
  window.TravelNoteTools = { memoCounter, addressCopy, countdown, daySummary, pendingTransfers };
})();

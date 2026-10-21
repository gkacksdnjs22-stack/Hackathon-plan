(function () {
  'use strict';
  const node = (tag, className = '', text = '') => {
    const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
  };
  function placesForDay(day) {
    return (day?.events || []).filter(event => event.type === 'place').map((event, index) => {
      const place = event.place || {}, latitude = place.latitude, longitude = place.longitude;
      const mapped = Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= 33 && latitude <= 39.5 && longitude >= 124 && longitude <= 132;
      return { number: index + 1, eventId: event.id, name: place.name || '이름 없는 관광지', address: place.address || '', latitude, longitude, mapped };
    });
  }
  function groupsForPlaces(places) {
    const groups = new Map();
    for (const item of places.filter(item => item.mapped)) {
      const key = `${item.latitude.toFixed(6)},${item.longitude.toFixed(6)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups.values()];
  }
  function mount(host, { onFocus }) {
    const summary = node('summary'), body = node('div', 'day-map-body');
    const caption = node('p', 'day-map-caption'), canvas = node('div', 'day-map-canvas');
    canvas.setAttribute('role', 'region');
    const actions = node('div', 'day-map-actions');
    const fit = node('button', 'button button-quiet', '장소 모두 보기'); fit.type = 'button';
    const retry = node('button', 'button button-quiet', '지도 다시 시도'); retry.type = 'button'; retry.hidden = true;
    const status = node('p', 'day-map-status'); status.setAttribute('role', 'status');
    const list = node('ol', 'day-map-places'); list.setAttribute('aria-label', '방문 순서별 장소');
    const credit = node('p', 'day-map-credit');
    const osm = node('a', '', '© OpenStreetMap contributors'); osm.href = 'https://www.openstreetmap.org/copyright'; osm.target = '_blank'; osm.rel = 'noopener noreferrer';
    credit.append(osm);
    actions.append(fit, retry); body.append(caption, canvas, actions, status, list, credit); host.append(summary, body);
    let itinerary = null, dayIndex = 0, places = [], visible = false, signature = '', painted = '';
    let map = null, layer = null, markers = new Map(), revision = 0, loadingTimer = null;
    const failedMessage = '배경 지도를 불러오지 못한 부분이 있어요. 아래 장소 목록에서 일정을 확인할 수 있어요.';
    const clearTimer = () => { if (loadingTimer !== null) clearTimeout(loadingTimer); loadingTimer = null; };
    function clearMap() {
      revision++; clearTimer();
      const old = map; map = null; layer = null; painted = ''; markers.clear();
      old?.remove(); canvas.replaceChildren();
    }
    function focus(item, version) {
      if (version === signature && itinerary && visible) onFocus(dayIndex, item.eventId);
    }
    function fitAll() {
      if (!map) return;
      const points = places.filter(item => item.mapped).map(item => [item.latitude, item.longitude]);
      if (points.length === 1 || groupsForPlaces(places).length === 1) map.setView(points[0], 16, { animate: false });
      else map.fitBounds(points, { padding: [30, 35], maxZoom: 16, animate: false });
    }
    function paint() {
      if (!visible || !host.open || !itinerary || !places.some(item => item.mapped)) return;
      const L = window.L;
      if (!L?.map || !L?.tileLayer || !L?.marker) {
        canvas.hidden = true; status.textContent = '지도를 시작하지 못했어요. 페이지를 새로고침하거나 아래 장소 목록을 이용해 주세요.'; retry.hidden = false; return;
      }
      canvas.hidden = false;
      try {
        if (!map) {
          const version = ++revision;
          status.textContent = '배경 지도를 불러오는 중이에요.'; retry.hidden = true;
          map = L.map(canvas, { scrollWheelZoom: true, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
          map.zoomControl?.setPosition('topright');
          layer = L.layerGroup().addTo(map);
          const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19, minZoom: 6, keepBuffer: 0, updateWhenIdle: true,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
          });
          let failed = false;
          tiles.on('loading', () => {
            if (version !== revision) return;
            failed = false; status.textContent = '배경 지도를 불러오는 중이에요.'; retry.hidden = true; clearTimer();
            loadingTimer = setTimeout(() => { if (version === revision) { status.textContent = failedMessage; retry.hidden = false; } }, 15000);
          });
          tiles.on('tileerror', () => { if (version === revision) { failed = true; status.textContent = failedMessage; retry.hidden = false; clearTimer(); } });
          tiles.on('load', () => { if (version === revision) { clearTimer(); status.textContent = failed ? failedMessage : ''; retry.hidden = !failed; } });
          tiles.addTo(map);
        }
        map.invalidateSize({ pan: false });
        if (painted === signature) return;
        layer.clearLayers(); markers.clear();
        const version = signature;
        groupsForPlaces(places).forEach(group => {
          const numbers = group.map(item => item.number).join('·'), first = group[0];
          const popup = node('div', 'day-map-popup');
          group.forEach(item => {
            const entry = node('div', 'day-map-popup-place');
            const title = node('strong', '', `${item.number}. ${item.name}`), address = node('p', '', item.address || '주소 정보 없음');
            const jump = node('button', 'day-map-jump', '해당 일정으로 이동'); jump.type = 'button';
            jump.setAttribute('aria-label', `${item.number}. ${item.name} 일정으로 이동`);
            jump.addEventListener('click', () => focus(item, version)); entry.append(title, address, jump); popup.append(entry);
          });
          const marker = L.marker([first.latitude, first.longitude], {
            icon: L.divIcon({ className: 'day-map-pin', html: `<span>${numbers}</span>`, iconSize: [group.length > 1 ? 46 : 34, 34], iconAnchor: [group.length > 1 ? 23 : 17, 34], popupAnchor: [0, -32] }),
            title: group.map(item => `${item.number}. ${item.name}`).join(' / '), alt: `${numbers}번 방문 장소`, keyboard: true
          }).addTo(layer).bindPopup(popup, { maxWidth: 280 });
          group.forEach(item => markers.set(item.eventId, marker));
        });
        painted = signature; fitAll();
      } catch (_error) {
        clearMap(); canvas.hidden = true; status.textContent = '지도를 표시하지 못했어요. 아래 장소 목록은 계속 사용할 수 있어요.'; retry.hidden = false;
      }
    }
    function renderList() {
      list.replaceChildren();
      const version = signature;
      places.forEach(item => {
        const entry = node('li', 'day-map-place'), copy = node('div', 'day-map-place-copy');
        copy.append(node('strong', '', `${item.number}. ${item.name}`), node('span', '', item.address || '주소 정보 없음'));
        const controls = node('div', 'day-map-place-actions');
        if (item.mapped) {
          const show = node('button', '', '지도에서 보기'); show.type = 'button';
          show.setAttribute('aria-label', `${item.number}. ${item.name} 지도에서 보기`);
          show.addEventListener('click', () => { paint(); markers.get(item.eventId)?.openPopup(); canvas.scrollIntoView({ block: 'nearest', behavior: 'instant' }); });
          controls.append(show);
        } else copy.append(node('span', 'day-map-missing', '좌표 없음 · 목록에서 일정 확인'));
        const jump = node('button', 'day-map-jump', '일정으로 이동'); jump.type = 'button';
        jump.setAttribute('aria-label', `${item.number}. ${item.name} 일정으로 이동`); jump.addEventListener('click', () => focus(item, version));
        controls.append(jump); entry.append(copy, controls); list.append(entry);
      });
    }
    function update(note, index) {
      itinerary = note; dayIndex = index;
      if (!note) { reset(); return; }
      places = placesForDay(note.days[index]);
      const next = JSON.stringify([index, places]);
      host.hidden = false; summary.textContent = `Day ${String(index + 1).padStart(2, '0')} 방문 장소 지도 · ${places.length}곳`;
      canvas.setAttribute('aria-label', `${index + 1}일차 관광지 지도`);
      const missing = places.filter(item => !item.mapped).length;
      caption.textContent = !places.length ? '이 날짜에는 담긴 관광지가 없어요.' : missing === places.length ? '지도에 표시할 좌표가 없어요. 아래 목록에서 일정으로 이동할 수 있어요.'
        : `방문 순서대로 번호를 표시해요.${missing ? ` 좌표가 없는 ${missing}곳은 목록에서 확인해 주세요.` : ''} 지도를 펼치면 OpenStreetMap 배경을 불러와요.`;
      fit.disabled = !places.some(item => item.mapped); canvas.hidden = fit.disabled;
      if (next !== signature) {
        // Marker changes do not imply another tile request. Keep the current
        // layer's error/retry state until its own loading events replace it.
        signature = next; renderList();
        if (fit.disabled) { clearMap(); status.textContent = ''; retry.hidden = true; }
      }
      paint();
    }
    function reset() {
      clearMap(); itinerary = null; places = []; signature = ''; visible = false; host.open = false; host.hidden = true;
      summary.textContent = ''; caption.textContent = ''; status.textContent = ''; list.replaceChildren(); retry.hidden = true;
    }
    host.addEventListener('toggle', () => { if (host.open) paint(); else clearMap(); });
    fit.addEventListener('click', () => { paint(); fitAll(); });
    retry.addEventListener('click', () => { clearMap(); paint(); });
    const resize = () => { if (visible && host.open) map?.invalidateSize({ pan: false }); };
    window.addEventListener('resize', resize);
    if (window.ResizeObserver) new window.ResizeObserver(resize).observe(canvas);
    return { update, reset, setVisible(value) { visible = value; if (value) paint(); else clearMap(); } };
  }
  window.TravelDayMap = { mount, placesForDay, groupsForPlaces };
})();

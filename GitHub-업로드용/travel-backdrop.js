(function () {
  'use strict';
  const trustedImage = value => {
    try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'tong.visitkorea.or.kr' && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  };
  const safeText = (value, maximum) => typeof value === 'string' && value.trim() && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
  function mount({ host, controls, caption, toggle, next } = {}) {
    if (!host || !controls || !caption || !toggle || !next) return null;
    let frames = [], active = 0, timer = null, paused = false, destroyed = false;
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const connection = window.navigator?.connection;
    const controller = new AbortController();
    const requestTimer = setTimeout(() => controller.abort(), 18000);
    const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const canAnimate = () => !destroyed && frames.length > 1 && !paused && !motion?.matches && !document.hidden && document.body.dataset.screen === 'start';
    function paint() {
      frames.forEach((frame, index) => frame.image.classList.toggle('is-current', index === active));
      const current = frames[active];
      if (current) {
        caption.textContent = `${current.item.title}${current.item.imageName ? ` (${current.item.imageName})` : ''} · ${current.item.author ? `${current.item.author} · ` : ''}${current.item.source || '한국관광공사'} · 공공누리 제1유형`;
        caption.href = current.item.sourceUrl;
      }
      controls.hidden = frames.length === 0;
      toggle.disabled = frames.length < 2 || Boolean(motion?.matches);
      next.disabled = frames.length < 2;
      toggle.textContent = motion?.matches ? '자동 전환 꺼짐' : paused ? '사진 재생' : '사진 멈추기';
      toggle.setAttribute('aria-pressed', String(paused || Boolean(motion?.matches)));
    }
    function schedule() {
      clear(); paint();
      if (canAnimate()) timer = setTimeout(() => { active = (active + 1) % frames.length; schedule(); }, 10000);
    }
    function onToggle() { paused = !paused; schedule(); }
    function onNext() { if (frames.length > 1) { active = (active + 1) % frames.length; schedule(); } }
    toggle.addEventListener('click', onToggle); next.addEventListener('click', onNext);
    document.addEventListener('visibilitychange', schedule);
    motion?.addEventListener?.('change', schedule);
    const observer = new MutationObserver(schedule); observer.observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
    async function load() {
      // The background is optional; data-saver users keep the paper treatment.
      if (connection?.saveData) { clearTimeout(requestTimer); return; }
      try {
        const response = await fetch('/api/tour/backdrop', { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const data = await response.json();
        if (destroyed || controller.signal.aborted || !Array.isArray(data?.items)) return;
        const urls = new Set();
        for (const item of data.items.slice(0, 3)) {
          const url = trustedImage(item?.imageUrl);
          // Only licensed, attributable provider photos may enter the decorative layer.
          if (!url || item.cpyrhtDivCd !== 'Type1' || !safeText(item.title, 160) || (item.author && !safeText(item.author, 300)) || (item.imageName && !safeText(item.imageName, 300)) || (item.source && !safeText(item.source, 300)) || urls.has(url)) continue;
          let source;
          try { source = new URL(item.sourceUrl); } catch { continue; }
          if (source.protocol !== 'https:' || !['api.visitkorea.or.kr', 'www.data.go.kr', 'tong.visitkorea.or.kr'].includes(source.hostname) || source.username || source.password) continue;
          urls.add(url);
          const image = document.createElement('img'); image.className = 'travel-backdrop-photo'; image.alt = ''; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
          image.addEventListener('load', () => { if (destroyed || frames.some(frame => frame.image === image)) return; frames.push({ image, item }); schedule(); });
          image.addEventListener('error', () => { image.remove(); });
          host.append(image); image.src = url;
        }
      } catch { /* Photo outages must never block the manual planner. */ }
      finally { clearTimeout(requestTimer); }
    }
    const ready = load();
    return { ready, destroy() { destroyed = true; clear(); clearTimeout(requestTimer); controller.abort(); observer.disconnect(); document.removeEventListener('visibilitychange', schedule); motion?.removeEventListener?.('change', schedule); toggle.removeEventListener('click', onToggle); next.removeEventListener('click', onNext); host.replaceChildren(); controls.hidden = true; frames = []; } };
  }
  window.TravelBackdrop = { mount };
  const host = document.getElementById('travel-backdrop');
  if (host) mount({ host, controls: document.getElementById('backdrop-controls'), caption: document.getElementById('backdrop-credit'), toggle: document.getElementById('backdrop-toggle'), next: document.getElementById('backdrop-next') });
})();

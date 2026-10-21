(function () {
  'use strict';
  const localImages = new Set(Array.from({ length: 10 }, (_, index) => `./travel-backdrop-${String(index + 1).padStart(2, '0')}.jpg`));
  const ccLicenses = new Map([
    ['CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'],
    ['CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0/'],
    ['CC BY 3.0', 'https://creativecommons.org/licenses/by/3.0/'],
    ['CC BY-SA 3.0', 'https://creativecommons.org/licenses/by-sa/3.0/'],
    ['CC BY 2.0', 'https://creativecommons.org/licenses/by/2.0/'],
    ['CC BY-SA 2.0', 'https://creativecommons.org/licenses/by-sa/2.0/'],
    ['CC0 1.0', 'https://creativecommons.org/publicdomain/zero/1.0/']
  ]);
  const trustedImage = (value, localOnly = false) => {
    if (localImages.has(value)) return value;
    if (localOnly) return null;
    try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'tong.visitkorea.or.kr' && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  };
  const safeText = (value, maximum) => typeof value === 'string' && value.trim() && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
  function mount({ host, story, storyTitle, storyDescription } = {}) {
    if (!host) return null;
    let frames = [], active = 0, timer = null, destroyed = false;
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const connection = window.navigator?.connection;
    const controller = new AbortController();
    const requestTimer = setTimeout(() => controller.abort(), 18000);
    const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const onStartScreen = () => document.body.dataset.screen === 'start';
    const canAnimate = () => !destroyed && frames.length > 1 && !motion?.matches && !document.hidden && onStartScreen();
    function paint() {
      frames.forEach((frame, index) => frame.image.classList.toggle('is-current', index === active));
      const current = frames[active];
      if (current) {
        if (storyTitle) storyTitle.textContent = current.item.title;
        if (storyDescription) {
          storyDescription.textContent = current.item.description;
          storyDescription.hidden = !current.item.description;
        }
      }
      host.hidden = !onStartScreen();
      if (story) story.hidden = !onStartScreen() || !current;
    }
    function schedule() {
      clear(); paint();
      if (canAnimate()) timer = setTimeout(() => { active = (active + 1) % frames.length; schedule(); }, 15000);
    }
    document.addEventListener('visibilitychange', schedule);
    motion?.addEventListener?.('change', schedule);
    const observer = new MutationObserver(schedule); observer.observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
    function addPhotos(items, localOnly = false) {
      const urls = new Set();
      for (const item of items.slice(0, localOnly ? 10 : 3)) {
        const url = trustedImage(item?.imageUrl, localOnly);
        if (!url || !safeText(item.title, 160) || (item.author && !safeText(item.author, 300)) || (item.imageName && !safeText(item.imageName, 300)) || (item.source && !safeText(item.source, 300)) || urls.has(url)) continue;
        let source;
        try { source = new URL(item.sourceUrl); } catch { continue; }
        if (source.protocol !== 'https:' || source.username || source.password) continue;
        // Audited local Commons photographs retain their own license and author.
        // The API fallback remains restricted to the provider's Type1 photographs.
        const providerPhoto = item.cpyrhtDivCd === 'Type1' && ['api.visitkorea.or.kr', 'www.data.go.kr', 'tong.visitkorea.or.kr'].includes(source.hostname);
        const commonsPhoto = localOnly && source.hostname === 'commons.wikimedia.org' && source.pathname.startsWith('/wiki/File:') && safeText(item.author, 300) && ccLicenses.has(item.license) && ccLicenses.get(item.license) === item.licenseUrl;
        if (!providerPhoto && !commonsPhoto) continue;
        urls.add(url);
        const normalized = { ...item, description: safeText(item.description, 300) ? item.description.trim() : '' };
        const image = document.createElement('img'); image.className = 'travel-backdrop-photo'; image.alt = ''; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.fetchPriority = urls.size === 1 ? 'auto' : 'low';
        image.addEventListener('load', () => { if (destroyed || frames.some(frame => frame.image === image)) return; frames.push({ image, item: normalized }); schedule(); });
        image.addEventListener('error', () => { image.remove(); });
        host.append(image); image.src = url;
      }
      return urls.size;
    }
    async function load() {
      // The background is optional; data-saver users keep the paper treatment.
      if (connection?.saveData) { clearTimeout(requestTimer); return; }
      // Packaged, attributed photographs keep the opening screen independent of API latency.
      const packaged = window.GIL_BACKDROP_FALLBACK_ITEMS;
      if (Array.isArray(packaged) && addPhotos(packaged, true)) { clearTimeout(requestTimer); return; }
      try {
        const response = await fetch('/api/tour/backdrop', { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const data = await response.json();
        if (destroyed || controller.signal.aborted || !Array.isArray(data?.items)) return;
        addPhotos(data.items);
      } catch { /* Photo outages must never block the manual planner. */ }
      finally { clearTimeout(requestTimer); }
    }
    schedule();
    const ready = load();
    return { ready, destroy() { destroyed = true; clear(); clearTimeout(requestTimer); controller.abort(); observer.disconnect(); document.removeEventListener('visibilitychange', schedule); motion?.removeEventListener?.('change', schedule); host.replaceChildren(); if (story) story.hidden = true; frames = []; } };
  }
  window.TravelBackdrop = { mount };
  const host = document.getElementById('travel-backdrop');
  if (host) mount({ host, story: document.getElementById('backdrop-story'), storyTitle: document.getElementById('backdrop-story-title'), storyDescription: document.getElementById('backdrop-story-description') });
})();

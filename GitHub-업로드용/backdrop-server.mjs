// Official schema: https://www.data.go.kr/data/15101578/openapi.do
// KOGL Type 1 permits adaptation with attribution; Type 3 does not.
import { normalizeServiceKey, TourApiError } from './tour-client.mjs';

export const BACKDROP_DESTINATIONS = Object.freeze([
  Object.freeze({ contentId: '126537', title: '북촌한옥마을' }),
  Object.freeze({ contentId: '127925', title: '광안리해변 테마거리' }),
  Object.freeze({ contentId: '228853', title: '용두암' })
]);
const PROVIDER = '한국관광공사 TourAPI';
const SOURCE_URL = 'https://www.data.go.kr/data/15101578/openapi.do';
const LICENSE_URL = 'https://www.kogl.or.kr/info/license.do';
const MAX_BYTES = 1024 * 1024;

function safeText(value, key) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 300) : '';
  return key && (text.includes(key) || text.includes(encodeURIComponent(key))) ? '' : text;
}
function imageUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'tong.visitkorea.or.kr' || url.username || url.password || url.port || url.search || url.hash) return '';
    if (!/^\/cms\/resource\/\d+\/[\w.-]+\.(?:jpe?g|png|webp)$/i.test(url.pathname)) return '';
    url.protocol = 'https:';
    return url.href;
  } catch { return ''; }
}
async function readJson(response) {
  if (!response.ok || response.redirected) throw new TourApiError('UPSTREAM_ERROR');
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw new TourApiError('INVALID_RESPONSE');
  const reader = response.body?.getReader();
  if (!reader) throw new TourApiError('INVALID_RESPONSE');
  const decoder = new TextDecoder();
  let size = 0, text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { void reader.cancel(); throw new TourApiError('INVALID_RESPONSE'); }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

export function createBackdropClient({ serviceKey, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 5000 } = {}) {
  let cache, expiresAt = 0, inFlight;
  async function photo(destination, key) {
    const url = new URL('https://apis.data.go.kr/B551011/KorService2/detailImage2');
    url.search = new URLSearchParams({ serviceKey: key, MobileOS: 'WEB', MobileApp: 'RODE', _type: 'json', contentId: destination.contentId, imageYN: 'Y', numOfRows: '30', pageNo: '1' }).toString();
    const controller = new AbortController();
    let timer;
    try {
      const data = await Promise.race([
        Promise.resolve().then(() => fetchImpl(url.href, { signal: controller.signal, redirect: 'error' })).then(readJson),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new TourApiError('TIMEOUT')); }, timeoutMs); })
      ]);
      const response = data?.response;
      if (!['0000', '00'].includes(String(response?.header?.resultCode))) return null;
      const raw = response?.body?.items?.item;
      const items = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
      for (const item of items) {
        if (item?.cpyrhtDivCd !== 'Type1' || String(item.contentid) !== destination.contentId) continue;
        const selectedUrl = imageUrl(item.smallimageurl) || imageUrl(item.originimgurl);
        if (!selectedUrl || selectedUrl.includes(key) || selectedUrl.includes(encodeURIComponent(key))) continue;
        return { ...destination, imageUrl: selectedUrl, imageName: safeText(item.imgname, key), serialNumber: safeText(item.serialnum, key), cpyrhtDivCd: 'Type1', license: '공공누리 제1유형 (출처표시)', licenseUrl: LICENSE_URL, source: '한국관광공사', sourceUrl: SOURCE_URL,
          ...(safeText(item.author, key) ? { author: safeText(item.author, key) } : {}) };
      }
      return null;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }
  async function load() {
    let items = [];
    try {
      const key = normalizeServiceKey(serviceKey);
      items = (await Promise.all(BACKDROP_DESTINATIONS.map(destination => photo(destination, key)))).filter(Boolean);
    } catch { /* A decorative backdrop must never block the itinerary UI. */ }
    cache = { provider: PROVIDER, items, fetchedAt: new Date(now()).toISOString() };
    expiresAt = now() + (items.length === BACKDROP_DESTINATIONS.length ? 6 * 60 * 60 * 1000 : 5 * 60 * 1000);
    return structuredClone(cache);
  }
  return { async getPhotos() {
    if (cache && now() < expiresAt) return structuredClone(cache);
    if (!inFlight) inFlight = load().finally(() => { inFlight = undefined; });
    return structuredClone(await inFlight);
  } };
}

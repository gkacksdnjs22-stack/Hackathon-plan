const SEARCH_ENDPOINT = 'https://photon.komoot.io/api/';
const PROVIDER = 'Photon / OpenStreetMap';
const ERRORS = Object.freeze({
  INVALID_QUERY: [400, '출발지 이름이나 주소를 2~100자로 입력해 주세요.'],
  SEARCH_UNAVAILABLE: [502, '출발지 검색에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'],
  INVALID_RESPONSE: [502, '출발지 검색 결과를 읽지 못했어요. 잠시 후 다시 시도해 주세요.'],
  SEARCH_TIMEOUT: [504, '출발지 검색이 지연되고 있어요. 잠시 후 다시 시도해 주세요.'],
  SEARCH_RATE_LIMIT: [429, '출발지 검색 요청이 많아요. 잠시 후 다시 시도해 주세요.']
});

export class DepartureSearchError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(ERRORS, code) ? code : 'SEARCH_UNAVAILABLE';
    super(ERRORS[safeCode][1]);
    this.name = 'DepartureSearchError';
    this.code = safeCode;
    this.status = ERRORS[safeCode][0];
  }
}

const clean = (value, length) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, length) : '';

function normalizeItems(features) {
  const items = [], seen = new Set();
  for (const feature of features) {
    if (!feature || typeof feature !== 'object' || feature.geometry?.type !== 'Point') continue;
    const properties = feature.properties;
    if (!properties || typeof properties !== 'object') continue;
    if (typeof properties.countrycode !== 'string' || properties.countrycode.trim().toUpperCase() !== 'KR') continue;
    if (!Array.isArray(feature.geometry.coordinates) || feature.geometry.coordinates.length < 2) continue;
    const [longitude, latitude] = feature.geometry.coordinates;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
      || latitude < 33 || latitude > 39.5 || longitude < 124 || longitude > 132) continue;
    const type = ({ n: 'node', w: 'way', r: 'relation', node: 'node', way: 'way', relation: 'relation' })[
      clean(properties.osm_type, 10).toLowerCase()];
    const osmId = typeof properties.osm_id === 'number'
      ? (Number.isSafeInteger(properties.osm_id) ? String(properties.osm_id) : '')
      : typeof properties.osm_id === 'string' ? properties.osm_id : '';
    if (!type || !/^[1-9]\d{0,19}$/.test(osmId)) continue;
    const id = `osm-${type}-${osmId}`;
    if (seen.has(id)) continue;
    const addressParts = ['state', 'city', 'district', 'street', 'housenumber']
      .map(key => clean(properties[key], 120)).filter(Boolean);
    const address = [...new Set(addressParts)].join(' ').slice(0, 300);
    const name = (clean(properties.name, 120)
      || [clean(properties.street, 100), clean(properties.housenumber, 20)].filter(Boolean).join(' ')
      || address).slice(0, 120);
    if (!name) continue;
    seen.add(id);
    items.push({ id, name, address, latitude, longitude,
      source: 'OpenStreetMap', sourceUrl: `https://www.openstreetmap.org/${type}/${osmId}` });
    if (items.length === 5) break;
  }
  return items;
}

async function readJson(response) {
  const maximum = 1024 * 1024;
  if (Number(response.headers?.get('content-length')) > maximum) throw new DepartureSearchError('INVALID_RESPONSE');
  const reader = response.body?.getReader();
  if (!reader) throw new DepartureSearchError('INVALID_RESPONSE');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new DepartureSearchError('INVALID_RESPONSE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)); }
  catch { throw new DepartureSearchError('INVALID_RESPONSE'); }
}

export function createDepartureClient({ fetchImpl = globalThis.fetch, now = Date.now,
  delayImpl = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  timeoutMs = 8000, totalTimeoutMs = 14000, cacheMs = 60 * 60 * 1000, maxCacheEntries = 200, maxPending = 20 } = {}) {
  const cache = new Map(), pending = new Map();
  const cacheLimit = Math.max(1, Math.min(200, Number.isSafeInteger(maxCacheEntries) ? maxCacheEntries : 200));
  const pendingLimit = Math.max(1, Math.min(200, Number.isSafeInteger(maxPending) ? maxPending : 20));
  let queue = Promise.resolve(), lastStartedAt = null;

  async function request(query, signal) {
    const url = new URL(SEARCH_ENDPOINT);
    for (const [key, value] of Object.entries({ q: query, limit: '5', bbox: '124,33,132,39.5', countrycode: 'KR' })) {
      url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    let rejectTimeout;
    const aborted = new Promise((_, reject) => { rejectTimeout = reject; });
    const abort = () => { controller.abort(); rejectTimeout(new DepartureSearchError('SEARCH_TIMEOUT')); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      return await Promise.race([aborted, (async () => {
        const response = await fetchImpl(url, { signal: controller.signal, redirect: 'manual', headers: {
          Accept: 'application/json', 'Accept-Language': 'ko', 'User-Agent': 'GilTravelPlanner/1.0'
        } });
        if (response.status === 429) throw new DepartureSearchError('SEARCH_RATE_LIMIT');
        if (!response.ok) throw new DepartureSearchError('SEARCH_UNAVAILABLE');
        const data = await readJson(response);
        if (!data || typeof data !== 'object' || !Array.isArray(data.features)) throw new DepartureSearchError('INVALID_RESPONSE');
        return { provider: PROVIDER, items: normalizeItems(data.features), fetchedAt: new Date(now()).toISOString() };
      })()]);
    } catch (error) {
      if (error instanceof DepartureSearchError) throw error;
      throw new DepartureSearchError(controller.signal.aborted ? 'SEARCH_TIMEOUT' : 'SEARCH_UNAVAILABLE');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }

  function schedule(query) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DepartureSearchError('SEARCH_TIMEOUT'));
      }, Number.isFinite(totalTimeoutMs) && totalTimeoutMs > 0 ? Math.min(totalTimeoutMs, 14000) : 14000);
    });
    const launch = queue.then(async () => {
      if (controller.signal.aborted) throw new DepartureSearchError('SEARCH_TIMEOUT');
      if (lastStartedAt !== null) {
        const remaining = Math.max(0, 1000 - (now() - lastStartedAt));
        if (remaining) await delayImpl(remaining);
      }
      if (controller.signal.aborted) throw new DepartureSearchError('SEARCH_TIMEOUT');
      lastStartedAt = now();
      // Only serialize starts. A slow response must not block unrelated searches.
      return { request: request(query, controller.signal) };
    });
    queue = launch.then(() => undefined, () => undefined);
    const work = launch.then(job => job.request);
    return Promise.race([deadline, work]).finally(() => clearTimeout(timer));
  }

  return {
    async search(value) {
      if (typeof value !== 'string') throw new DepartureSearchError('INVALID_QUERY');
      const query = value.trim();
      if (query.length < 2 || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query)) {
        throw new DepartureSearchError('INVALID_QUERY');
      }
      const cached = cache.get(query);
      if (cached && cached.expiresAt > now()) {
        cache.delete(query);
        cache.set(query, cached);
        return cached.payload;
      }
      if (cached) cache.delete(query);
      if (pending.has(query)) return pending.get(query);
      if (pending.size >= pendingLimit) throw new DepartureSearchError('SEARCH_RATE_LIMIT');
      const job = schedule(query).then(payload => {
        cache.delete(query);
        while (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
        cache.set(query, { expiresAt: now() + cacheMs, payload });
        return payload;
      }).catch(error => {
        throw error instanceof DepartureSearchError ? error : new DepartureSearchError('SEARCH_UNAVAILABLE');
      }).finally(() => pending.delete(query));
      pending.set(query, job);
      return job;
    }
  };
}

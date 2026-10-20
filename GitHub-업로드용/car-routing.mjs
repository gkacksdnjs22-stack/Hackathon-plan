// Current-traffic summary only: https://developers.kakaomobility.com/guide/navi-api/directions
const ENDPOINT = 'https://apis-navi.kakaomobility.com/v1/directions';
const MAX_BYTES = 1024 * 1024;
const NO_ROUTE_CODES = new Set([1, 101, 102, 103, 104, 105, 106, 107]);
const ERRORS = Object.freeze({
  INVALID_COORDINATES: [400, '차량 이동의 출발지와 도착지를 국내 위치로 선택해 주세요.'],
  KEY_MISSING: [503, '차량 예상시간 서비스 설정이 아직 완료되지 않았어요.'],
  AUTH_ERROR: [502, '차량 예상시간 인증을 확인하지 못했어요. 인증키와 서비스 활성화 상태를 확인해 주세요.'],
  RATE_LIMIT: [429, '차량 예상시간 조회 한도에 도달했어요. 잠시 후 다시 시도해 주세요.'],
  TIMEOUT: [504, '차량 예상시간 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.'],
  NETWORK_ERROR: [502, '차량 예상시간 서비스에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'],
  UPSTREAM_ERROR: [502, '차량 예상시간 제공 서비스에서 오류가 발생했어요. 잠시 후 다시 시도해 주세요.'],
  INVALID_RESPONSE: [502, '차량 예상시간 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.'],
  NO_ROUTE: [422, '선택한 출발지와 도착지 사이의 차량 경로를 찾지 못했어요. 위치를 확인하거나 이동시간을 직접 입력해 주세요.']
});

export class CarRoutingError extends Error {
  constructor(code) {
    const safe = Object.hasOwn(ERRORS, code) ? code : 'UPSTREAM_ERROR';
    super(ERRORS[safe][1]);
    this.name = 'CarRoutingError'; this.code = safe; this.status = ERRORS[safe][0];
  }
}

const invalid = () => { throw new CarRoutingError('INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, fallback, maximum) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
function apiKeyValue(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) throw new CarRoutingError('KEY_MISSING');
  if (key.length > 512 || /[^\x21-\x7e]/.test(key) || /^(?:test|example|demo|your[_-].*)$/i.test(key)) throw new CarRoutingError('AUTH_ERROR');
  return key;
}
function coordinate(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : NaN;
}
function point(latitude, longitude) {
  const lat = coordinate(latitude), lon = coordinate(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 33 || lat > 39.5 || lon < 124 || lon > 132) throw new CarRoutingError('INVALID_COORDINATES');
  return { latitude: Number(lat.toFixed(6)), longitude: Number(lon.toFixed(6)) };
}
function serviceError(code) {
  if ([-3, -4, -5, -8, -401, -903].includes(code)) return new CarRoutingError('AUTH_ERROR');
  if (code === -10 || code === 429) return new CarRoutingError('RATE_LIMIT');
  return new CarRoutingError('UPSTREAM_ERROR');
}
function parseSummary(text) {
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { invalid(); }
  if (!object(data)) invalid();
  if (Number.isSafeInteger(data.code) && data.code !== 0) throw serviceError(data.code);
  if (!Array.isArray(data.routes) || data.routes.length > 3) invalid();
  if (!data.routes.length) throw new CarRoutingError('NO_ROUTE');
  // alternatives=false requests one recommended route. Never silently choose a
  // different result when the first route failed or its summary is malformed.
  const route = data.routes[0];
  if (!object(route) || !Number.isSafeInteger(route.result_code)) invalid();
  if (route.result_code !== 0) throw new CarRoutingError(NO_ROUTE_CODES.has(route.result_code) ? 'NO_ROUTE' : 'UPSTREAM_ERROR');
  const summary = route.summary;
  if (!object(summary) || !Number.isSafeInteger(summary.duration) || summary.duration <= 0 || summary.duration > 86400 ||
    !Number.isSafeInteger(summary.distance) || summary.distance <= 0 || summary.distance > 1500000) invalid();
  return { durationSeconds: summary.duration, durationMinutes: Math.ceil(summary.duration / 60), distanceMeters: summary.distance };
}
async function cancelBody(response) { try { await response.body?.cancel(); } catch { /* best effort */ } }
async function readBody(response) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) { await cancelBody(response); invalid(); }
  const reader = response.body?.getReader();
  if (!reader) invalid();
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { try { await reader.cancel(); } catch { /* best effort */ } invalid(); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { invalid(); }
}

export function createCarRoutingClient({ apiKey, fetchImpl = globalThis.fetch, now = Date.now,
  timeoutMs = 12000, cacheMs = 300000, maxCacheEntries = 100, maxPending = 10 } = {}) {
  const cache = new Map(), pending = new Map();
  const timeout = bounded(timeoutMs, 12000, 30000), ttl = bounded(cacheMs, 300000, 300000);
  const cacheLimit = bounded(maxCacheEntries, 100, 100), pendingLimit = bounded(maxPending, 10, 20);

  async function load(origin, destination, key) {
    const url = new URL(ENDPOINT);
    for (const [name, value] of Object.entries({ origin: `${origin.longitude},${origin.latitude}`,
      destination: `${destination.longitude},${destination.latitude}`, summary: 'true', alternatives: 'false', priority: 'RECOMMEND' })) url.searchParams.set(name, value);
    const controller = new AbortController(); let timer;
    try {
      const result = await Promise.race([
        (async () => {
          const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: controller.signal,
            headers: { Authorization: `KakaoAK ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' } });
          if (response.status >= 300 && response.status < 400) { await cancelBody(response); throw new CarRoutingError('UPSTREAM_ERROR'); }
          if (response.status === 401 || response.status === 403) { await cancelBody(response); throw new CarRoutingError('AUTH_ERROR'); }
          if (response.status === 429) { await cancelBody(response); throw new CarRoutingError('RATE_LIMIT'); }
          const text = await readBody(response);
          if (!response.ok) {
            let code;
            try { code = JSON.parse(text).code; } catch { /* upstream text is never returned */ }
            throw serviceError(code);
          }
          return parseSummary(text);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new CarRoutingError('TIMEOUT')); }, timeout); })
      ]);
      return { provider: '카카오모빌리티', fetchedAt: new Date(now()).toISOString(), origin, destination,
        ...result, reference: '현재 교통 기준' };
    } catch (error) {
      if (error instanceof CarRoutingError) throw error;
      if (controller.signal.aborted || error?.name === 'AbortError') throw new CarRoutingError('TIMEOUT');
      throw new CarRoutingError('NETWORK_ERROR');
    } finally { clearTimeout(timer); }
  }

  return {
    async getRoute({ originLatitude, originLongitude, destinationLatitude, destinationLongitude } = {}) {
      const origin = point(originLatitude, originLongitude), destination = point(destinationLatitude, destinationLongitude);
      if (origin.latitude === destination.latitude && origin.longitude === destination.longitude) throw new CarRoutingError('NO_ROUTE');
      const key = apiKeyValue(apiKey), time = now();
      const id = `${origin.latitude},${origin.longitude}:${destination.latitude},${destination.longitude}`;
      for (const [entryId, entry] of cache) if (entry.expiresAt <= time) cache.delete(entryId);
      const existing = cache.get(id);
      if (existing) return structuredClone(existing.result);
      if (pending.has(id)) return structuredClone(await pending.get(id));
      if (pending.size >= pendingLimit) throw new CarRoutingError('RATE_LIMIT');
      const promise = load(origin, destination, key).then(result => {
        if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
        cache.set(id, { result, expiresAt: now() + ttl }); return result;
      }).finally(() => pending.delete(id));
      pending.set(id, promise);
      return structuredClone(await promise);
    }
  };
}

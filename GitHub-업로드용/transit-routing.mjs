// https://developers.kakao.com/docs/ko/kakaomap/rest-api#routing-publictraffic
// Results are fetched per explicit request. No response cache or stored route geometry.
const ENDPOINT = 'https://dapi.kakao.com/v2/routing/publictraffic';
const MAX_BYTES = 1024 * 1024;
const ROUTE_TYPES = new Set(['BUS', 'SUBWAY', 'BUS_AND_SUBWAY']);
const STEP_TYPES = new Set(['BUS', 'SUBWAY', 'WALKING']);
const NO_ROUTE_STATUSES = new Set(['STARTNODES_NULL', 'ENDNODES_NULL', 'EQUAL_POINTS', 'NO_RESULTS']);
const ERRORS = Object.freeze({
  INVALID_COORDINATES: [400, '대중교통 이동의 출발지와 도착지를 국내 위치로 선택해 주세요.'],
  INVALID_MODE: [400, '버스 또는 지하철을 선택해 주세요.'],
  KEY_MISSING: [503, '대중교통 경로 서비스 설정이 아직 완료되지 않았어요.'],
  AUTH_ERROR: [502, '대중교통 경로 인증을 확인하지 못했어요. 인증키와 카카오맵 사용 설정을 확인해 주세요.'],
  RATE_LIMIT: [429, '대중교통 경로 조회 요청이 많아요. 잠시 후 다시 시도해 주세요.'],
  TIMEOUT: [504, '대중교통 경로 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.'],
  NETWORK_ERROR: [502, '대중교통 경로 서비스에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'],
  UPSTREAM_ERROR: [502, '대중교통 경로 제공 서비스에서 오류가 발생했어요. 잠시 후 다시 시도해 주세요.'],
  INVALID_RESPONSE: [502, '대중교통 경로 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.'],
  NO_ROUTE: [422, '선택한 두 지점 사이에 해당 수단을 포함한 대중교통 경로가 없어요. 다른 수단을 선택하거나 이동시간을 직접 입력해 주세요.']
});

export class TransitRoutingError extends Error {
  constructor(code) {
    const safe = Object.hasOwn(ERRORS, code) ? code : 'UPSTREAM_ERROR';
    super(ERRORS[safe][1]);
    this.name = 'TransitRoutingError'; this.code = safe; this.status = ERRORS[safe][0];
  }
}
const invalid = () => { throw new TransitRoutingError('INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, fallback, maximum) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
function apiKeyValue(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) throw new TransitRoutingError('KEY_MISSING');
  if (key.length > 512 || /[^\x21-\x7e]/.test(key) || /^(?:test|example|demo|your[_-].*)$/i.test(key)) throw new TransitRoutingError('AUTH_ERROR');
  return key;
}
function coordinate(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : NaN;
}
function point(latitude, longitude) {
  const lat = coordinate(latitude), lon = coordinate(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 33 || lat > 39.5 || lon < 124 || lon > 132) throw new TransitRoutingError('INVALID_COORDINATES');
  return { latitude: Number(lat.toFixed(6)), longitude: Number(lon.toFixed(6)) };
}
function serviceError(code) {
  if ([-3, -4, -5, -8, -401, -903].includes(code)) return new TransitRoutingError('AUTH_ERROR');
  if (code === -10 || code === 429) return new TransitRoutingError('RATE_LIMIT');
  return new TransitRoutingError('UPSTREAM_ERROR');
}
function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function text(value, maximum, required = false) {
  if (typeof value !== 'string' || value.length > maximum) invalid();
  const clean = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length > maximum || (required && !clean)) invalid();
  return clean;
}
function optionalList(value, maximum) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maximum) invalid();
  return value;
}
function normalizeStep(raw) {
  const properties = raw?.properties;
  if (!object(raw) || !object(properties) || !STEP_TYPES.has(properties.type)) invalid();
  const stops = optionalList(properties.stops, 200).map(stop => {
    if (!object(stop)) invalid();
    return text(stop.name, 120, true);
  });
  const vehicles = optionalList(properties.vehicles, 100).map(vehicle => {
    if (!object(vehicle)) invalid();
    return { name: text(vehicle.name, 120, true), type: text(vehicle.type, 80) };
  });
  return { type: properties.type, guidance: text(properties.guidance, 500),
    durationSeconds: integer(properties.time, 0, 86400), distanceMeters: integer(properties.distance, 0, 1500000), stops, vehicles };
}
function normalizeRoute(raw, index) {
  const properties = raw?.properties;
  if (!object(raw) || !object(properties) || !ROUTE_TYPES.has(properties.type) || !Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > 64) invalid();
  const durationSeconds = integer(properties.totalTime, 1, 86400);
  const steps = raw.steps.map(normalizeStep), hasBus = steps.some(step => step.type === 'BUS'), hasSubway = steps.some(step => step.type === 'SUBWAY');
  if (properties.type === 'BUS' && (!hasBus || hasSubway) || properties.type === 'SUBWAY' && (!hasSubway || hasBus)
    || properties.type === 'BUS_AND_SUBWAY' && (!hasBus || !hasSubway)) invalid();
  return { id: `transit-${index + 1}`, type: properties.type, durationSeconds, durationMinutes: Math.ceil(durationSeconds / 60),
    distanceMeters: integer(properties.totalDistance, 1, 1500000), transfers: integer(properties.transfers, 0, 30), steps };
}
function parseRoutes(source, mode, key) {
  let data;
  try { data = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { invalid(); }
  if (!object(data)) invalid();
  if (Number.isSafeInteger(data.code) && data.code !== 0) throw serviceError(data.code);
  if (NO_ROUTE_STATUSES.has(data.status)) throw new TransitRoutingError('NO_ROUTE');
  if (data.status === 'INVALID_REQUEST') throw new TransitRoutingError('UPSTREAM_ERROR');
  if (data.status !== 'OK' || !Array.isArray(data.routes) || data.routes.length > 100) invalid();
  const routes = data.routes.map(normalizeRoute).filter(route => route.type === 'BUS_AND_SUBWAY' || route.type === (mode === 'local-bus' ? 'BUS' : 'SUBWAY'));
  if (!routes.length) throw new TransitRoutingError('NO_ROUTE');
  routes.sort((first, second) => first.durationSeconds - second.durationSeconds || first.transfers - second.transfers || first.distanceMeters - second.distanceMeters);
  const result = routes.slice(0, 5);
  if (JSON.stringify(result).includes(key)) invalid();
  return result;
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

export function createTransitRoutingClient({ apiKey, fetchImpl = globalThis.fetch, now = Date.now,
  timeoutMs = 12000, maxPending = 10 } = {}) {
  const timeout = bounded(timeoutMs, 12000, 30000), pendingLimit = bounded(maxPending, 10, 20);
  let pending = 0;
  async function load(origin, destination, mode, key) {
    const url = new URL(ENDPOINT);
    for (const [name, value] of Object.entries({ start_x: origin.longitude, start_y: origin.latitude,
      end_x: destination.longitude, end_y: destination.latitude, input_coord: 'WGS84', output_coord: 'WGS84' })) url.searchParams.set(name, String(value));
    const controller = new AbortController(); let timer;
    try {
      const routes = await Promise.race([
        (async () => {
          const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', cache: 'no-store', signal: controller.signal,
            headers: { Authorization: `KakaoAK ${key}`, Accept: 'application/json' } });
          if (response.status >= 300 && response.status < 400) { await cancelBody(response); throw new TransitRoutingError('UPSTREAM_ERROR'); }
          if (response.status === 401 || response.status === 403) { await cancelBody(response); throw new TransitRoutingError('AUTH_ERROR'); }
          if (response.status === 429) { await cancelBody(response); throw new TransitRoutingError('RATE_LIMIT'); }
          const source = await readBody(response);
          if (!response.ok) {
            let code;
            try { code = JSON.parse(source).code; } catch { /* raw service details are never returned */ }
            throw serviceError(code);
          }
          return parseRoutes(source, mode, key);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new TransitRoutingError('TIMEOUT')); }, timeout); })
      ]);
      return { provider: '카카오맵', fetchedAt: new Date(now()).toISOString(), origin, destination, mode, routes };
    } catch (error) {
      if (error instanceof TransitRoutingError) throw error;
      if (controller.signal.aborted || error?.name === 'AbortError') throw new TransitRoutingError('TIMEOUT');
      throw new TransitRoutingError('NETWORK_ERROR');
    } finally { clearTimeout(timer); }
  }
  return {
    async getRoutes({ originLatitude, originLongitude, destinationLatitude, destinationLongitude, mode } = {}) {
      if (!['local-bus', 'subway'].includes(mode)) throw new TransitRoutingError('INVALID_MODE');
      const origin = point(originLatitude, originLongitude), destination = point(destinationLatitude, destinationLongitude);
      if (origin.latitude === destination.latitude && origin.longitude === destination.longitude) throw new TransitRoutingError('NO_ROUTE');
      const key = apiKeyValue(apiKey);
      if (pending >= pendingLimit) throw new TransitRoutingError('RATE_LIMIT');
      pending++;
      try { return await load(origin, destination, mode, key); }
      finally { pending--; }
    }
  };
}

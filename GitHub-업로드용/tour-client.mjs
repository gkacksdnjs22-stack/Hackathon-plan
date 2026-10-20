// Fetch-based TourAPI client shared by the local server and Cloudflare Worker.
const API_BASE_URL = 'https://apis.data.go.kr/B551011/KorService2/';
const PROVIDER = '한국관광공사 TourAPI';
const CACHE_MS = 60 * 60 * 1000;

const ERRORS = Object.freeze({
  KEY_MISSING: [503, '서버의 .env에 DATA_GO_KR_SERVICE_KEY를 설정해 주세요.'],
  AUTH_ERROR: [502, '관광정보 API 인증에 실패했습니다. 공공데이터포털에서 인증키와 활용신청 승인 상태를 확인해 주세요.'],
  RATE_LIMIT: [503, '관광정보 API 호출 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.'],
  TIMEOUT: [504, '관광정보 API 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.'],
  NETWORK_ERROR: [502, '관광정보 API에 연결할 수 없습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.'],
  UPSTREAM_ERROR: [502, '관광정보 제공 서비스에서 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'],
  INVALID_RESPONSE: [502, '관광정보 API 응답을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.'],
  UNSUPPORTED_CITY: [400, '목록에서 국내 여행 지역을 선택해 주세요.'],
  INTERNAL_ERROR: [500, '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.']
});

export class TourApiError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(ERRORS, code) ? code : 'INTERNAL_ERROR';
    super(ERRORS[safeCode][1]);
    this.name = 'TourApiError';
    this.code = safeCode;
    this.status = ERRORS[safeCode][0];
  }
}

export function normalizeServiceKey(value) {
  let key = String(value || '').trim();
  if (!key) throw new TourApiError('KEY_MISSING');
  // URLSearchParams encodes exactly once, for both portal key variants.
  if (/%[0-9a-f]{2}/i.test(key)) {
    try { key = decodeURIComponent(key); }
    catch { throw new TourApiError('AUTH_ERROR'); }
  }
  return key;
}

function cleanText(value, length = 500) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, length);
}

function coordinate(value, min, max) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max && number !== 0 ? number : null;
}

function publicImage(value) {
  try {
    const url = new URL(cleanText(value, 2048));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function numericCode(value, maximumLength = 4) {
  const text = cleanText(value, maximumLength + 1);
  return new RegExp(`^[0-9]{1,${maximumLength}}$`).test(text) && Number(text) > 0 ? String(Number(text)) : '';
}

export function normalizeAreas(rawItems) {
  const source = Array.isArray(rawItems) ? rawItems : rawItems && typeof rawItems === 'object' ? [rawItems] : [];
  const unique = new Map();
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue;
    const code = numericCode(raw.code, 2);
    const name = cleanText(raw.name, 80);
    if (code && name) unique.set(code, { code, name });
  }
  return [...unique.values()];
}

export function normalizeItems(rawItems, requestedType, requestedArea) {
  const source = Array.isArray(rawItems) ? rawItems : rawItems && typeof rawItems === 'object' ? [rawItems] : [];
  const unique = new Map();
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue;
    const contentId = cleanText(raw.contentid, 60);
    const contentTypeId = cleanText(raw.contenttypeid || requestedType, 10);
    const title = cleanText(raw.title, 200);
    if (!/^\d+$/.test(contentId) || !title || !['12', '14'].includes(contentTypeId)) continue;
    unique.set(contentId, {
      contentId,
      contentTypeId,
      areaCode: numericCode(raw.areacode, 2) || numericCode(requestedArea, 2),
      sigunguCode: numericCode(raw.sigungucode),
      title,
      address: [cleanText(raw.addr1), cleanText(raw.addr2)].filter(Boolean).join(' '),
      latitude: coordinate(raw.mapy, -90, 90),
      longitude: coordinate(raw.mapx, -180, 180),
      imageUrl: publicImage(raw.firstimage || raw.firstimage2),
      category: contentTypeId === '14' ? '문화시설' : '관광지'
    });
  }
  return [...unique.values()];
}

function upstreamCodeError(code) {
  const value = String(code || '').trim();
  if (['20', '30', '31'].includes(value)) return new TourApiError('AUTH_ERROR');
  if (['22', '23'].includes(value)) return new TourApiError('RATE_LIMIT');
  if (value === '05') return new TourApiError('TIMEOUT');
  return new TourApiError('UPSTREAM_ERROR');
}

async function readResponse(response) {
  // Limit even malformed upstream responses without saving any raw response to disk.
  const maximum = 4 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) throw new TourApiError('INVALID_RESPONSE');
  const reader = response.body?.getReader();
  if (!reader) throw new TourApiError('INVALID_RESPONSE');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new TourApiError('INVALID_RESPONSE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8').decode(bytes);
}

export function createTourClient({ serviceKey, fetchImpl = globalThis.fetch, now = Date.now,
  cacheMs = CACHE_MS, timeoutMs = 15000, rows = 1000, maxPages = 3 } = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const pageSize = Math.min(1000, Math.max(1, Number.isSafeInteger(rows) ? rows : 1000));
  const pageLimit = Math.min(4, Math.max(1, Number.isSafeInteger(maxPages) ? maxPages : 3));

  async function fetchPage(endpoint, query, normalize) {
    const url = new URL(endpoint, API_BASE_URL);
    const params = {
      serviceKey: normalizeServiceKey(serviceKey),
      MobileOS: 'ETC', MobileApp: 'TravelWeave', _type: 'json',
      ...query
    };
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'application/json' } });
      if (!response.ok) {
        if ([401, 403].includes(response.status)) throw new TourApiError('AUTH_ERROR');
        if (response.status === 429) throw new TourApiError('RATE_LIMIT');
        throw new TourApiError('UPSTREAM_ERROR');
      }
      const source = await readResponse(response);
      // Gateway authentication/quota errors can arrive as XML despite _type=json.
      if (source.trimStart().startsWith('<')) {
        const code = source.match(/<(?:returnReasonCode|resultCode)>\s*([^<]+)\s*<\//i)?.[1];
        throw code ? upstreamCodeError(code) : new TourApiError('UPSTREAM_ERROR');
      }
      let data;
      try { data = JSON.parse(source); }
      catch { throw new TourApiError('INVALID_RESPONSE'); }
      const resultCode = String(data?.response?.header?.resultCode ?? '');
      if (!/^0+$/.test(resultCode)) {
        if (resultCode) throw upstreamCodeError(resultCode);
        throw new TourApiError('INVALID_RESPONSE');
      }
      const body = data.response.body;
      if (!body || typeof body !== 'object') throw new TourApiError('INVALID_RESPONSE');
      const totalCount = Number(body.totalCount);
      const items = normalize(body.items?.item);
      if (!Number.isSafeInteger(totalCount) || totalCount < 0 || (totalCount > 0 && items.length === 0)) {
        throw new TourApiError('INVALID_RESPONSE');
      }
      return { items, totalCount };
    } catch (error) {
      if (error instanceof TourApiError) throw error;
      throw new TourApiError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
    } finally { clearTimeout(timer); }
  }

  async function fetchAreaPlaces(areaCode) {
    const unique = new Map();
    let totalCount = 0;
    let truncated = false;
    // Keep calls sequential to respect the public API's per-second quota.
    for (const contentTypeId of ['12', '14']) {
      let lastPage = 1;
      for (let pageNo = 1; pageNo <= lastPage; pageNo++) {
        const result = await fetchPage('areaBasedList2', {
          areaCode, contentTypeId, numOfRows: String(pageSize), pageNo: String(pageNo), arrange: 'A'
        }, items => normalizeItems(items, contentTypeId, areaCode));
        if (pageNo === 1) {
          totalCount += result.totalCount;
          lastPage = Math.min(pageLimit, Math.max(1, Math.ceil(result.totalCount / pageSize)));
          if (result.totalCount > pageSize * pageLimit) truncated = true;
        }
        for (const item of result.items) unique.set(item.contentId, item);
      }
    }
    return { provider: PROVIDER, fetchedAt: new Date(now()).toISOString(), areaCode,
      items: [...unique.values()], totalCount, truncated: truncated || unique.size < totalCount };
  }

  async function cachedRequest(key, fetchData) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.payload;
    if (inFlight.has(key)) return inFlight.get(key);
    const request = fetchData().then(payload => {
      cache.set(key, { expiresAt: now() + cacheMs, payload });
      return payload;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
  }

  return {
    async getAreas() {
      return cachedRequest('areas', async () => {
        const result = await fetchPage('areaCode2', { numOfRows: '100', pageNo: '1' }, normalizeAreas);
        if (!result.items.length || result.items.length < result.totalCount) throw new TourApiError('INVALID_RESPONSE');
        return { provider: PROVIDER, fetchedAt: new Date(now()).toISOString(), items: result.items };
      });
    },
    async getPlaces(value = '1') {
      const areaCode = value === 'seoul' ? '1' : numericCode(value, 2);
      if (!areaCode) throw new TourApiError('UNSUPPORTED_CITY');
      return cachedRequest(`places:${areaCode}`, () => fetchAreaPlaces(areaCode));
    }
  };
}


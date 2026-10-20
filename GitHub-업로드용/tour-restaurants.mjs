const ENDPOINT = 'https://apis.data.go.kr/B551011/KorService2/areaBasedList2';
const SOURCE_URL = 'https://www.data.go.kr/data/15101578/openapi.do';
const PROVIDER = '한국관광공사 TourAPI';
const RESULT_LIMIT = 50;
const ERRORS = Object.freeze({
  INVALID_AREA: [400, '목록에서 음식점을 찾을 국내 여행 지역을 선택해 주세요.'],
  INVALID_DISTRICT: [400, '음식점을 찾을 시·군·구 이름을 확인해 주세요.'],
  INVALID_COORDINATES: [400, '음식점 거리 기준의 국내 위도와 경도를 함께 확인해 주세요.'],
  KEY_MISSING: [503, '서버의 .env에 DATA_GO_KR_SERVICE_KEY를 설정해 주세요.'],
  AUTH_ERROR: [502, '관광 음식점 API 인증에 실패했어요. 인증키와 활용신청 승인 상태를 확인해 주세요.'],
  RATE_LIMIT: [429, '음식점 조회 요청이 많아요. 잠시 후 다시 시도해 주세요.'],
  TIMEOUT: [504, '관광 음식점 정보 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.'],
  NETWORK_ERROR: [502, '관광 음식점 정보에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'],
  UPSTREAM_ERROR: [502, '관광 음식점 제공 서비스에서 오류가 발생했어요. 잠시 후 다시 시도해 주세요.'],
  INVALID_RESPONSE: [502, '관광 음식점 정보 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.']
});

export class TourRestaurantError extends Error {
  constructor(code) {
    const safe = Object.hasOwn(ERRORS, code) ? code : 'UPSTREAM_ERROR';
    super(ERRORS[safe][1]);
    this.name = 'TourRestaurantError';
    this.code = safe;
    this.status = ERRORS[safe][0];
  }
}

const REGIONS = [
  ['1', '서울', '서울특별시', '서울시'], ['2', '인천', '인천광역시', '인천시'],
  ['3', '대전', '대전광역시', '대전시'], ['4', '대구', '대구광역시', '대구시'],
  ['5', '광주', '광주광역시', '광주시'], ['6', '부산', '부산광역시', '부산시'],
  ['7', '울산', '울산광역시', '울산시'], ['8', '세종', '세종특별자치시', '세종시'],
  ['31', '경기', '경기도'], ['32', '강원', '강원특별자치도', '강원도'],
  ['33', '충북', '충청북도'], ['34', '충남', '충청남도'],
  ['35', '경북', '경상북도'], ['36', '경남', '경상남도'],
  ['37', '전북', '전북특별자치도', '전라북도'], ['38', '전남', '전라남도'],
  ['39', '제주', '제주특별자치도', '제주도']
];
const AREAS = new Map(REGIONS.flatMap(([code, name, ...aliases]) =>
  [name, ...aliases].map(alias => [alias, { code, name }])));
// TourAPI keeps separate area codes for these catalogs although their current
// address text shares a province name. Never use that name as a region alias.
const MERGED_ADDRESS_PREFIX = '전남광주통합특별시';
const MERGED_DISTRICTS = new Map([
  ['5', new Map([['광산구', '1'], ['남구', '2'], ['동구', '3'], ['북구', '4'], ['서구', '5']])],
  ['38', new Map([['강진군', '1'], ['고흥군', '2'], ['곡성군', '3'], ['광양시', '4'], ['구례군', '5'],
    ['나주시', '6'], ['담양군', '7'], ['목포시', '8'], ['무안군', '9'], ['보성군', '10'], ['순천시', '11'],
    ['신안군', '12'], ['여수시', '13'], ['영광군', '16'], ['영암군', '17'], ['완도군', '18'],
    ['장성군', '19'], ['장흥군', '20'], ['진도군', '21'], ['함평군', '22'], ['해남군', '23'], ['화순군', '24']])]
]);
const bounded = (value, fallback, maximum) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
const invalid = () => { throw new TourRestaurantError('INVALID_RESPONSE'); };
const clean = (value, maximum = 300) => typeof value === 'string' || typeof value === 'number'
  ? String(value).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, maximum) : '';

function areaValue(value) {
  if (typeof value !== 'string' || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new TourRestaurantError('INVALID_AREA');
  const area = AREAS.get(value.normalize('NFKC').replace(/\s+/g, ''));
  if (!area) throw new TourRestaurantError('INVALID_AREA');
  return area;
}
function districtValue(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 60 || /[\u0000-\u001f\u007f]/.test(value)) throw new TourRestaurantError('INVALID_DISTRICT');
  const district = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (district.length < 2 || district.length > 60 || !/^[가-힣]+[시군구](?: [가-힣]+[시군구]){0,2}$/.test(district)) throw new TourRestaurantError('INVALID_DISTRICT');
  return district;
}
function addressDistricts(address, areaCode) {
  const tokens = address.replace(/^대한민국\s+/, '').split(/\s+/);
  if (tokens[0] === MERGED_ADDRESS_PREFIX) {
    return MERGED_DISTRICTS.get(areaCode)?.has(tokens[1]) ? tokens.slice(1) : null;
  }
  return AREAS.get(tokens[0])?.code === areaCode ? tokens.slice(1) : null;
}
function keyValue(value) {
  let key = typeof value === 'string' ? value.trim() : '';
  if (!key) throw new TourRestaurantError('KEY_MISSING');
  if (/%[0-9a-f]{2}/i.test(key)) {
    try { key = decodeURIComponent(key); } catch { throw new TourRestaurantError('AUTH_ERROR'); }
  }
  if (/[\u0000-\u0020\u007f]/.test(key)) throw new TourRestaurantError('AUTH_ERROR');
  return key;
}
function coordinate(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function point(latitude, longitude, required = false) {
  if (required && latitude == null && longitude == null) return null;
  const lat = coordinate(latitude), lon = coordinate(longitude);
  if (lat === null || lon === null || lat < 33 || lat > 39.5 || lon < 124 || lon > 132) {
    if (required) throw new TourRestaurantError('INVALID_COORDINATES');
    return null;
  }
  return { latitude: lat, longitude: lon };
}
function upstreamError(code, message = '') {
  const text = `${code ?? ''} ${message}`.toUpperCase();
  if (['20', '21', '30', '31', '32'].includes(String(code)) || /SERVICE.?KEY|UNREGISTERED|NOT.REGISTERED|AUTH|인증|승인/.test(text)) return new TourRestaurantError('AUTH_ERROR');
  if (['22', '23', '429'].includes(String(code)) || /LIMIT|QUOTA|EXCEED|TOO.MANY|한도/.test(text)) return new TourRestaurantError('RATE_LIMIT');
  if (/TIME.?OUT|TIMEOVER/.test(text)) return new TourRestaurantError('TIMEOUT');
  return new TourRestaurantError('UPSTREAM_ERROR');
}
function successfulCode(code, message) {
  if (typeof code !== 'string' && typeof code !== 'number') invalid();
  const value = String(code).trim();
  if (/^0+$/.test(value)) return true;
  if (value === '03') return false;
  throw upstreamError(value, message);
}
async function readBody(response) {
  const maximum = 4 * 1024 * 1024;
  if (Number(response.headers?.get('content-length')) > maximum) invalid();
  const reader = response.body?.getReader();
  if (!reader) invalid();
  let size = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel(); invalid(); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, '');
}
function parsePage(source) {
  if (source.trimStart().startsWith('<')) {
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) invalid();
    const code = source.match(/<(?:returnReasonCode|resultCode)>\s*([^<]+)\s*<\//i)?.[1];
    const message = source.match(/<(?:returnAuthMsg|resultMsg|errMsg)>\s*([^<]+)\s*<\//i)?.[1];
    if (code && !successfulCode(code, message)) return { items: [], totalCount: 0 };
    invalid();
  }
  let data;
  try { data = JSON.parse(source); } catch { invalid(); }
  const gateway = data?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (gateway) throw upstreamError(gateway.returnReasonCode, gateway.returnAuthMsg || gateway.errMsg);
  const response = data?.response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) invalid();
  if (!successfulCode(response.header?.resultCode, response.header?.resultMsg)) return { items: [], totalCount: 0 };
  const body = response.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  const totalCount = typeof body.totalCount === 'string' && /^\d+$/.test(body.totalCount.trim())
    ? Number(body.totalCount) : typeof body.totalCount === 'number' ? body.totalCount : NaN;
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) invalid();
  const collection = body.items;
  if (collection != null && collection !== '' && (typeof collection !== 'object')) invalid();
  const raw = Array.isArray(collection) ? collection : collection?.item;
  const items = raw == null || raw === '' ? [] : Array.isArray(raw) ? raw : typeof raw === 'object' ? [raw] : invalid();
  if ((totalCount > 0 && !items.length) || (totalCount === 0 && items.length)) invalid();
  return { items, totalCount };
}
function normalizeItem(raw, areaCode) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.contentid === 'number' && !Number.isSafeInteger(raw.contentid)) return null;
  const id = clean(raw.contentid, 61), name = clean(raw.title, 160);
  const address = clean([clean(raw.addr1), clean(raw.addr2)].filter(Boolean).join(' '));
  const districts = addressDistricts(address, areaCode);
  if (!/^[1-9]\d{0,19}$/.test(id) || !name || !address || !districts) return null;
  if (raw.contenttypeid != null && raw.contenttypeid !== '' && clean(raw.contenttypeid, 10) !== '39') return null;
  if (raw.areacode != null && raw.areacode !== '' && clean(raw.areacode, 10) !== areaCode) return null;
  if (address.replace(/^대한민국\s+/, '').split(' ')[0] === MERGED_ADDRESS_PREFIX) {
    if (clean(raw.areacode, 10) !== areaCode) return null;
    if (raw.sigungucode != null && raw.sigungucode !== ''
      && clean(raw.sigungucode, 10) !== MERGED_DISTRICTS.get(areaCode)?.get(districts[0])) return null;
  }
  const location = point(raw.mapy, raw.mapx);
  return { id: `tour-food-${id}`, name, branch: '', category: '음식점', address,
    latitude: location?.latitude ?? null, longitude: location?.longitude ?? null,
    updatedAt: clean(raw.modifiedtime, 40), source: PROVIDER, sourceUrl: SOURCE_URL };
}
function distance(first, second) {
  const rad = value => value * Math.PI / 180;
  const latitude = rad(second.latitude - first.latitude), longitude = rad(second.longitude - first.longitude);
  const value = Math.sin(latitude / 2) ** 2 + Math.cos(rad(first.latitude)) * Math.cos(rad(second.latitude)) * Math.sin(longitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}

export function createTourRestaurantClient({ serviceKey, fetchImpl = globalThis.fetch, now = Date.now,
  timeoutMs = 15000, cacheMs = 60 * 60 * 1000, pageSize = 100, maxPages = 3,
  maxCacheEntries = 100, maxPending = 20 } = {}) {
  const cache = new Map(), pending = new Map();
  const rows = bounded(pageSize, 100, 100), pages = bounded(maxPages, 3, 3);
  const cacheLimit = bounded(maxCacheEntries, 100, 200), pendingLimit = bounded(maxPending, 20, 100);
  const timeout = bounded(timeoutMs, 15000, 60000), ttl = bounded(cacheMs, 60 * 60 * 1000, 60 * 60 * 1000);

  async function fetchPage(area, pageNo) {
    const url = new URL(ENDPOINT);
    for (const [name, value] of Object.entries({ serviceKey: keyValue(serviceKey), MobileOS: 'ETC', MobileApp: 'TravelPlanner',
      _type: 'json', contentTypeId: '39', areaCode: area.code, numOfRows: rows, pageNo, arrange: 'A' })) url.searchParams.set(name, String(value));
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new TourRestaurantError('TIMEOUT')); }, timeout); });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(url, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'application/json' } });
        if ([401, 403].includes(response.status)) throw new TourRestaurantError('AUTH_ERROR');
        if (response.status === 429) throw new TourRestaurantError('RATE_LIMIT');
        if (!response.ok) throw new TourRestaurantError('UPSTREAM_ERROR');
        const parsed = parsePage(await readBody(response));
        if (parsed.items.length > rows) invalid();
        return parsed;
      })()]);
    } catch (error) {
      if (error instanceof TourRestaurantError) throw error;
      throw new TourRestaurantError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
    } finally { clearTimeout(timer); }
  }
  async function catalog(area) {
    const key = area.code, entry = cache.get(key);
    if (entry && entry.expiresAt > now()) { cache.delete(key); cache.set(key, entry); return entry.payload; }
    if (entry) cache.delete(key);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= pendingLimit) throw new TourRestaurantError('RATE_LIMIT');
    const job = (async () => {
      const unique = new Map();
      let received = 0, truncated = false;
      for (let pageNo = 1; pageNo <= pages; pageNo++) {
        const page = await fetchPage(area, pageNo);
        received += page.items.length;
        for (const raw of page.items) {
          const item = normalizeItem(raw, area.code);
          if (item && !unique.has(item.id)) unique.set(item.id, item);
        }
        if (received >= page.totalCount) break;
        if (page.items.length < rows || pageNo === pages) { truncated = true; break; }
      }
      const payload = { items: [...unique.values()], fetchedAt: new Date(now()).toISOString(), truncated };
      while (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
      cache.set(key, { payload, expiresAt: now() + ttl });
      return payload;
    })().finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }
  return {
    async search(query = {}) {
      if (!query || typeof query !== 'object' || Array.isArray(query)) throw new TourRestaurantError('INVALID_AREA');
      const area = areaValue(query.area), district = districtValue(query.district), origin = point(query.latitude, query.longitude, true);
      const result = await catalog(area);
      const tokens = district ? district.split(' ') : [];
      const matching = district ? result.items.filter(item => {
        const actual = addressDistricts(item.address, area.code);
        return actual && tokens.every((token, index) => actual[index] === token);
      }) : result.items;
      const ordered = matching.map((item, index) => ({ item, index,
        distanceKm: origin && item.latitude !== null && item.longitude !== null ? distance(origin, item) : null }));
      if (origin) ordered.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || a.index - b.index);
      const items = ordered.slice(0, RESULT_LIMIT).map(({ item, distanceKm }) => distanceKm === null ? { ...item } : { ...item, distanceKm: Math.round(distanceKm * 100) / 100 });
      return { items, area: area.name, district, category: '전체', provider: PROVIDER, fetchedAt: result.fetchedAt,
        truncated: result.truncated || matching.length > RESULT_LIMIT };
    }
  };
}

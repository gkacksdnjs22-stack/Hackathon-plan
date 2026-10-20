import { createHash } from 'node:crypto';

const ENDPOINT = 'https://api.kcisa.kr/openapi/API_CNV_063/request';
const SOURCE_URL = 'https://www.culture.go.kr/data/openapi/openapiView.do?id=603';
const PROVIDER = '한국문화정보원';
const CATEGORIES = new Set(['전체', '한식', '분식', '치킨', '동양식', '서양식', '패스트푸드', '뷔페', '퓨전']);
const ERRORS = Object.freeze({
  INVALID_AREA: [400, '음식점을 찾을 국내 지역명을 2~80자로 입력해 주세요.'],
  INVALID_CATEGORY: [400, '목록에서 음식점 분류를 선택해 주세요.'],
  INVALID_COORDINATES: [400, '음식점 거리 기준의 국내 위도와 경도를 함께 확인해 주세요.'],
  KEY_MISSING: [503, '서버의 .env에 CULTURE_API_SERVICE_KEY를 설정해 주세요.'],
  AUTH_ERROR: [502, '문화 음식점 API 인증에 실패했어요. 인증키와 활용신청 승인 상태를 확인해 주세요.'],
  RATE_LIMIT: [429, '음식점 조회 요청이 많아요. 잠시 후 다시 시도해 주세요.'],
  TIMEOUT: [504, '공공 음식점 정보 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.'],
  NETWORK_ERROR: [502, '공공 음식점 정보에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'],
  UPSTREAM_ERROR: [502, '공공 음식점 제공 서비스에서 오류가 발생했어요. 잠시 후 다시 시도해 주세요.'],
  INVALID_RESPONSE: [502, '공공 음식점 정보 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.']
});

export class RestaurantApiError extends Error {
  constructor(code) {
    const safe = Object.hasOwn(ERRORS, code) ? code : 'UPSTREAM_ERROR';
    super(ERRORS[safe][1]);
    this.name = 'RestaurantApiError'; this.code = safe; this.status = ERRORS[safe][0];
  }
}

const clean = (value, maximum = 300) => typeof value === 'string' || typeof value === 'number'
  ? String(value).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, maximum) : '';
const invalid = () => { throw new RestaurantApiError('INVALID_RESPONSE'); };
const bounded = (value, fallback, maximum) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;

function keyValue(value) {
  let key = typeof value === 'string' ? value.trim() : '';
  if (!key) throw new RestaurantApiError('KEY_MISSING');
  if (/%[0-9a-f]{2}/i.test(key)) {
    try { key = decodeURIComponent(key); } catch { throw new RestaurantApiError('AUTH_ERROR'); }
  }
  if (/[\u0000-\u0020\u007f]/.test(key)) throw new RestaurantApiError('AUTH_ERROR');
  return key;
}
function areaValue(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new RestaurantApiError('INVALID_AREA');
  const area = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (area.length < 2 || area.length > 80 || !/^[가-힣0-9 ·.-]+$/.test(area) || !/[가-힣]/.test(area)) throw new RestaurantApiError('INVALID_AREA');
  return area;
}
function coordinate(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function point(latitude, longitude, required = false) {
  const absent = value => value === null || value === undefined;
  if (required && absent(latitude) && absent(longitude)) return null;
  const lat = coordinate(latitude), lon = coordinate(longitude);
  if (lat === null || lon === null || lat < 33 || lat > 39.5 || lon < 124 || lon > 132) {
    if (required) throw new RestaurantApiError('INVALID_COORDINATES');
    return null;
  }
  return { latitude: lat, longitude: lon };
}

const REGION_ALIASES = [
  ['서울', '서울특별시', '서울시'], ['부산', '부산광역시', '부산시'], ['대구', '대구광역시', '대구시'],
  ['인천', '인천광역시', '인천시'], ['광주', '광주광역시'], ['대전', '대전광역시', '대전시'],
  ['울산', '울산광역시', '울산시'], ['세종', '세종특별자치시', '세종시'], ['경기', '경기도'],
  ['강원', '강원특별자치도', '강원도'], ['충북', '충청북도'], ['충남', '충청남도'],
  ['전북', '전북특별자치도', '전라북도'], ['전남', '전라남도'], ['경북', '경상북도'],
  ['경남', '경상남도'], ['제주', '제주특별자치도', '제주도']
].flatMap(([canonical, ...aliases]) => [canonical, ...aliases].map(alias => [alias, canonical])).sort((a, b) => b[0].length - a[0].length);
function regionText(value) {
  const text = clean(value).replace(/^대한민국\s*/, '').replace(/[\s·.-]/g, '');
  const alias = REGION_ALIASES.find(([name]) => text.startsWith(name));
  return alias ? alias[1] + text.slice(alias[0].length) : text;
}
function matchesArea(address, area) {
  const requested = regionText(area), actual = regionText(address);
  const province = REGION_ALIASES.some(([name]) => area.replace(/\s+/g, '').startsWith(name));
  return province ? actual.startsWith(requested) : actual.includes(requested);
}

function upstreamError(code, message = '') {
  const text = `${code ?? ''} ${message}`.toUpperCase();
  if (['20', '21', '30', '31', '32'].includes(String(code)) || /SERVICE.?KEY|UNREGISTERED|NOT.REGISTERED|AUTH|인증|승인|등록되지/.test(text)) return new RestaurantApiError('AUTH_ERROR');
  if (['22', '23', '429'].includes(String(code)) || /LIMIT|QUOTA|EXCEED|TOO.MANY|한도|요청.*초과/.test(text)) return new RestaurantApiError('RATE_LIMIT');
  if (/TIME.?OUT|TIMEOVER/.test(text)) return new RestaurantApiError('TIMEOUT');
  return new RestaurantApiError('UPSTREAM_ERROR');
}
function checkCode(code, message) {
  if (typeof code !== 'string' && typeof code !== 'number') invalid();
  const value = String(code).trim();
  if (/^0+$/.test(value) || value === 'INFO-000') return true;
  if (value === '03' || /NO.?DATA|NODATA/.test(`${value} ${message}`.toUpperCase())) return false;
  throw upstreamError(value, message);
}

async function readBody(response) {
  const maximum = 4 * 1024 * 1024;
  if (Number(response.headers?.get('content-length')) > maximum) invalid();
  const reader = response.body?.getReader();
  if (!reader) invalid();
  let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel(); invalid(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString('utf8').replace(/^\uFEFF/, '');
}

// Parse the small XML response grammar without external entities or a networked XML resolver.
function xmlTree(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) invalid();
  const root = { name: '', children: [], text: '' }, stack = [root];
  const tokens = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?xml[\s\S]*?\?>|<[^>]*>|[^<]+/g;
  let position = 0, count = 0;
  const decode = value => value.replace(/&([^;\s]+);/g, (match, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    if (!/^#(?:\d+|x[0-9a-f]+)$/i.test(entity)) invalid();
    const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isSafeInteger(number) || number > 0x10ffff || (number < 32 && ![9, 10, 13].includes(number)) || (number >= 0xd800 && number <= 0xdfff)) invalid();
    return String.fromCodePoint(number);
  });
  for (const match of source.matchAll(tokens)) {
    if (match.index !== position) invalid();
    position += match[0].length;
    const token = match[0], parent = stack[stack.length - 1];
    if (token.startsWith('<!--') || token.startsWith('<?xml')) continue;
    if (token.startsWith('<![CDATA[')) { if (stack.length === 1) invalid(); parent.text += token.slice(9, -3); continue; }
    if (token.startsWith('</')) {
      const name = /^<\/([A-Za-z_][\w.:-]*)\s*>$/.exec(token)?.[1];
      if (!name || stack.length === 1 || parent.name !== name) invalid();
      stack.pop(); continue;
    }
    if (token.startsWith('<')) {
      const opening = /^<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>$/.exec(token);
      if (!opening || stack.length > 30 || ++count > 20000) invalid();
      const node = { name: opening[1], children: [], text: '' };
      parent.children.push(node);
      if (!opening[3]) stack.push(node);
    } else {
      if (stack.length === 1 && token.trim()) invalid();
      if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(token)) invalid();
      parent.text += decode(token);
    }
  }
  if (position !== source.length || stack.length !== 1 || root.children.length !== 1) invalid();
  return root.children[0];
}
const localName = node => node.name.split(':').at(-1);
const child = (node, name) => node?.children.find(value => localName(value) === name);
const text = (node, name) => child(node, name)?.text.trim();
function parseXml(source) {
  const root = xmlTree(source);
  if (localName(root) !== 'response') {
    const header = child(root, 'cmmMsgHeader') || child(root, 'header');
    if (header) throw upstreamError(text(header, 'returnReasonCode') || text(header, 'resultCode'), text(header, 'returnAuthMsg') || text(header, 'errMsg') || text(header, 'resultMsg'));
    invalid();
  }
  const header = child(root, 'header');
  if (!checkCode(text(header, 'resultCode'), text(header, 'resultMsg'))) return { items: [], totalCount: 0 };
  const body = child(root, 'body');
  if (!body) invalid();
  const list = child(body, 'items');
  const items = list ? list.children.filter(node => localName(node) === 'item').map(node => Object.fromEntries(node.children.map(field => [localName(field), field.text]))) : [];
  return pageData(items, text(body, 'totalCount'), Boolean(list));
}
function pageData(raw, total, hasItems) {
  const items = raw === undefined || raw === null || raw === '' ? [] : Array.isArray(raw) ? raw : typeof raw === 'object' ? [raw] : invalid();
  const totalCount = total === undefined ? null : Number(total);
  if ((!hasItems && totalCount !== 0) || (totalCount !== null && (!Number.isSafeInteger(totalCount) || totalCount < 0))) invalid();
  // Culture603 can report its global totalCount alongside null filtered items.
  // The explicit empty collection is a successful search with no matching rows.
  return { items, totalCount: items.length ? totalCount : 0 };
}
function parseJson(source) {
  let data; try { data = JSON.parse(source); } catch { invalid(); }
  const response = data?.response;
  if (!response || typeof response !== 'object') {
    const header = data?.OpenAPI_ServiceResponse?.cmmMsgHeader;
    if (header) throw upstreamError(header.returnReasonCode, header.returnAuthMsg || header.errMsg);
    invalid();
  }
  if (!checkCode(response.header?.resultCode, response.header?.resultMsg)) return { items: [], totalCount: 0 };
  const body = response.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  const raw = Array.isArray(body.items) ? body.items : body.items?.item;
  if (body.items !== undefined && body.items !== null && body.items !== '' && typeof body.items !== 'object') invalid();
  return pageData(raw, body.totalCount, body.items !== undefined);
}

function normalizeItem(raw, area, category) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = clean(raw.rstrNm, 160), branch = clean(raw.rstrBhfNm, 120), actualCategory = clean(raw.rstrClNm, 40) || '음식점';
  const address = clean(raw.rstrRoadAddr) || clean(raw.rstrLnbrAddr);
  if (!name || !address || (category !== '전체' && actualCategory !== category) || !matchesArea(address, area)) return null;
  const location = point(raw.rstrLatPos, raw.rstrLotPos);
  const identity = [clean(raw.rstrPnu, 80), name, branch, address].join('\0');
  return { id: `culture-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`, name, branch,
    category: actualCategory, address, latitude: location?.latitude ?? null, longitude: location?.longitude ?? null,
    updatedAt: clean(raw.rstrInfoStdDt, 40), source: PROVIDER, sourceUrl: SOURCE_URL };
}
function distance(first, second) {
  const rad = value => value * Math.PI / 180;
  const latitude = rad(second.latitude - first.latitude), longitude = rad(second.longitude - first.longitude);
  const value = Math.sin(latitude / 2) ** 2 + Math.cos(rad(first.latitude)) * Math.cos(rad(second.latitude)) * Math.sin(longitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}

export function createRestaurantClient({ serviceKey, fetchImpl = globalThis.fetch, now = Date.now,
  timeoutMs = 8000, cacheMs = 60 * 60 * 1000, pageSize = 100, maxPages = 3,
  maxCacheEntries = 100, maxPending = 20 } = {}) {
  const cache = new Map(), pending = new Map();
  const rows = bounded(pageSize, 100, 100), pages = bounded(maxPages, 3, 3);
  const cacheLimit = bounded(maxCacheEntries, 100, 200), pendingLimit = bounded(maxPending, 20, 100);

  async function fetchPage(area, category, pageNo) {
    const url = new URL(ENDPOINT);
    for (const [name, value] of Object.entries({ serviceKey: keyValue(serviceKey), numOfRows: rows, pageNo, areaNm: area, clNm: category === '전체' ? '' : category })) url.searchParams.set(name, String(value));
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new RestaurantApiError('TIMEOUT')); }, timeoutMs); });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
        if ([401, 403].includes(response.status)) throw new RestaurantApiError('AUTH_ERROR');
        if (response.status === 429) throw new RestaurantApiError('RATE_LIMIT');
        const source = await readBody(response);
        if (!response.ok) throw new RestaurantApiError('UPSTREAM_ERROR');
        const parsed = source.trimStart().startsWith('<') ? parseXml(source) : parseJson(source);
        if (parsed.items.length > rows) invalid();
        return parsed;
      })()]);
    } catch (error) {
      if (error instanceof RestaurantApiError) throw error;
      throw new RestaurantApiError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
    } finally { clearTimeout(timer); }
  }
  async function catalog(area, category) {
    const key = JSON.stringify([area, category]);
    const entry = cache.get(key);
    if (entry && entry.expiresAt > now()) { cache.delete(key); cache.set(key, entry); return entry.payload; }
    if (entry) cache.delete(key);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= pendingLimit) throw new RestaurantApiError('RATE_LIMIT');
    const job = (async () => {
      const unique = new Map();
      let received = 0, truncated = false;
      for (let pageNo = 1; pageNo <= pages; pageNo++) {
        const page = await fetchPage(area, category, pageNo);
        received += page.items.length;
        for (const raw of page.items) {
          const item = normalizeItem(raw, area, category);
          if (item) unique.set(item.id, item);
        }
        if (page.items.length < rows || (page.totalCount !== null && received >= page.totalCount)) break;
        if (pageNo === pages) truncated = true;
      }
      const payload = { items: [...unique.values()], fetchedAt: new Date(now()).toISOString(), truncated };
      while (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
      cache.set(key, { payload, expiresAt: now() + cacheMs });
      return payload;
    })().finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }
  return {
    async search(query = {}) {
      if (!query || typeof query !== 'object' || Array.isArray(query)) throw new RestaurantApiError('INVALID_AREA');
      const { area, category = '전체', latitude, longitude } = query;
      const region = areaValue(area);
      if (!CATEGORIES.has(category)) throw new RestaurantApiError('INVALID_CATEGORY');
      const origin = point(latitude, longitude, true);
      const result = await catalog(region, category);
      const ordered = result.items.map((item, index) => ({ item, index,
        distanceKm: origin && item.latitude !== null && item.longitude !== null ? distance(origin, item) : null }));
      if (origin) ordered.sort((first, second) => (first.distanceKm ?? Infinity) - (second.distanceKm ?? Infinity) || first.index - second.index);
      const items = ordered.slice(0, 20).map(({ item, distanceKm }) => distanceKm === null ? { ...item } : { ...item, distanceKm: Math.round(distanceKm * 100) / 100 });
      return { items, area: region, category, provider: PROVIDER, fetchedAt: result.fetchedAt, truncated: result.truncated || result.items.length > 20 };
    }
  };
}

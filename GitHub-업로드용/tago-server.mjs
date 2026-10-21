const CONFIG = Object.freeze({
  train: { mode: 'train', base: 'TrainInfo', stops: 'GetCtyAcctoTrainSttnList', trips: 'GetStrtpntAlocFndTrainInfo',
    id: 'nodeid', name: 'nodename', from: 'depPlaceId', to: 'arrPlaceId', pageId: '15098552' },
  express: { mode: 'bus', base: 'ExpBusInfo', stops: 'GetExpBusTrminlList', trips: 'GetStrtpntAlocFndExpbusInfo',
    id: 'terminalId', name: 'terminalNm', from: 'depTerminalId', to: 'arrTerminalId', pageId: '15098522' },
  intercity: { mode: 'bus', base: 'SuburbsBusInfo', stops: 'GetSuberbsBusTrminlList', trips: 'GetStrtpntAlocFndSuberbsBusInfo',
    id: 'terminalId', name: 'terminalNm', from: 'depTerminalId', to: 'arrTerminalId', pageId: '15098541' },
  flight: { mode: 'flight', base: 'DmstcFlightNvgInfo', stops: 'GetArprtList', trips: 'GetFlightOpratInfoList',
    id: 'airportId', name: 'airportNm', from: 'depAirportId', to: 'arrAirportId', pageId: '15098526' },
  ferry: { mode: 'ferry', base: 'DmstcShipNvgInfo', stops: 'GetPortList', trips: 'GetShipOpratInfoList',
    id: 'nodeId', name: 'nodeNm', from: 'depNodeId', to: null, pageId: '15098523' }
});
const ERRORS = Object.freeze({
  INVALID_REQUEST: [400, '교통수단과 검색 조건을 확인해 주세요.'],
  INVALID_QUERY: [400, '역·터미널·공항·항구 이름을 2~100자로 입력해 주세요.'],
  INVALID_DATE: [400, '운행일을 올바른 날짜로 선택해 주세요.'],
  TODAY_ONLY: [400, '시외버스는 현재 한국시간 기준 오늘의 배차만 조회할 수 있어요.'],
  CATALOG_INCOMPLETE: [503, '일부 교통기관 목록을 불러오지 못했어요. 잠시 후 다시 검색하거나 시간을 직접 입력해 주세요.'],
  UNKNOWN_STOP: [400, '출발지와 도착지를 해당 교통수단의 검색 목록에서 다시 선택해 주세요.'],
  KEY_MISSING: [503, '서버의 .env에 DATA_GO_KR_SERVICE_KEY를 설정해 주세요.'],
  AUTH_ERROR: [502, '공공 교통정보 인증에 실패했어요. 해당 TAGO 서비스의 활용신청 승인 상태를 확인해 주세요.'],
  RATE_LIMIT: [429, '공공 교통정보 조회 요청이 많아요. 잠시 후 다시 시도해 주세요.'],
  TIMEOUT: [504, '공공 교통정보 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.'],
  NETWORK_ERROR: [502, '공공 교통정보에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'],
  UPSTREAM_ERROR: [502, '공공 교통정보 제공 서비스에서 오류가 발생했어요. 잠시 후 다시 시도해 주세요.'],
  INVALID_RESPONSE: [502, '공공 교통정보 응답을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.']
});
const PROVIDER = '국토교통부 TAGO';
const DAY = 24 * 60 * 60 * 1000;
const clean = (value, maximum = 120) => typeof value === 'string' || typeof value === 'number'
  ? String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maximum) : '';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const sourceUrl = service => `https://www.data.go.kr/data/${CONFIG[service].pageId}/openapi.do`;
const comparable = value => clean(value).replace(/\s+/g, '').toLocaleLowerCase('ko');

export class TransportApiError extends Error {
  constructor(code) {
    const safe = Object.hasOwn(ERRORS, code) ? code : 'UPSTREAM_ERROR';
    super(ERRORS[safe][1]);
    this.name = 'TransportApiError'; this.code = safe; this.status = ERRORS[safe][0];
  }
}
class FetchBudgetError extends TransportApiError {
  constructor() { super('CATALOG_INCOMPLETE'); }
}

function keyValue(value) {
  let key = typeof value === 'string' ? value.trim() : '';
  if (!key) throw new TransportApiError('KEY_MISSING');
  if (/%[0-9a-f]{2}/i.test(key)) {
    try { key = decodeURIComponent(key); } catch { throw new TransportApiError('AUTH_ERROR'); }
  }
  return key;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(`${value}T00:00:00Z`);
  return year >= 1900 && date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}
function koreanDate(milliseconds) {
  return new Date(milliseconds + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function timestamp(value) {
  const text = clean(value, 30);
  if (!/^(?:\d{12}|\d{14})$/.test(text)) return null;
  const date = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const hour = Number(text.slice(8, 10)), minute = Number(text.slice(10, 12)), second = Number(text.slice(12) || 0);
  if (!validDate(date) || hour > 23 || minute > 59 || second > 59) return null;
  return { date, minutes: hour * 60 + minute, epoch: Date.parse(`${date}T${text.slice(8, 10)}:${text.slice(10, 12)}:00Z`) };
}
function safeCode(code) {
  const normalized = String(code ?? '').trim();
  if (['20', '30', '31'].includes(normalized)) return new TransportApiError('AUTH_ERROR');
  if (['22', '23'].includes(normalized)) return new TransportApiError('RATE_LIMIT');
  if (normalized === '05') return new TransportApiError('TIMEOUT');
  return new TransportApiError('UPSTREAM_ERROR');
}
async function readBody(response) {
  const maximum = 4 * 1024 * 1024;
  if (Number(response.headers?.get('content-length')) > maximum) throw new TransportApiError('INVALID_RESPONSE');
  const reader = response.body?.getReader();
  if (!reader) throw new TransportApiError('INVALID_RESPONSE');
  let size = 0; const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new TransportApiError('INVALID_RESPONSE'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

export function createTransportClient({ serviceKey, fetchImpl = globalThis.fetch, now = Date.now,
  timeoutMs = 8000, catalogTimeoutMs = 18000, catalogCacheMs = DAY, tripCacheMs = 5 * 60 * 1000,
  pageSize = 1000, maximumItems = 1000, maxPages = 10 } = {}) {
  const catalogs = new Map(), trips = new Map(), pending = new Map(), trainLists = new Map();
  let nextTrainRegion = 0, trainCitiesProgress;
  const rows = Math.min(1000, Math.max(1, Number.isSafeInteger(pageSize) ? pageSize : 1000));
  const limit = Math.min(1000, Math.max(1, Number.isSafeInteger(maximumItems) ? maximumItems : 1000));
  const pages = Math.min(10, Math.max(1, Number.isSafeInteger(maxPages) ? maxPages : 10));

  // Each public invocation owns its credits, including failed fetch attempts.
  // In-flight cache followers keep their own credits for any subsequent work.
  const scope = () => ({ remaining: 40, closed: false, controllers: new Set() });
  const context = (budget, reserve = 0) => ({ budget, reserve, closed: false, controllers: new Set() });
  function close(work) { work.closed = true; for (const controller of work.controllers) controller.abort(); }
  function active(work) {
    if (work.closed || work.budget.closed) throw new TransportApiError('TIMEOUT');
  }
  function available(work) { return !work.closed && !work.budget.closed && work.budget.remaining > work.reserve; }

  async function fetchPage(service, operation, query, pageNo, work) {
    const url = new URL(`https://apis.data.go.kr/1613000/${CONFIG[service].base}/${operation}`);
    for (const [name, value] of Object.entries({ serviceKey: keyValue(serviceKey), _type: 'json',
      numOfRows: String(rows), pageNo: String(pageNo), ...query })) url.searchParams.set(name, value);
    active(work);
    if (!available(work)) throw new FetchBudgetError();
    const controller = new AbortController(); let timer, onAbort;
    work.controllers.add(controller); work.budget.controllers.add(controller);
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new TransportApiError('TIMEOUT'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new TransportApiError('TIMEOUT')); }, timeoutMs); });
    try {
      return await Promise.race([deadline, aborted, (async () => {
      // No await may separate this debit from starting its external request.
      work.budget.remaining--;
      const response = await fetchImpl(url, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'application/json' } });
      if ([401, 403].includes(response.status)) throw new TransportApiError('AUTH_ERROR');
      if (response.status === 429) throw new TransportApiError('RATE_LIMIT');
      if (response.status >= 300 && response.status < 400) throw new TransportApiError('UPSTREAM_ERROR');
      const source = await readBody(response);
      if (source.trimStart().startsWith('<')) {
        const code = source.match(/<(?:returnReasonCode|resultCode)>\s*(\d+)\s*<\//i)?.[1];
        if (code) throw safeCode(code);
        throw new TransportApiError('UPSTREAM_ERROR');
      }
      if (!response.ok) throw new TransportApiError('UPSTREAM_ERROR');
      let data; try { data = JSON.parse(source); } catch { throw new TransportApiError('INVALID_RESPONSE'); }
      const code = String(data?.response?.header?.resultCode ?? '');
      if (code === '03') return { items: [], totalCount: 0 };
      if (!/^0+$/.test(code)) throw code ? safeCode(code) : new TransportApiError('INVALID_RESPONSE');
      const body = data?.response?.body;
      if (!body || typeof body !== 'object') throw new TransportApiError('INVALID_RESPONSE');
      const raw = body.items?.item;
      if ((body.items === undefined && body.totalCount === undefined)
        || (raw !== undefined && raw !== null && raw !== '' && (typeof raw !== 'object'))
        || (body.items !== undefined && body.items !== null && body.items !== '' && typeof body.items !== 'object')) {
        throw new TransportApiError('INVALID_RESPONSE');
      }
      const items = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
      const totalCount = body.totalCount === undefined ? items.length : Number(body.totalCount);
      if (!Number.isSafeInteger(totalCount) || totalCount < 0 || (totalCount > 0 && items.length === 0)) throw new TransportApiError('INVALID_RESPONSE');
      active(work);
      return { items, totalCount };
      })()]);
    } catch (error) {
      if (error instanceof TransportApiError) throw error;
      throw new TransportApiError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort);
      work.controllers.delete(controller); work.budget.controllers.delete(controller);
    }
  }

  async function fetchList(service, operation, query, work) {
    const items = []; let totalCount = 0, truncated = false;
    for (let pageNo = 1; pageNo <= pages; pageNo++) {
      let result;
      try { result = await fetchPage(service, operation, query, pageNo, work); }
      catch (error) {
        if (error instanceof FetchBudgetError && items.length) return { items, totalCount, truncated: true, partial: true };
        throw error;
      }
      active(work);
      totalCount = result.totalCount;
      items.push(...result.items.slice(0, limit - items.length));
      if (items.length >= totalCount) break;
      if (!result.items.length || items.length >= limit || pageNo === pages) { truncated = true; break; }
    }
    return { items, totalCount, truncated };
  }

  async function cached(map, key, ttl, fetchData, capacity = 100) {
    const entry = map.get(key);
    if (entry && entry.expiresAt > now()) { map.delete(key); map.set(key, entry); return entry.payload; }
    if (entry) map.delete(key);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 30) throw new TransportApiError('RATE_LIMIT');
    const request = fetchData().then(payload => {
      while (map.size >= capacity) map.delete(map.keys().next().value);
      if (!payload.partial) map.set(key, { expiresAt: payload.cacheUntil ?? now() + ttl, payload }); return payload;
    }).finally(() => pending.delete(key));
    pending.set(key, request); return request;
  }

  function normalizeStop(service, raw, region = '') {
    if (!raw || typeof raw !== 'object') return null;
    const config = CONFIG[service], providerId = clean(raw[config.id], 81), name = clean(raw[config.name]);
    if (!validId(providerId) || !name) return null;
    return { id: `tago-${service}-${providerId}`, providerId, service, mode: config.mode,
      name, address: clean(raw.cityName || region, 200), latitude: null, longitude: null,
      source: 'TAGO', sourceUrl: sourceUrl(service) };
  }

  async function trainRegions(work) {
    if (trainCitiesProgress?.expiresAt <= now()) trainCitiesProgress = undefined;
    const progress = trainCitiesProgress || { items: [], totalCount: null, nextPage: 1, expiresAt: now() + catalogCacheMs };
    let partial = false;
    while (progress.totalCount === null || progress.items.length < progress.totalCount) {
      let result;
      try { result = await fetchPage('train', 'GetCtyCodeList', {}, progress.nextPage, work); }
      catch (error) {
        if (error instanceof FetchBudgetError && progress.items.length) { partial = true; break; }
        throw error;
      }
      active(work);
      if (result.totalCount > 64 || progress.items.length + result.items.length > 64
        || progress.totalCount !== null && progress.totalCount !== result.totalCount) {
        trainCitiesProgress = undefined;
        throw new TransportApiError('INVALID_RESPONSE');
      }
      progress.totalCount = result.totalCount;
      progress.items.push(...result.items.map(region => ({ citycode: clean(region?.citycode, 10), cityname: clean(region?.cityname) })));
      progress.nextPage++;
      // Checkpoint successful pages, never errors or late timeout responses.
      trainCitiesProgress = progress;
    }
    const seen = new Set(), items = [];
    for (const region of progress.items) {
      const cityCode = region.citycode, cityName = region.cityname;
      if (!/^\d{1,3}$/.test(cityCode) || !cityName || seen.has(cityCode)) continue;
      seen.add(cityCode); items.push({ cityCode, cityName });
    }
    if (!partial) trainCitiesProgress = undefined;
    return { items, totalCount: progress.totalCount, truncated: partial, partial, cacheUntil: progress.expiresAt };
  }

  async function catalog(service, work) {
    return cached(catalogs, `catalog:${service}`, catalogCacheMs, async () => {
      const unique = new Map(); let truncated = false, partial = false, cacheUntil;
      if (service === 'train') {
        const trainWork = context(work.budget, work.reserve);
        let catalogTimer;
        const expired = new Promise(resolve => {
          catalogTimer = setTimeout(() => { close(trainWork); resolve(); }, Math.max(1, catalogTimeoutMs));
        });
        try {
        const regions = await cached(trainLists, 'train:cities', catalogCacheMs, () => trainRegions(trainWork), 65);
        truncated = regions.truncated;
        const validRegions = regions.items;
        // A cold nationwide station search must not wait for every city serially.
        // Four workers bound provider pressure; collect in source order for stable results.
        const results = new Array(validRegions.length), missing = [];
        const start = nextTrainRegion % Math.max(1, validRegions.length);
        for (let offset = 0; offset < validRegions.length; offset++) {
          const index = (start + offset) % validRegions.length, entry = trainLists.get(`train:region:${validRegions[index].cityCode}`);
          if (entry && entry.expiresAt > now()) results[index] = entry.payload;
          else missing.push(index);
        }
        let nextRegion = 0;
        const workers = Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
          while (available(trainWork) && nextRegion < missing.length) {
            const index = missing[nextRegion++], region = validRegions[index];
            nextTrainRegion = (index + 1) % validRegions.length;
            try {
              results[index] = await cached(trainLists, `train:region:${region.cityCode}`, catalogCacheMs, async () => {
                const result = await fetchList(service, CONFIG[service].stops, { cityCode: region.cityCode }, trainWork);
                return { ...result, items: result.items.map(raw => normalizeStop(service, raw, region.cityName)).filter(Boolean) };
              }, 65);
            }
            catch (error) { results[index] = { error }; }
          }
        }));
        await Promise.race([workers, expired]);
        close(trainWork);
        partial = Boolean(regions.partial) || results.filter(result => result && !result.error && !result.partial).length < validRegions.length;
        if (partial && !regions.partial && !results.some(result => result && !result.error)) {
          throw results.find(result => result?.error)?.error || new TransportApiError('TIMEOUT');
        }
        for (let index = 0; index < results.length; index++) {
          const result = results[index]; if (!result || result.error) continue; truncated ||= result.truncated;
          for (const stop of result.items) {
            if (stop && unique.size < limit) unique.set(stop.providerId, stop);
            else if (stop && !unique.has(stop.providerId)) truncated = true;
          }
        }
        if (!partial) cacheUntil = Math.min(...['train:cities', ...validRegions.map(region => `train:region:${region.cityCode}`)]
          .map(key => trainLists.get(key)?.expiresAt ?? now()));
        } finally { clearTimeout(catalogTimer); close(trainWork); }
      } else {
        const result = await fetchList(service, CONFIG[service].stops, {}, work);
        truncated = result.truncated; partial = Boolean(result.partial);
        for (const raw of result.items) {
          const stop = normalizeStop(service, raw);
          if (stop) unique.set(stop.providerId, stop);
        }
      }
      return { items: [...unique.values()], truncated, partial, fetchedAt: new Date(now()).toISOString(), ...(cacheUntil === undefined ? {} : { cacheUntil }) };
    }, 5);
  }

  async function normalizeTrip(service, raw, from, to, date, fetchedAt) {
    if (!raw || typeof raw !== 'object') return null;
    const isTrain = service === 'train', isFlight = service === 'flight';
    const departureName = clean(raw[isTrain ? 'depplacename' : isFlight ? 'depAirportNm' : 'depPlaceNm']);
    const arrivalName = clean(raw[isTrain ? 'arrplacename' : isFlight ? 'arrAirportNm' : 'arrPlaceNm']);
    if (comparable(departureName) !== comparable(from.name) || comparable(arrivalName) !== comparable(to.name)) return null;
    const departure = timestamp(raw[isTrain ? 'depplandtime' : 'depPlandTime']);
    const arrival = timestamp(raw[isTrain ? 'arrplandtime' : 'arrPlandTime']);
    if (!departure || !arrival || departure.date !== date) return null;
    const durationMinutes = (arrival.epoch - departure.epoch) / 60000;
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes > 4320) return null;
    const departureMinutes = departure.minutes, arrivalMinutes = departureMinutes + durationMinutes;
    const tripNo = clean(raw[isTrain ? 'trainno' : isFlight ? 'vihicleId' : service === 'ferry' ? 'vihicleNm' : ''], 80);
    const grade = clean(raw[isTrain ? 'traingradename' : 'gradeNm'], 80);
    const identity = JSON.stringify([service, from.providerId, to.providerId,
      date, departureMinutes, arrivalMinutes, tripNo, grade]);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
    return { id: `tago-trip-${service}-${hash}`, service, departureId: from.providerId, arrivalId: to.providerId,
      departureName, arrivalName, date, departureMinutes, arrivalMinutes, durationMinutes, tripNo, grade,
      source: 'TAGO', sourceUrl: sourceUrl(service), fetchedAt };
  }

  return {
    async searchStops({ mode, q, service } = {}) {
      const query = typeof q === 'string' ? q.trim() : '';
      if (query.length < 2 || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query)) throw new TransportApiError('INVALID_QUERY');
      if (!['train', 'bus', 'flight', 'ferry'].includes(mode)) throw new TransportApiError('INVALID_REQUEST');
      const services = service ? [service] : mode === 'bus' ? ['express', 'intercity'] : [mode];
      if (services.some(name => !Object.hasOwn(CONFIG, name) || CONFIG[name].mode !== mode)) throw new TransportApiError('INVALID_REQUEST');
      const budget = scope(), work = context(budget);
      try {
      const loaded = await Promise.allSettled(services.map(name => catalog(name, work)));
      const catalogs = loaded.filter(result => result.status === 'fulfilled').map(result => result.value);
      if (!catalogs.length) throw loaded.find(result => result.status === 'rejected').reason;
      const unavailableServices = loaded.flatMap((result, index) => result.status === 'rejected'
        ? [{ service: services[index], code: result.reason instanceof TransportApiError ? result.reason.code : 'UPSTREAM_ERROR' }]
        : result.value.partial ? [{ service: services[index], code: 'CATALOG_INCOMPLETE' }] : []);
      const needle = comparable(query);
      const alias = mode === 'train' && needle.endsWith('역') ? needle.slice(0, -1) : needle;
      const matches = catalogs.flatMap(entry => entry.items).filter(stop => comparable(stop.name).includes(needle)
        || (alias.length && comparable(stop.name).includes(alias)));
      const rank = stop => comparable(stop.name) === alias ? 0 : comparable(stop.name).startsWith(alias) ? 1 : 2;
      matches.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ko') || a.id.localeCompare(b.id));
      return { provider: PROVIDER, items: matches.slice(0, 10), partial: unavailableServices.length > 0, unavailableServices, truncated: catalogs.some(entry => entry.truncated) || matches.length > 10,
        fetchedAt: catalogs.map(entry => entry.fetchedAt).sort()[0] };
      } finally { close(budget); }
    },
    async getTrips({ service, from, to, date } = {}) {
      if (!Object.hasOwn(CONFIG, service) || !validId(from) || !validId(to) || from === to) throw new TransportApiError('INVALID_REQUEST');
      if (!validDate(date)) throw new TransportApiError('INVALID_DATE');
      if (service === 'intercity' && date !== koreanDate(now())) throw new TransportApiError('TODAY_ONLY');
      const budget = scope();
      try {
      // A cold catalog cannot spend the credits needed to retrieve trip pages.
      const stops = await catalog(service, context(budget, pages));
      const departure = stops.items.find(stop => stop.providerId === from), arrival = stops.items.find(stop => stop.providerId === to);
      if (!departure || !arrival) throw new TransportApiError(stops.partial ? 'CATALOG_INCOMPLETE' : 'UNKNOWN_STOP');
      return await cached(trips, `trips:${service}:${from}:${to}:${date}`, tripCacheMs, async () => {
        const config = CONFIG[service], query = { [config.from]: from, depPlandTime: date.replaceAll('-', '') };
        if (config.to) query[config.to] = to;
        const result = await fetchList(service, config.trips, query, context(budget)), fetchedAt = new Date(now()).toISOString(), unique = new Map();
        for (const raw of result.items) {
          const item = await normalizeTrip(service, raw, departure, arrival, date, fetchedAt);
          if (item) unique.set(item.id, item);
        }
        return { provider: PROVIDER, service, items: [...unique.values()].sort((a, b) => a.departureMinutes - b.departureMinutes
          || a.arrivalMinutes - b.arrivalMinutes || a.id.localeCompare(b.id)), truncated: result.truncated, fetchedAt,
          ...(result.partial ? { partial: true } : {}) };
      });
      } finally { close(budget); }
    }
  };
}

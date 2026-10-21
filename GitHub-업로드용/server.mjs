import { createBackdropClient } from './backdrop-server.mjs';
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { TourApiError, normalizeServiceKey, normalizeAreas, normalizeItems, createTourClient } from './tour-client.mjs';
export { TourApiError, normalizeServiceKey, normalizeAreas, normalizeItems, createTourClient } from './tour-client.mjs';
import { createDepartureClient, DepartureSearchError } from './departure-server.mjs';
import { createTransportClient, TransportApiError } from './tago-server.mjs';
import { RestaurantApiError } from './restaurant-server.mjs';
import { createTourRestaurantClient, TourRestaurantError } from './tour-restaurants.mjs';
import { createCarRoutingClient, CarRoutingError } from './car-routing.mjs';
import { createTransitRoutingClient, TransitRoutingError } from './transit-routing.mjs';
import { PUBLIC_FILES } from './public-assets.mjs';
import { createAccountHandler } from './auth-store.mjs';
import { createLocalDatabase } from './local-db.mjs';
import { ensureLocalAccountSecret } from './setup-account-db.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Do not log .env contents, request URLs, raw upstream responses, or exception stacks.
export async function loadEnvFile(filename = path.join(ROOT, '.env')) {
  let source;
  try { source = await readFile(filename, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new TourApiError('KEY_MISSING');
  }
  const values = {};
  for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

export function resolveServiceKey(env = {}, runtimeEnv = process.env) {
  // Prefer the shared key in either source. Within each compatibility tier,
  // runtime variables override .env; the former TourAPI name precedes TAGO.
  const candidates = [
    runtimeEnv?.DATA_GO_KR_SERVICE_KEY, env?.DATA_GO_KR_SERVICE_KEY,
    runtimeEnv?.TOURAPI_SERVICE_KEY, runtimeEnv?.TAGO_SERVICE_KEY,
    env?.TOURAPI_SERVICE_KEY, env?.TAGO_SERVICE_KEY
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

export function resolveCarRoutingApiKey(env = {}, runtimeEnv = process.env) {
  return [runtimeEnv?.KAKAO_REST_API_KEY, env?.KAKAO_REST_API_KEY].find(value => typeof value === 'string' && value.trim())?.trim();
}

function send(response, method, status, body, contentType = 'application/json; charset=utf-8') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  response.end(method === 'HEAD' ? undefined : data);
}

export function createAppServer({ root = ROOT, backdropClient = createBackdropClient(), client = createTourClient(), departureClient = createDepartureClient(), transportClient = createTransportClient(), restaurantClient = createTourRestaurantClient(), carRoutingClient = createCarRoutingClient(), transitRoutingClient = createTransitRoutingClient(), accountHandler = createAccountHandler({}) } = {}) {
  return createServer(async (request, response) => {
    const method = request.method;
    try {
      const rawPath = (request.url || '/').split('?')[0];
      let pathname;
      try { pathname = decodeURIComponent(rawPath); }
      catch { return send(response, method, 400, { error: { code: 'BAD_REQUEST', message: '올바르지 않은 요청입니다.' } }); }
      if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '.' || part === '..')) {
        return send(response, method, 404, { error: { code: 'NOT_FOUND', message: '파일을 찾을 수 없습니다.' } });
      }
      if (pathname.startsWith('/api/auth/') || pathname === '/api/plans' || pathname.startsWith('/api/plans/')) {
        const chunks=[];
        let size=0;
        for await (const chunk of request) {
          size+=chunk.length;
          if(size>270000)return send(response,method,413,{error:{code:'BODY_TOO_LARGE',message:'저장할 내용이 너무 커요.'}});
          chunks.push(chunk);
        }
        const webHeaders=new Headers();
        for(const [name,value] of Object.entries(request.headers)){
          if(value!==undefined)webHeaders.set(name,Array.isArray(value)?value.join(', '):value);
        }
        // Never trust a client-supplied proxy/IP header on the local server.
        webHeaders.set('CF-Connecting-IP',request.socket.remoteAddress||'local');
        const webRequest=new Request(new URL(request.url,`http://${request.headers.host||'127.0.0.1'}`),{
          method,headers:webHeaders,...(!['GET','HEAD'].includes(method)?{body:Buffer.concat(chunks)}:{})
        });
        const result=await accountHandler(webRequest);
        if(result){
          const resultHeaders=Object.fromEntries(result.headers);
          // OAuth callback issues the session and clears its state cookie.
          // They must remain separate Set-Cookie fields in Node as in Workers.
          const cookies=result.headers.getSetCookie();
          if(cookies.length)resultHeaders['set-cookie']=cookies;
          response.writeHead(result.status,resultHeaders);
          return response.end(method==='HEAD'?undefined:Buffer.from(await result.arrayBuffer()));
        }
        return send(response,method,404,{error:{code:'NOT_FOUND',message:'요청한 기능을 찾을 수 없어요.'}});
      }
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        return send(response, method, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '허용되지 않은 요청 방식입니다.' } });
      }
      if (pathname === '/api/tour/backdrop') return send(response, method, 200, await backdropClient.getPhotos());
      if (pathname === '/api/tour/places') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return send(response, method, 200, await client.getPlaces(url.searchParams.get('areaCode') ?? url.searchParams.get('city') ?? '1'));
      }
      if (pathname === '/api/tour/areas') {
        return send(response, method, 200, await client.getAreas());
      }
      if (pathname === '/api/departures/search') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return send(response, method, 200, await departureClient.search(url.searchParams.get('q')));
      }
      if (pathname === '/api/transport/stops') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return send(response, method, 200, await transportClient.searchStops({mode:url.searchParams.get('mode'),q:url.searchParams.get('q'),service:url.searchParams.get('service')||undefined}));
      }
      if (pathname === '/api/transport/trips') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return send(response, method, 200, await transportClient.getTrips({service:url.searchParams.get('service'),from:url.searchParams.get('from'),to:url.searchParams.get('to'),date:url.searchParams.get('date')}));
      }
      if (pathname === '/api/restaurants') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return send(response, method, 200, await restaurantClient.search({area:url.searchParams.get('area'),district:url.searchParams.get('district')??undefined,category:url.searchParams.get('category')||'전체',latitude:url.searchParams.get('latitude')??undefined,longitude:url.searchParams.get('longitude')??undefined}));
      }
      if (pathname === '/api/car-route') {
        const query = new URL(request.url, 'http://127.0.0.1').searchParams;
        return send(response, method, 200, await carRoutingClient.getRoute({ originLatitude: query.get('originLatitude'), originLongitude: query.get('originLongitude'), destinationLatitude: query.get('destinationLatitude'), destinationLongitude: query.get('destinationLongitude') }));
      }
      if (pathname === '/api/transit-routes') {
        const query = new URL(request.url, 'http://127.0.0.1').searchParams;
        return send(response, method, 200, await transitRoutingClient.getRoutes({ originLatitude: query.get('originLatitude'), originLongitude: query.get('originLongitude'), destinationLatitude: query.get('destinationLatitude'), destinationLongitude: query.get('destinationLongitude'), mode: query.get('mode') }));
      }
      const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!PUBLIC_FILES.has(filename)) {
        return send(response, method, 404, { error: { code: 'NOT_FOUND', message: '파일을 찾을 수 없습니다.' } });
      }
      // Refuse symlinks that point outside the public app directory.
      const publicRoot = await realpath(root);
      const filenamePath = await realpath(path.join(publicRoot, filename));
      const relativePath = path.relative(publicRoot, filenamePath);
      if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        return send(response, method, 404, { error: { code: 'NOT_FOUND', message: '파일을 찾을 수 없습니다.' } });
      }
      return send(response, method, 200, await readFile(filenamePath), PUBLIC_FILES.get(filename));
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code)) {
        return send(response, method, 404, { error: { code: 'NOT_FOUND', message: '파일을 찾을 수 없습니다.' } });
      }
      const safe = error instanceof TourApiError || error instanceof DepartureSearchError || error instanceof TransportApiError || error instanceof RestaurantApiError || error instanceof TourRestaurantError || error instanceof CarRoutingError || error instanceof TransitRoutingError ? error : new TourApiError('INTERNAL_ERROR');
      return send(response, method, safe.status, { error: { code: safe.code, message: safe.message } });
    }
  });
}

export async function startServer() {
  const env = await loadEnvFile();
  const serviceKey = resolveServiceKey(env);
  const requestedPort = process.env.PORT || env.PORT || '3000';
  if (!/^\d+$/.test(requestedPort) || Number(requestedPort) < 1 || Number(requestedPort) > 65535) {
    console.error('PORT는 1~65535 사이의 정수여야 합니다.');
    process.exitCode = 1;
    return;
  }
  const kakaoApiKey = resolveCarRoutingApiKey(env);
  const secret = process.env.AUTH_SECRET || env.AUTH_SECRET || await ensureLocalAccountSecret(ROOT);
  const db = createLocalDatabase({filename:path.join(ROOT,'.local','gil.sqlite')});
  const server = createAppServer({ backdropClient: createBackdropClient({serviceKey}), client: createTourClient({ serviceKey }), transportClient: createTransportClient({serviceKey}),restaurantClient:createTourRestaurantClient({serviceKey}), carRoutingClient:createCarRoutingClient({apiKey:kakaoApiKey}), transitRoutingClient:createTransitRoutingClient({apiKey:kakaoApiKey}), accountHandler:createAccountHandler({db,secret,oauthEnv:{...env,...process.env}}) });
  server.on('close',()=>db.close());
  server.on('error', () => {
    console.error('서버를 시작할 수 없습니다. 포트 사용 여부를 확인해 주세요.');
    process.exitCode = 1;
  });
  server.listen(Number(requestedPort), '127.0.0.1', () => {
    console.log(`길: http://127.0.0.1:${Number(requestedPort)}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().catch(() => {
    console.error('서버 설정을 읽을 수 없습니다. .env 파일을 확인해 주세요.');
    process.exitCode = 1;
  });
}

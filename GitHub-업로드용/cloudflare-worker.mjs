import { createBackdropClient } from './backdrop-server.mjs';
import { createTourClient, TourApiError } from './tour-client.mjs';
import { createDepartureClient, DepartureSearchError } from './departure-server.mjs';
import { createTransportClient, TransportApiError } from './tago-server.mjs';
import { createTourRestaurantClient, TourRestaurantError } from './tour-restaurants.mjs';
import { createCarRoutingClient, CarRoutingError } from './car-routing.mjs';
import { createTransitRoutingClient, TransitRoutingError } from './transit-routing.mjs';
import { PUBLIC_FILES } from './public-assets.mjs';
import { createAccountHandler } from './auth-store.mjs';

const API_PATHS = new Set(['/api/tour/backdrop', '/api/tour/areas', '/api/tour/places', '/api/departures/search', '/api/transport/stops', '/api/transport/trips', '/api/restaurants', '/api/car-route', '/api/transit-routes']);
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
function json(request, status, data, extra = {}) {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}
function createDefaultClients({ serviceKey, carRoutingApiKey }) {
  return { backdrop: createBackdropClient({ serviceKey }), tour: createTourClient({ serviceKey }), departure: createDepartureClient(), transport: createTransportClient({ serviceKey }), restaurants: createTourRestaurantClient({ serviceKey }), carRouting: createCarRoutingClient({ apiKey: carRoutingApiKey }), transitRouting: createTransitRoutingClient({ apiKey: carRoutingApiKey }) };
}
function secretFrom(env) {
  return [env.DATA_GO_KR_SERVICE_KEY, env.TOURAPI_SERVICE_KEY, env.TAGO_SERVICE_KEY].find(value => typeof value === 'string' && value.trim())?.trim();
}

export function createPagesWorker({ createClients = createDefaultClients } = {}) {
  let clients, currentKey, currentCarRoutingKey, initialized = false;
  function services(env) {
    const serviceKey = secretFrom(env);
    const carRoutingApiKey = typeof env.KAKAO_REST_API_KEY === 'string' && env.KAKAO_REST_API_KEY.trim() ? env.KAKAO_REST_API_KEY.trim() : undefined;
    if (!initialized || currentKey !== serviceKey || currentCarRoutingKey !== carRoutingApiKey) {
      clients = createClients({ serviceKey, carRoutingApiKey }); currentKey = serviceKey; currentCarRoutingKey = carRoutingApiKey; initialized = true;
    }
    return clients;
  }
  return {
    async fetch(request, env = {}) {
      try {
        const url = new URL(request.url);
        let pathname;
        try { pathname = decodeURIComponent(url.pathname); }
        catch { return json(request, 400, { error: { code: 'BAD_REQUEST', message: '올바르지 않은 요청입니다.' } }); }
        if (!pathname.startsWith('/') || /[\\\u0000]/.test(pathname) || pathname.split('/').some(part => part === '.' || part === '..')) return json(request, 404, { error: { code: 'NOT_FOUND', message: '파일을 찾을 수 없습니다.' } });
        if(pathname.startsWith('/api/auth/')||pathname==='/api/plans'||pathname.startsWith('/api/plans/')){
          const accountResponse=await createAccountHandler({db:env.DB,secret:env.AUTH_SECRET})(request);
          return accountResponse||json(request,404,{error:{code:'NOT_FOUND',message:'요청한 기능을 찾을 수 없어요.'}});
        }
        if (!['GET', 'HEAD'].includes(request.method)) return json(request, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '허용되지 않은 요청 방식입니다.' } }, { Allow: 'GET, HEAD' });
        if (API_PATHS.has(pathname)) {
          const api = services(env), query = url.searchParams;
          let result;
          if (pathname === '/api/tour/backdrop') result = await api.backdrop.getPhotos();
          else if (pathname === '/api/tour/areas') result = await api.tour.getAreas();
          else if (pathname === '/api/tour/places') result = await api.tour.getPlaces(query.get('areaCode') ?? query.get('city') ?? '1');
          else if (pathname === '/api/departures/search') result = await api.departure.search(query.get('q'));
          else if (pathname === '/api/transport/stops') result = await api.transport.searchStops({ mode: query.get('mode'), q: query.get('q'), service: query.get('service') || undefined });
          else if (pathname === '/api/transport/trips') result = await api.transport.getTrips({ service: query.get('service'), from: query.get('from'), to: query.get('to'), date: query.get('date') });
          else if (pathname === '/api/car-route') result = await api.carRouting.getRoute({ originLatitude: query.get('originLatitude'), originLongitude: query.get('originLongitude'), destinationLatitude: query.get('destinationLatitude'), destinationLongitude: query.get('destinationLongitude') });
          else if (pathname === '/api/transit-routes') result = await api.transitRouting.getRoutes({ originLatitude: query.get('originLatitude'), originLongitude: query.get('originLongitude'), destinationLatitude: query.get('destinationLatitude'), destinationLongitude: query.get('destinationLongitude'), mode: query.get('mode') });
          else result = await api.restaurants.search({ area: query.get('area'), district: query.get('district') ?? undefined, category: '전체', latitude: query.get('latitude') ?? undefined, longitude: query.get('longitude') ?? undefined });
          return json(request, 200, result);
        }
        let filename = pathname === '/' ? 'index.html' : pathname.slice(1);
        if (!PUBLIC_FILES.has(filename) && PUBLIC_FILES.has(`${filename}.html`)) filename += '.html';
        if (!PUBLIC_FILES.has(filename)) return json(request, 404, { error: { code: 'NOT_FOUND', message: '파일을 찾을 수 없습니다.' } });
        if (!env.ASSETS?.fetch) throw new Error('Missing assets binding');
        // Pages canonicalizes HTML to extensionless URLs; requesting index.html
        // through ASSETS would otherwise redirect back to this same Worker route.
        url.pathname = filename.endsWith('.html') ? filename === 'index.html' ? '/' : `/${filename.slice(0, -5)}` : `/${filename}`;
        const asset = await env.ASSETS.fetch(new Request(url, request));
        const safeHeaders = new Headers(asset.headers);
        for (const [name, value] of Object.entries(headers)) safeHeaders.set(name, value);
        if (asset.ok) safeHeaders.set('Content-Type', PUBLIC_FILES.get(filename));
        return new Response(request.method === 'HEAD' ? null : asset.body, { status: asset.status, headers: safeHeaders });
      } catch (error) {
        const safe = error instanceof TourApiError || error instanceof DepartureSearchError || error instanceof TransportApiError || error instanceof TourRestaurantError || error instanceof CarRoutingError || error instanceof TransitRoutingError ? error : new TourApiError('INTERNAL_ERROR');
        const message = safe.code === 'KEY_MISSING' ? '서비스 설정이 아직 완료되지 않았어요. 관리자에게 문의해 주세요.' : safe.message;
        return json(request, safe.status, { error: { code: safe.code, message } });
      }
    }
  };
}

export default createPagesWorker();

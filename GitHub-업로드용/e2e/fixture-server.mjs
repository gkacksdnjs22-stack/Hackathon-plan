import { createAppServer } from '../server.mjs';
import { createAccountHandler } from '../auth-store.mjs';
import { createLocalDatabase } from '../local-db.mjs';

const origin = 'http://localhost:4179';
const db = createLocalDatabase({ filename: ':memory:' });
const items = [
  [101, '합성 문화공원', 37.57, 126.98],
  [102, '합성 역사박물관', 37.571, 126.981],
  [103, '합성 산책정원', 37.572, 126.982],
  [104, '합성 미술관', 37.573, 126.983],
  [201, '합성 강변공원', 37.51, 127.05],
  [202, '합성 전시관', 37.511, 127.051],
  [203, '합성 휴식정원', 37.512, 127.052],
  [204, '합성 현대미술관', 37.513, 127.053]
].map(([contentId, title, latitude, longitude]) => ({
  contentId: String(contentId), title, latitude, longitude,
  contentTypeId: [102, 104, 202, 204].includes(contentId) ? '14' : '12',
  theme: [102, 104, 202, 204].includes(contentId) ? 'culture' : [103, 203].includes(contentId) ? 'rest' : 'nature',
  areaCode: '1', address: `서울특별시 ${contentId < 200 ? '종로구' : '강남구'} 테스트로 ${contentId}`
}));
const unavailable = async () => { throw new Error('This browser scenario does not use a live external API'); };

// The real OAuth state, callback, cookie, account and document code is exercised.
// Only provider HTTP responses are synthetic; there are no usable credentials.
const accountHandler = createAccountHandler({
  db,
  secret: 'browser-scenario-only-secret-at-least-32-characters',
  oauthEnv: {
    SOCIAL_AUTH_BASE_URL: origin,
    KAKAO_LOGIN_CLIENT_ID: 'browser-fixture-client',
    KAKAO_LOGIN_CLIENT_SECRET: 'browser-fixture-secret'
  },
  fetchImpl: async (url, options) => {
    if (url === 'https://kauth.kakao.com/oauth/token') {
      const code = new URLSearchParams(options.body).get('code');
      if (!/^browser-scenario-[12]$/.test(code || '')) return Response.json({}, { status: 400 });
      return Response.json({ access_token: code, token_type: 'bearer' });
    }
    if (url === 'https://kapi.kakao.com/v2/user/me') {
      const account = options.headers.Authorization === 'Bearer browser-scenario-2' ? 2 : 1;
      return Response.json({ id: 990000 + account });
    }
    throw new Error('Unexpected provider URL in browser fixture');
  }
});
const server = createAppServer({
  accountHandler,
  client: {
    getAreas: async () => ({ items: [{ code: '1', name: '서울' }] }),
    getPlaces: async () => ({ areaCode: '1', items, fetchedAt: new Date().toISOString() }),
    getPlaceDetails: async ({ contentId, contentTypeId }) => ({
      provider: '한국관광공사 TourAPI', contentId, contentTypeId,
      fetchedAt: new Date().toISOString(), sourceUrl: 'https://www.data.go.kr/data/15101578/openapi.do',
      status: 'available',
      hoursText: contentId === '101' ? '12:00~18:00' : contentId === '103' ? '계절별 운영시간 별도 안내' : '09:00~18:00',
      closedText: contentId === '102' ? `매주 ${new Intl.DateTimeFormat('ko-KR', { weekday: 'long', timeZone: 'Asia/Seoul' }).format(new Date())} 휴무` : contentId === '103' ? '' : '연중무휴'
    })
  },
  backdropClient: { getPhotos: async () => ({ items: [] }) },
  departureClient: { search: async () => ({ items: [{
    id: 'osm-node-990001', name: '비공개 합성 숙소', address: '서울특별시 종로구 비공개숙소길 99',
    latitude: 37.56, longitude: 126.98, source: 'OpenStreetMap', sourceUrl: 'https://www.openstreetmap.org/node/990001'
  }] }) },
  transportClient: { searchStops: async () => ({ items: [] }), getTrips: unavailable },
  restaurantClient: { search: async () => ({ items: [] }) },
  carRoutingClient: { getRoute: async ({ originLatitude, originLongitude, destinationLatitude, destinationLongitude }) => {
    const origin = { latitude: Number(originLatitude), longitude: Number(originLongitude) };
    const destination = { latitude: Number(destinationLatitude), longitude: Number(destinationLongitude) };
    const from = items.find(item => item.latitude === origin.latitude && item.longitude === origin.longitude)?.contentId;
    const to = items.find(item => item.latitude === destination.latitude && item.longitude === destination.longitude)?.contentId;
    const durationMinutes = ['103>101', '101>102'].includes(`${from}>${to}`) ? 1 : 20;
    return { provider: '카카오모빌리티', reference: '현재 교통 기준', fetchedAt: new Date().toISOString(),
      origin, destination, durationSeconds: durationMinutes * 60, durationMinutes, distanceMeters: durationMinutes * 100 };
  } },
  transitRoutingClient: { getRoutes: unavailable }
});
server.listen(4179, '127.0.0.1', () => console.log('Isolated browser fixture ready on port 4179'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { db.close(); process.exit(0); }));

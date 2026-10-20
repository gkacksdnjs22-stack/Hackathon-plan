import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer, resolveCarRoutingApiKey } from './server.mjs';
import { createPagesWorker } from './cloudflare-worker.mjs';
import { CarRoutingError } from './car-routing.mjs';

const parameters = { originLatitude: '37.55', originLongitude: '126.97', destinationLatitude: '37.56', destinationLongitude: '126.99' };
const query = new URLSearchParams(parameters);

test('카카오 키는 독립된 환경변수만 읽고 공통키·ITS키로 대체하지 않는다', () => {
  assert.equal(resolveCarRoutingApiKey({ KAKAO_REST_API_KEY: ' local ' }, { KAKAO_REST_API_KEY: ' runtime ' }), 'runtime');
  assert.equal(resolveCarRoutingApiKey({ KAKAO_REST_API_KEY: ' local ' }, { KAKAO_REST_API_KEY: ' ' }), 'local');
  assert.equal(resolveCarRoutingApiKey({ ITS_API_KEY: 'its', DATA_GO_KR_SERVICE_KEY: 'common' }, {}), undefined);
});

test('Worker는 카카오 Secret을 분리하고 변경·삭제 시 이전 클라이언트를 재사용하지 않는다', async () => {
  const settings = [], calls = [];
  const worker = createPagesWorker({ createClients: keys => {
    settings.push(keys);
    return { carRouting: { getRoute: async points => { calls.push(points); return { durationMinutes: 17 }; } } };
  } });
  const request = () => new Request(`https://gil.example/api/car-route?${query}`);
  for (const key of [' first ', 'first', 'second', undefined]) {
    const response = await worker.fetch(request(), { DATA_GO_KR_SERVICE_KEY: 'common', ITS_API_KEY: 'its', KAKAO_REST_API_KEY: key });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { durationMinutes: 17 });
  }
  assert.equal(settings.length, 3);
  assert.deepEqual(settings.map(keys => keys.carRoutingApiKey), ['first', 'second', undefined]);
  assert.ok(settings.every(keys => keys.serviceKey === 'common' && !Object.hasOwn(keys, 'itsApiKey')));
  assert.equal(calls.length, 4); assert.deepEqual(calls[0], parameters);
});

test('로컬 자동차 경로 API는 좌표만 전달하며 경로 없음·HEAD·비공개 파일을 처리한다', async () => {
  const calls = [];
  const server = createAppServer({ carRoutingClient: { getRoute: async points => {
    calls.push(points);
    if (points.originLatitude === 'no-route') throw new CarRoutingError('NO_ROUTE');
    if (points.originLatitude === 'unsafe') throw new Error('DO-NOT-EXPOSE-KEY');
    return { provider: '카카오모빌리티', durationMinutes: 17, distanceMeters: 3690 };
  } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/car-route?${query}&url=https://ignored.example&apiKey=ignored`);
    assert.equal(response.status, 200); assert.equal((await response.json()).durationMinutes, 17); assert.deepEqual(calls[0], parameters);
    const head = await fetch(`${base}/api/car-route?${query}`, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    const missing = await fetch(`${base}/api/car-route?originLatitude=no-route`);
    assert.equal(missing.status, 422); assert.equal((await missing.json()).error.code, 'NO_ROUTE');
    const unsafe = await fetch(`${base}/api/car-route?originLatitude=unsafe`);
    assert.equal(unsafe.status, 500); assert.ok(!(await unsafe.text()).includes('DO-NOT-EXPOSE-KEY'));
    assert.equal((await fetch(`${base}/car-routing.mjs`)).status, 404);
    const count = calls.length;
    assert.equal((await fetch(`${base}/api/car-route`, { method: 'POST' })).status, 405);
    assert.equal(calls.length, count);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

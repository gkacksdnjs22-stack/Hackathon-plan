import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from './server.mjs';
import { createPagesWorker } from './cloudflare-worker.mjs';
import { TransitRoutingError } from './transit-routing.mjs';

const points = { originLatitude:'37.55', originLongitude:'126.97', destinationLatitude:'37.56', destinationLongitude:'126.99', mode:'local-bus' };
const query = new URLSearchParams(points);
const summary = { provider:'카카오맵', mode:'local-bus', routes:[{id:'bus-0',durationMinutes:25,distanceMeters:3500,transfers:1}] };

test('Worker 대중교통 조회는 기존 카카오 Secret을 재사용하며 모드와 좌표만 전달하고 응답을 저장하지 않는다', async () => {
  const settings=[], calls=[];
  const worker=createPagesWorker({createClients:keys=>{
    settings.push(keys);
    return {transitRouting:{getRoutes:async args=>{calls.push(args);return summary;}}};
  }});
  for(const key of [' first ','first','second',undefined]){
    const response=await worker.fetch(new Request(`https://gil.example/api/transit-routes?${query}&apiKey=ignored&url=https://ignored.example`),{KAKAO_REST_API_KEY:key});
    assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.deepEqual(await response.json(),summary);
  }
  assert.deepEqual(settings.map(x=>x.carRoutingApiKey),['first','second',undefined]);
  assert.equal(calls.length,4);assert.deepEqual(calls[0],points);
});

test('로컬 대중교통 API는 오류·HEAD·허용 메서드·비공개 소스를 안전하게 처리한다',async()=>{
  const calls=[];
  const server=createAppServer({transitRoutingClient:{getRoutes:async args=>{
    calls.push(args);
    if(args.originLatitude==='no-route')throw new TransitRoutingError('NO_ROUTE');
    if(args.originLatitude==='unsafe')throw new Error('PRIVATE-UPSTREAM-CREDENTIAL');
    return summary;
  }}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const response=await fetch(`${base}/api/transit-routes?${query}&url=https://ignored.example`);
    assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.deepEqual(await response.json(),summary);assert.deepEqual(calls[0],points);
    const head=await fetch(`${base}/api/transit-routes?${query}`,{method:'HEAD'});
    assert.equal(head.status,200);assert.equal(await head.text(),'');
    const empty=await fetch(`${base}/api/transit-routes?originLatitude=no-route`);
    assert.equal(empty.status,422);assert.equal((await empty.json()).error.code,'NO_ROUTE');
    const unsafe=await fetch(`${base}/api/transit-routes?originLatitude=unsafe`);
    assert.equal(unsafe.status,500);assert.ok(!(await unsafe.text()).includes('PRIVATE-UPSTREAM-CREDENTIAL'));
    assert.equal((await fetch(`${base}/transit-routing.mjs`)).status,404);
    assert.equal((await fetch(`${base}/.env`)).status,404);
    const before=calls.length;
    assert.equal((await fetch(`${base}/api/transit-routes`,{method:'POST'})).status,405);
    assert.equal(calls.length,before);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

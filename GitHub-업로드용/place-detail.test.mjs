import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createTourClient} from './tour-client.mjs';
import {createAppServer} from './server.mjs';
const ok=items=>new Response(JSON.stringify({response:{header:{resultCode:'0000'},body:{totalCount:items.length,items:{item:items}}}}));
const common={contentid:'101',contenttypeid:'14',title:'문화관',overview:'안내<br>전시 &amp; 체험<script>private script</script>',addr1:'서울',firstimage:'https://example.com/original.jpg',homepage:'<a href="https://example.com/?a=1&amp;b=2">홈</a>',private:'DO_NOT_EXPOSE'};
const intro={contentid:'101',contenttypeid:'14',usetimeculture:'09:00~18:00',restdateculture:'월요일',usefee:'성인 3,000원',parkingculture:'주차 가능',infocenterculture:'02-123-4567'};

test('place detail makes sequential common and type-specific calls, sanitizes fields and caches only normalized output',async()=>{
  const calls=[];
  const client=createTourClient({serviceKey:'TEST_SECRET',fetchImpl:async url=>{calls.push(url);return ok([url.pathname.endsWith('detailCommon2')?common:intro]);}});
  const detail=await client.getPlaceDetail({contentId:'101',contentTypeId:'14'});
  assert.deepEqual(calls.map(url=>url.pathname.split('/').at(-1)),['detailCommon2','detailIntro2']);
  assert.equal(calls[1].searchParams.get('contentTypeId'),'14');assert.equal(detail.hours,'09:00~18:00');assert.equal(detail.fee,'성인 3,000원');
  assert.equal(detail.overview,'안내\n전시 & 체험');assert.equal(detail.homepage,'https://example.com/?a=1&b=2');
  assert.equal(JSON.stringify(detail).includes('DO_NOT_EXPOSE'),false);assert.equal(JSON.stringify(detail).includes('TEST_SECRET'),false);
  await client.getPlaceDetail({contentId:'101',contentTypeId:'14'});assert.equal(calls.length,2);
});

test('the full introduction preserves text beyond 5000 characters while removing upstream markup',async()=>{
  const overview='원문 소개입니다. '.repeat(600)+'<br>마지막 안내<script>private script</script>';
  const client=createTourClient({serviceKey:'TEST',fetchImpl:async url=>ok([url.pathname.endsWith('detailCommon2')?{...common,overview}:intro])});
  const detail=await client.getPlaceDetail({contentId:'101',contentTypeId:'14'});
  assert.equal(detail.overview,'원문 소개입니다. '.repeat(600)+'\n마지막 안내');
  assert.ok(detail.overview.length>5000);
});

test('partial introduction errors are retryable, empty introductions stay unknown and type-12 hours use their own fields',async()=>{
  let failure=true,calls=0;
  const client=createTourClient({serviceKey:'TEST',fetchImpl:async url=>{
    calls++;if(url.pathname.endsWith('detailCommon2'))return ok([{...common,contenttypeid:'12',firstimage:'javascript:alert(1)',homepage:'javascript:alert(1)'}]);
    if(failure)throw Error('upstream');return ok([{contentid:'101',contenttypeid:'12',usetime:'일출~일몰',restdate:'연중무휴'}]);
  }});
  const partial=await client.getPlaceDetail({contentId:'101',contentTypeId:'12'});assert.equal(partial.partial,true);assert.equal(partial.hours,'');
  failure=false;const retry=await client.getPlaceDetail({contentId:'101',contentTypeId:'12'});assert.equal(calls,4);assert.equal(retry.partial,false);assert.equal(retry.hours,'일출~일몰');assert.equal(retry.imageUrl,'');assert.equal(retry.homepage,'');
  const empty=createTourClient({serviceKey:'TEST',fetchImpl:async url=>ok(url.pathname.endsWith('detailCommon2')?[common]:[])});
  const missing=await empty.getPlaceDetail({contentId:'101',contentTypeId:'14'});assert.equal(missing.partial,false);assert.equal(missing.hours,'');
});

test('invalid or missing detail identities never query arbitrary endpoints or accept mismatched upstream items',async()=>{
  let calls=0;const client=createTourClient({serviceKey:'TEST',fetchImpl:async()=>{calls++;return ok([{...common,contentid:'999'}]);}});
  for(const args of [{contentId:'https://private/',contentTypeId:'12'},{contentId:'0',contentTypeId:'12'},{contentId:'101',contentTypeId:'32'}])await assert.rejects(client.getPlaceDetail(args),error=>error.code==='INVALID_PLACE');
  assert.equal(calls,0);await assert.rejects(client.getPlaceDetail({contentId:'101',contentTypeId:'14'}),error=>error.code==='INVALID_RESPONSE');
  const missing=createTourClient({serviceKey:'TEST',fetchImpl:async()=>ok([])});await assert.rejects(missing.getPlaceDetail({contentId:'101',contentTypeId:'14'}),error=>error.code==='PLACE_NOT_FOUND');
});

test('Node serves the same detail query for GET and HEAD without exposing internal client state',async t=>{
  const calls=[],server=createAppServer({client:{async getPlaceDetail(query){calls.push(query);return {contentId:'101',title:'문화관'};}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}/api/tour/place-detail?contentId=101&contentTypeId=14`;
  const response=await fetch(url);assert.equal(response.status,200);assert.deepEqual(await response.json(),{contentId:'101',title:'문화관'});
  const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  assert.deepEqual(calls,[{contentId:'101',contentTypeId:'14'},{contentId:'101',contentTypeId:'14'}]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createTourClient,normalizeItems,normalizeThemeItems,normalizePlaceDetails} from './tour-client.mjs';
import {createAppServer} from './server.mjs';
import {createPagesWorker} from './cloudflare-worker.mjs';

const key='test-fixture-tour-secret-value';
const response=(items=[],totalCount=items.length)=>new Response(JSON.stringify({response:{header:{resultCode:'0000'},body:{items:{item:items},totalCount}}}),{headers:{'Content-Type':'application/json'}});
const item=(id='101',type='12',overrides={})=>({contentid:id,contenttypeid:type,areacode:'1',title:'공식 관광지',mapx:'126.98',mapy:'37.57',...overrides});
const taxonomy=(overrides={})=>({lclsSystm1Cd:'NA',lclsSystm1Nm:'자연관광',lclsSystm2Cd:'NA01',lclsSystm2Nm:'자연경관',lclsSystm3Cd:'NA010100',lclsSystm3Nm:'산',...overrides});

test('new taxonomy normalization includes only bounded official code/name metadata, with legacy fields unchanged when absent',()=>{
  const legacy=normalizeItems([item()])[0];assert.equal(legacy.classification,undefined);assert.equal(legacy.theme,undefined);
  const normalized=normalizeItems([item('102','12',{lclsSystm1:'NA',lclsSystm2:'NA01',lclsSystm3:'NA010100',private:key,cat1:'untrusted-legacy'})])[0];
  assert.deepEqual(normalized.classification,{code1:'NA',code2:'NA01',code3:'NA010100',name1:'',name2:'',name3:''});assert.equal(JSON.stringify(normalized).includes(key),false);
  assert.equal(normalizeItems([item('103','12',{lclsSystm1:'<script>',lclsSystm2:'x',lclsSystm3:'../../'})])[0].classification,undefined);
  assert.deepEqual(normalizeThemeItems([taxonomy(),taxonomy(),null,taxonomy({lclsSystm1Cd:'bad'}),taxonomy({lclsSystm3Nm:''})]),[{code1:'NA',code2:'NA01',code3:'NA010100',name1:'자연관광',name2:'자연경관',name3:'산'}]);
});
test('only official classification names determine nature/rest, cultural facilities have a confirmed fallback, and titles never classify',async()=>{
  const paths=[];const client=createTourClient({serviceKey:key,fetchImpl:async(url,options)=>{
    paths.push(url.pathname);assert.equal(options.redirect,'manual');assert.equal(url.origin,'https://apis.data.go.kr');
    if(url.pathname.endsWith('/lclsSystmCode2')){assert.equal(url.searchParams.get('lclsSystmListYn'),'Y');return response([taxonomy(),taxonomy({lclsSystm3Cd:'NA010200',lclsSystm3Nm:'자연휴양림'})]);}
    if(url.searchParams.get('contentTypeId')==='14')return response([item('104','14')]);
    return response([item('101','12',{title:'박물관처럼 보이는 이름',lclsSystm1:'NA',lclsSystm2:'NA01',lclsSystm3:'NA010100'}),
      item('102','12',{lclsSystm1:'NA',lclsSystm2:'NA01',lclsSystm3:'NA010200'}),item('103','12',{title:'자연휴양림'})]);
  }});
  const result=await client.getPlaces('1');assert.deepEqual(result.items.map(value=>value.theme),['nature','rest',undefined,'culture']);
  assert.equal(result.items[0].classification.name3,'산');assert.equal(result.items[1].classification.name3,'자연휴양림');assert.equal(result.themeStatus,'available');
  assert.equal(paths.filter(path=>path.endsWith('/lclsSystmCode2')).length,1);await client.getThemes();assert.equal(paths.length,3);assert.equal(JSON.stringify(result).includes(key),false);
});
test('legacy place responses never request taxonomy, and taxonomy failure does not block the tourism catalog',async()=>{
  const paths=[];let classified=false;const client=createTourClient({serviceKey:key,fetchImpl:async url=>{
    paths.push(url.pathname);if(url.pathname.endsWith('/lclsSystmCode2'))return new Response('private upstream detail',{status:503});
    const type=url.searchParams.get('contentTypeId');return response([item(type==='14'?'102':'101',type,classified?{lclsSystm1:'NA',lclsSystm2:'NA01',lclsSystm3:'NA010100'}:{})]);
  }});
  const first=await client.getPlaces('1');assert.equal(paths.length,2);assert.equal(first.items[0].theme,undefined);assert.equal(first.items[1].theme,'culture');
  classified=true;const second=await client.getPlaces('6');assert.equal(second.items.length,2);assert.equal(second.themeStatus,'unavailable');assert.equal(second.items[0].theme,undefined);assert.equal(second.items[0].classification.name1,'');
});
test('taxonomy is shared across regions and fully paginated before mapping official names',async()=>{
  const seen=[];const client=createTourClient({serviceKey:key,fetchImpl:async url=>{
    if(url.pathname.endsWith('/lclsSystmCode2')){seen.push(url.searchParams.get('pageNo'));const page=Number(url.searchParams.get('pageNo'));return response(page===1?Array.from({length:1000},(_,index)=>taxonomy({lclsSystm3Cd:`NA${String(index).padStart(6,'0')}`})):[taxonomy({lclsSystm3Cd:'NA999999',lclsSystm3Nm:'온천'})],1001);}
    const type=url.searchParams.get('contentTypeId');return response([item(type==='14'?'102':'101',type,{lclsSystm1:'NA',lclsSystm2:'NA01',lclsSystm3:'NA999999'})]);
  }});
  const result=await client.getPlaces('1');assert.equal(result.items[0].theme,'rest');await client.getPlaces('6');assert.deepEqual(seen,['1','2']);
});
test('detailIntro2 normalizes each supported content type and returns exact safe metadata without interpreting business rules',async()=>{
  const calls=[];const client=createTourClient({serviceKey:key,now:()=>Date.parse('2026-10-21T00:00:00Z'),fetchImpl:async(url,options)=>{
    calls.push(url);assert.equal(url.pathname,'/B551011/KorService2/detailIntro2');assert.equal(url.searchParams.get('serviceKey'),key);assert.equal(options.redirect,'manual');
    const type=url.searchParams.get('contentTypeId');return response([{contentid:url.searchParams.get('contentId'),contenttypeid:type,usetime:'<b>09:00 ~ 18:00</b><br>계절별 변동 &amp; 사전 확인',restdate:'매주 월요일<script>alert(1)</script>',
      usetimeculture:'10:00&#126;17:00',restdateculture:'매주 화요일',raw:key}]);
  }});
  const attraction=await client.getPlaceDetails({contentId:'101',contentTypeId:'12'});
  assert.deepEqual(attraction,{provider:'한국관광공사 TourAPI',contentId:'101',contentTypeId:'12',fetchedAt:'2026-10-21T00:00:00.000Z',sourceUrl:'https://www.data.go.kr/data/15101578/openapi.do',hoursText:'09:00 ~ 18:00\n계절별 변동 & 사전 확인',closedText:'매주 월요일',status:'available'});
  assert.equal(JSON.stringify(attraction).includes(key),false);const culture=await client.getPlaceDetails({contentId:'101',contentTypeId:'14'});assert.equal(culture.hoursText,'10:00~17:00');assert.equal(culture.closedText,'매주 화요일');assert.equal(calls.length,2);
  assert.equal(normalizePlaceDetails([{contentid:'101',contenttypeid:'12',usetime:'a'.repeat(1400)}],'101','12')[0].hoursText.length,1200);
});
test('empty details remain unknown and never acquire fabricated open hours or holidays',async()=>{
  for(const items of [[],[{contentid:'101',contenttypeid:'12',usetime:'',restdate:''}]]){
    const client=createTourClient({serviceKey:key,fetchImpl:async()=>response(items)});const result=await client.getPlaceDetails({contentId:'101',contentTypeId:'12'});
    assert.equal(result.status,'unknown');assert.equal(result.hoursText,'');assert.equal(result.closedText,'');
  }
});
test('details reject invalid requests before calling upstream and reject mismatched identities or echoed credentials',async()=>{
  let calls=0;const client=createTourClient({serviceKey:key,fetchImpl:async()=>{calls++;return response([]);}});
  for(const input of [{},{contentId:'0',contentTypeId:'12'},{contentId:'1&serviceKey=other',contentTypeId:'12'},{contentId:'../101',contentTypeId:'12'},
    {contentId:'101',contentTypeId:'39'},{contentId:'101',contentTypeId:12},{contentId:'9'.repeat(21),contentTypeId:'12'}])await assert.rejects(client.getPlaceDetails(input),error=>error.status===400&&error.code==='INVALID_PLACE');
  assert.equal(calls,0);
  for(const raw of [{contentid:'102',contenttypeid:'12'},{contentid:'101',contenttypeid:'14'},{contentid:'101',contenttypeid:'12',restdate:key}]){
    const mismatch=createTourClient({serviceKey:key,fetchImpl:async()=>response([raw])});await assert.rejects(mismatch.getPlaceDetails({contentId:'101',contentTypeId:'12'}),error=>error.code==='INVALID_RESPONSE'&&!error.message.includes(key));
  }
});
test('detail requests coalesce, caches expire and remain bounded, with quota pressure rejected before another upstream call',async()=>{
  let time=1000,calls=0;const client=createTourClient({serviceKey:key,now:()=>time,cacheMs:100,maxCacheEntries:2,fetchImpl:async url=>{calls++;return response([{contentid:url.searchParams.get('contentId'),contenttypeid:'12',usetime:'09:00~18:00'}]);}});
  const query=id=>({contentId:id,contentTypeId:'12'});const [a,b]=await Promise.all([client.getPlaceDetails(query('101')),client.getPlaceDetails(query('101'))]);assert.equal(a,b);assert.equal(calls,1);
  await client.getPlaceDetails(query('102'));await client.getPlaceDetails(query('103'));await client.getPlaceDetails(query('101'));assert.equal(calls,4);time+=100;await client.getPlaceDetails(query('101'));assert.equal(calls,5);
  let resolve;const pending=new Promise(yes=>{resolve=yes;});let pendingCalls=0;const busy=createTourClient({serviceKey:key,maxPending:1,fetchImpl:async()=>{pendingCalls++;return pending;}});
  const first=busy.getPlaceDetails(query('101'));await assert.rejects(busy.getPlaceDetails(query('102')),error=>error.code==='RATE_LIMIT');assert.equal(pendingCalls,1);resolve(response([]));await first;
});
test('Node and Worker dispatch only validated detail requests and keep GET/HEAD/error responses uncached',async()=>{
  const calls=[],client=createTourClient({serviceKey:key,fetchImpl:async url=>{calls.push(url.pathname);return response([{contentid:url.searchParams.get('contentId'),contenttypeid:url.searchParams.get('contentTypeId'),usetime:'09:00~18:00'}]);}});
  const worker=createPagesWorker({createClients:()=>({tour:client})});
  const server=createAppServer({client});server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const send of [path=>worker.fetch(new Request(`https://trip.example${path}`)),path=>fetch(`${origin}${path}`)]){
      const result=await send('/api/tour/place-details?contentId=101&contentTypeId=12');assert.equal(result.status,200);assert.equal((await result.json()).hoursText,'09:00~18:00');assert.equal(result.headers.get('Cache-Control'),'no-store');
      const invalid=await send('/api/tour/place-details?contentId=101&contentTypeId=39');assert.equal(invalid.status,400);assert.equal((await invalid.json()).error.code,'INVALID_PLACE');
    }
    const head=await worker.fetch(new Request('https://trip.example/api/tour/place-details?contentId=101&contentTypeId=12',{method:'HEAD'}));assert.equal(head.status,200);assert.equal(await head.text(),'');
    const post=await fetch(`${origin}/api/tour/place-details?contentId=101&contentTypeId=12`,{method:'POST'});assert.equal(post.status,405);
    assert.equal(calls.length,1);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

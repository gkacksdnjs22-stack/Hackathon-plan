import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { normalizePlanDocument, normalizePlanTitle, PlanDocumentError } from './plan-document.mjs';
import { createAccountHandler } from './auth-store.mjs';
import { createLocalDatabase } from './local-db.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const document = () => ({ version:8,itinerary:{ cityId:'seoul',startDate:'2026-10-20',dayCount:1,
  dayAreaIds:['tour-cluster-100'],selections:{0:['tourapi-100','tourapi-101','tourapi-102']} } });

test('budget canonical storage detaches costs, keeps exact won amounts and rejects invalid money and days',()=>{
  const input=document();input.itinerary.budget={limit:100000,items:[{id:'cost-1',dayIndex:0,category:'food',title:' 점심 ',amount:0}]};
  const stored=normalizePlanDocument(input);assert.equal(stored.itinerary.budget.items[0].title,'점심');
  input.itinerary.budget.items[0].amount=5000;assert.equal(stored.itinerary.budget.items[0].amount,0);
  for(const patch of [{amount:-1},{amount:1.5},{amount:'1000'},{amount:1000000001},{dayIndex:1},{category:'PRIVATE'},{title:''},{extra:'field'}]){
    const value=clone(stored);Object.assign(value.itinerary.budget.items[0],patch);assert.throws(()=>normalizePlanDocument(value));
  }
  const duplicate=clone(stored);duplicate.itinerary.budget.items.push({...duplicate.itinerary.budget.items[0]});assert.throws(()=>normalizePlanDocument(duplicate));
  const many=clone(stored);many.itinerary.budget.items=Array.from({length:201},(_,index)=>({...stored.itinerary.budget.items[0],id:`cost-${index}`}));assert.throws(()=>normalizePlanDocument(many));
  for(const limit of [-1,1.1,'100',1000000000001]){const value=clone(stored);value.itinerary.budget.limit=limit;assert.throws(()=>normalizePlanDocument(value));}
});
const error = code => value => value instanceof PlanDocumentError && value.code===code && !value.message.includes('PRIVATE');
const stop = (providerId='FROM') => ({ mode:'train',id:`tago-train-${providerId}`,name:providerId,address:'',latitude:null,longitude:null,
  source:'TAGO',service:'train',providerId,sourceUrl:'https://www.data.go.kr/data/15098552/openapi.do' });
const trip = changes => ({ id:'train-1',service:'train',departureId:'FROM',arrivalId:'TO',departureName:'FROM',arrivalName:'TO',date:'2026-10-20',
  departureMinutes:540,arrivalMinutes:600,durationMinutes:60,tripNo:'KTX1',grade:'일반',source:'TAGO',
  sourceUrl:stop().sourceUrl,fetchedAt:'2026-10-20T00:00:00Z',...changes });

test('plan documents retain only canonical inputs and detach all nested user content', () => {
  const input=document(); Object.assign(input.itinerary,{ok:true,cityName:'서울',dataSource:'tourapi',days:[{routes:[{PRIVATE:'transient route response'}]}],maxDays:1,
    eventEdits:{0:{lunch:{title:'예약 식당',description:'창가 자리'}}},extraEvents:{0:[{id:'extra-1',beforeId:'finish',type:'free',title:'친구 만나기',description:'따로 적은 메모',duration:30}]},
    excludedEvents:{0:['place-0']},eventOrders:{0:['extra-1','lunch']}});
  const saved=normalizePlanDocument(input), text=JSON.stringify(saved);
  for(const forbidden of ['PRIVATE','routes','days','cityName','maxDays','dataSource'])assert.equal(text.includes(`"${forbidden}"`),false);
  input.itinerary.eventEdits[0].lunch.description='외부 변경'; input.itinerary.extraEvents[0][0].title='외부 변경';input.itinerary.selections[0].reverse();
  assert.equal(saved.itinerary.eventEdits[0].lunch.description,'창가 자리');assert.equal(saved.itinerary.extraEvents[0][0].title,'친구 만나기');
  assert.equal(saved.itinerary.selections[0][0],'tourapi-100');
  assert.deepEqual(normalizePlanDocument(saved),saved);
});

test('real planner output with hidden recommendations, a whole-catalog tourist and a pending transfer round-trips', async () => {
  const context=vm.createContext({window:{},location:{protocol:'http:'},AbortSignal,Intl,fetch:async()=>({ok:true,json:async()=>({areaCode:'1',items:
    Array.from({length:5},(_,index)=>({contentId:String(100+index),contentTypeId:'12',areaCode:'1',title:`관광지 ${index}`,address:`서울 여행로 ${index}`,
      latitude:index===4?37.8:37.5+index*0.0001,longitude:index===4?127.5:127+index*0.0001}))})})});
  for(const name of ['places.js','planner.js','tour-data.js'])vm.runInContext(readFileSync(new URL(name,import.meta.url),'utf8'),context);
  const app=context.window,city=await app.TourData.ensureCity('seoul'),planner=app.TravelPlanner;
  let current=planner.createItinerary({city,startDate:'2026-10-20',dayCount:1});
  current=planner.replaceTouristEvent({city,itinerary:current,dayIndex:0,eventId:'place-0',replacementId:'tourapi-104'}).itinerary;
  current=planner.addEvent({city,itinerary:current,dayIndex:0,type:'transfer',travelMode:'local-bus',duration:0}).itinerary;
  current=planner.moveEvent({city,itinerary:current,dayIndex:0,eventId:'place-2',direction:-1}).itinerary;
  for (const eventId of ['transfer-0','transfer-1']) {
    const updated=planner.updateEvent({city,itinerary:current,dayIndex:0,eventId,duration:0});
    assert.equal(updated.ok,true,updated.reason);current=updated.itinerary;
  }
  current=planner.updateEvent({city,itinerary:current,dayIndex:0,eventId:'lunch',title:'점심 식사 · 직접 정한 식당',description:'서울 골목 1\n예약 메모'}).itinerary;
  const extraMeal=planner.addEvent({city,itinerary:current,dayIndex:0,type:'meal',title:'식사 · 저녁 밥집',description:'주소와 메모',duration:50});
  assert.equal(extraMeal.ok,true);current=extraMeal.itinerary;
  const personalized=planner.updatePersonalization({city,itinerary:current,personalization:{checklist:[{id:'item-1',text:'입장권',done:true}],
    favoritePlaceIds:['tourapi-100','tourapi-104'],eventTags:{0:{'place-0':'must',[extraMeal.eventId]:'booked'}}}});
  assert.equal(personalized.ok,true,personalized.reason);current=personalized.itinerary;
  const saved=normalizePlanDocument({version:8,itinerary:clone(current)});
  for (const eventId of ['transfer-0','transfer-1']) assert.equal(saved.itinerary.eventEdits[0][eventId].duration,0);
  const restored=planner.createItinerary({city,...saved.itinerary});
  assert.equal(restored.ok,true,restored.reason);assert.deepEqual(clone(restored.days),clone(current.days));
  assert.deepEqual(clone(restored.personalization),clone(current.personalization));
  assert.equal(restored.days[0].events.find(item=>item.id==='lunch').description,'서울 골목 1\n예약 메모');
  const cleared=planner.updateEvent({city,itinerary:restored,dayIndex:0,eventId:'lunch',resetTitle:true,description:''});
  assert.equal(cleared.ok,true);
  assert.deepEqual(clone(cleared.itinerary.personalization),clone(current.personalization));
  const clearSaved=normalizePlanDocument({version:8,itinerary:clone(cleared.itinerary)});
  assert.equal(planner.createItinerary({city,...clearSaved.itinerary}).days[0].events.find(item=>item.id==='lunch').description,'');
});

test('a real first local transfer mode and manual duration save to the account DB and rebuild unchanged', async t => {
  const context=vm.createContext({window:{},location:{protocol:'http:'},AbortSignal,Intl,fetch:async()=>({ok:true,json:async()=>({areaCode:'1',items:
    Array.from({length:3},(_,index)=>({contentId:String(100+index),contentTypeId:'12',areaCode:'1',title:`관광지 ${index}`,address:`서울 여행로 ${index}`,
      latitude:37.5+index*0.0001,longitude:127+index*0.0001}))})})});
  for(const name of ['places.js','planner.js','tour-data.js'])vm.runInContext(readFileSync(new URL(name,import.meta.url),'utf8'),context);
  const city=await context.window.TourData.ensureCity('seoul'),planner=context.window.TravelPlanner;
  const db=createLocalDatabase();t.after(()=>db.close());
  const handle=createAccountHandler({db,secret:'synthetic-plan-roundtrip-account-secret-2026'}),origin='https://plan.example';
  const send=(path,method='GET',body,cookie)=>handle(new Request(origin+path,{method,headers:{Origin:origin,
    ...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})}));
  const userId=crypto.randomUUID(),token=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const tokenHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('base64url');
  await db.batch([
    db.prepare('INSERT INTO gil_users(id,username,password_salt,password_hash,created_at) VALUES(?,?,?,?,?)').bind(userId,'kakao_first_transfer','unused','social-only-v1',Date.now()),
    db.prepare('INSERT INTO gil_oauth_identities(provider,subject_hash,user_id,created_at) VALUES(?,?,?,?)').bind('kakao','synthetic-first-transfer',userId,Date.now()),
    db.prepare('INSERT INTO gil_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(tokenHash,userId,Date.now()+86400000,Date.now())
  ]);
  const cookie='gil_session='+token;
  for(const [travelMode,duration]of [['walk',12],['local-bus',53],['subway',35],['car',20]]){
    let current=planner.createItinerary({city,startDate:'2026-10-20',dayCount:1,dayDepartures:{0:stop()},dayArrivals:{0:stop('TO')},eventEdits:{0:{departure:{duration:60}}}});
    assert.equal(current.ok,true,current.reason);
    const selected=planner.setTransferMode({city,itinerary:current,dayIndex:0,eventId:'arrival-transfer',mode:travelMode});
    assert.equal(selected.ok,true,selected.reason);current=selected.itinerary;
    const timed=planner.updateEvent({city,itinerary:current,dayIndex:0,eventId:'arrival-transfer',duration});
    assert.equal(timed.ok,true,timed.reason);current=timed.itinerary;
    current=planner.updateBudget({city,itinerary:current,budget:{limit:100000,items:[{id:'cost-trip',dayIndex:0,category:'transport',title:'교통비',amount:35000}]}}).itinerary;
    const saved=normalizePlanDocument({version:8,itinerary:clone(current)});
    assert.deepEqual(saved.itinerary.eventEdits[0]['arrival-transfer'],{travelMode,duration});
    const created=await send('/api/plans','POST',{title:`첫 관광지 ${travelMode}`,document:saved},cookie);
    assert.equal(created.status,201,travelMode);const plan=(await created.json()).plan;
    const loaded=await send(`/api/plans/${plan.id}`,'GET',undefined,cookie);assert.equal(loaded.status,200);
    const stored=(await loaded.json()).plan.document;
    assert.deepEqual(stored.itinerary.eventEdits[0]['arrival-transfer'],{travelMode,duration});
    const rebuilt=planner.createItinerary({city,...stored.itinerary});
    assert.equal(rebuilt.ok,true,rebuilt.reason);assert.deepEqual(clone(rebuilt.days),clone(current.days));
    assert.deepEqual(clone(rebuilt.budget),clone(current.budget));
  }
});

test('arrival-transfer mode still requires its matching arrival and cannot be applied to non-transfer rows', () => {
  const input=document();Object.assign(input.itinerary,{dayDepartures:{0:stop()},dayArrivals:{0:stop('TO')},eventEdits:{0:{'arrival-transfer':{travelMode:'local-bus',duration:53}}}});
  assert.equal(normalizePlanDocument(input).itinerary.eventEdits[0]['arrival-transfer'].travelMode,'local-bus');
  for(const arrival of [undefined,null]){
    const invalid=clone(input);if(arrival===undefined)delete invalid.itinerary.dayArrivals;else invalid.itinerary.dayArrivals[0]=arrival;
    assert.throws(()=>normalizePlanDocument(invalid),error('INVALID_PLAN'));
  }
  for(const travelMode of ['train','flight',null,'PRIVATE']){
    const invalid=clone(input);invalid.itinerary.eventEdits[0]['arrival-transfer'].travelMode=travelMode;
    assert.throws(()=>normalizePlanDocument(invalid),error('INVALID_PLAN'));
  }
  for(const id of ['departure','place-0','lunch','finish']){
    const invalid=clone(input);invalid.itinerary.eventEdits[0]={[id]:{travelMode:'local-bus'}};
    assert.throws(()=>normalizePlanDocument(invalid),error('INVALID_PLAN'));
  }
});

test('personal checklist, favorite ids and event tags round-trip as detached inputs while old documents remain compatible', () => {
  const input=document();
  input.itinerary.personalization={checklist:[{id:'item-1',text:'  여권  ',done:true}],favoritePlaceIds:['tourapi-100','tourapi-999'],eventTags:{0:{'place-0':'must',lunch:'booked'}}};
  const saved=normalizePlanDocument(input);
  assert.deepEqual(saved.itinerary.personalization,{checklist:[{id:'item-1',text:'여권',done:true}],favoritePlaceIds:['tourapi-100','tourapi-999'],eventTags:{0:{'place-0':'must',lunch:'booked'}}});
  assert.deepEqual(normalizePlanDocument(saved),saved);
  input.itinerary.personalization.checklist[0].done=false;input.itinerary.personalization.favoritePlaceIds.pop();input.itinerary.personalization.eventTags[0].lunch='flex';
  assert.equal(saved.itinerary.personalization.checklist[0].done,true);assert.equal(saved.itinerary.personalization.favoritePlaceIds.length,2);
  assert.equal(saved.itinerary.personalization.eventTags[0].lunch,'booked');
  assert.equal(Object.hasOwn(normalizePlanDocument(document()).itinerary,'personalization'),false);
});

test('personal data validation rejects oversized, duplicate, malformed or arbitrary fields and unknown tag targets', () => {
  const valid={checklist:[{id:'item-1',text:'충전기',done:false}],favoritePlaceIds:['tourapi-100'],eventTags:{0:{lunch:'booked'}}};
  const invalid=[null,[],{...valid,privateProviderData:{}},{...valid,checklist:null},
    {...valid,checklist:Array.from({length:101},(_,i)=>({id:`item-${i+1}`,text:'준비물',done:false}))},
    {...valid,checklist:[valid.checklist[0],valid.checklist[0]]},
    ...[{id:'item-1',text:' ',done:false},{id:'item-1',text:'x'.repeat(121),done:false},{id:'item-1',text:'줄\n바꿈',done:false},
      {id:'item-1',text:'충전기',done:'true'},{id:'item-1',text:'충전기',done:false,address:'PRIVATE'}].map(item=>({...valid,checklist:[item]})),
    {...valid,favoritePlaceIds:['tourapi-100','tourapi-100']},{...valid,favoritePlaceIds:[{id:'tourapi-100',name:'PRIVATE'}]},
    {...valid,favoritePlaceIds:Array.from({length:101},(_,i)=>`tourapi-${i}`)},
    {...valid,eventTags:{1:{lunch:'must'}}},{...valid,eventTags:{0:{lunch:'#fff'}}},{...valid,eventTags:{0:{'extra-1':'must'}}}];
  for(const personal of invalid){const input=document();input.itinerary.personalization=personal;assert.throws(()=>normalizePlanDocument(input),error('INVALID_PLAN'));}
});

test('unknown top-level and nested API fields are rejected rather than stored', () => {
  const cases=[{...document(),PRIVATE:'secret'}, {...document(),version:9}];
  for(const field of ['routes','steps','apiKey','response','userId'])cases.push({version:8,itinerary:{...document().itinerary,[field]:'PRIVATE'}});
  cases.push({version:8,itinerary:{...document().itinerary,eventEdits:{0:{lunch:{routes:[]}}}}});
  cases.push({version:8,itinerary:{...document().itinerary,extraEvents:{0:[{id:'extra-1',type:'place',placeId:'tourapi-200',duration:60,place:{raw:'PRIVATE'}}]}}});
  for(const value of cases)assert.throws(()=>normalizePlanDocument(value),error('INVALID_PLAN'));
});

test('dates, source identities, day maps, duplicates and protected rows are validated', () => {
  for(const patch of [{startDate:'2026-02-30'},{dayCount:8},{dayStarts:null},{dayStarts:{1:'09:00'}},{dayStarts:{0:'25:10'}},
    {selections:{0:['tourapi-100','tourapi-100','tourapi-102']}},{dayAreaIds:['../PRIVATE']},
    {eventEdits:{0:{arrival:{duration:0}}}},{eventEdits:{0:{'place-0':{duration:0}}}},
    {excludedEvents:{0:['departure']}},{eventOrders:{0:['finish']}},
    {extraEvents:{0:[{id:'extra-1',type:'place',placeId:'tourapi-100',duration:60}]}},
    {extraEvents:{0:[{id:'extra-1',type:'free',beforeId:'arrival-transfer',duration:30}]}},
    {dayDepartures:{0:{mode:'car',id:'osm-node-1',name:'출발',address:'서울',latitude:37.5,longitude:127,source:'OpenStreetMap',sourceUrl:'https://example.invalid'}}},
    {dayDepartures:{0:{...stop(),latitude:37.5}}}])assert.throws(()=>normalizePlanDocument({version:8,itinerary:{...document().itinerary,...patch}}),error('INVALID_PLAN'));
  assert.equal(normalizePlanTitle('  제주 여행  '),'제주 여행');
  for(const value of ['',null,'가'.repeat(81),'PRIVATE\n제목'])assert.throws(()=>normalizePlanTitle(value),error('INVALID_TITLE'));
});

test('hidden recommendations still require distinct daily slots while their unused place can remain in extras', () => {
  for(const ids of [['tourapi-100','tourapi-100','tourapi-102'],['tourapi-100','tourapi-101','tourapi-100']]) {
    for(const hidden of [[],['place-0'],['place-1'],['place-0','place-1'],['place-0','place-2']]) {
      const input=document();input.itinerary.selections[0]=ids;input.itinerary.excludedEvents={0:hidden};
      assert.throws(()=>normalizePlanDocument(input),error('INVALID_PLAN'),JSON.stringify({ids,hidden}));
    }
  }
  const valid=document();valid.itinerary.excludedEvents={0:['place-0']};
  valid.itinerary.extraEvents={0:[{id:'extra-1',type:'place',placeId:'tourapi-100',duration:60}]};
  const stored=normalizePlanDocument(valid);
  assert.deepEqual(stored.itinerary.selections[0],valid.itinerary.selections[0]);
  assert.equal(stored.itinerary.extraEvents[0][0].placeId,'tourapi-100');
  assert.deepEqual(normalizePlanDocument(stored),stored);
});

test('malformed excluded rows consistently produce plan validation errors before checking selected places', () => {
  for(const value of [{},1,true,null,'place-0',['departure'],['place-0','place-0']]) {
    const input=document();input.itinerary.excludedEvents={0:value};
    assert.throws(()=>normalizePlanDocument(input),error('INVALID_PLAN'));
  }
  for(const value of [null,[],1,true]) {
    const input=document();input.itinerary.excludedEvents=value;
    assert.throws(()=>normalizePlanDocument(input),error('INVALID_PLAN'));
  }
  const valid=document();valid.itinerary.excludedEvents={0:['place-0','lunch']};
  assert.deepEqual(normalizePlanDocument(valid).itinerary.excludedEvents,valid.itinerary.excludedEvents);
});

test('only selected official transport summaries and validated connections survive with matching clocks', () => {
  const input=document();Object.assign(input.itinerary,{dayDepartures:{0:stop()},dayArrivals:{0:stop('TO')},dayStarts:{0:'09:00'},eventEdits:{0:{departure:{duration:60}}},dayTransports:{0:trip()}});
  assert.equal(normalizePlanDocument(input).itinerary.dayTransports[0].tripNo,'KTX1');
  for(const patch of [{durationMinutes:61},{departureId:'OTHER'},{sourceUrl:'https://PRIVATE.invalid'},{routes:[]},{date:'2026-10-21'}]){
    const invalid=clone(input);Object.assign(invalid.itinerary.dayTransports[0],patch);assert.throws(()=>normalizePlanDocument(invalid),error('INVALID_PLAN'));
  }
  const first=trip({id:'first',arrivalId:'VIA',arrivalName:'VIA'}),second=trip({id:'second',departureId:'VIA',departureName:'VIA',departureMinutes:630,arrivalMinutes:750,durationMinutes:120,tripNo:'KTX2'});
  const aggregate=trip({id:'connection-first-second',arrivalMinutes:750,durationMinutes:210,tripNo:'KTX1 → KTX2',connection:{via:stop('VIA'),legs:[first,second],minimumTransferMinutes:15}});
  input.itinerary.dayTransports[0]=aggregate;input.itinerary.eventEdits[0].departure.duration=210;
  assert.equal(normalizePlanDocument(input).itinerary.dayTransports[0].connection.legs.length,2);
  const bad=clone(input);bad.itinerary.dayTransports[0].connection.minimumTransferMinutes=31;
  assert.throws(()=>normalizePlanDocument(bad),error('INVALID_PLAN'));
});

test('canonical UTF-8 document size is bounded even when all individual notes are within their limits', () => {
  const input=document();input.itinerary.dayCount=7;input.itinerary.dayAreaIds=Array.from({length:7},(_,index)=>`tour-cluster-${index}`);
  input.itinerary.selections={};input.itinerary.extraEvents={};input.itinerary.eventEdits={};
  for(let index=0;index<7;index++){
    input.itinerary.selections[index]=Array.from({length:3},(_,offset)=>`tourapi-${index*3+offset+100}`);
    input.itinerary.extraEvents[index]=Array.from({length:20},(_,offset)=>({id:`extra-${offset+1}`,type:'free',title:'자유',description:'가'.repeat(500),duration:1}));
    input.itinerary.eventEdits[index]=Object.fromEntries(['departure','place-0','transfer-0','free-0','lunch','place-1','rest','transfer-1','place-2','dinner','free-1','finish']
      .map(id=>[id,{description:'나'.repeat(500)}]));
  }
  assert.throws(()=>normalizePlanDocument(input),error('PAYLOAD_TOO_LARGE'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { normalizePlanDocument, normalizePlanTitle, PlanDocumentError } from './plan-document.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const document = () => ({ version:8,itinerary:{ cityId:'seoul',startDate:'2026-10-20',dayCount:1,
  dayAreaIds:['tour-cluster-100'],selections:{0:['tourapi-100','tourapi-101','tourapi-102']} } });
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

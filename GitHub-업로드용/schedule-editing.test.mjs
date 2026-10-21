import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizePlanDocument } from './plan-document.mjs';

const source = readFileSync(new URL('./planner.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function runtime() {
  const area = (id, offset = 0) => ({ id, name: id === 'area-one' ? '첫 권역' : '둘째 권역', places: [0, 1, 2, 3, 4, 5].map((index) => ({
    id: `tourapi-${100 + offset + index}`, contentId: String(100 + offset + index), name: `관광지 ${offset + index}`,
    areaId: id, area: id === 'area-one' ? '첫 권역' : '둘째 권역', areaName: id === 'area-one' ? '첫 권역' : '둘째 권역',
    stayMinutes: 60, latitude: 37.55, longitude: 126.9 + [0, 0.03, 0.01, 0.02, 0.04, 0.05][index],
    address: `서울 주소 ${offset + index}`, intro: `공식 소개 ${offset + index}`, contentTypeId: '12', source: '한국관광공사 TourAPI'
  })) });
  const city = { id: 'seoul', country: 'KR', name: '서울', supportedDays: 2, areas: [area('area-one'), area('area-two', 10)] };
  const window = { TRAVEL_DATA: { countries: { KR: '대한민국' }, cities: { seoul: city } } };
  const context = vm.createContext({ window, Intl, Map }); vm.runInContext(source, context);
  const planner = window.TravelPlanner;
  const create = options => planner.createItinerary({ city, startDate: '2026-10-21', dayCount: 1,
    selections: { 0: city.areas[0].places.slice(0, 3).map(place => place.id) }, ...options });
  return { city, planner, create };
}

test('insertion before an added row preserves exact order, memos and existing tags',()=>{
 const {city,planner,create}=runtime();let note=create();
 let r=planner.addEvent({city,itinerary:note,dayIndex:0,type:'rest',title:'예약 전 휴식',description:'내 메모',duration:20,beforeId:'place-1'});assert.equal(r.ok,true,r.reason);note=r.itinerary;const first=r.eventId;
 r=planner.addEvent({city,itinerary:note,dayIndex:0,type:'meal',title:'먼저 식사',duration:40,beforeId:first});assert.equal(r.ok,true,r.reason);
 const ids=r.itinerary.days[0].events.map(e=>e.id);assert.equal(ids.indexOf(r.eventId)+1,ids.indexOf(first));assert.equal(ids.indexOf(first)+1,ids.indexOf('place-1'));
 assert.equal(r.itinerary.days[0].events.find(e=>e.id===first).description,'내 메모');
});

test('same-day reordering preserves memo, stay and booked tag after account normalization',()=>{
 const {city,planner,create}=runtime();let note=create({dayCount:2});
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'place-1',description:'예약번호 ABC',duration:95}).itinerary;
 note=planner.updatePersonalization({city,itinerary:note,personalization:{checklist:[],favoritePlaceIds:[],eventTags:{0:{'place-1':'booked'}}}}).itinerary;
 const moved=planner.moveEvent({city,itinerary:note,dayIndex:0,eventId:'place-1',direction:1});assert.equal(moved.ok,true,moved.reason);
 const next=moved.itinerary,event=next.days[0].events.find(e=>e.id==='place-1');
 assert.equal(event.description,'예약번호 ABC');assert.equal(event.duration,95);assert.equal(next.personalization.eventTags[0]['place-1'],'booked');
 const document=normalizePlanDocument({version:8,itinerary:plain(next)});const restored=planner.createItinerary({city,...document.itinerary});assert.equal(restored.ok,true,restored.reason);assert.deepEqual(plain(restored.days),plain(next.days));
 assert.equal(planner.moveEventToDay,undefined);
});

test('duration edits linearly recalculate later rows while keeping booked tags, notes and all entries',()=>{
 const {city,planner,create}=runtime();let note=create();
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'place-1',description:'예약번호 ABC',duration:95}).itinerary;
 note=planner.updatePersonalization({city,itinerary:note,personalization:{checklist:[],favoritePlaceIds:[],eventTags:{0:{'place-1':'booked'}}}}).itinerary;
 const before=note.days[0].events.find(e=>e.id==='place-1').start,count=note.days[0].events.length;
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'place-0',duration:400}).itinerary;
 const event=note.days[0].events.find(e=>e.id==='place-1'),after=note.days[0].events.find(e=>e.id==='rest');
 assert.equal(event.start,before+340);assert.equal(after.start,event.end);assert.equal(event.description,'예약번호 ABC');assert.equal(note.personalization.eventTags[0]['place-1'],'booked');assert.equal(note.days[0].events.length,count);
 const restored=planner.createItinerary({city,...normalizePlanDocument({version:8,itinerary:plain(note)}).itinerary});assert.equal(restored.ok,true,restored.reason);assert.deepEqual(plain(restored.days),plain(note.days));
 const travel=planner.updateEvent({city,itinerary:restored,dayIndex:0,eventId:'transfer-0',duration:25});assert.equal(travel.ok,true,travel.reason);assert.equal(travel.itinerary.days[0].events.find(e=>e.id==='place-1').start,event.start+25);
});

const restaurant={id:'tour-food-90',name:'실제 데이터 식당',address:'서울 주소',latitude:37.56,longitude:126.92,kind:'meal'};
test('meal locations change route endpoints, invalidate affected manual times and survive canonical save',()=>{
 const {city,planner,create}=runtime();let note=create({dayCount:2,eventEdits:{0:{'transfer-0':{duration:25},'transfer-1':{duration:35}}}});
 const before=planner.localTravelLegs(note.days[0]).get('transfer-0');
 const changed=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'lunch',location:restaurant});assert.equal(changed.ok,true,changed.reason);note=changed.itinerary;
 assert.notEqual(planner.localTravelLegs(note.days[0]).get('transfer-0'),before);assert.equal(note.days[0].events.find(e=>e.id==='transfer-0').duration,0);assert.equal(note.days[0].events.find(e=>e.id==='transfer-1').duration,35);
 const saved=normalizePlanDocument({version:8,itinerary:plain(note)});assert.deepEqual(saved.itinerary.eventEdits[0].lunch.location,restaurant);
 for(const bad of [{...restaurant,latitude:0},{...restaurant,longitude:999},{...restaurant,name:''}]){
 assert.equal(planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'lunch',location:bad}).ok,false);
 const doc={version:8,itinerary:plain(note)};doc.itinerary.eventEdits[0].lunch.location=bad;assert.throws(()=>normalizePlanDocument(doc));
 }
});

test('a missing leg after a chosen restaurant keeps the timetable provisional even when other travel times are known',()=>{
 const {city,planner,create}=runtime();const departure={mode:'walk',id:'osm-node-1',name:'출발',address:'서울',latitude:37.55,longitude:126.9,source:'OpenStreetMap',sourceUrl:'https://www.openstreetmap.org/node/1'};
 let note=create({departure,eventEdits:{0:{departure:{duration:10},'transfer-0':{duration:10},'transfer-1':{duration:10}}}});
 assert.equal(note.days[0].timesProvisional,false);
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'lunch',location:restaurant}).itinerary;
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'transfer-0',duration:10}).itinerary;
 const nextVisit=note.days[0].events.find(e=>e.id==='place-1');assert.equal(nextVisit.routePending,true);assert.equal(note.days[0].timesProvisional,true);
});

test('renaming an unlocated restaurant resets both adjacent legs but memo and meal-label changes retain them',()=>{
 const {city,planner,create}=runtime();let note=create();
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'lunch',title:'점심 식사 · 식당 A',description:'기존 메모',location:null}).itinerary;
 const added=planner.addEvent({city,itinerary:note,dayIndex:0,type:'transfer',beforeId:'place-1',duration:35});assert.equal(added.ok,true,added.reason);note=added.itinerary;
 for(const [eventId,duration]of [['transfer-0',25],['transfer-1',40]])note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId,duration}).itinerary;
 const duration=(value,id)=>value.days[0].events.find(event=>event.id===id).duration;
 const same=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'lunch',title:'저녁 식사 · 식당 A',description:'메모만 수정',duration:70});assert.equal(same.ok,true,same.reason);
 assert.equal(duration(same.itinerary,'transfer-0'),25);assert.equal(duration(same.itinerary,added.eventId),35);
 const changed=planner.updateEvent({city,itinerary:same.itinerary,dayIndex:0,eventId:'lunch',title:'저녁 식사 · 식당 B',location:null});assert.equal(changed.ok,true,changed.reason);
 assert.equal(duration(changed.itinerary,'transfer-0'),0);assert.equal(duration(changed.itinerary,added.eventId),0);assert.equal(duration(changed.itinerary,'transfer-1'),40);
 assert.equal(changed.itinerary.days[0].events.find(event=>event.id==='lunch').location,null);
 const restored=planner.createItinerary({city,...normalizePlanDocument({version:8,itinerary:plain(changed.itinerary)}).itinerary});assert.equal(restored.ok,true,restored.reason);assert.deepEqual(plain(restored.days),plain(changed.itinerary.days));
});

test('an unlocated first meal invalidates departure and extra-transfer times when renamed',()=>{
 const {city,planner,create}=runtime();
 const departure={mode:'walk',id:'osm-node-1',name:'출발',address:'서울',latitude:37.55,longitude:126.9,source:'OpenStreetMap',sourceUrl:'https://www.openstreetmap.org/node/1'};
 let note=create({departure});
 const meal=planner.addEvent({city,itinerary:note,dayIndex:0,type:'meal',title:'식사 · 식당 A',beforeId:'place-0',duration:60});assert.equal(meal.ok,true,meal.reason);note=meal.itinerary;
 const leg=planner.addEvent({city,itinerary:note,dayIndex:0,type:'transfer',beforeId:'place-0',duration:35});assert.equal(leg.ok,true,leg.reason);note=leg.itinerary;
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'departure',duration:25}).itinerary;
 const changed=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:meal.eventId,title:'식사 · 식당 B'});assert.equal(changed.ok,true,changed.reason);
 assert.equal(changed.itinerary.days[0].events.find(event=>event.id==='departure').duration,0);assert.equal(changed.itinerary.days[0].events.find(event=>event.id===leg.eventId).duration,0);
 assert.equal(planner.visitIdentity(null),null);assert.equal(planner.visitIdentity(undefined),null);
});

test('renaming an unlocated restaurant clears hidden travel times before the leg is restored',()=>{
 const {city,planner,create}=runtime();let note=create();
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'lunch',title:'점심 식사 · 식당 A',location:null}).itinerary;
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'transfer-0',duration:25,description:'보존할 이동 메모'}).itinerary;
 const hidden=planner.removeEvent({city,itinerary:note,dayIndex:0,eventId:'transfer-0'});assert.equal(hidden.ok,true,hidden.reason);
 const changed=planner.updateEvent({city,itinerary:hidden.itinerary,dayIndex:0,eventId:'lunch',title:'점심 식사 · 식당 B'});assert.equal(changed.ok,true,changed.reason);
 const restored=planner.restoreEvent({city,itinerary:changed.itinerary,dayIndex:0,eventId:'transfer-0'});assert.equal(restored.ok,true,restored.reason);
 const event=restored.itinerary.days[0].events.find(event=>event.id==='transfer-0');assert.equal(event.duration,0);assert.equal(event.description,'보존할 이동 메모');
});

const restaurantReference={id:'culture-aaaaaaaaaaaaaaaaaaaaaaaa',name:'같은 상호 식당',address:'서울 첫 번째 주소'};
const eventDuration=(note,id)=>note.days[0].events.find(event=>event.id===id).duration;
function withRestaurantReference(planner,city,note,eventId='lunch',reference=restaurantReference){
 const result=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId,title:`식사 · ${reference.name}`,location:null,restaurantRef:reference});
 assert.equal(result.ok,true,result.reason);return result.itinerary;
}

test('coordinate-free restaurants with the same name retain their provider identity and reset only changed journeys',()=>{
 const {city,planner,create}=runtime();let note=withRestaurantReference(planner,city,create());
 const outgoing=planner.addEvent({city,itinerary:note,dayIndex:0,type:'transfer',beforeId:'place-1',duration:35});assert.equal(outgoing.ok,true,outgoing.reason);note=outgoing.itinerary;
 for(const [eventId,duration]of [['transfer-0',25],['transfer-1',40]])note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId,duration}).itinerary;
 const same=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'lunch',title:`저녁 식사 · ${restaurantReference.name}`,description:'메모만 변경',duration:70});assert.equal(same.ok,true,same.reason);
 assert.deepEqual(plain(same.itinerary.eventEdits[0].lunch.restaurantRef),restaurantReference);
 assert.equal(eventDuration(same.itinerary,'transfer-0'),25);assert.equal(eventDuration(same.itinerary,outgoing.eventId),35);
 for(const reference of [{...restaurantReference,id:'culture-bbbbbbbbbbbbbbbbbbbbbbbb'},
  {...restaurantReference,address:'서울 두 번째 주소'},
  {...restaurantReference,id:'culture-bbbbbbbbbbbbbbbbbbbbbbbb',address:'서울 두 번째 주소'}]){
  const changed=planner.updateEvent({city,itinerary:same.itinerary,dayIndex:0,eventId:'lunch',title:`저녁 식사 · ${reference.name}`,location:null,restaurantRef:reference});assert.equal(changed.ok,true,changed.reason);
  assert.equal(eventDuration(changed.itinerary,'transfer-0'),0);assert.equal(eventDuration(changed.itinerary,outgoing.eventId),0);assert.equal(eventDuration(changed.itinerary,'transfer-1'),40);
  assert.equal(changed.itinerary.days[0].events.find(event=>event.id==='lunch').location,null);
  const canonical=normalizePlanDocument({version:8,itinerary:plain(changed.itinerary)});
  assert.deepEqual(canonical.itinerary.eventEdits[0].lunch.restaurantRef,reference);
  const restored=planner.createItinerary({city,...canonical.itinerary});assert.equal(restored.ok,true,restored.reason);assert.deepEqual(plain(restored.days),plain(changed.itinerary.days));
 }
});

test('restaurant identity changes invalidate first-meal departure times, extra legs and hidden journeys',()=>{
 const {city,planner,create}=runtime();
 const departure={mode:'walk',id:'osm-node-1',name:'출발',address:'서울',latitude:37.55,longitude:126.9,source:'OpenStreetMap',sourceUrl:'https://www.openstreetmap.org/node/1'};
 const firstMeal=planner.addEvent({city,itinerary:create({departure}),dayIndex:0,type:'meal',title:'식사',beforeId:'place-0',duration:60});assert.equal(firstMeal.ok,true,firstMeal.reason);
 let note=withRestaurantReference(planner,city,firstMeal.itinerary,firstMeal.eventId);
 const outgoing=planner.addEvent({city,itinerary:note,dayIndex:0,type:'transfer',beforeId:'place-0',duration:35});assert.equal(outgoing.ok,true,outgoing.reason);note=outgoing.itinerary;
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'departure',duration:25}).itinerary;
 const different={...restaurantReference,id:'culture-bbbbbbbbbbbbbbbbbbbbbbbb'};
 const changed=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:firstMeal.eventId,restaurantRef:different});assert.equal(changed.ok,true,changed.reason);
 assert.equal(eventDuration(changed.itinerary,'departure'),0);assert.equal(eventDuration(changed.itinerary,outgoing.eventId),0);
 const saved=normalizePlanDocument({version:8,itinerary:plain(changed.itinerary)});
 assert.deepEqual(saved.itinerary.extraEvents[0].find(event=>event.id===firstMeal.eventId).restaurantRef,different);
 const reloaded=planner.createItinerary({city,...saved.itinerary});assert.equal(reloaded.ok,true,reloaded.reason);assert.deepEqual(plain(reloaded.days),plain(changed.itinerary.days));
 let hidden=withRestaurantReference(planner,city,create());
 hidden=planner.updateEvent({city,itinerary:hidden,dayIndex:0,eventId:'transfer-0',duration:25,description:'유지할 이동 메모'}).itinerary;
 hidden=planner.removeEvent({city,itinerary:hidden,dayIndex:0,eventId:'transfer-0'}).itinerary;
 hidden=planner.updateEvent({city,itinerary:hidden,dayIndex:0,eventId:'lunch',restaurantRef:{...restaurantReference,address:'다른 주소'}}).itinerary;
 const restored=planner.restoreEvent({city,itinerary:hidden,dayIndex:0,eventId:'transfer-0'});assert.equal(restored.ok,true,restored.reason);
 const travel=restored.itinerary.days[0].events.find(event=>event.id==='transfer-0');assert.equal(travel.duration,0);assert.equal(travel.description,'유지할 이동 메모');
});

test('generic meal renames clear a selected restaurant reference while memo, duration and explicit selections retain it',()=>{
 const {city,planner,create}=runtime();let note=withRestaurantReference(planner,city,create());
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'transfer-0',duration:25}).itinerary;
 const same=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'lunch',title:`저녁 식사 · ${restaurantReference.name}`,description:'다른 메모',duration:70});assert.equal(same.ok,true,same.reason);
 assert.deepEqual(plain(same.itinerary.eventEdits[0].lunch.restaurantRef),restaurantReference);assert.equal(eventDuration(same.itinerary,'transfer-0'),25);
 for(const edit of [{title:'식사 · 직접 정한 다른 식당'},{resetTitle:true},{restaurantRef:null}]){
  const cleared=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'lunch',...edit});assert.equal(cleared.ok,true,cleared.reason);
  assert.equal(cleared.itinerary.eventEdits[0].lunch.restaurantRef,null);assert.equal(eventDuration(cleared.itinerary,'transfer-0'),0);
 }
 const different={...restaurantReference,id:'tour-food-91',name:'선택한 새 식당'};
 const explicit=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'lunch',title:`식사 · ${different.name}`,restaurantRef:different});assert.equal(explicit.ok,true,explicit.reason);
 assert.deepEqual(plain(explicit.itinerary.eventEdits[0].lunch.restaurantRef),different);
 const added=planner.addEvent({city,itinerary:create(),dayIndex:0,type:'meal',duration:60});assert.equal(added.ok,true,added.reason);
 const extra=withRestaurantReference(planner,city,added.itinerary,added.eventId);
 const renamed=planner.updateEvent({city,itinerary:extra,dayIndex:0,eventId:added.eventId,title:'새 직접 입력 식당'});assert.equal(renamed.ok,true,renamed.reason);
 assert.equal(renamed.itinerary.extraEvents[0].find(event=>event.id===added.eventId).restaurantRef,null);
 const located=planner.updateEvent({city,itinerary:create(),dayIndex:0,eventId:'lunch',location:restaurant});assert.equal(located.ok,true,located.reason);
 assert.equal(Object.hasOwn(located.itinerary.eventEdits[0].lunch,'restaurantRef'),false);
});

test('restaurant references validate exact bounded fields and are accepted only on meal rows',()=>{
 const {city,planner,create}=runtime();const note=create();
 const invalid=[{},[],{id:'id',name:'이름'},{...restaurantReference,id:''},{...restaurantReference,name:' '},
  {...restaurantReference,id:'a'.repeat(161)},{...restaurantReference,name:'a'.repeat(161)},{...restaurantReference,address:'a'.repeat(501)},
  {...restaurantReference,address:null},{...restaurantReference,latitude:37.5},{...restaurantReference,id:'a\0b'}];
 for(const restaurantRef of invalid){
  assert.equal(planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'lunch',restaurantRef}).ok,false);
  assert.equal(create({eventEdits:{0:{lunch:{restaurantRef}}}}).ok,false);
 }
 for(const eventId of ['place-0','rest','free-0','transfer-0','departure'])assert.equal(planner.updateEvent({city,itinerary:note,dayIndex:0,eventId,restaurantRef:null}).ok,false,eventId);
 const nonMeal=planner.addEvent({city,itinerary:note,dayIndex:0,type:'rest',duration:30});assert.equal(nonMeal.ok,true,nonMeal.reason);
 assert.equal(planner.updateEvent({city,itinerary:nonMeal.itinerary,dayIndex:0,eventId:nonMeal.eventId,restaurantRef:restaurantReference}).ok,false);
 const dinner=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'dinner',restaurantRef:{id:'  tour-food-90 ',name:' 같은 식당 ',address:''}});assert.equal(dinner.ok,true,dinner.reason);
 const event=dinner.itinerary.days[0].events.find(event=>event.id==='dinner');assert.equal(planner.visitEvent(event),true);
 assert.deepEqual(plain(event.restaurantRef),{id:'tour-food-90',name:'같은 식당',address:''});
 assert.deepEqual(plain(planner.visitIdentity(event)),['restaurant','tour-food-90','같은 식당','',null,null]);
});

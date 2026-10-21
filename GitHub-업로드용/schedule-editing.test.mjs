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

test('same-day reordering preserves memo, stay, tag and fixed time after account normalization',()=>{
 const {city,planner,create}=runtime();let note=create({dayCount:2});
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'place-1',description:'예약번호 ABC',duration:95,fixedStart:'14:00'}).itinerary;
 note=planner.updatePersonalization({city,itinerary:note,personalization:{checklist:[],favoritePlaceIds:[],eventTags:{0:{'place-1':'booked'}}}}).itinerary;
 const moved=planner.moveEvent({city,itinerary:note,dayIndex:0,eventId:'place-1',direction:1});assert.equal(moved.ok,true,moved.reason);
 const next=moved.itinerary,event=next.days[0].events.find(e=>e.id==='place-1');
 assert.equal(event.description,'예약번호 ABC');assert.equal(event.duration,95);assert.equal(event.fixedStart,'14:00');assert.equal(next.personalization.eventTags[0]['place-1'],'booked');
 const document=normalizePlanDocument({version:8,itinerary:plain(next)});const restored=planner.createItinerary({city,...document.itinerary});assert.equal(restored.ok,true,restored.reason);assert.deepEqual(plain(restored.days),plain(next.days));
 assert.equal(planner.moveEventToDay,undefined);
});

test('fixed reservations keep their displayed time, propagate lateness and retain uncertainty without removing other rows',()=>{
 const {city,planner,create}=runtime();let note=create();
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'place-1',fixedStart:'14:00'}).itinerary;
 const count=note.days[0].events.length;
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'place-0',duration:400}).itinerary;
 const event=note.days[0].events.find(e=>e.id==='place-1'),after=note.days[0].events.find(e=>e.id==='rest');
 assert.equal(event.start,840);assert.equal(event.arrivalUncertain,true);assert.ok(event.lateMinutes>0);assert.equal(event.lateMinutes,event.plannedArrival-840);assert.equal(after.start,event.plannedArrival+event.duration);assert.equal(note.days[0].events.length,count);
 const restored=planner.createItinerary({city,...normalizePlanDocument({version:8,itinerary:plain(note)}).itinerary});assert.equal(restored.ok,true,restored.reason);assert.equal(restored.days[0].events.find(e=>e.id==='place-1').lateMinutes,event.lateMinutes);
 const unfixed=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'place-1',fixedStart:null});assert.equal(unfixed.ok,true);assert.equal(unfixed.itinerary.days[0].events.find(e=>e.id==='place-1').start,event.plannedArrival);
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

test('a missing leg after a chosen restaurant keeps reservation arrival unconfirmed even when other travel times are known',()=>{
 const {city,planner,create}=runtime();const departure={mode:'walk',id:'osm-node-1',name:'출발',address:'서울',latitude:37.55,longitude:126.9,source:'OpenStreetMap',sourceUrl:'https://www.openstreetmap.org/node/1'};
 let note=create({departure,eventEdits:{0:{departure:{duration:10},'transfer-0':{duration:10},'transfer-1':{duration:10},'place-1':{fixedStart:'14:00'}}}});
 assert.equal(note.days[0].events.find(e=>e.id==='place-1').arrivalUncertain,false);
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'lunch',location:restaurant}).itinerary;
 note=planner.updateEvent({city,itinerary:note,dayIndex:0,eventId:'transfer-0',duration:10}).itinerary;
 const booked=note.days[0].events.find(e=>e.id==='place-1');assert.equal(booked.routePending,true);assert.equal(booked.arrivalUncertain,true);assert.equal(note.days[0].timesProvisional,true);
});

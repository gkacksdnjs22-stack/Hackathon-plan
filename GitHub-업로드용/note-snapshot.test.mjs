import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {validateShareSnapshot} from './share-snapshot.mjs';
const window={};vm.runInNewContext(readFileSync(new URL('note-snapshot.js',import.meta.url),'utf8'),{window});
const itinerary={ok:true,cityName:'서울',startDate:'2026-10-21',dayCount:1,ownerId:'never-public',providerResult:{access_token:'never-public'},days:[{
  timesProvisional:true,events:[
    {type:'departure',title:'집에서 출발',departure:{name:'비공개 집',address:'비공개 상세주소'},description:'비공개 출발 메모',start:540,end:600},
    {type:'place',place:{name:'공개 관광지',address:'서울 관광지',intro:'소개'},description:'개인 예약번호',start:600,end:660},
    {type:'arrival',title:'비공개 도착지 도착',arrival:{address:'비공개 도착 주소'},description:'비공개 도착 메모',start:660,end:660}
  ]}]};
const make=options=>JSON.parse(JSON.stringify(window.TravelNoteSnapshot.create(itinerary,{title:'나의 여행',...options})));
test('share snapshot defaults exclude private notes and departure data and never serialize owner or raw API fields',()=>{
  const value=make();validateShareSnapshot(value);
  assert.doesNotMatch(JSON.stringify(value),/비공개|개인 예약번호|never-public|access_token|ownerId/);
  assert.equal(value.days[0].events[0].title,'출발');assert.equal(value.days[0].events[1].address,'서울 관광지');
  assert.equal(value.days[0].provisional,true);assert.equal(value.days[0].date,'2026-10-21');
});
test('memo inclusion does not silently include private departure data; departure opt-in alone does not include notes',()=>{
  const memos=make({includeMemos:true});assert.equal(memos.days[0].events[1].memo,'개인 예약번호');assert.doesNotMatch(JSON.stringify(memos),/비공개/);
  const origin=make({includeDeparture:true});assert.match(JSON.stringify(origin),/비공개 상세주소/);assert.doesNotMatch(JSON.stringify(origin),/비공개 출발 메모|개인 예약번호/);
  const both=make({includeMemos:true,includeDeparture:true});assert.equal(both.days[0].events[0].memo,'비공개 출발 메모');
});
test('snapshot is an independent fixed copy and keeps canonical minutes even when display-only route fields exist',()=>{
  const source=structuredClone(itinerary),before=JSON.stringify(source);source.liveTransitDurations={departure:53};
  const value=window.TravelNoteSnapshot.create(source,{title:'사본'});source.days[0].events[1].place.name='바뀐 장소';
  assert.equal(value.days[0].events[1].title,'공개 관광지');assert.equal(value.days[0].events[0].end,600);
  assert.equal(JSON.stringify(itinerary),before);
});
test('public snapshot schema rejects injected fields, invalid dates, oversized text and inconsistent timing',()=>{
  for(const alter of [
    value=>value.ownerId='secret',value=>value.days[0].events[0].token='secret',value=>value.startDate='2026-02-30',
    value=>value.days[0].date='2026-10-22',value=>value.days[0].events[0].end=500,
    value=>value.days[0].events[0].memo='x'.repeat(501),value=>value.days[0].events[0].type='script',
    value=>value.days[0].events=Array(41).fill(value.days[0].events[0]),value=>value.title+='\u0000'
  ]){const value=make();alter(value);assert.throws(()=>validateShareSnapshot(value));}
});

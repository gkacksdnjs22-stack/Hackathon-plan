import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const window={};vm.runInNewContext(readFileSync(new URL('operating-info.js',import.meta.url),'utf8'),{window});
const assess=options=>window.TravelOperatingInfo.assess({date:'2026-10-21',start:600,end:660,hoursText:'09:00~18:00',closedText:'매주 월요일',...options});
test('only complete simple weekly dates and hours create definite conflicts',()=>{
  assert.equal(assess({date:'2026-10-19'}).closed,true);assert.equal(assess({}).closed,false);
  assert.equal(assess({start:480,end:600}).hoursConflict,true);assert.equal(assess({start:1020,end:1080}).hoursConflict,false);
  assert.equal(assess({start:1020,end:1081}).hoursConflict,true);
  assert.equal(assess({closedText:'2026-10-21 휴무'}).closed,true);
});
test('seasonal, holiday and admission conditions stay uncertain instead of partial parsing',()=>{
  for(const closedText of ['매주 수요일 (공휴일 제외)','공휴일 휴무','매주 월요일, 명절','2026-02-30 휴무',''])assert.equal(assess({closedText}).uncertain,true);
  for(const hoursText of ['09:00~18:00 (입장 17:00)','하절기 09:00~18:00','18:00~02:00','24:30~25:30',''])assert.equal(assess({hoursText}).uncertain,true);
  assert.equal(assess({closedText:'매주 수요일 (공휴일 제외)'}).closed,false);
});
test('midnight offsets use the actual visit date and an end exactly at midnight does not include the next day',()=>{
  assert.equal(assess({date:'2026-10-20',start:2040,end:2100,closedText:'매주 수요일'}).closed,true);
  assert.equal(assess({date:'2026-10-20',start:1380,end:1440,hoursText:'00:00~24:00',closedText:'매주 수요일'}).closed,false);
  assert.equal(assess({date:'2026-10-20',start:1380,end:1441,hoursText:'00:00~24:00',closedText:'매주 수요일'}).closed,true);
  assert.equal(assess({start:1380,end:1470,hoursText:'00:00~24:00'}).hoursConflict,false);
});
test('provisional and unknown data never imply that a venue is guaranteed open',()=>{
  const result=assess({provisional:true});assert.match(result.messages.join(' '),/임시 계획/);assert.doesNotMatch(result.messages.join(' '),/영업 중|영업 보장/);
  assert.equal(assess({date:'2026-02-30'}).uncertain,true);assert.equal(assess({start:-1}).uncertain,true);
});

export const MAX_PLAN_DOCUMENT_BYTES = 256 * 1024;
const ENCODER = new TextEncoder();
const BASE = ['departure','arrival-transfer','place-0','transfer-0','free-0','lunch','place-1','rest','transfer-1','place-2','dinner','free-1','finish'];
const EDITABLE = BASE.filter(id => !['departure','arrival-transfer','finish'].includes(id));
const MODES = ['walk','local-bus','subway','car'];
const SERVICES = { train:['train','15098552'], express:['bus','15098522'], intercity:['bus','15098541'], flight:['flight','15098526'], ferry:['ferry','15098523'] };
const TRIP_FIELDS = ['id','service','departureId','arrivalId','departureName','arrivalName','date','departureMinutes','arrivalMinutes','durationMinutes','tripNo','grade','source','sourceUrl','fetchedAt'];
const INPUTS = ['cityId','startDate','dayCount','dayAreaIds','selections','dayStarts','eventEdits','extraEvents','excludedEvents','eventOrders','departure','dayDepartures','dayArrivals','dayTransports','personalization','budget'];
const COMPUTED = ['ok','cityName','countryName','dataSource','days','maxDays'];
const EXTRA = /^extra-[1-9]\d{0,8}$/;
const PLACE = /^tourapi-\d{1,60}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalMap = value => value === undefined ? {} : value;
const mode = value => ['rental-car','taxi'].includes(value) ? 'car' : value;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const fail = (code = 'INVALID_PLAN') => { throw new PlanDocumentError(code); };

export class PlanDocumentError extends Error {
  constructor(code = 'INVALID_PLAN') {
    const codes = { INVALID_PLAN:[400,'저장할 여행 계획의 형식을 확인해 주세요.'], INVALID_TITLE:[400,'계획 제목은 1~80자로 입력해 주세요.'], PAYLOAD_TOO_LARGE:[413,'여행 계획의 저장 용량이 너무 커요. 메모나 추가 일정을 줄여 주세요.'] };
    const safe = Object.hasOwn(codes, code) ? code : 'INVALID_PLAN';
    super(codes[safe][1]); this.name = 'PlanDocumentError'; this.code = safe; this.status = codes[safe][0];
  }
}
function keys(value, allowed, required = []) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value,key))) fail();
}
function string(value, max, min = 0) {
  if (typeof value !== 'string' || value.length > max || value.trim().length < min || value.includes('\0')) fail();
  return value.trim();
}
function location(value) {
  if(value===null)return null;
  keys(value,['id','name','address','latitude','longitude','kind'],['id','name','address','latitude','longitude','kind']);
  if(!Number.isFinite(value.latitude)||value.latitude<33||value.latitude>39.5||!Number.isFinite(value.longitude)||value.longitude<124||value.longitude>132||!['meal','stay','other'].includes(value.kind))fail();
  return {id:string(value.id,160,1),name:string(value.name,160,1),address:string(value.address,500),latitude:value.latitude,longitude:value.longitude,kind:value.kind};
}
function restaurantRef(value) {
  if(value===null)return null;
  keys(value,['id','name','address'],['id','name','address']);
  return {id:string(value.id,160,1),name:string(value.name,160,1),address:string(value.address,500)};
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
  const [year,month,day] = value.split('-').map(Number), parsed = new Date(Date.UTC(year,month-1,day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth()+1 !== month || parsed.getUTCDate() !== day) fail();
  return value;
}
function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail();
  return value;
}
function dayMap(value, count, convert) {
  if (!record(value) || Object.keys(value).some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= count)) fail();
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,convert(item,Number(key))]));
}
function stop(value) {
  if (value === null) return null;
  const allowed = ['mode','id','name','address','latitude','longitude','source','sourceUrl','service','providerId'];
  keys(value,allowed,['mode','id','name','address','latitude','longitude','source','sourceUrl']);
  const selected = mode(value.mode), name = string(value.name,120,1), address = string(value.address,300);
  if (!['train','bus','flight','ferry',...MODES].includes(selected)) fail();
  const result = { mode:selected,id:string(value.id,120,1),name,address,latitude:value.latitude,longitude:value.longitude,source:value.source,sourceUrl:value.sourceUrl };
  if (value.source === 'TAGO') {
    const service = Object.hasOwn(SERVICES,value.service) ? SERVICES[value.service] : null;
    if (!service || selected !== service[0] || typeof value.providerId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.providerId)
      || value.id !== `tago-${value.service}-${value.providerId}` || value.sourceUrl !== `https://www.data.go.kr/data/${service[1]}/openapi.do`
      || value.latitude !== null || value.longitude !== null) fail();
    return { ...result, service:value.service,providerId:value.providerId };
  }
  const match = typeof value.id === 'string' && /^osm-(node|way|relation)-([1-9]\d*)$/.exec(value.id);
  if (!match || value.id.length > 100 || value.source !== 'OpenStreetMap' || Object.hasOwn(value,'service') || Object.hasOwn(value,'providerId')
    || value.sourceUrl !== `https://www.openstreetmap.org/${match[1]}/${match[2]}`
    || !Number.isFinite(value.latitude) || !Number.isFinite(value.longitude) || value.latitude < 33 || value.latitude > 39.5 || value.longitude < 124 || value.longitude > 132) fail();
  return result;
}
function trip(value, origin, arrival, expectedDate) {
  if (value === null) return null;
  keys(value,[...TRIP_FIELDS,'connection'],TRIP_FIELDS);
  const service = Object.hasOwn(SERVICES,value.service) ? SERVICES[value.service] : null;
  if (!service || value.source !== 'TAGO' || value.sourceUrl !== `https://www.data.go.kr/data/${service[1]}/openapi.do`
    || origin?.source !== 'TAGO' || arrival?.source !== 'TAGO' || origin.service !== value.service || arrival.service !== value.service
    || value.departureId !== origin.providerId || value.arrivalId !== arrival.providerId || date(value.date) !== expectedDate
    || !integer(value.departureMinutes,0,1439) || !integer(value.arrivalMinutes,value.departureMinutes+1,value.departureMinutes+4320)
    || value.durationMinutes !== value.arrivalMinutes-value.departureMinutes) fail();
  const normalized = { id:string(value.id,300,1),service:value.service,departureId:value.departureId,arrivalId:value.arrivalId,
    departureName:string(value.departureName,120,1),arrivalName:string(value.arrivalName,120,1),date:value.date,
    departureMinutes:value.departureMinutes,arrivalMinutes:value.arrivalMinutes,durationMinutes:value.durationMinutes,
    tripNo:string(value.tripNo,100),grade:string(value.grade,100),source:'TAGO',sourceUrl:value.sourceUrl,fetchedAt:iso(value.fetchedAt) };
  if (Object.hasOwn(value,'connection')) {
    const connection = value.connection;
    keys(connection,['via','legs','minimumTransferMinutes'],['via','legs','minimumTransferMinutes']);
    const via = stop(connection.via);
    if (via?.source !== 'TAGO' || via.service !== value.service || via.id === origin.id || via.id === arrival.id
      || !integer(connection.minimumTransferMinutes,0,180) || !Array.isArray(connection.legs) || connection.legs.length !== 2
      || connection.legs.some(leg => !record(leg) || Object.hasOwn(leg,'connection'))) fail();
    const first = trip(connection.legs[0],origin,via,expectedDate), secondDate = date(connection.legs[1].date);
    const offset = (Date.parse(`${secondDate}T00:00:00Z`)-Date.parse(`${expectedDate}T00:00:00Z`))/86400000;
    if (!integer(offset,0,3)) fail();
    const second = trip(connection.legs[1],via,arrival,secondDate), end = offset*1440+second.arrivalMinutes;
    if (offset*1440+second.departureMinutes-first.arrivalMinutes < connection.minimumTransferMinutes
      || value.departureMinutes !== first.departureMinutes || value.arrivalMinutes !== end || end-first.departureMinutes > 4320
      || value.id !== `connection-${first.id.slice(0,120)}-${second.id.slice(0,120)}`
      || value.tripNo !== [first,second].map(item=>item.tripNo).filter(Boolean).join(' → ').slice(0,100)
      || value.grade !== [...new Set([first.grade,second.grade].filter(Boolean))].join(' / ').slice(0,100)
      || value.departureName !== first.departureName || value.arrivalName !== second.arrivalName
      || value.fetchedAt !== (Date.parse(first.fetchedAt)>=Date.parse(second.fetchedAt)?first.fetchedAt:second.fetchedAt)) fail();
    normalized.connection = { via,legs:[first,second],minimumTransferMinutes:connection.minimumTransferMinutes };
  }
  return normalized;
}

export function normalizePlanTitle(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_TITLE');
  return value.trim();
}

function normalizePersonalization(value,count,extras,arrivals) {
  keys(value,['checklist','favoritePlaceIds','eventTags']);
  const items=value.checklist===undefined?[]:value.checklist, favorites=value.favoritePlaceIds===undefined?[]:value.favoritePlaceIds;
  if(!Array.isArray(items)||items.length>100||!Array.isArray(favorites)||favorites.length>100
    ||new Set(favorites).size!==favorites.length||favorites.some(id=>typeof id!=='string'||!PLACE.test(id)))fail();
  const used=new Set();
  const checklist=items.map(item=>{
    keys(item,['id','text','done'],['id','text','done']);
    if(typeof item.id!=='string'||!/^item-[1-9]\d{0,8}$/.test(item.id)||used.has(item.id)||typeof item.done!=='boolean'
      ||typeof item.text!=='string'||/[\u0000-\u001f\u007f]/.test(item.text))fail();
    used.add(item.id);return {id:item.id,text:string(item.text,120,1),done:item.done};
  });
  const eventTags=dayMap(optionalMap(value.eventTags),count,(entries,index)=>{
    const allowed=[...BASE,...(arrivals[index]?['arrival']:[]),...(extras[index]??[]).map(item=>item.id)];
    keys(entries,allowed);
    if(Object.keys(entries).length>34||Object.values(entries).some(tag=>!['must','booked','flex'].includes(tag)))fail();
    return {...entries};
  });
  return {checklist,favoritePlaceIds:[...favorites],eventTags};
}

// Only user-editable planning inputs are stored. Generated days/place snapshots
// and transient route responses never become part of the persisted document.
export function normalizePlanDocument(input) {
  keys(input,['version','itinerary'],['version','itinerary']);
  if (input.version !== 8) fail();
  const source = input.itinerary;
  keys(source,[...INPUTS,...COMPUTED],['cityId','startDate','dayCount','dayAreaIds','selections']);
  if (typeof source.cityId !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(source.cityId) || !integer(source.dayCount,1,7)) fail();
  const count = source.dayCount, startDate = date(source.startDate), used = new Set();
  if (!Array.isArray(source.dayAreaIds) || source.dayAreaIds.length !== count || new Set(source.dayAreaIds).size !== count
    || source.dayAreaIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(id))) fail();
  const excludedEvents = dayMap(optionalMap(source.excludedEvents),count, ids => {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id=>!EDITABLE.includes(id))) fail(); return [...ids];
  });
  const selections = dayMap(source.selections,count, (ids,index) => {
    if (!Array.isArray(ids) || ids.length !== 3 || new Set(ids).size !== 3 || ids.some(id => typeof id !== 'string' || !PLACE.test(id) || used.has(id))) fail();
    for (const [slot,id] of ids.entries()) { if (used.has(id)) fail(); if(!excludedEvents[index]?.includes(`place-${slot}`))used.add(id); }
    return [...ids];
  });
  if (Object.keys(selections).length !== count) fail();
  const dayStarts = dayMap(optionalMap(source.dayStarts),count,value => {
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(); return value;
  });
  for (let index=0;index<count;index++) dayStarts[index]??='09:00';
  const eventEdits = dayMap(optionalMap(source.eventEdits),count, entries => {
    keys(entries,BASE);
    return Object.fromEntries(Object.entries(entries).map(([id,edit]) => {
      keys(edit,['title','description','duration','travelMode','location','restaurantRef']);
      const patch = {};
      if (Object.hasOwn(edit,'title')) patch.title=string(edit.title,80,1);
      if (Object.hasOwn(edit,'description')) patch.description=string(edit.description,500);
      if (Object.hasOwn(edit,'duration')) { if (!integer(edit.duration,['departure','arrival-transfer','finish','transfer-0','transfer-1'].includes(id)?0:1,id==='departure'?4320:720)) fail(); patch.duration=edit.duration; }
      if (Object.hasOwn(edit,'travelMode')) { if (!['arrival-transfer','transfer-0','transfer-1'].includes(id) || !MODES.includes(mode(edit.travelMode))) fail(); patch.travelMode=mode(edit.travelMode); }
      if(Object.hasOwn(edit,'location')){if(!['free-0','free-1','rest','lunch','dinner'].includes(id))fail();patch.location=location(edit.location);}
      if(Object.hasOwn(edit,'restaurantRef')){if(!['lunch','dinner'].includes(id))fail();patch.restaurantRef=restaurantRef(edit.restaurantRef);}
      return [id,patch];
    }));
  });
  const extraEvents = dayMap(optionalMap(source.extraEvents),count, entries => {
    if (!Array.isArray(entries) || entries.length > 20) fail();
    const ids = new Set();
    return entries.map(entry => {
      keys(entry,['id','beforeId','type','title','description','duration','placeId','travelMode','location','restaurantRef'],['id','type','duration']);
      if (typeof entry.id !== 'string' || !EXTRA.test(entry.id) || ids.has(entry.id) || !['free','meal','rest','place','transfer'].includes(entry.type)
        || !integer(entry.duration,entry.type==='transfer'?0:1,720)) fail();
      ids.add(entry.id);
      const beforeId = entry.beforeId===undefined?'finish':entry.beforeId;
      if (![...EDITABLE,'finish'].includes(beforeId)) fail();
      const item = { id:entry.id,beforeId,type:entry.type,duration:entry.duration };
      if (Object.hasOwn(entry,'title')) item.title=string(entry.title,entry.type==='place'?200:80,1);
      if (Object.hasOwn(entry,'description')) item.description=string(entry.description,500);
      if (entry.type === 'place') {
        if (typeof entry.placeId !== 'string' || !PLACE.test(entry.placeId) || used.has(entry.placeId)) fail();
        used.add(entry.placeId); item.placeId=entry.placeId;
      } else if (Object.hasOwn(entry,'placeId')) fail();
      if (entry.type === 'transfer') {
        if (entry.travelMode != null && !MODES.includes(mode(entry.travelMode))) fail();
        item.travelMode=entry.travelMode==null?null:mode(entry.travelMode);
      } else if (Object.hasOwn(entry,'travelMode')) fail();
      if(Object.hasOwn(entry,'location')){if(['place','transfer'].includes(entry.type))fail();item.location=location(entry.location);}
      if(Object.hasOwn(entry,'restaurantRef')){if(entry.type!=='meal')fail();item.restaurantRef=restaurantRef(entry.restaurantRef);}
      return item;
    });
  });
  const eventOrders = dayMap(optionalMap(source.eventOrders),count,(ids,index) => {
    const allowed = [...EDITABLE,...(extraEvents[index]??[]).map(event=>event.id)];
    if (!Array.isArray(ids) || ids.length>30 || new Set(ids).size!==ids.length || ids.some(id=>!allowed.includes(id))) fail(); return [...ids];
  });
  const legacy = source.departure===undefined?null:stop(source.departure);
  const dayDepartures = dayMap(optionalMap(source.dayDepartures),count,stop);
  for (let index=0;index<count;index++) if (!Object.hasOwn(dayDepartures,index)) dayDepartures[index]=index===0?legacy:null;
  const dayArrivals = dayMap(optionalMap(source.dayArrivals),count,(value,index) => {
    const arrival=stop(value), departure=dayDepartures[index];
    if (arrival && (!['train','bus','flight','ferry'].includes(departure?.mode) || arrival.mode!==departure.mode
      || ((arrival.source==='TAGO'||departure.source==='TAGO') && (arrival.source!=='TAGO'||departure.source!=='TAGO'||arrival.service!==departure.service)))) fail();
    return arrival;
  });
  for (let index=0;index<count;index++) dayArrivals[index]??=null;
  const dayTransports = dayMap(optionalMap(source.dayTransports),count,(value,index) => {
    const day = new Date(`${startDate}T12:00:00Z`); day.setUTCDate(day.getUTCDate()+index);
    const selected=trip(value,dayDepartures[index],dayArrivals[index],day.toISOString().slice(0,10));
    const clock=Number(dayStarts[index].slice(0,2))*60+Number(dayStarts[index].slice(3));
    if (selected && (selected.departureMinutes!==clock || selected.durationMinutes!==eventEdits[index]?.departure?.duration)) fail();
    return selected;
  });
  for (let index=0;index<count;index++) {
    dayTransports[index]??=null;
    if (eventEdits[index]?.['arrival-transfer'] && !dayArrivals[index]) fail();
  }
  const result = { version:8,itinerary:{ cityId:source.cityId,startDate,dayCount:count,dayAreaIds:[...source.dayAreaIds],selections,
    dayStarts,eventEdits,extraEvents,excludedEvents,eventOrders,departure:dayDepartures[0],dayDepartures,dayArrivals,dayTransports } };
  if(source.personalization!==undefined)result.itinerary.personalization=normalizePersonalization(source.personalization,count,extraEvents,dayArrivals);
  if(source.budget!==undefined){
    const budget=source.budget;keys(budget,['limit','items'],['limit','items']);
    if(!(budget.limit===null||integer(budget.limit,0,1000000000000))||!Array.isArray(budget.items)||budget.items.length>200)fail();
    const ids=new Set();
    result.itinerary.budget={limit:budget.limit,items:budget.items.map(item=>{
      keys(item,['id','dayIndex','category','title','amount'],['id','dayIndex','category','title','amount']);
      if(typeof item.id!=='string'||!/^cost-[a-zA-Z0-9_-]{1,64}$/.test(item.id)||ids.has(item.id)||!integer(item.dayIndex,0,count-1)
        ||!['transport','stay','food','admission','other'].includes(item.category)||!integer(item.amount,0,1000000000)
        ||typeof item.title!=='string'||/[\u0000-\u001f\u007f]/.test(item.title))fail();
      ids.add(item.id);return {...item,title:string(item.title,80,1)};
    })};
  }
  if (ENCODER.encode(JSON.stringify(result)).byteLength > MAX_PLAN_DOCUMENT_BYTES) fail('PAYLOAD_TOO_LARGE');
  return result;
}

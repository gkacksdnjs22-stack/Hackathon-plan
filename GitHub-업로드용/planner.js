(function(){
  'use strict';

  const DEFAULT_START='09:00';
  const MAX_TRIP_DAYS=7;
  const TAGO_SERVICES={
    train:{mode:'train',sourceUrl:'https://www.data.go.kr/data/15098552/openapi.do'},
    express:{mode:'bus',sourceUrl:'https://www.data.go.kr/data/15098522/openapi.do'},
    intercity:{mode:'bus',sourceUrl:'https://www.data.go.kr/data/15098541/openapi.do'},
    flight:{mode:'flight',sourceUrl:'https://www.data.go.kr/data/15098526/openapi.do'},
    ferry:{mode:'ferry',sourceUrl:'https://www.data.go.kr/data/15098523/openapi.do'}
  };
  const TRANSPORT_FIELDS=['id','service','departureId','arrivalId','departureName','arrivalName','date','departureMinutes','arrivalMinutes','durationMinutes','tripNo','grade','source','sourceUrl','fetchedAt'];
  const EVENT_IDS=['departure','arrival-transfer','place-0','transfer-0','free-0','lunch','place-1','rest','transfer-1','place-2','dinner','free-1','finish'];
  const PROTECTED_IDS=['departure','arrival','arrival-transfer','finish'];
  const EDITABLE_IDS=EVENT_IDS.filter(id=>!PROTECTED_IDS.includes(id));
  const TRANSFER_IDS=['transfer-0','transfer-1'];
  const LOCAL_TRANSFER_IDS=['arrival-transfer',...TRANSFER_IDS];
  const TRANSFER_MODES=['walk','local-bus','subway','car'];
  const EXTRA_TYPES=['free','meal','rest','place','transfer'];
  const EXTRA_FIELDS=['id','beforeId','type','title','description','duration','placeId','travelMode','location'];
  function normalizeLocation(value){
    if(value===null)return null;
    if(!record(value)||Object.keys(value).some(key=>!['id','name','address','latitude','longitude','kind'].includes(key))
      ||typeof value.id!=='string'||!value.id||value.id.length>160||typeof value.name!=='string'||!value.name.trim()||value.name.length>160
      ||typeof value.address!=='string'||value.address.length>500||!['meal','stay','other'].includes(value.kind)
      ||!Number.isFinite(value.latitude)||value.latitude<33||value.latitude>39.5||!Number.isFinite(value.longitude)||value.longitude<124||value.longitude>132)return undefined;
    return {...value,name:value.name.trim(),address:value.address.trim()};
  }
  const eventLocation=event=>event?.place||event?.location||event?.departure||event?.arrival||null;
  const visitEvent=event=>Boolean(event?.type!=='transfer'&&(event?.type==='place'||event?.location||event?.type==='meal'&&event.title?.includes(' · ')||/^extra-/.test(event?.id)&&['free','rest','meal'].includes(event.type)||event?.departure||event?.arrival));
  function visitIdentity(event){
    if(!event)return null;
    const place=eventLocation(event);
    if(place)return [place.id,place.latitude??null,place.longitude??null];
    const title=typeof event.title==='string'?event.title.trim():'';
    const name=event.type==='meal'&&title.includes(' · ')?title.slice(title.indexOf(' · ')+3).trim():title;
    return ['unlocated',event.type,event.id,name];
  }
  const extraId=id=>typeof id==='string'&&/^extra-[1-9]\d{0,8}$/.test(id);
  const canonicalTravelMode=mode=>mode==='rental-car'||mode==='taxi'?'car':mode;
  const vehicleMode=mode=>canonicalTravelMode(mode)==='car';
  const requiresArrival=mode=>['train','bus','flight','ferry'].includes(mode);
  const publicTransport=departure=>requiresArrival(departure?.mode);
  const formatTime=minutes=>{
    const offset=Math.floor(minutes/(24*60)),clock=minutes%(24*60);
    const time=`${String(Math.floor(clock/60)).padStart(2,'0')}:${String(clock%60).padStart(2,'0')}`;
    return `${offset===1?'다음 날 ':offset>1?`${offset}일 후 `:''}${time}`;
  };
  const allPlaces=city=>{
    const places=Array.isArray(city?.areas)?city.areas.flatMap(area=>Array.isArray(area?.places)?area.places:[]):[];
    const seen=new Set(places.map(place=>place?.id));
    for(const place of Array.isArray(city?.catalogPlaces)?city.catalogPlaces:[]){
      if(place&&typeof place.id==='string'&&!seen.has(place.id)){places.push(place);seen.add(place.id);}
    }
    return places;
  };
  const placeEvents=day=>Array.isArray(day?.events)?day.events.filter(event=>event.type==='place'):[];

  function validDate(dateString){
    if(typeof dateString!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(dateString))return false;
    const [year,month,day]=dateString.split('-').map(Number);
    const date=new Date(Date.UTC(year,month-1,day));
    return date.getUTCFullYear()===year&&date.getUTCMonth()+1===month&&date.getUTCDate()===day;
  }
  function fmtDate(dateString,offset){
    const d=new Date(`${dateString}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate()+offset);
    return new Intl.DateTimeFormat('ko-KR',{timeZone:'UTC',month:'long',day:'numeric',weekday:'short'}).format(d);
  }
  function calendarDate(dateString,offset){
    const d=new Date(`${dateString}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate()+offset);
    return d.toISOString().slice(0,10);
  }
  function validateCity(city){
    if(!city||typeof city!=='object'||typeof city.id!=='string'||!city.id||typeof city.name!=='string'||!city.name||typeof city.country!=='string')
      return {ok:false,reason:'도시 데이터의 식별자가 올바르지 않습니다.'};
    if(!window.TRAVEL_DATA?.countries?.[city.country]||window.TRAVEL_DATA.cities?.[city.id]!==city||city.id!==city.id.toLowerCase())
      return {ok:false,reason:'도시와 나라 데이터의 연결을 확인할 수 없습니다.'};
    if(!Array.isArray(city.areas)||city.areas.length===0)
      return {ok:false,reason:'장소 데이터가 준비 중인 도시입니다.'};
    if(!Number.isInteger(city.supportedDays)||city.supportedDays<0||city.supportedDays>MAX_TRIP_DAYS)
      return {ok:false,reason:'도시의 지원 기간 데이터가 올바르지 않습니다.'};

    const areaIds=new Set(),placeIds=new Set(),places=[];
    for(const area of city.areas){
      if(!area||typeof area.id!=='string'||!area.id||typeof area.name!=='string'||!area.name||!Array.isArray(area.places))
        return {ok:false,reason:'권역 데이터의 식별자 또는 장소 목록이 올바르지 않습니다.'};
      if(areaIds.has(area.id))return {ok:false,reason:'권역 데이터 ID가 중복되어 일정을 만들 수 없습니다.'};
      areaIds.add(area.id);
      for(const place of area.places){
        if(!place||typeof place.id!=='string'||!place.id||typeof place.areaId!=='string'||place.areaId!==area.id
          ||typeof place.area!=='string'||place.area!==area.name||typeof place.areaName!=='string'||place.areaName!==area.name
          ||!Number.isInteger(place.stayMinutes)||place.stayMinutes<=0)
          return {ok:false,reason:`${area.name}의 장소가 부모 권역 ID 또는 표시명과 일치하지 않습니다.`};
        if(placeIds.has(place.id))return {ok:false,reason:'장소 데이터 ID가 중복되어 일정을 만들 수 없습니다.'};
        placeIds.add(place.id);places.push(place);
      }
    }
    if(city.catalogPlaces!==undefined){
      if(!Array.isArray(city.catalogPlaces)||typeof city.tourAreaCode!=='string'||!/^\d+$/.test(city.tourAreaCode)||city.dataSource!=='tourapi')
        return {ok:false,reason:'전체 관광지 목록의 공공정보 지역 연결을 확인할 수 없습니다.'};
      const registered=new Map(places.map(place=>[place.id,place])),catalogIds=new Set();
      const core=['id','contentId','name','areaId','area','areaName','category','stayMinutes','address','latitude','longitude','source','sourceUrl'];
      for(const place of city.catalogPlaces){
        if(!place||typeof place!=='object'||Array.isArray(place)||typeof place.contentId!=='string'||!/^\d+$/.test(place.contentId)
          ||place.id!==`tourapi-${place.contentId}`||catalogIds.has(place.id)||typeof place.name!=='string'||!place.name.trim()||place.name.length>200
          ||typeof place.address!=='string'||place.address.length>1001||!['관광지','문화시설'].includes(place.category)
          ||!Number.isInteger(place.stayMinutes)||place.stayMinutes<1||place.stayMinutes>720
          ||!Number.isFinite(place.latitude)||!Number.isFinite(place.longitude)||place.latitude<33||place.latitude>39.5||place.longitude<124||place.longitude>132
          ||place.source!=='한국관광공사 TourAPI'||place.sourceUrl!=='https://www.data.go.kr/data/15101578/openapi.do')
          return {ok:false,reason:'전체 관광지 목록의 식별자·좌표 또는 공식 출처가 올바르지 않습니다.'};
        catalogIds.add(place.id);
        const clustered=registered.get(place.id);
        if(clustered){
          if(core.some(field=>clustered[field]!==place[field]))return {ok:false,reason:'같은 관광지 ID의 권역 정보와 전체 목록 정보가 일치하지 않습니다.'};
        }else{
          if(place.areaId!==`tour-catalog-${city.tourAreaCode}`||place.areaName!==`${city.name} 전체`||place.area!==place.areaName)
            return {ok:false,reason:'권역 밖 관광지가 현재 여행 지역의 전체 목록과 연결되지 않습니다.'};
          places.push(place);placeIds.add(place.id);
        }
      }
    }
    return {ok:true,places,areaIds};
  }
  const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const validDayKey=(key,count)=>/^(0|[1-9]\d*)$/.test(key)&&Number(key)<count;
  const validStart=value=>typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const startMinutes=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
  function normalizeDeparture(departure){
    if(departure===null||departure===undefined)return {ok:true,departure:null};
    const mode=canonicalTravelMode(departure?.mode);
    if(!record(departure)||!['train','bus','flight','ferry','car','local-bus','subway','walk'].includes(mode))
      return {ok:false,reason:'출발지의 이동수단 정보를 확인해 주세요.'};
    if(typeof departure.name!=='string'||!departure.name.trim()||departure.name.trim().length>120
      ||typeof departure.address!=='string'||departure.address.length>300)
      return {ok:false,reason:'출발지의 이름 또는 주소 형식이 올바르지 않습니다.'};
    if(departure.source==='TAGO'){
      const service=Object.hasOwn(TAGO_SERVICES,departure.service)?TAGO_SERVICES[departure.service]:null;
      if(!service||service.mode!==mode||typeof departure.providerId!=='string'
        ||!/^[A-Za-z0-9_-]{1,100}$/.test(departure.providerId)||departure.id!==`tago-${departure.service}-${departure.providerId}`
        ||departure.sourceUrl!==service.sourceUrl||departure.latitude!==null||departure.longitude!==null)
        return {ok:false,reason:'출발지의 TAGO 서비스, 장소 ID 또는 공식 출처가 올바르지 않습니다.'};
      return {ok:true,departure:{mode,id:departure.id,service:departure.service,providerId:departure.providerId,
        name:departure.name.trim(),address:departure.address.trim(),latitude:null,longitude:null,source:'TAGO',sourceUrl:service.sourceUrl}};
    }
    const match=typeof departure.id==='string'?/^osm-(node|way|relation)-([1-9]\d*)$/.exec(departure.id):null;
    if(!match||departure.id.length>100||departure.source!=='OpenStreetMap'
      ||departure.sourceUrl!==`https://www.openstreetmap.org/${match[1]}/${match[2]}`)
      return {ok:false,reason:'출발지의 장소 ID와 지도 출처 정보가 일치하지 않습니다. 출발지를 다시 검색해 주세요.'};
    if(!Number.isFinite(departure.latitude)||!Number.isFinite(departure.longitude)
      ||departure.latitude<33||departure.latitude>39.5||departure.longitude<124||departure.longitude>132)
      return {ok:false,reason:'출발지 좌표가 국내 여행 범위를 벗어났거나 올바르지 않습니다.'};
    return {ok:true,departure:{mode,id:departure.id,name:departure.name.trim(),address:departure.address.trim(),
      latitude:departure.latitude,longitude:departure.longitude,source:'OpenStreetMap',sourceUrl:departure.sourceUrl}};
  }
  function normalizeDayDepartures(dayDepartures,departure,count){
    if(!record(dayDepartures)||Object.keys(dayDepartures).some(key=>!validDayKey(key,count)))
      return {ok:false,reason:'날짜별 출발지가 여행 기간의 날짜와 일치하지 않습니다.'};
    const legacy=normalizeDeparture(departure);
    if(!legacy.ok)return legacy;
    const normalized={};
    for(let index=0;index<count;index++){
      const explicit=Object.hasOwn(dayDepartures,index);
      if(explicit&&dayDepartures[index]===undefined)return {ok:false,reason:'날짜별 출발지는 검색한 장소 또는 미선택 값이어야 합니다.'};
      const origin=normalizeDeparture(explicit?dayDepartures[index]:index===0?legacy.departure:null);
      if(!origin.ok)return {ok:false,reason:`${index+1}일차 ${origin.reason}`};
      normalized[index]=origin.departure;
    }
    return {ok:true,dayDepartures:normalized};
  }
  function normalizeDayArrivals(dayArrivals,dayDepartures,count){
    if(!record(dayArrivals)||Object.keys(dayArrivals).some(key=>!validDayKey(key,count)))
      return {ok:false,reason:'날짜별 도착지가 여행 기간의 날짜와 일치하지 않습니다.'};
    const normalized={};
    for(let index=0;index<count;index++){
      if(Object.hasOwn(dayArrivals,index)&&dayArrivals[index]===undefined)
        return {ok:false,reason:'날짜별 도착지는 검색한 장소 또는 미선택 값이어야 합니다.'};
      const result=normalizeDeparture(dayArrivals[index]??null);
      if(!result.ok)return {ok:false,reason:`${index+1}일차 ${result.reason.replaceAll('출발지','도착지')}`};
      const arrival=result.departure,departure=dayDepartures[index];
      if(arrival&&(!publicTransport(departure)||arrival.mode!==departure.mode))
        return {ok:false,reason:`${index+1}일차 도착지는 대중교통 출발지와 같은 이동수단으로 선택해 주세요.`};
      if(arrival&&(arrival.source==='TAGO'||departure.source==='TAGO')
        &&(arrival.source!=='TAGO'||departure.source!=='TAGO'||arrival.service!==departure.service))
        return {ok:false,reason:`${index+1}일차 출발지와 도착지는 같은 TAGO 서비스를 사용해야 합니다.`};
      normalized[index]=arrival;
    }
    return {ok:true,dayArrivals:normalized};
  }
  function normalizeDirectTransport(transport,departure,arrival,date){
    if(transport===null)return {ok:true,transport:null};
    const fail=reason=>({ok:false,reason:`선택한 교통편의 ${reason}`});
    if(!record(transport)||TRANSPORT_FIELDS.some(field=>!Object.hasOwn(transport,field))
      ||Object.keys(transport).some(field=>!TRANSPORT_FIELDS.includes(field)))return fail('정보 형식이 올바르지 않습니다.');
    const service=Object.hasOwn(TAGO_SERVICES,transport.service)?TAGO_SERVICES[transport.service]:null;
    if(!service||transport.source!=='TAGO'||transport.sourceUrl!==service.sourceUrl
      ||departure?.source!=='TAGO'||arrival?.source!=='TAGO'||departure.service!==transport.service||arrival.service!==transport.service
      ||transport.departureId!==departure.providerId||transport.arrivalId!==arrival.providerId)
      return fail('출발지·도착지 또는 TAGO 서비스가 현재 일정과 일치하지 않습니다.');
    const stringFields={id:[1,300],departureName:[1,120],arrivalName:[1,120],tripNo:[0,100],grade:[0,100]};
    for(const [field,[minimum,maximum]] of Object.entries(stringFields)){
      if(typeof transport[field]!=='string'||transport[field].trim().length<minimum||transport[field].length>maximum)
        return fail('이름이나 편 번호 형식이 올바르지 않습니다.');
    }
    if(transport.date!==date||!validDate(transport.date))return fail('날짜가 여행 날짜와 일치하지 않습니다.');
    if(!Number.isInteger(transport.departureMinutes)||transport.departureMinutes<0||transport.departureMinutes>1439
      ||!Number.isInteger(transport.arrivalMinutes)||!Number.isInteger(transport.durationMinutes)
      ||transport.arrivalMinutes<=transport.departureMinutes||transport.arrivalMinutes>transport.departureMinutes+4320
      ||transport.durationMinutes!==transport.arrivalMinutes-transport.departureMinutes)
      return fail('출발·도착 시각 또는 소요시간을 확인할 수 없습니다.');
    if(typeof transport.fetchedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(transport.fetchedAt)
      ||!Number.isFinite(Date.parse(transport.fetchedAt)))return fail('조회 시각이 올바르지 않습니다.');
    return {ok:true,transport:{id:transport.id.trim(),service:transport.service,departureId:transport.departureId,arrivalId:transport.arrivalId,
      departureName:transport.departureName.trim(),arrivalName:transport.arrivalName.trim(),date:transport.date,
      departureMinutes:transport.departureMinutes,arrivalMinutes:transport.arrivalMinutes,durationMinutes:transport.durationMinutes,
      tripNo:transport.tripNo.trim(),grade:transport.grade.trim(),source:'TAGO',sourceUrl:service.sourceUrl,fetchedAt:transport.fetchedAt}};
  }
  function buildConnection({departure,arrival,via,legs,minimumTransferMinutes=15,date}={}){
    const fail=reason=>({ok:false,reason:`환승 교통편의 ${reason}`});
    if(!validDate(date)||!Number.isInteger(minimumTransferMinutes)||minimumTransferMinutes<0||minimumTransferMinutes>180)
      return fail('날짜 또는 최소 환승시간을 확인해 주세요. 최소 환승시간은 0~180분으로 입력해 주세요.');
    if(!Array.isArray(legs)||legs.length!==2||legs.some(leg=>!record(leg)))return fail('출발지 → 환승지, 환승지 → 도착지의 교통편을 각각 선택해 주세요.');
    const stops=[departure,via,arrival].map(normalizeDeparture);
    if(stops.some(stop=>!stop.ok||stop.departure?.source!=='TAGO'))return fail('출발지·환승지·도착지를 같은 교통기관 목록에서 선택해 주세요.');
    const [origin,middle,destination]=stops.map(stop=>stop.departure);
    if(origin.service!==middle.service||origin.service!==destination.service||origin.providerId===middle.providerId||middle.providerId===destination.providerId)
      return fail('환승지는 출발지·도착지와 다른 곳이며 같은 교통정보 서비스를 사용해야 합니다.');
    const first=normalizeDirectTransport(legs[0],origin,middle,date);
    if(!first.ok)return first;
    const secondDate=legs[1]?.date;
    if(!validDate(secondDate))return fail('두 번째 교통편의 운행 날짜가 올바르지 않습니다.');
    const dayOffset=(Date.parse(`${secondDate}T00:00:00Z`)-Date.parse(`${date}T00:00:00Z`))/(24*60*60*1000);
    if(!Number.isInteger(dayOffset)||dayOffset<0||dayOffset>3)return fail('두 번째 교통편은 첫 출발일부터 3일 이내의 실제 운행 날짜로 선택해 주세요.');
    const second=normalizeDirectTransport(legs[1],middle,destination,secondDate);
    if(!second.ok)return second;
    const start=first.transport.departureMinutes,arrivalMinutes=dayOffset*1440+second.transport.arrivalMinutes;
    const wait=dayOffset*1440+second.transport.departureMinutes-first.transport.arrivalMinutes;
    if(wait<minimumTransferMinutes)return fail(`환승 시간이 부족해요. 첫 교통편 도착 후 최소 ${minimumTransferMinutes}분 뒤에 출발하는 편을 선택해 주세요.`);
    if(arrivalMinutes<=start||arrivalMinutes-start>4320)return fail('전체 이동시간은 대기시간을 포함해 최대 72시간이어야 합니다.');
    const trips=[first.transport,second.transport];
    const transport={
      id:`connection-${first.transport.id.slice(0,120)}-${second.transport.id.slice(0,120)}`,
      service:origin.service,departureId:origin.providerId,arrivalId:destination.providerId,
      departureName:first.transport.departureName,arrivalName:second.transport.arrivalName,date,
      departureMinutes:start,arrivalMinutes,durationMinutes:arrivalMinutes-start,
      tripNo:trips.map(trip=>trip.tripNo).filter(Boolean).join(' → ').slice(0,100),
      grade:[...new Set(trips.map(trip=>trip.grade).filter(Boolean))].join(' / ').slice(0,100),
      source:'TAGO',sourceUrl:TAGO_SERVICES[origin.service].sourceUrl,
      fetchedAt:trips.reduce((latest,trip)=>Date.parse(trip.fetchedAt)>Date.parse(latest)?trip.fetchedAt:latest,trips[0].fetchedAt),
      connection:{via:middle,legs:trips,minimumTransferMinutes}
    };
    return {ok:true,transport};
  }
  function normalizeTransport(transport,departure,arrival,date){
    if(!record(transport)||!Object.hasOwn(transport,'connection'))return normalizeDirectTransport(transport,departure,arrival,date);
    const fail=()=>({ok:false,reason:'선택한 환승 교통편의 전체 시간 또는 구간 정보가 일치하지 않습니다.'});
    if(TRANSPORT_FIELDS.some(field=>!Object.hasOwn(transport,field))||Object.keys(transport).some(field=>!TRANSPORT_FIELDS.includes(field)&&field!=='connection'))return fail();
    const connection=transport.connection;
    if(!record(connection)||['via','legs','minimumTransferMinutes'].some(field=>!Object.hasOwn(connection,field))
      ||Object.keys(connection).some(field=>!['via','legs','minimumTransferMinutes'].includes(field)))return fail();
    const result=buildConnection({departure,arrival,date,...connection});
    if(!result.ok)return result;
    if(TRANSPORT_FIELDS.some(field=>transport[field]!==result.transport[field]))return fail();
    return result;
  }
  function normalizeDayTransports(dayTransports,dayDepartures,dayArrivals,dayStarts,eventEdits,startDate,count){
    if(!record(dayTransports)||Object.keys(dayTransports).some(key=>!validDayKey(key,count)))
      return {ok:false,reason:'날짜별 교통편 정보가 여행 날짜와 일치하지 않습니다.'};
    const normalized={};
    for(let index=0;index<count;index++){
      if(Object.hasOwn(dayTransports,index)&&dayTransports[index]===undefined)return {ok:false,reason:'교통편은 조회한 편 또는 미선택 값이어야 합니다.'};
      const result=normalizeTransport(dayTransports[index]??null,dayDepartures[index],dayArrivals[index],calendarDate(startDate,index));
      if(!result.ok)return {ok:false,reason:`${index+1}일차 ${result.reason}`};
      if(result.transport&&(startMinutes(dayStarts[index])!==result.transport.departureMinutes
        ||eventEdits[index]?.departure?.duration!==result.transport.durationMinutes))
        return {ok:false,reason:`${index+1}일차 선택한 교통편과 일정의 출발시각·소요시간이 일치하지 않습니다.`};
      normalized[index]=result.transport;
    }
    return {ok:true,dayTransports:normalized};
  }
  function normalizeOptions(dayStarts,eventEdits,count){
    if(!record(dayStarts)||!record(eventEdits))return {ok:false,reason:'출발시간 또는 일정 수정 정보의 형식이 올바르지 않습니다.'};
    if(Object.keys(dayStarts).some(key=>!validDayKey(key,count)||!validStart(dayStarts[key])))
      return {ok:false,reason:'날짜별 출발시간은 여행 날짜에 맞는 HH:MM 형식으로 입력해 주세요.'};
    const starts={},edits={};
    for(let index=0;index<count;index++)starts[index]=dayStarts[index]??DEFAULT_START;
    for(const key of Object.keys(eventEdits)){
      if(!validDayKey(key,count)||!record(eventEdits[key]))return {ok:false,reason:'수정할 일정 날짜가 여행 기간과 일치하지 않습니다.'};
      const normalized={};
      for(const id of Object.keys(eventEdits[key])){
        const edit=eventEdits[key][id];
        if(!EVENT_IDS.includes(id)||!record(edit)||Object.keys(edit).some(field=>!['title','description','duration','travelMode','location'].includes(field)))
          return {ok:false,reason:'수정할 일정의 ID 또는 항목 형식이 올바르지 않습니다.'};
        const patch={};
        if(Object.hasOwn(edit,'title')){
          if(typeof edit.title!=='string'||!edit.title.trim()||edit.title.trim().length>80)return {ok:false,reason:'일정 제목은 1~80자로 입력해 주세요.'};
          patch.title=edit.title.trim();
        }
        if(Object.hasOwn(edit,'description')){
          if(typeof edit.description!=='string'||edit.description.length>500)return {ok:false,reason:'일정 내용은 500자 이내로 입력해 주세요.'};
          patch.description=edit.description.trim();
        }
        if(Object.hasOwn(edit,'duration')){
          const minimum=['departure','arrival-transfer','finish',...TRANSFER_IDS].includes(id)?0:1;
          const maximum=id==='departure'?4320:720;
          if(!Number.isInteger(edit.duration)||edit.duration<minimum||edit.duration>maximum)return {ok:false,reason:`소요시간은 ${minimum}~${maximum}분의 정수로 입력해 주세요.`};
          patch.duration=edit.duration;
        }
        if(Object.hasOwn(edit,'travelMode')){
          const mode=canonicalTravelMode(edit.travelMode);
          if(!LOCAL_TRANSFER_IDS.includes(id)||!TRANSFER_MODES.includes(mode))return {ok:false,reason:'관광지까지 이동수단을 목록에서 선택해 주세요.'};
          patch.travelMode=mode;
        }
        if(Object.hasOwn(edit,'location')){
          const location=normalizeLocation(edit.location);
          if(location===undefined||!['free-0','free-1','rest','lunch','dinner'].includes(id))return {ok:false,reason:'직접 입력한 장소의 국내 좌표와 이름을 확인해 주세요.'};
          patch.location=location;
        }
        if(Object.keys(patch).length)normalized[id]=patch;
      }
      if(Object.keys(normalized).length)edits[key]=normalized;
    }
    return {ok:true,dayStarts:starts,eventEdits:edits};
  }
  function normalizeExtraEvents(extraEvents,count,places,arrivals){
    if(!record(extraEvents)||Object.keys(extraEvents).some(key=>!validDayKey(key,count)))
      return {ok:false,reason:'추가 일정의 날짜가 여행 기간과 일치하지 않습니다.'};
    const normalized={},byId=new Map(places.map(place=>[place.id,place])),used=new Set();
    for(const key of Object.keys(extraEvents)){
      const entries=extraEvents[key];
      if(!Array.isArray(entries)||entries.length>20)return {ok:false,reason:'추가 일정은 날짜별로 최대 20개까지 만들 수 있습니다.'};
      const ids=new Set(),items=[];
      for(const entry of entries){
        if(!record(entry)||Object.keys(entry).some(field=>!EXTRA_FIELDS.includes(field))||!extraId(entry.id)||ids.has(entry.id)||!EXTRA_TYPES.includes(entry.type))
          return {ok:false,reason:'추가 일정의 종류 또는 ID가 올바르지 않습니다.'};
        const beforeId=entry.beforeId===undefined?'finish':entry.beforeId;
        if(!EVENT_IDS.includes(beforeId)||['departure','arrival-transfer'].includes(beforeId))
          return {ok:false,reason:'추가 일정을 놓을 위치를 현재 날짜의 일정에서 선택해 주세요.'};
        const minimum=entry.type==='transfer'?0:1;
        if(!Number.isInteger(entry.duration)||entry.duration<minimum||entry.duration>720)
          return {ok:false,reason:`추가 일정의 소요시간은 ${minimum}~720분의 정수로 입력해 주세요.`};
        let place=null;
        if(entry.type==='place'){
          place=byId.get(entry.placeId);
          if(!place||used.has(place.id))return {ok:false,reason:'관광지는 현재 여행 지역의 목록에서 중복되지 않게 선택해 주세요.'};
          if(Object.hasOwn(entry,'title')&&entry.title!==place.name)return {ok:false,reason:'추가 관광지명은 공공정보의 등록명을 사용해 주세요.'};
          used.add(place.id);
        }else if(Object.hasOwn(entry,'placeId'))return {ok:false,reason:'관광지 일정에만 장소를 지정할 수 있습니다.'};
        const title=place?place.name:entry.title??({free:'자유 일정',meal:'식사',rest:'휴식',transfer:'이동'})[entry.type];
        const description=entry.description??(place?.intro||'');
        if(typeof title!=='string'||!title.trim()||(!place&&title.trim().length>80)
          ||typeof description!=='string'||description.length>500)return {ok:false,reason:'추가 일정 제목은 1~80자, 메모는 500자 이내로 입력해 주세요.'};
        const item={id:entry.id,beforeId,type:entry.type,title:title.trim(),description:description.trim(),duration:entry.duration};
        if(place)item.placeId=place.id;
        if(entry.type==='transfer'){
          const mode=entry.travelMode==null?null:canonicalTravelMode(entry.travelMode);
          if(mode!==null&&!TRANSFER_MODES.includes(mode))return {ok:false,reason:'추가 이동수단을 목록에서 선택해 주세요.'};
          item.travelMode=mode;
        }else if(Object.hasOwn(entry,'travelMode'))return {ok:false,reason:'이동 일정에만 이동수단을 지정할 수 있습니다.'};
        if(Object.hasOwn(entry,'location')){
          const location=normalizeLocation(entry.location);
          if(location===undefined||['place','transfer'].includes(entry.type))return {ok:false,reason:'장소의 국내 좌표와 이름을 확인해 주세요.'};
          item.location=location;
        }
        ids.add(entry.id);items.push(item);
      }
      if(items.length)normalized[key]=items;
    }
    return {ok:true,extraEvents:normalized,placeIds:used};
  }
  function normalizeLayout(excludedEvents,eventOrders,count,extras){
    const fail=()=>({ok:false,reason:'일정의 제외 항목 또는 표시 순서가 올바르지 않습니다.'});
    if(!record(excludedEvents)||!record(eventOrders)||[...Object.keys(excludedEvents),...Object.keys(eventOrders)].some(key=>!validDayKey(key,count)))return fail();
    const excluded={},orders={};
    for(let index=0;index<count;index++){
      const hidden=excludedEvents[index]??[],requested=eventOrders[index]??[];
      if(!Array.isArray(hidden)||hidden.length>EDITABLE_IDS.length||new Set(hidden).size!==hidden.length||hidden.some(id=>!EDITABLE_IDS.includes(id)))return fail();
      if(!Array.isArray(requested)||requested.length>50||new Set(requested).size!==requested.length||requested.some(id=>!EDITABLE_IDS.includes(id)&&!extraId(id)))return fail();
      if(hidden.length)excluded[index]=[...hidden];
      const defaults=EVENT_IDS.flatMap(id=>[...(extras[index]??[]).filter(event=>event.beforeId===id).map(event=>event.id),id])
        .filter(id=>!PROTECTED_IDS.includes(id)&&!hidden.includes(id));
      const ordered=requested.filter(id=>defaults.includes(id));
      for(let position=0;position<defaults.length;position++){
        const id=defaults[position];
        if(ordered.includes(id))continue;
        const next=defaults.slice(position+1).find(candidate=>ordered.includes(candidate));
        if(next)ordered.splice(ordered.indexOf(next),0,id);else ordered.push(id);
      }
      orders[index]=ordered;
    }
    return {ok:true,excludedEvents:excluded,eventOrders:orders};
  }
  function scheduleDay(area,places,startTime=DEFAULT_START,edits={},departure=null,arrival=null,extras=[],excluded=[],order=null){
    if(!area||!Array.isArray(places)||places.length!==3
      ||places.some(place=>!place||place.areaId!==area.id||place.areaName!==area.name)
      ||new Set(places.map(place=>place.id)).size!==3)return {ok:false};
    const events=[];
    const toSecond=0; // Unknown until the user enters or applies a route duration.
    const toThird=0;
    const flow=[
      {id:'departure',type:'departure',departure,title:departure?`${departure.name}에서 출발`:'출발지를 선택해 주세요',description:departure?departure.address:'역·숙소·주소에서 이날 출발할 곳을 골라주세요.',duration:0},
      ...(arrival?[
        {id:'arrival',type:'arrival',arrival,title:`${arrival.name} 도착`,description:arrival.address,duration:0},
        {id:'arrival-transfer',type:'transfer',arrival,title:'첫 관광지로 이동',description:`${arrival.name} → ${places[0].name}`,duration:0,from:arrival.id,to:places[0].id}
      ]:[]),
      {id:'place-0',type:'place',place:places[0],title:places[0].name,description:places[0].intro||'',duration:places[0].stayMinutes,transferBefore:0},
      {id:'transfer-0',type:'transfer',title:'이동',description:'다음 장소로 이동 · 예상 소요시간',duration:toSecond,from:places[0].areaId,to:places[1].areaId,travelMode:null},
      {id:'free-0',type:'free',title:'산책과 휴식',description:'가볍게 산책하거나 쉬어 가기',duration:90},
      {id:'lunch',type:'meal',title:'점심 식사',meal:'점심 식사',description:`${area.name}에서 점심 식사 · 식당을 특정하지 않음`,duration:60},
      {id:'place-1',type:'place',place:places[1],title:places[1].name,description:places[1].intro||'',duration:places[1].stayMinutes,transferBefore:toSecond},
      {id:'rest',type:'rest',title:'휴식 시간',description:'잠깐 쉬어 가기',duration:30},
      {id:'transfer-1',type:'transfer',title:'이동',description:'다음 장소로 이동 · 예상 소요시간',duration:toThird,from:places[1].areaId,to:places[2].areaId,travelMode:null},
      {id:'place-2',type:'place',place:places[2],title:places[2].name,description:places[2].intro||'',duration:places[2].stayMinutes,transferBefore:toThird},
      {id:'dinner',type:'meal',title:'저녁 식사',meal:'저녁 식사',description:`${area.name}에서 저녁 식사 · 식당을 특정하지 않음`,duration:60},
      {id:'free-1',type:'free',title:'권역에서 여유롭게 둘러보기',description:'산책이나 카페 방문 등, 내 마음대로 보내는 시간',duration:120},
      {id:'finish',type:'finish',title:'오늘 여행 마무리',description:'오늘의 길을 돌아보며, 편안하게 쉬어가요.',duration:0}
    ];
    const merged=flow.flatMap(base=>[...extras.filter(extra=>extra.beforeId===base.id),base]);
    const hiddenEvents=flow.filter(event=>excluded.includes(event.id)).map(event=>({...event,...edits[event.id]}));
    const active=merged.filter(event=>!excluded.includes(event.id));
    const combined=order?[...active.filter(event=>PROTECTED_IDS.includes(event.id)&&event.id!=='finish'),
      ...order.map(id=>active.find(event=>event.id===id)),active.find(event=>event.id==='finish')].filter(Boolean):active;
    const firstPlace=eventLocation(combined.map(event=>({...event,...edits[event.id]})).find(event=>!['departure','arrival','transfer','finish'].includes(event.type)&&visitEvent(event)));
    let clock=startMinutes(startTime);
    for(const base of combined){
      let defaults=base;
      if(base.id==='arrival-transfer')defaults={...base,from:arrival.id,to:firstPlace?.id??null,
        description:firstPlace?`${arrival.name} → ${firstPlace.name}`:'도착 후 관광지로 이동 · 방문할 관광지를 담아 주세요.'};
      if(base.type==='meal'&&!extraId(base.id)){
        const localTime=clock%(24*60);
        const meal=localTime<10*60?'아침 식사':localTime<15*60?'점심 식사':localTime<17*60?'오후 식사':localTime<21*60?'저녁 식사':'늦은 식사';
        defaults={...base,meal,title:meal,description:`${area.name}에서 ${meal} · 식당을 특정하지 않음`};
      }
      const event={...defaults,...edits[base.id]};
      const previousAt=events.findLastIndex(visitEvent),previous=events[previousAt];
      const routePending=Boolean(visitEvent(event)&&!['departure','arrival'].includes(event.type)&&previous&&previous.type!=='departure'&&!events.slice(previousAt+1).some(item=>item.type==='transfer'));
      events.push({...event,start:clock,end:clock+event.duration,startLabel:formatTime(clock),endLabel:formatTime(clock+event.duration),
        ...(routePending?{routePending:true}:{})});
      clock+=event.duration;
    }
    const travelDuration=events[0].duration;
    const arrivalTransfer=arrival?events.find(event=>event.id==='arrival-transfer').duration:null;
    const needsTravelTime=Boolean(departure&&(travelDuration===0||(publicTransport(departure)&&(!arrival||arrivalTransfer===0))));
    const needsLocalTravelTime=events.some(event=>event.type==='transfer'&&event.duration===0||event.routePending);
    return {ok:true,area,events,hiddenEvents,start:startMinutes(startTime),end:clock,
      needsTravelTime:needsTravelTime||needsLocalTravelTime,timesProvisional:!departure||needsTravelTime||needsLocalTravelTime};
  }
  const validVisitPoint=place=>Number.isFinite(place?.latitude)&&Number.isFinite(place?.longitude)
    &&place.latitude>=33&&place.latitude<=39.5&&place.longitude>=124&&place.longitude<=132;
  function visitDistance(from,to){
    const radians=value=>value*Math.PI/180,lat=radians(to.latitude-from.latitude),lon=radians(to.longitude-from.longitude);
    const h=Math.sin(lat/2)**2+Math.cos(radians(from.latitude))*Math.cos(radians(to.latitude))*Math.sin(lon/2)**2;
    return 6371000*2*Math.asin(Math.min(1,Math.sqrt(h)));
  }
  const preferredPlace=(place,preferences)=>preferences.includes(['nature','culture','rest'].includes(place.theme)?place.theme
    :String(place.contentTypeId)==='14'?'culture':null);
  function defaultSelection(area,excluded=new Set(),preferences=[]){
    const candidates=area.places.filter(place=>!excluded.has(place.id));
    if(candidates.length<3)return null;
    const matching=candidates.filter(place=>preferredPlace(place,preferences));
    if(matching.length)candidates.sort((a,b)=>Number(preferredPlace(b,preferences))-Number(preferredPlace(a,preferences)));
    // Only new recommendations use straight-line proximity. Saved selections
    // and manual visit orders take separate paths and keep their exact order.
    if(candidates.every(validVisitPoint)){
      const remaining=candidates.slice(1);
      const places=[candidates[0]];
      while(places.length<3){
        let closest=0,distance=visitDistance(places.at(-1),remaining[0]);
        for(let index=1;index<remaining.length;index++){
          const candidateDistance=visitDistance(places.at(-1),remaining[index]);
          const candidatePreferred=preferredPlace(remaining[index],preferences),currentPreferred=preferredPlace(remaining[closest],preferences);
          if(candidatePreferred&&!currentPreferred||candidatePreferred===currentPreferred&&candidateDistance<distance-0.000001){closest=index;distance=candidateDistance;}
        }
        places.push(remaining.splice(closest,1)[0]);
      }
      if(scheduleDay(area,places).ok)return places.map(place=>place.id);
    }
    for(let first=0;first<candidates.length-2;first++){
      for(let second=first+1;second<candidates.length-1;second++){
        for(let third=second+1;third<candidates.length;third++){
          const places=[candidates[first],candidates[second],candidates[third]];
          if(scheduleDay(area,places).ok)return places.map(place=>place.id);
        }
      }
    }
    return null;
  }
  function validateDayAreas(city,dayAreaIds,count,validation){
    if(!validation?.ok)return {ok:false,reason:validation?.reason||'도시의 권역 정보를 확인할 수 없습니다.'};
    if(!Array.isArray(dayAreaIds)||dayAreaIds.length!==count)
      return {ok:false,reason:'날짜별 방문 권역 목록의 길이가 여행 일수와 일치하지 않습니다.'};
    const seen=new Set();
    for(const id of dayAreaIds){
      if(typeof id!=='string'||!validation.areaIds.has(id))return {ok:false,reason:'날짜별 방문 권역에 현재 도시의 유효하지 않은 권역이 포함되어 있습니다.'};
      if(seen.has(id))return {ok:false,reason:'여행 중 같은 권역을 두 번 선택할 수 없습니다.'};
      seen.add(id);
    }
    return {ok:true};
  }

  function normalizePersonalization(value,count){
    if(value===undefined)return {ok:true};
    const invalid=()=>({ok:false,reason:'준비물·즐겨찾기·색상 태그의 저장 형식을 확인해 주세요.'});
    if(!record(value)||Object.keys(value).some(key=>!['checklist','favoritePlaceIds','eventTags'].includes(key)))return invalid();
    const checklist=value.checklist===undefined?[]:value.checklist,favorites=value.favoritePlaceIds===undefined?[]:value.favoritePlaceIds,tags=value.eventTags===undefined?{}:value.eventTags;
    if(!Array.isArray(checklist)||!Array.isArray(favorites)||!record(tags))return invalid();
    if(checklist.length>100)return {ok:false,reason:'준비물은 여행 노트마다 최대 100개까지 저장할 수 있어요.'};
    if(favorites.length>100)return {ok:false,reason:'즐겨찾기는 여행 노트마다 최대 100곳까지 저장할 수 있어요.'};
    const ids=new Set();
    for(const item of checklist){
      if(!record(item)||Object.keys(item).some(key=>!['id','text','done'].includes(key))||!/^item-[1-9]\d{0,8}$/.test(item.id)
        ||ids.has(item.id)||typeof item.text!=='string'||!item.text.trim()||item.text.length>120||/[\u0000-\u001f\u007f]/.test(item.text)||typeof item.done!=='boolean')return invalid();
      ids.add(item.id);
    }
    if(new Set(favorites).size!==favorites.length||favorites.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(id)))return invalid();
    for(const [day,entries] of Object.entries(tags)){
      if(!/^(0|[1-9]\d*)$/.test(day)||Number(day)>=count||!record(entries)||Object.keys(entries).length>34)return invalid();
      if(Object.entries(entries).some(([id,tag])=>(!['arrival',...EVENT_IDS].includes(id)&&!extraId(id))||!['must','booked','flex'].includes(tag)))return invalid();
    }
    return {ok:true,personalization:{checklist:checklist.map(item=>({...item,text:item.text.trim()})),favoritePlaceIds:[...favorites],
      eventTags:Object.fromEntries(Object.entries(tags).map(([day,entries])=>[day,{...entries}]))}};
  }
  function normalizeBudget(value,count){
    if(value===undefined)return {ok:true};
    const invalid=()=>({ok:false,reason:'예산은 날짜·분류·항목 이름과 0~10억 원의 정수 금액으로 입력해 주세요.'});
    if(!record(value)||Object.keys(value).some(key=>!['limit','items'].includes(key))||!Array.isArray(value.items)||value.items.length>200
      ||!(value.limit===null||Number.isSafeInteger(value.limit)&&value.limit>=0&&value.limit<=1000000000000))return invalid();
    const ids=new Set(),items=[];
    for(const item of value.items){
      if(!record(item)||Object.keys(item).some(key=>!['id','dayIndex','category','title','amount'].includes(key))
        ||typeof item.id!=='string'||!/^cost-[a-zA-Z0-9_-]{1,64}$/.test(item.id)||ids.has(item.id)
        ||!Number.isInteger(item.dayIndex)||item.dayIndex<0||item.dayIndex>=count||!['transport','stay','food','admission','other'].includes(item.category)
        ||typeof item.title!=='string'||!item.title.trim()||item.title.length>80||/[\u0000-\u001f\u007f]/.test(item.title)
        ||!Number.isSafeInteger(item.amount)||item.amount<0||item.amount>1000000000)return invalid();
      ids.add(item.id);items.push({...item,title:item.title.trim()});
    }
    return {ok:true,budget:{limit:value.limit,items}};
  }
  function createItinerary({city,startDate,dayCount,dayAreaIds,selections={},dayStarts={},eventEdits={},departure=null,dayDepartures={},dayArrivals={},dayTransports={},extraEvents={},excludedEvents={},eventOrders={},personalization,budget,preferences=[]}={}){
    const validation=validateCity(city);
    if(!validation.ok)return {ok:false,reason:validation.reason,days:[],maxDays:0};
    const maxDays=Math.min(MAX_TRIP_DAYS,city.supportedDays,city.areas.length);
    const count=Number(dayCount);
    if(!Array.isArray(preferences)||preferences.length>3||new Set(preferences).size!==preferences.length||preferences.some(value=>!['nature','culture','rest'].includes(value)))
      return {ok:false,reason:'여행 취향을 목록에서 선택해 주세요.',days:[],maxDays};
    if(!validDate(startDate))return {ok:false,reason:'여행 시작일을 올바르게 선택해 주세요.',days:[],maxDays};
    if(!Number.isInteger(count)||count<1||count>MAX_TRIP_DAYS)return {ok:false,reason:`여행 기간은 1~${MAX_TRIP_DAYS}일 중에서 선택해 주세요.`,days:[],maxDays};
    const personal=normalizePersonalization(personalization,count);
    if(!personal.ok)return {ok:false,reason:personal.reason,days:[],maxDays};
    const costs=normalizeBudget(budget,count);
    if(!costs.ok)return {ok:false,reason:costs.reason,days:[],maxDays};
    if(count>maxDays)return {ok:false,reason:`현재 데이터로 만들 수 있는 최대 일정은 ${maxDays}일입니다. 같은 장소로 빈 날짜를 채우지 않습니다.`,days:[],maxDays};
    const chosenAreaIds=dayAreaIds===undefined?city.areas.slice(0,count).map(area=>area.id):dayAreaIds;
    const areaValidation=validateDayAreas(city,chosenAreaIds,count,validation);
    if(!areaValidation.ok)return {ok:false,reason:areaValidation.reason,days:[],maxDays};
    if(!selections||typeof selections!=='object'||Array.isArray(selections))return {ok:false,reason:'선택한 장소 데이터 형식이 올바르지 않습니다.',days:[],maxDays};
    const selectionKeys=Object.keys(selections);
    if(selectionKeys.some(key=>!/^\d+$/.test(key)||Number(key)>=count))return {ok:false,reason:'선택한 일정 날짜가 여행 기간과 일치하지 않습니다.',days:[],maxDays};
    const options=normalizeOptions(dayStarts,eventEdits,count);
    if(!options.ok)return {ok:false,reason:options.reason,days:[],maxDays};
    const origins=normalizeDayDepartures(dayDepartures,departure,count);
    if(!origins.ok)return {ok:false,reason:origins.reason,days:[],maxDays};
    const arrivals=normalizeDayArrivals(dayArrivals,origins.dayDepartures,count);
    if(!arrivals.ok)return {ok:false,reason:arrivals.reason,days:[],maxDays};
    const extras=normalizeExtraEvents(extraEvents,count,validation.places,arrivals.dayArrivals);
    if(!extras.ok)return {ok:false,reason:extras.reason,days:[],maxDays};
    const layout=normalizeLayout(excludedEvents,eventOrders,count,extras.extraEvents);
    if(!layout.ok)return {ok:false,reason:layout.reason,days:[],maxDays};
    const transports=normalizeDayTransports(dayTransports,origins.dayDepartures,arrivals.dayArrivals,options.dayStarts,options.eventEdits,startDate,count);
    if(!transports.ok)return {ok:false,reason:transports.reason,days:[],maxDays};
    for(let index=0;index<count;index++){
      if(options.eventEdits[index]?.['arrival-transfer']&&!arrivals.dayArrivals[index])
        return {ok:false,reason:`${index+1}일차 도착지를 선택한 뒤 첫 관광지 이동시간을 입력해 주세요.`,days:[],maxDays};
    }

    const allById=new Map(validation.places.map(place=>[place.id,place]));
    const used=new Set(extras.placeIds),days=[],recommended={};
    for(let index=0;index<count;index++){
      const area=city.areas.find(item=>item.id===chosenAreaIds[index]);
      const ids=selections[index]===undefined?defaultSelection(area,used,preferences):selections[index];
      if(!ids)return {ok:false,reason:`${area.name}에는 서로 다른 장소 3곳으로 구성할 수 있는 일정이 부족합니다.`,days,maxDays:index};
      if(!Array.isArray(ids)||ids.length!==3||ids.some(id=>typeof id!=='string')||new Set(ids).size!==3)
        return {ok:false,reason:`${area.name}의 일정에는 서로 다른 장소 3곳이 필요합니다.`,days,maxDays:index};
      const places=ids.map(id=>allById.get(id));
      if(places.some(place=>!place||place.areaId!==area.id))return {ok:false,reason:`${area.name}에서 고른 장소가 이 권역의 장소 데이터와 일치하지 않습니다.`,days,maxDays};
      if(places.some((place,slot)=>!layout.excludedEvents[index]?.includes(`place-${slot}`)&&used.has(place.id)))return {ok:false,reason:'여행 전체에서 같은 장소를 중복 방문하도록 선택할 수 없습니다.',days,maxDays};
      const extraFlow=(extras.extraEvents[index]??[]).map(event=>event.type==='place'?{...event,place:allById.get(event.placeId)}:{...event});
      const result=scheduleDay(area,places,options.dayStarts[index],options.eventEdits[index],origins.dayDepartures[index],arrivals.dayArrivals[index],extraFlow,layout.excludedEvents[index],layout.eventOrders[index]);
      if(!result.ok)return {ok:false,reason:`${area.name}의 일정 장소를 확인할 수 없습니다.`,days,maxDays};
      places.forEach((place,slot)=>{if(!layout.excludedEvents[index]?.includes(`place-${slot}`))used.add(place.id);});
      recommended[index]=[...ids];
      days.push({index:index+1,date:fmtDate(startDate,index),area:area.name,areaId:area.id,departure:origins.dayDepartures[index],arrival:arrivals.dayArrivals[index],transport:transports.dayTransports[index],events:result.events,hiddenEvents:result.hiddenEvents,start:result.start,end:result.end,needsTravelTime:result.needsTravelTime,timesProvisional:result.timesProvisional});
    }
    if(personal.personalization){
      // Keep hidden recommendations tagged, but discard tags of deleted extra
      // events/arrival markers so reusing an event id cannot inherit an old tag.
      personal.personalization.eventTags=Object.fromEntries(Object.entries(personal.personalization.eventTags).flatMap(([day,entries])=>{
        const allowed=new Set([...days[day].events,...days[day].hiddenEvents].map(event=>event.id));
        const kept=Object.entries(entries).filter(([id])=>allowed.has(id));
        return kept.length?[[day,Object.fromEntries(kept)]]:[];
      }));
    }
    return {ok:true,cityId:city.id,cityName:city.name,countryName:window.TRAVEL_DATA.countries[city.country],startDate,dayCount:count,dayAreaIds:[...chosenAreaIds],selections:recommended,dayStarts:options.dayStarts,eventEdits:options.eventEdits,extraEvents:extras.extraEvents,excludedEvents:layout.excludedEvents,eventOrders:layout.eventOrders,departure:origins.dayDepartures[0],dayDepartures:origins.dayDepartures,dayArrivals:arrivals.dayArrivals,dayTransports:transports.dayTransports,days,maxDays,...(personal.personalization?{personalization:personal.personalization}:{}),...(costs.budget?{budget:costs.budget}:{})};
  }
  function selectionsFromItinerary(itinerary){
    if(itinerary.selections!==undefined)return record(itinerary.selections)?Object.fromEntries(Object.entries(itinerary.selections)
      .map(([key,ids])=>[key,Array.isArray(ids)?[...ids]:ids])):itinerary.selections;
    const selections={};
    itinerary.days.forEach((day,index)=>{selections[index]=placeEvents(day).filter(event=>!extraId(event.id)).map(event=>event.place?.id);});
    return selections;
  }
  function areaIdsFromItinerary(city,itinerary){
    if(!Array.isArray(itinerary?.days)||itinerary.days.length!==Number(itinerary.dayCount))return null;
    const ids=itinerary.days.map(day=>day?.areaId);
    if(itinerary.dayAreaIds&&JSON.stringify(itinerary.dayAreaIds)!==JSON.stringify(ids))return null;
    const validation=validateCity(city);
    return validateDayAreas(city,ids,ids.length,validation).ok?ids:null;
  }
  function rebuild(city,itinerary,changes={}){
    const next=createItinerary({city,startDate:itinerary.startDate,dayCount:itinerary.dayCount,
      dayAreaIds:areaIdsFromItinerary(city,itinerary),selections:selectionsFromItinerary(itinerary),
      dayStarts:itinerary.dayStarts,eventEdits:itinerary.eventEdits,extraEvents:itinerary.extraEvents,excludedEvents:itinerary.excludedEvents,eventOrders:itinerary.eventOrders,departure:itinerary.departure,dayDepartures:itinerary.dayDepartures,dayArrivals:itinerary.dayArrivals,dayTransports:itinerary.dayTransports,personalization:itinerary.personalization,budget:itinerary.budget,...changes});
    if(next.ok&&itinerary.dataSource!==undefined)next.dataSource=itinerary.dataSource;
    if(next.ok&&next.personalization){
      for(const [day,entries] of Object.entries(next.personalization.eventTags)){
        const oldEvents=[...(itinerary.days[day]?.events||[]),...(itinerary.days[day]?.hiddenEvents||[])];
        const newEvents=[...next.days[day].events,...next.days[day].hiddenEvents];
        for(const id of Object.keys(entries)){
          const before=oldEvents.find(event=>event.id===id),after=newEvents.find(event=>event.id===id);
          if(before&&after&&(before.place?.id!==after.place?.id||before.departure?.id!==after.departure?.id||before.arrival?.id!==after.arrival?.id))delete entries[id];
        }
        if(!Object.keys(entries).length)delete next.personalization.eventTags[day];
      }
    }
    return next;
  }
  function editableItinerary(city,itinerary,dayIndex){
    if(!itinerary||itinerary.cityId!==city?.id||!Array.isArray(itinerary.days)||!Number.isInteger(dayIndex)||dayIndex<0||dayIndex>=itinerary.days.length)
      return {ok:false,reason:'수정할 여행 일정 날짜를 확인할 수 없습니다.'};
    return rebuild(city,itinerary);
  }
  function localTravelLegs(day){
    const events=day.events,legs=new Map();
    const first=events.find(event=>!['departure','arrival','transfer','finish'].includes(event.type)&&visitEvent(event)) ;
    if(!requiresArrival(day.departure?.mode))legs.set('departure',JSON.stringify([visitIdentity(day.departure?{departure:day.departure}:null),visitIdentity(first)]));
    for(let index=0;index<events.length;index++){
      const event=events[index];
      if(event.type!=='transfer')continue;
      const origin=event.id==='arrival-transfer'?(day.arrival?{arrival:day.arrival}:null):events.slice(0,index).reverse().find(item=>!['transfer','finish'].includes(item.type)&&visitEvent(item));
      const destination=events.slice(index+1).find(item=>!['transfer','finish'].includes(item.type)&&visitEvent(item));
      // Use the same visible neighbours as the route lookup. Slot numbers and
      // intervening meals/rests do not identify a journey after manual moves.
      legs.set(event.id,JSON.stringify([visitIdentity(origin),visitIdentity(destination)]));
    }
    return legs;
  }
  function preserveUnchangedTravel(city,current,next,dayIndex){
    if(!next.ok)return next;
    const legsFor=itinerary=>{
      const day=itinerary.days[dayIndex],legs=localTravelLegs(day);
      // A hidden transfer still owns a manual edit. Compare the journey it
      // would have when restored so hiding it cannot revive a stale duration.
      for(const event of day.hiddenEvents.filter(item=>item.type==='transfer')){
        const excludedEvents={...itinerary.excludedEvents,[dayIndex]:itinerary.excludedEvents[dayIndex].filter(id=>id!==event.id)};
        const restored=rebuild(city,itinerary,{excludedEvents});
        if(restored.ok)legs.set(event.id,localTravelLegs(restored.days[dayIndex]).get(event.id));
      }
      return legs;
    };
    const previous=legsFor(current),following=legsFor(next);
    const changed=new Set([...following].filter(([id,leg])=>previous.has(id)&&previous.get(id)!==leg).map(([id])=>id));
    if(!changed.size)return next;
    const eventEdits={...next.eventEdits},edits={...eventEdits[dayIndex]};
    for(const id of changed){
      if(!edits[id]||edits[id].duration===0)continue;
      const patch={...edits[id]};delete patch.duration;
      if(Object.keys(patch).length)edits[id]=patch;else delete edits[id];
    }
    if(Object.keys(edits).length)eventEdits[dayIndex]=edits;else delete eventEdits[dayIndex];
    const extraEvents={...next.extraEvents};
    if(extraEvents[dayIndex])extraEvents[dayIndex]=extraEvents[dayIndex].map(event=>changed.has(event.id)&&event.type==='transfer'?{...event,duration:0}:event);
    return rebuild(city,next,{eventEdits,extraEvents});
  }
  function addEvent({city,itinerary,dayIndex,type='free',title,description,duration,placeId,beforeId='finish',travelMode,reservedEventIds=[]}={}){
    const current=editableItinerary(city,itinerary,dayIndex);
    if(!current.ok)return {ok:false,reason:current.reason};
    if(type==='place'&&Object.values(current.selections).flat().includes(placeId))return {ok:false,reason:'이미 추천한 관광지는 뺀 일정 다시 담기를 이용해 주세요.'};
    const entries=current.extraEvents[dayIndex]??[];
    if(!Array.isArray(reservedEventIds)||reservedEventIds.some(id=>!extraId(id)))return {ok:false,reason:'추가 일정의 이전 항목 정보를 확인해 주세요.'};
    if(!current.days[dayIndex].events.some(event=>event.id===beforeId&&!PROTECTED_IDS.includes(event.id)||event.id===beforeId&&event.id==='finish'))
      return {ok:false,reason:'추가 일정을 놓을 위치를 화면에 있는 일정에서 선택해 주세요.'};
    // UI history and move highlights can still reference deleted extras.
    const number=[...Object.values(current.extraEvents).flat().map(event=>event.id),...reservedEventIds].reduce((maximum,id)=>Math.max(maximum,Number(id.slice(6))),0)+1;
    const id=`extra-${number}`,place=type==='place'?validationPlace(city,placeId):null;
    const anchor=extraId(beforeId)?'finish':beforeId;
    const entry={id,type,beforeId:anchor,duration:duration===undefined?(place?.stayMinutes??({free:60,meal:60,rest:30,transfer:0})[type]):duration};
    if(title!==undefined)entry.title=title;
    if(description!==undefined)entry.description=description;
    if(type==='place'||placeId!==undefined)entry.placeId=placeId;
    if(travelMode!==undefined)entry.travelMode=travelMode;
    const order=current.days[dayIndex].events.filter(event=>!PROTECTED_IDS.includes(event.id)).map(event=>event.id);
    const at=beforeId==='finish'?order.length:order.indexOf(beforeId);order.splice(at,0,id);
    const changes={extraEvents:{...current.extraEvents,[dayIndex]:[...entries,entry]},eventOrders:{...current.eventOrders,[dayIndex]:order}};
    const validated=rebuild(city,current,changes);
    if(!validated.ok)return {ok:false,reason:validated.reason};
    const next=preserveUnchangedTravel(city,current,validated,dayIndex);
    return next.ok?{ok:true,itinerary:next,eventId:id}:{ok:false,reason:next.reason};
  }
  function removeEvent({city,itinerary,dayIndex,eventId}={}){
    const current=editableItinerary(city,itinerary,dayIndex);
    if(!current.ok)return {ok:false,reason:current.reason};
    const entries=current.extraEvents[dayIndex]??[],selected=entries.find(event=>event.id===eventId);
    if(!selected){
      if(!EDITABLE_IDS.includes(eventId)||!current.days[dayIndex].events.some(event=>event.id===eventId))
        return {ok:false,reason:'화면에 있는 관광지·식사·휴식·이동 일정만 뺄 수 있습니다.'};
      const excludedEvents={...current.excludedEvents,[dayIndex]:[...(current.excludedEvents[dayIndex]??[]),eventId]};
      const next=preserveUnchangedTravel(city,current,rebuild(city,current,{excludedEvents}),dayIndex);
      return next.ok?{ok:true,itinerary:next}:{ok:false,reason:next.reason};
    }
    const extraEvents={...current.extraEvents,[dayIndex]:entries.filter(event=>event.id!==eventId)};
    const next=preserveUnchangedTravel(city,current,rebuild(city,current,{extraEvents}),dayIndex);
    return next.ok?{ok:true,itinerary:next}:{ok:false,reason:next.reason};
  }
  function restoreEvent({city,itinerary,dayIndex,eventId}={}){
    const current=editableItinerary(city,itinerary,dayIndex);
    if(!current.ok)return {ok:false,reason:current.reason};
    if(!EDITABLE_IDS.includes(eventId)||!current.excludedEvents[dayIndex]?.includes(eventId))return {ok:false,reason:'뺀 기본 일정에서 다시 담을 항목을 골라 주세요.'};
    const excludedEvents={...current.excludedEvents,[dayIndex]:current.excludedEvents[dayIndex].filter(id=>id!==eventId)};
    const next=preserveUnchangedTravel(city,current,rebuild(city,current,{excludedEvents}),dayIndex);
    return next.ok?{ok:true,itinerary:next,eventId}:{ok:false,reason:next.reason};
  }
  function moveEvent({city,itinerary,dayIndex,eventId,direction,toIndex}={}){
    const current=editableItinerary(city,itinerary,dayIndex);
    if(!current.ok)return {ok:false,reason:current.reason};
    if(toIndex===undefined&&direction!==-1&&direction!==1)return {ok:false,reason:'일정을 위 또는 아래로 한 칸 이동해 주세요.'};
    const ids=current.days[dayIndex].events.filter(event=>!PROTECTED_IDS.includes(event.id)).map(event=>event.id);
    const position=ids.indexOf(eventId),destination=toIndex===undefined?position+direction:toIndex;
    if(position<0||!Number.isInteger(destination)||destination<0||destination>=ids.length)return {ok:false,reason:'출발·도착 이동과 마무리 사이에서만 일정을 이동할 수 있습니다.'};
    if(position===destination)return {ok:true,itinerary:current,eventId};
    ids.splice(position,1);ids.splice(destination,0,eventId);
    const next=preserveUnchangedTravel(city,current,rebuild(city,current,{eventOrders:{...current.eventOrders,[dayIndex]:ids}}),dayIndex);
    return next.ok?{ok:true,itinerary:next,eventId}:{ok:false,reason:next.reason};
  }
  function proposeVisitOrder({city,itinerary,dayIndex,mode='distance',costs}={}){
    if(!['distance','car'].includes(mode))return {ok:false,reason:'가까운 순서 또는 차량 경로 비교를 선택해 주세요.'};
    const current=editableItinerary(city,itinerary,dayIndex);
    if(!current.ok)return {ok:false,reason:current.reason};
    const events=current.days[dayIndex].events,visits=placeEvents(current.days[dayIndex]);
    if(visits.length<2||visits.length>5)return {ok:false,reason:'방문 장소가 2~5곳인 날짜에서 순서를 비교할 수 있어요.'};
    if(visits.some(event=>!validVisitPoint(event.place)))return {ok:false,reason:'모든 방문 장소의 확인 가능한 좌표가 필요해요.'};
    const beforeIds=visits.map(event=>event.id);
    if(new Set(beforeIds).size!==beforeIds.length)return {ok:false,reason:'방문 일정의 식별자가 중복되어 순서를 비교할 수 없어요.'};
    const graph=new Map();
    for(const from of visits)for(const to of visits){
      if(from.id===to.id)continue;
      const key=`${from.id}>${to.id}`,value=mode==='distance'?visitDistance(from.place,to.place)
        :costs instanceof Map?costs.get(key):record(costs)&&Object.hasOwn(costs,key)?costs[key]:undefined;
      if(!Number.isFinite(value)||value<0||mode==='car'&&(value<=0||value>1440))return {ok:false,reason:'방문 장소 사이의 모든 방향별 차량 경로를 확인한 뒤 비교해 주세요.'};
      graph.set(key,value);
    }
    const score=ids=>ids.slice(1).reduce((sum,id,index)=>sum+graph.get(`${ids[index]}>${id}`),0);
    const beforeCost=score(beforeIds),booked=new Set(Object.entries(current.personalization?.eventTags?.[dayIndex]??{}).filter(([,tag])=>tag==='booked').map(([id])=>id));
    const segments=new Map();let segment=0;
    for(const event of events){
      if(booked.has(event.id)){if(event.type==='place')segments.set(event.id,`fixed:${event.id}`);segment++;}
      else if(event.type==='place')segments.set(event.id,segment);
    }
    const candidates=[];
    function permute(ids,remaining){
      if(!remaining.length){candidates.push(ids);return;}
      const expected=segments.get(beforeIds[ids.length]);
      for(let index=0;index<remaining.length;index++)if(segments.get(remaining[index])===expected)
        permute([...ids,remaining[index]],remaining.filter((_,position)=>position!==index));
    }
    permute([],beforeIds);
    let best=current,afterIds=[...beforeIds],afterCost=beforeCost;
    const epsilon=0.000001;
    for(const ids of candidates){
      const cost=score(ids);if(cost>=afterCost-epsilon)continue;
      let at=0;
      const order=events.map(event=>event.type==='place'?ids[at++]:event.id).filter(id=>!PROTECTED_IDS.includes(id));
      const next=preserveUnchangedTravel(city,current,rebuild(city,current,{eventOrders:{...current.eventOrders,[dayIndex]:order}}),dayIndex);
      if(!next.ok)continue;
      // Booked meals, activities and arrival markers also act as barriers.
      // Resetting changed travel estimates must not shift a booked time.
      if(events.some(event=>booked.has(event.id)&&(()=>{const after=next.days[dayIndex].events.find(item=>item.id===event.id);return !after||event.start!==after.start||event.end!==after.end;})()))continue;
      best=next;afterIds=[...ids];afterCost=cost;
    }
    return {ok:true,changed:afterCost<beforeCost-epsilon,itinerary:best,beforeIds:[...beforeIds],afterIds,beforeCost,afterCost,unit:mode==='car'?'minutes':'meters'};
  }
  function updateEvent({city,itinerary,dayIndex,eventId,title,description,duration,beforeId,placeId,resetTitle=false,location}={}){
    const current=editableItinerary(city,itinerary,dayIndex);
    if(!current.ok)return {ok:false,reason:current.reason};
    if(extraId(eventId)){
      const entries=current.extraEvents[dayIndex]??[],selected=entries.find(event=>event.id===eventId);
      if(!selected)return {ok:false,reason:'수정할 추가 일정을 찾지 못했습니다.'};
      const patch={...selected};
      if(location!==undefined)patch.location=location;
      if(title!==undefined)patch.title=title;
      if(description!==undefined)patch.description=description;
      if(duration!==undefined)patch.duration=duration;
      if(placeId!==undefined){
        if(patch.type!=='place')return {ok:false,reason:'관광지 일정에만 장소를 지정할 수 있습니다.'};
        const place=validationPlace(city,placeId);
        if(!place)return {ok:false,reason:'현재 여행 지역의 관광지 목록에서 선택해 주세요.'};
        patch.placeId=placeId;patch.title=place.name;
      }
      if(beforeId!==undefined){
        if(!current.days[dayIndex].events.some(event=>event.id===beforeId&&(!PROTECTED_IDS.includes(event.id)||event.id==='finish')))
          return {ok:false,reason:'추가 일정을 놓을 위치를 화면에 있는 일정에서 선택해 주세요.'};
        patch.beforeId=beforeId;
      }
      const moved=beforeId!==undefined;
      const extraEvents={...current.extraEvents,[dayIndex]:entries.map(event=>event.id===eventId?patch:event)};
      const changes={extraEvents};
      if(moved)changes.eventOrders={...current.eventOrders,[dayIndex]:current.eventOrders[dayIndex].filter(id=>id!==eventId)};
      const next=preserveUnchangedTravel(city,current,rebuild(city,current,changes),dayIndex);
      return next.ok?{ok:true,itinerary:next}:{ok:false,reason:next.reason};
    }
    if(beforeId!==undefined)return {ok:false,reason:'직접 추가한 일정의 위치만 바꿀 수 있습니다.'};
    if(placeId!==undefined)return {ok:false,reason:'기본 관광지는 장소 변경 목록에서 교체해 주세요.'};
    if(!EVENT_IDS.includes(eventId))return {ok:false,reason:'수정할 일정의 ID를 확인할 수 없습니다.'};
    const patch={...current.eventEdits[dayIndex]?.[eventId]};
    if(location!==undefined)patch.location=location;
    if(title!==undefined)patch.title=title;
    if(resetTitle===true)delete patch.title;
    if(description!==undefined)patch.description=description;
    if(duration!==undefined)patch.duration=duration;
    const eventEdits={...current.eventEdits,[dayIndex]:{...current.eventEdits[dayIndex],[eventId]:patch}};
    const dayTransports={...current.dayTransports};
    if(eventId==='departure'&&duration!==undefined&&duration!==current.days[dayIndex].events[0].duration)dayTransports[dayIndex]=null;
    const next=preserveUnchangedTravel(city,current,rebuild(city,current,{eventEdits,dayTransports}),dayIndex);
    return next.ok?{ok:true,itinerary:next}:{ok:false,reason:next.reason};
  }
  function setTransferMode({city,itinerary,dayIndex,eventId,mode}={}){
    const current=editableItinerary(city,itinerary,dayIndex);
    if(!current.ok)return {ok:false,reason:current.reason};
    const selectedMode=canonicalTravelMode(mode);
    if(extraId(eventId)){
      const entries=current.extraEvents[dayIndex]??[],selected=entries.find(event=>event.id===eventId);
      if(selected?.type!=='transfer'||!TRANSFER_MODES.includes(selectedMode))return {ok:false,reason:'추가 이동수단을 목록에서 선택해 주세요.'};
      const extraEvents={...current.extraEvents,[dayIndex]:entries.map(event=>event.id===eventId?{...event,travelMode:selectedMode,
        duration:event.travelMode===selectedMode?event.duration:0}:event)};
      const next=rebuild(city,current,{extraEvents});
      return next.ok?{ok:true,itinerary:next}:{ok:false,reason:next.reason};
    }
    if(!LOCAL_TRANSFER_IDS.includes(eventId)||!TRANSFER_MODES.includes(selectedMode)||!current.days[dayIndex].events.some(event=>event.id===eventId&&event.type==='transfer'))return {ok:false,reason:'관광지까지 이동수단을 목록에서 선택해 주세요.'};
    const previous=current.days[dayIndex].events.find(event=>event.id===eventId)?.travelMode;
    const patch={...current.eventEdits[dayIndex]?.[eventId],travelMode:selectedMode};
    if(previous!==selectedMode&&!(vehicleMode(previous)&&vehicleMode(selectedMode)))delete patch.duration;
    const eventEdits={...current.eventEdits,[dayIndex]:{...current.eventEdits[dayIndex],[eventId]:patch}};
    const next=rebuild(city,current,{eventEdits});
    return next.ok?{ok:true,itinerary:next}:{ok:false,reason:next.reason};
  }
  function getTransferSuggestion({origin,destination}={}){
    const valid=point=>point&&Number.isFinite(point.latitude)&&Number.isFinite(point.longitude)
      &&point.latitude>=33&&point.latitude<=39.5&&point.longitude>=124&&point.longitude<=132;
    if(!valid(origin)||!valid(destination))return null;
    const radians=value=>value*Math.PI/180;
    const lat=radians(destination.latitude-origin.latitude),lon=radians(destination.longitude-origin.longitude);
    const a=Math.sin(lat/2)**2+Math.cos(radians(origin.latitude))*Math.cos(radians(destination.latitude))*Math.sin(lon/2)**2;
    const meters=6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a)));
    const distanceMeters=Math.round(meters);
    return meters<=800?{mode:'walk',label:'도보 추천',reason:'가까운 구간 · 직선거리 기준',distanceMeters}
      :{mode:null,label:'대중교통·차량 고려',reason:'노선과 실제 경로를 확인해 주세요.',distanceMeters};
  }
  function setDayStart({city,itinerary,dayIndex,startTime}={}){
    const current=editableItinerary(city,itinerary,dayIndex);
    if(!current.ok)return {ok:false,reason:current.reason};
    const dayTransports={...current.dayTransports};
    if(startTime!==current.dayStarts[dayIndex])dayTransports[dayIndex]=null;
    const next=rebuild(city,current,{dayStarts:{...current.dayStarts,[dayIndex]:startTime},dayTransports});
    return next.ok?{ok:true,itinerary:next}:{ok:false,reason:next.reason};
  }
  function setDayDeparture({city,itinerary,dayIndex,departure}={}){
    const current=editableItinerary(city,itinerary,dayIndex);
    if(!current.ok)return {ok:false,reason:current.reason};
    if(departure===undefined)return {ok:false,reason:'날짜별 출발지는 검색한 장소 또는 미선택 값이어야 합니다.'};
    const origin=normalizeDeparture(departure);
    if(!origin.ok)return {ok:false,reason:origin.reason};
    const previous=current.dayDepartures[dayIndex];
    const changed=origin.departure===null||previous?.id!==origin.departure?.id||previous?.mode!==origin.departure?.mode;
    const vehicleCategoryChanged=vehicleMode(previous?.mode)!==vehicleMode(origin.departure?.mode);
    const clearArrival=!origin.departure||previous?.mode!==origin.departure.mode
      ||previous?.source!==origin.departure.source||previous?.service!==origin.departure.service;
    const dayArrivals={...current.dayArrivals};
    if(clearArrival)dayArrivals[dayIndex]=null;
    const dayTransports={...current.dayTransports};
    if(changed||clearArrival)dayTransports[dayIndex]=null;
    const eventEdits={...current.eventEdits};
    if(changed&&eventEdits[dayIndex]){
      eventEdits[dayIndex]={...eventEdits[dayIndex]};
      delete eventEdits[dayIndex].departure;
      if(clearArrival)delete eventEdits[dayIndex]['arrival-transfer'];
      if(vehicleCategoryChanged)for(const id of ['transfer-0','transfer-1']){
        const patch=eventEdits[dayIndex][id];
        if(!patch||patch.travelMode)continue;
        eventEdits[dayIndex][id]={...patch};
        delete eventEdits[dayIndex][id].duration;
        if(!Object.keys(eventEdits[dayIndex][id]).length)delete eventEdits[dayIndex][id];
      }
      if(!Object.keys(eventEdits[dayIndex]).length)delete eventEdits[dayIndex];
    }
    const next=rebuild(city,current,{dayDepartures:{...current.dayDepartures,[dayIndex]:origin.departure},dayArrivals,dayTransports,eventEdits});
    return next.ok?{ok:true,itinerary:next}:{ok:false,reason:next.reason};
  }
  function setDayArrival({city,itinerary,dayIndex,arrival}={}){
    const current=editableItinerary(city,itinerary,dayIndex);
    if(!current.ok)return {ok:false,reason:current.reason};
    if(arrival===undefined)return {ok:false,reason:'날짜별 도착지는 검색한 장소 또는 미선택 값이어야 합니다.'};
    const arrivals=normalizeDayArrivals({...current.dayArrivals,[dayIndex]:arrival},current.dayDepartures,current.dayCount);
    if(!arrivals.ok)return {ok:false,reason:arrivals.reason};
    const previous=current.dayArrivals[dayIndex],selected=arrivals.dayArrivals[dayIndex];
    const changed=previous?.id!==selected?.id||previous?.mode!==selected?.mode;
    const dayTransports={...current.dayTransports};
    if(changed)dayTransports[dayIndex]=null;
    const eventEdits={...current.eventEdits};
    if(changed&&eventEdits[dayIndex]){
      eventEdits[dayIndex]={...eventEdits[dayIndex]};
      delete eventEdits[dayIndex].departure;
      delete eventEdits[dayIndex]['arrival-transfer'];
      if(!Object.keys(eventEdits[dayIndex]).length)delete eventEdits[dayIndex];
    }
    const next=rebuild(city,current,{dayArrivals:arrivals.dayArrivals,dayTransports,eventEdits});
    return next.ok?{ok:true,itinerary:next}:{ok:false,reason:next.reason};
  }
  function setDayTransport({city,itinerary,dayIndex,transport}={}){
    const current=editableItinerary(city,itinerary,dayIndex);
    if(!current.ok)return {ok:false,reason:current.reason};
    const selected=normalizeTransport(transport,current.dayDepartures[dayIndex],current.dayArrivals[dayIndex],calendarDate(current.startDate,dayIndex));
    if(!selected.ok)return {ok:false,reason:selected.reason};
    const changes={dayTransports:{...current.dayTransports,[dayIndex]:selected.transport}};
    if(selected.transport){
      changes.dayStarts={...current.dayStarts,[dayIndex]:formatTime(selected.transport.departureMinutes)};
      changes.eventEdits={...current.eventEdits,[dayIndex]:{...current.eventEdits[dayIndex],departure:{...current.eventEdits[dayIndex]?.departure,duration:selected.transport.durationMinutes}}};
    }
    const next=rebuild(city,current,changes);
    return next.ok?{ok:true,itinerary:next}:{ok:false,reason:next.reason};
  }
  function setDayConnection({city,itinerary,dayIndex,via,legs,minimumTransferMinutes=15}={}){
    const current=editableItinerary(city,itinerary,dayIndex);
    if(!current.ok)return {ok:false,reason:current.reason};
    const result=buildConnection({departure:current.dayDepartures[dayIndex],arrival:current.dayArrivals[dayIndex],via,legs,minimumTransferMinutes,date:calendarDate(current.startDate,dayIndex)});
    if(!result.ok)return result;
    return setDayTransport({city,itinerary:current,dayIndex,transport:result.transport});
  }
  function setDeparture({city,itinerary,departure}={}){
    return setDayDeparture({city,itinerary,dayIndex:0,departure});
  }
  function getAlternatives({city,itinerary,dayIndex,placeId}={}){
    const validation=validateCity(city);
    const dayAreaIds=areaIdsFromItinerary(city,itinerary);
    if(!validation.ok||!dayAreaIds||!itinerary||itinerary.cityId!==city.id||!Number.isInteger(dayIndex))return [];
    if(!normalizeOptions(itinerary.dayStarts===undefined?{}:itinerary.dayStarts,itinerary.eventEdits===undefined?{}:itinerary.eventEdits,Number(itinerary.dayCount)).ok)return [];
    const day=itinerary.days[dayIndex];
    if(!day||!Array.isArray(day.events))return [];
    const area=city.areas.find(item=>item.id===dayAreaIds[dayIndex]);
    if(!area||day.area!==area.name||day.areaId!==area.id)return [];
    const currentEvents=[...placeEvents(day),...placeEvents({events:day.hiddenEvents})].filter(event=>!extraId(event.id));
    const event=currentEvents.find(item=>item.place?.id===placeId);
    if(!event||currentEvents.length!==3||currentEvents.some(item=>item.place?.areaId!==area.id))return [];
    const used=new Set(itinerary.days.flatMap(item=>[...placeEvents(item),...placeEvents({events:item.hiddenEvents})].map(entry=>entry.place?.id)));
    const currentIds=currentEvents.map(item=>item.place.id);
    return area.places.filter(place=>place.id!==placeId&&!used.has(place.id)).filter(candidate=>{
      const ids=currentIds.map(id=>id===placeId?candidate.id:id);
      const places=ids.map(id=>area.places.find(item=>item.id===id));
      return places.every(item=>item&&item.areaId===area.id)&&scheduleDay(area,places).ok;
    });
  }
  function replacePlace({city,itinerary,dayIndex,placeId,replacementId}={}){
    if(!itinerary||itinerary.cityId!==city?.id||!Array.isArray(itinerary.days))return {ok:false,reason:'현재 도시의 일정이 아니므로 장소를 교체할 수 없습니다.'};
    const dayAreaIds=areaIdsFromItinerary(city,itinerary);
    if(!dayAreaIds)return {ok:false,reason:'날짜별 방문 권역을 확인할 수 없어 장소를 교체할 수 없습니다.'};
    const alternatives=getAlternatives({city,itinerary,dayIndex,placeId});
    const replacement=alternatives.find(place=>place.id===replacementId);
    if(!replacement)return {ok:false,reason:'중복되거나 현재 권역에 없는 장소라 교체할 수 없습니다.'};
    const options=normalizeOptions(itinerary.dayStarts===undefined?{}:itinerary.dayStarts,itinerary.eventEdits===undefined?{}:itinerary.eventEdits,Number(itinerary.dayCount));
    if(!options.ok)return {ok:false,reason:options.reason};
    const current=rebuild(city,itinerary);
    if(!current.ok)return {ok:false,reason:current.reason};
    const selections=selectionsFromItinerary(itinerary);
    const dayPlaces=selections[dayIndex],placeIndex=dayPlaces?.indexOf(placeId)??-1;
    if(placeIndex<0)return {ok:false,reason:'교체할 장소를 찾지 못했습니다.'};
    dayPlaces[placeIndex]=replacementId;
    if(options.eventEdits[dayIndex]){
      delete options.eventEdits[dayIndex][`place-${placeIndex}`];
      if(!Object.keys(options.eventEdits[dayIndex]).length)delete options.eventEdits[dayIndex];
    }
    const next=preserveUnchangedTravel(city,current,rebuild(city,itinerary,{dayAreaIds,selections,dayStarts:options.dayStarts,eventEdits:options.eventEdits}),dayIndex);
    if(!next.ok)return {ok:false,reason:next.reason};
    const ids=next.days.flatMap(day=>placeEvents(day).map(event=>event.place.id));
    if(new Set(ids).size!==ids.length)return {ok:false,reason:'교체 후 일정의 장소 중복을 확인하지 못했습니다.'};
    return {ok:true,itinerary:next,oldPlace:validationPlace(city,placeId),newPlace:replacement};
  }
  function replaceTouristEvent({city,itinerary,dayIndex,eventId,replacementId,reservedEventIds=[]}={}){
    const current=editableItinerary(city,itinerary,dayIndex);
    if(!current.ok)return {ok:false,reason:current.reason};
    const event=current.days[dayIndex].events.find(item=>item.id===eventId),replacement=validationPlace(city,replacementId);
    if(event?.type!=='place'||!replacement)return {ok:false,reason:'변경할 관광지와 현재 여행 지역의 새 관광지를 목록에서 선택해 주세요.'};
    if(event.place.id===replacement.id)return {ok:true,itinerary:current,eventId,oldPlace:event.place,newPlace:replacement};
    if(extraId(eventId)){
      const description=event.description??'';
      const oldIntro=(event.place.intro??'').slice(0,500).trim();
      const result=updateEvent({city,itinerary:current,dayIndex,eventId,placeId:replacement.id,duration:replacement.stayMinutes,
        description:!description||description===oldIntro?(replacement.intro??'').slice(0,500):description});
      return result.ok?{...result,eventId,oldPlace:event.place,newPlace:replacement}:result;
    }
    if(!/^place-[0-2]$/.test(eventId))return {ok:false,reason:'관광지 일정만 다른 장소로 변경할 수 있습니다.'};
    if(replacement.areaId===current.days[dayIndex].areaId){
      const result=replacePlace({city,itinerary:current,dayIndex,placeId:event.place.id,replacementId});
      return result.ok?{...result,eventId}:result;
    }
    const added=addEvent({city,itinerary:current,dayIndex,type:'place',placeId:replacement.id,beforeId:eventId,reservedEventIds,
      duration:replacement.stayMinutes,description:(replacement.intro??'').slice(0,500)});
    if(!added.ok)return added;
    const removed=removeEvent({city,itinerary:added.itinerary,dayIndex,eventId});
    return removed.ok?{...removed,eventId:added.eventId,oldPlace:event.place,newPlace:replacement}:removed;
  }
  function changeDayArea({city,itinerary,dayIndex,areaId}={}){
    const validation=validateCity(city);
    if(!validation.ok)return {ok:false,reason:validation.reason};
    const currentAreaIds=areaIdsFromItinerary(city,itinerary);
    if(!itinerary||itinerary.cityId!==city.id||!currentAreaIds)return {ok:false,reason:'현재 일정의 날짜별 방문 권역을 확인할 수 없습니다.'};
    if(!Number.isInteger(dayIndex)||dayIndex<0||dayIndex>=currentAreaIds.length)return {ok:false,reason:'변경할 여행 날짜를 확인할 수 없습니다.'};
    if(typeof areaId!=='string'||!validation.areaIds.has(areaId))return {ok:false,reason:'선택한 권역은 현재 도시의 권역이 아닙니다.'};
    if(currentAreaIds[dayIndex]===areaId)return {ok:false,reason:'이미 해당 날짜에 선택된 방문 권역입니다.'};
    const current=rebuild(city,itinerary);
    if(!current.ok)return {ok:false,reason:current.reason};
    const options=normalizeOptions(itinerary.dayStarts===undefined?{}:itinerary.dayStarts,itinerary.eventEdits===undefined?{}:itinerary.eventEdits,Number(itinerary.dayCount));
    if(!options.ok)return {ok:false,reason:options.reason};

    const nextAreaIds=[...currentAreaIds];
    const otherIndex=currentAreaIds.indexOf(areaId);
    const selections=selectionsFromItinerary(itinerary);
    let swapIndex=null;
    if(otherIndex>=0){
      nextAreaIds[dayIndex]=currentAreaIds[otherIndex];
      nextAreaIds[otherIndex]=currentAreaIds[dayIndex];
      const currentDaySelection=selections[dayIndex];
      selections[dayIndex]=selections[otherIndex];
      selections[otherIndex]=currentDaySelection;
      swapIndex=otherIndex;
    }else{
      nextAreaIds[dayIndex]=areaId;
      delete selections[dayIndex];
    }
    for(const affected of otherIndex>=0?[dayIndex,otherIndex]:[dayIndex]){
      const mainTravel=current.dayArrivals[affected]?options.eventEdits[affected]?.departure:null;
      if(mainTravel)options.eventEdits[affected]={departure:mainTravel};
      else delete options.eventEdits[affected];
    }
    let next=rebuild(city,itinerary,{dayAreaIds:nextAreaIds,selections,dayStarts:options.dayStarts,eventEdits:options.eventEdits});
    for(const affected of otherIndex>=0?[dayIndex,otherIndex]:[dayIndex])next=preserveUnchangedTravel(city,current,next,affected);
    if(!next.ok)return {ok:false,reason:next.reason};
    const ids=next.days.flatMap(day=>placeEvents(day).map(event=>event.place.id));
    if(new Set(ids).size!==ids.length)return {ok:false,reason:'권역 변경 후 장소 중복을 확인하지 못했습니다.'};
    return {ok:true,itinerary:next,changedIndex:dayIndex,swappedIndex:swapIndex,areaName:city.areas.find(area=>area.id===areaId).name};
  }
  function validationPlace(city,id){return allPlaces(city).find(place=>place.id===id)||null;}

  function updatePersonalization({city,itinerary,personalization}={}){
    if(!itinerary||itinerary.cityId!==city?.id)return {ok:false,reason:'수정할 여행 노트를 확인해 주세요.'};
    const next=rebuild(city,itinerary,{personalization});
    return next.ok?{ok:true,itinerary:next}:{ok:false,reason:next.reason};
  }
  function updateBudget({city,itinerary,budget}={}){
    if(!itinerary||itinerary.cityId!==city?.id)return {ok:false,reason:'수정할 여행 노트를 확인해 주세요.'};
    const next=rebuild(city,itinerary,{budget});
    return next.ok?{ok:true,itinerary:next}:{ok:false,reason:next.reason};
  }
  window.TravelPlanner={eventLocation,visitEvent,visitIdentity,localTravelLegs,createItinerary,proposeVisitOrder,getAlternatives,replacePlace,replaceTouristEvent,changeDayArea,addEvent,removeEvent,restoreEvent,moveEvent,updateEvent,updatePersonalization,updateBudget,setTransferMode,getTransferSuggestion,setDayStart,setDeparture,setDayDeparture,setDayArrival,setDayTransport,setDayConnection,buildConnection,requiresArrival,validateCity,allPlaces,formatTime,areaIdsFromItinerary};
})();

(function(){
  'use strict';
  const SOURCE_URL='https://www.data.go.kr/data/15101578/openapi.do';
  const MAX_TRIP_DAYS=7;
  const pendingCities=new Map();
  let destinations=null,pendingDestinations=null;
  const validCode=code=>typeof code==='string'&&/^[1-9]\d*$/.test(code);
  const radians=value=>value*Math.PI/180;
  const byContentId=(a,b)=>a.contentId.length-b.contentId.length||(a.contentId<b.contentId?-1:a.contentId>b.contentId?1:0);
  function distance(a,b){
    const dLat=radians(b.latitude-a.latitude),dLon=radians(b.longitude-a.longitude);
    const h=Math.sin(dLat/2)**2+Math.cos(radians(a.latitude))*Math.cos(radians(b.latitude))*Math.sin(dLon/2)**2;
    return 6371.0088*2*Math.asin(Math.min(1,Math.sqrt(h)));
  }
  async function request(url,label){
    if(location.protocol==='file:')throw new Error('관광정보를 불러오려면 npm start로 실행한 http://127.0.0.1:3000에서 열어 주세요.');
    let response;
    try{response=await fetch(url,{signal:AbortSignal.timeout(120000)});}
    catch(error){throw new Error(`${label}에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.`);}
    let payload;
    try{payload=await response.json();}catch(error){throw new Error('관광정보 응답을 읽지 못했어요. npm start로 앱을 실행했는지 확인해 주세요.');}
    if(!response.ok)throw new Error(typeof payload?.error==='string'?payload.error:typeof payload?.error?.message==='string'?payload.error.message:`${label}를 불러오지 못했어요.`);
    return payload;
  }
  async function loadDestinations(){
    if(destinations)return destinations.slice();
    if(!pendingDestinations)pendingDestinations=(async()=>{
      const payload=await request('/api/tour/areas','전국 여행지 목록');
      if(!Array.isArray(payload?.items)||!payload.items.length)throw new Error('공공 관광정보의 여행지 목록 형식이 올바르지 않습니다.');
      const codes=new Set();
      const entries=payload.items.map(item=>{
        if(!item||!validCode(item.code)||typeof item.name!=='string'||!item.name.trim()||codes.has(item.code))
          throw new Error('공공 관광정보의 여행지 목록 형식이 올바르지 않습니다.');
        codes.add(item.code);
        return {code:item.code,name:item.name.trim()};
      });
      // Validate the entire response before touching registered city objects.
      const cities=entries.map(({code,name})=>{
        const id=code==='1'?'seoul':code==='6'?'busan':`tour-area-${code}`;
        let city=window.TRAVEL_DATA.cities[id];
        if(!city){
          city={id,country:'KR',name,timezone:'Asia/Seoul',supportedDays:MAX_TRIP_DAYS,areas:[]};
          window.TRAVEL_DATA.cities[id]=city;
        }
        Object.assign(city,{country:'KR',name,timezone:'Asia/Seoul',tourAreaCode:code});
        if(city.dataSource!=='tourapi'&&!city.areas?.length)city.supportedDays=MAX_TRIP_DAYS;
        return city;
      });
      destinations=cities;
      return cities.slice();
    })().finally(()=>{pendingDestinations=null;});
    return pendingDestinations;
  }
  function getDestinations(){return destinations?destinations.slice():[];}
  function validItems(items,areaCode){
    if(!Array.isArray(items))return [];
    const seen=new Set(),valid=[];
    for(const item of items){
      if(!item||typeof item.contentId!=='string'||!/^\d+$/.test(item.contentId)||seen.has(item.contentId)
        ||typeof item.title!=='string'||!item.title.trim()||!['12','14'].includes(String(item.contentTypeId))
        ||!Number.isFinite(item.latitude)||!Number.isFinite(item.longitude)
        ||item.latitude<33||item.latitude>39.5||item.longitude<124||item.longitude>132
        ||(item.areaCode!==undefined&&String(item.areaCode)!==areaCode))continue;
      seen.add(item.contentId);
      valid.push(item);
    }
    return valid;
  }
  function placeFrom(item,area){
    const address=typeof item.address==='string'?item.address.trim():'';
    const theme=['nature','culture','rest'].includes(item.theme)?item.theme:String(item.contentTypeId)==='14'?'culture':null;
    const metadata=item.classification;
    const classification=metadata&&typeof metadata==='object'&&[1,2,3].every(level=>typeof metadata[`code${level}`]==='string'&&(!metadata[`code${level}`]||/^[A-Z][A-Z0-9]{1,15}$/.test(metadata[`code${level}`]))&&typeof metadata[`name${level}`]==='string'&&metadata[`name${level}`].length<=80)
      ?{...Object.fromEntries([1,2,3].flatMap(level=>[[`code${level}`,metadata[`code${level}`]],[`name${level}`,metadata[`name${level}`]]]))}:null;
    return {
      id:`tourapi-${item.contentId}`,contentId:item.contentId,name:item.title.trim(),
      area:area.name,areaName:area.name,areaId:area.id,
      category:String(item.contentTypeId)==='14'?'문화시설':'관광지',
      stayMinutes:String(item.contentTypeId)==='14'?75:60,
      intro:address||'방문 전 시설의 운영시간과 예약 정보를 확인해 주세요.',
      address,latitude:item.latitude,longitude:item.longitude,imageUrl:typeof item.imageUrl==='string'?item.imageUrl:'',
      mapQuery:`${item.latitude},${item.longitude}`,source:'한국관광공사 TourAPI',sourceUrl:SOURCE_URL,
      stayBasis:'앱 추천 체류시간',hoursNotice:'방문 전 운영시간 확인',distanceToCenter:distance(item,area),
      contentTypeId:String(item.contentTypeId),...(theme?{theme}:{}),...(classification?{classification}:{})
    };
  }
  function sortPlaces(area){
    area.places.sort((a,b)=>a.distanceToCenter-b.distanceToCenter||byContentId(a,b));
    return area;
  }
  function clusterName(item){
    const address=typeof item.address==='string'?item.address.trim():'';
    const locality=address.split(/\s+/).filter(part=>/^[가-힣\d·]+(?:구|군|읍|면|동)$/.test(part));
    return locality.length?`${locality.slice(0,2).join(' ')} · ${item.title.trim()} 주변`:`${item.title.trim()} 주변`;
  }
  function buildAreas(items,areaCode='1'){
    const valid=validItems(items,String(areaCode));
    const sorted=[...valid].sort(byContentId),used=new Set(),areas=[];
    // Every member stays within 2.5 km of its actual representative point.
    // Content ID order keeps area IDs stable when response ordering changes.
    for(const anchor of sorted){
      if(used.has(anchor.contentId))continue;
      const nearby=sorted.filter(item=>!used.has(item.contentId)&&distance(anchor,item)<=2.5);
      if(nearby.length<3)continue;
      const area={id:`tour-cluster-${anchor.contentId}`,name:clusterName(anchor),latitude:anchor.latitude,longitude:anchor.longitude,places:[]};
      area.places=nearby.map(item=>placeFrom(item,area));
      nearby.forEach(item=>used.add(item.contentId));
      areas.push(sortPlaces(area));
    }
    return areas;
  }
  function buildCatalog(items,areaCode='1',cityName='',areas=[]){
    const code=String(areaCode);
    const clustered=new Map((Array.isArray(areas)?areas:[]).flatMap(area=>Array.isArray(area?.places)?area.places:[])
      .filter(place=>typeof place?.id==='string').map(place=>[place.id,place]));
    const name=typeof cityName==='string'&&cityName.trim()?`${cityName.trim()} 전체`:'지역 전체';
    return validItems(items,code).sort(byContentId).map(item=>clustered.get(`tourapi-${item.contentId}`)||placeFrom(item,{
      id:`tour-catalog-${code}`,name,latitude:item.latitude,longitude:item.longitude
    }));
  }
  async function ensureCity(cityId){
    const city=window.TRAVEL_DATA.cities[cityId];
    if(!city)throw new Error('선택한 여행지 도시를 찾을 수 없습니다. 여행지 목록을 다시 불러와 주세요.');
    const areaCode=city.tourAreaCode||(cityId==='seoul'?'1':cityId==='busan'?'6':null);
    if(!validCode(areaCode))throw new Error('선택한 여행지의 공공 관광정보 지역코드를 확인하지 못했어요. 여행지 목록을 다시 불러와 주세요.');
    if(city.dataSource==='tourapi'&&Array.isArray(city.catalogPlaces))return city;
    if(!pendingCities.has(areaCode)){
      const pending=(async()=>{
        const payload=await request(`/api/tour/places?areaCode=${encodeURIComponent(areaCode)}`,`${city.name} 관광정보`);
        if(!Array.isArray(payload?.items))throw new Error(`${city.name} 관광정보의 형식이 올바르지 않습니다.`);
        if(String(payload.areaCode)!==areaCode)throw new Error('선택한 여행지와 관광정보의 지역코드가 다릅니다. 다시 시도해 주세요.');
        const areas=buildAreas(payload.items,areaCode);
        if(!areas.length)throw new Error(`${city.name}에는 가까운 관광지 3곳을 묶을 수 있는 권역별 관광정보가 부족해요. 다른 여행지를 선택하거나 잠시 후 다시 시도해 주세요.`);
        const catalogPlaces=buildCatalog(payload.items,areaCode,city.name,areas);
        Object.assign(city,{areas,catalogPlaces,supportedDays:Math.min(MAX_TRIP_DAYS,areas.length),tourAreaCode:areaCode,dataSource:'tourapi',sourceLabel:'한국관광공사 TourAPI',sourceUrl:SOURCE_URL,fetchedAt:payload.fetchedAt});
        return city;
      })().finally(()=>{pendingCities.delete(areaCode);});
      pendingCities.set(areaCode,pending);
    }
    return pendingCities.get(areaCode);
  }
  window.TourData={loadDestinations,getDestinations,ensureCity,buildAreas,buildCatalog};
})();

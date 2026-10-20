/* 일본 정리 CSV 전용 로더. sources.json의 outputs만 읽고 원본 CSV에는 접근하지 않습니다. */
(function(){
  'use strict';

  const REGION_DEFS={
    tokyo:{label:'도쿄도 · 고토구',scope:'도쿄도 고토구 관광시설 자료',datasets:['tokyo_koto_tourism']},
    kyoto:{label:'교토부',scope:'교토부 여러 시·정',datasets:['kyoto_prefecture_tourism_20210902']},
    osaka:{label:'오사카부',scope:'오사카부 관광시설 자료',datasets:['osaka_prefecture_tourism']},
    sapporo:{label:'홋카이도 · 삿포로 도심',scope:'삿포로 도심 자료 (홋카이도 전체가 아님)',datasets:['hokkaido_sapporo_downtown_tourism']},
    fukuoka:{label:'후쿠오카시',scope:'후쿠오카시 박물관·문화시설',datasets:['fukuoka_city_museums','fukuoka_city_cultural_facilities'],mealDatasets:['fukuoka_city_yatai_food_stalls']},
    okinawa:{label:'오키나와현 · 오키나와시 및 현내 해변 자료',scope:'오키나와시 관광시설과 현내 여러 지역 해변 (서로 다른 섬은 별도 권역)',datasets:['okinawa_city_tourism_2025-04-01','okinawa_ottop_beaches']},
    fuji:{label:'시즈오카현 · 후지노미야 및 현내 전망지 자료',scope:'후지노미야 관광시설과 시즈오카현 후지산 전망지',datasets:['fuji_fujinomiya_tourism','fuji_shizuoka_viewpoints_projected']},
    kobe:{label:'고베시',scope:'고베시 문화·관광시설 자료',datasets:['kobe_culture_tourism_barrierfree']},
    hiroshima:{label:'히로시마시',scope:'히로시마시 관광시설 자료 (미야지마 포함 히로시마현 전체가 아님)',datasets:['hiroshima_city_tourism_20190801']},
    sango:{label:'나라현 · 산고정',scope:'나라현 산고정 및 자료에 표시된 개별 행정구역',datasets:['nara_sango_tourism']}
  };
  const cache={manifest:null,datasets:new Map(),regions:new Map(),cities:new Map(),cityOrigins:new Map()};
  const PLACE_CACHE_LIMIT=0;
  const EARTH_KM=6371.0088;
  const MAX_CLUSTER_RADIUS_KM=2.2;
  const OUTDOOR_OR_VISITOR=/博物館|美術館|資料館|資料室|記念館|展示館|科学館|水族館|動植物園|植物園|庭園|公園|神社|寺|城|史跡|遺跡|展望|観光|歴史|文化財|自然|景観|滝|湖|海岸|ビーチ|市場|資料|museum|gallery|garden|park|shrine|temple|castle|heritage|viewpoint|waterfall|lake|beach/i;
  const FOOD=/飲食店|レストラン|喫茶|カフェ|屋台|食堂|料理店|居酒屋|寿司|鮨|焼肉|ラーメン|グルメ|食品|料亭|food|restaurant|cafe|dining|bar\b|eatery|yatai/i;
  const LODGING=/宿泊|ホテル|旅館|民宿|ゲストハウス|ペンション|キャンプ場|コテージ|宿\b|hotel|inn\b|hostel|lodging|accommodation/i;
  const NON_VISITOR=/会議室|会議場|会議センター|コンベンション|貸会議|展示即売|事務所|営業所|庁舎|市役所|区役所|図書館|図書室|公民館|研修施設|結婚式場|宴会場|劇場|ホール|多目的施設|conference|meeting room|convention|office|library|wedding|banquet|theater|theatre/i;
  const CULTURAL_VISITOR=/博物館|美術館|資料館|資料室|記念館|展示館|科学館|水族館|動植物園|植物園|庭園|公園|神社|寺|城|史跡|遺跡|観光|歴史|文化財|museum|gallery|garden|park|shrine|temple|castle|heritage/i;

  function csvRecords(text){
    if(typeof text!=='string')throw new Error('CSV 내용을 읽을 수 없습니다.');
    const input=text.charCodeAt(0)===0xFEFF?text.slice(1):text;
    const rows=[];let row=[],cell='',quoted=false;
    for(let i=0;i<input.length;i++){
      const ch=input[i];
      if(quoted){
        if(ch==='"'&&input[i+1]==='"'){cell+='"';i++;}
        else if(ch==='"')quoted=false;
        else cell+=ch;
      }else if(ch==='"')quoted=true;
      else if(ch===','){row.push(cell);cell='';}
      else if(ch==='\r'||ch==='\n'){
        if(ch==='\r'&&input[i+1]==='\n')i++;
        row.push(cell);cell='';
        if(row.some(value=>value!==''))rows.push(row);
        row=[];
      }else cell+=ch;
    }
    if(quoted)throw new Error('CSV 따옴표가 닫히지 않은 행이 있습니다.');
    if(cell!==''||row.length){row.push(cell);if(row.some(value=>value!==''))rows.push(row);}
    if(!rows.length)throw new Error('CSV에 헤더나 데이터가 없습니다.');
    const headers=rows.shift().map(value=>value.trim());
    if(new Set(headers).size!==headers.length)throw new Error('CSV 헤더 이름이 중복되어 안전하게 읽을 수 없습니다.');
    return rows.map((values,index)=>{
      if(values.length!==headers.length)throw new Error(`CSV ${index+2}행의 열 개수가 헤더와 다릅니다.`);
      const result={};headers.forEach((header,column)=>{result[header]=values[column];});return result;
    });
  }
  function clean(value){return typeof value==='string'?value.trim():'';}
  function first(row,names){for(const name of names){const value=clean(row[name]);if(value)return value;}return '';}
  function numberCoordinate(row,key,fallback){const value=Number(clean(row[key])||clean(row[fallback]));return Number.isFinite(value)?value:null;}
  function distanceKm(a,b){
    const radians=value=>value*Math.PI/180;
    const dLat=radians(b.lat-a.lat),dLon=radians(b.lon-a.lon);
    const x=Math.sin(dLat/2)**2+Math.cos(radians(a.lat))*Math.cos(radians(b.lat))*Math.sin(dLon/2)**2;
    return 2*EARTH_KM*Math.asin(Math.min(1,Math.sqrt(x)));
  }
  function hash(text){let value=2166136261;for(let i=0;i<text.length;i++){value^=text.charCodeAt(i);value=Math.imul(value,16777619);}return (value>>>0).toString(36);}
  function normName(value){return clean(value).normalize('NFKC').toLowerCase().replace(/[\s　・･、。，．.\-‐‑–—()（）［］【】「」『』]/g,'');}
  function manifest(){
    if(cache.manifest)return cache.manifest;
    cache.manifest=fetch('./data/sources.json',{cache:'force-cache'}).then(response=>{
      if(!response.ok)throw new Error(`자료 목록을 읽지 못했습니다 (HTTP ${response.status}).`);
      return response.json();
    }).then(value=>{
      if(!Array.isArray(value?.datasets))throw new Error('자료 목록의 형식이 올바르지 않습니다.');
      return value;
    });
    return cache.manifest;
  }
  async function loadDataset(datasetId){
    if(cache.datasets.has(datasetId))return cache.datasets.get(datasetId);
    const task=(async()=>{
      const catalog=await manifest();
      const dataset=catalog.datasets.find(item=>item.dataset_id===datasetId);
      if(!dataset||!Array.isArray(dataset.outputs)||!dataset.outputs.length)throw new Error(`자료 목록에 ${datasetId} 정리본이 없습니다.`);
      const records=[];
      for(const output of dataset.outputs){
        if(typeof output.path!=='string'||!output.path.startsWith('csv/')||output.path.includes('..')||!output.path.endsWith('.csv'))
          throw new Error(`${datasetId}의 정리본 경로가 허용 범위 밖입니다.`);
        const response=await fetch(`./data/${output.path}`,{cache:'force-cache'});
        if(!response.ok)throw new Error(`${output.path} 파일을 읽지 못했습니다 (HTTP ${response.status}).`);
        const parsed=csvRecords(await response.text());
        if(parsed.some(row=>row._dataset_id!==datasetId))throw new Error(`${output.path}의 데이터셋 식별자가 목록과 다릅니다.`);
        records.push(...parsed);
      }
      return {dataset,records};
    })();
    cache.datasets.set(datasetId,task);
    try{return await task;}catch(error){cache.datasets.delete(datasetId);throw error;}
  }
  function sourceRows(dataset,records){
    const options=[];
    for(let index=0;index<records.length;index++){
      const row=records[index];
      const name=clean(row._name_original)||first(row,['名称','施設名','場所','name']);
      const lat=numberCoordinate(row,'_latitude','coordinates[1]');
      const lon=numberCoordinate(row,'_longitude','coordinates[0]');
      if(!name||lat===null||lon===null||lat < -90||lat>90||lon < -180||lon>180)continue;
      const datasetId=clean(row._dataset_id)||dataset.dataset_id;
      const sourceRow=clean(row._source_row_number)||String(index+1);
      const sourceId=first(row,['ID','屋台ID','NO','施設ID','id']);
      const identifier=`${datasetId}:${encodeURIComponent(sourceId||'row').toLowerCase()}:${sourceRow}`;
      const nameNorm=normName(name);
      if(!nameNorm)continue;
      const location=first(row,['所在地_連結表記','住所','所在地','address']);
      const municipality=municipalityFor(datasetId,row,location,name);
      if(!municipality)continue;
      const categories=first(row,['分類','カテゴリ','カテゴリー','category','ジャンル','テーマ（旅行の趣向性）','POI分類']);
      const titleCategory=`${name} ${categories}`;
      const description=first(row,['説明','コメント','本文','リード文']);
      const sourcePage=clean(row._source_page)||dataset.source||'';
      const license=clean(row._source_license)||dataset.license||'자료에 라이선스 정보 없음';
      options.push({
        id:identifier,sourceId,sourceRow,name,nameNorm,lat,lon,municipality,location,categories,description,
        datasetId,sourcePage,license,publisher:dataset.publisher||'자료 제공자 미표기',
        sourceLabel:dataset.label||datasetId,raw:row,titleCategory
      });
    }
    return options;
  }
  function municipalityFor(datasetId,row,address,name){
    if(datasetId==='fuji_shizuoka_viewpoints_projected'){
      const leading=clean(name).split(/[\s　]+/)[0];
      if(/(?:市|区|町|村)$/.test(leading))return leading;
      return '';
    }
    const field=first(row,['所在地_市区町村','市区町村名','所在地_市区町村名','自治体名','市町村','municipality','区名']);
    if(field){
      const fromAddress=administrativeName(address);
      if(fromAddress&&field.includes('市')&&fromAddress.startsWith(field))return fromAddress;
      return field;
    }
    return administrativeName(address);
  }
  function administrativeName(value){
    const text=clean(value);
    if(!text)return '';
    const m=text.match(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶー]+市[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶー]+区)/u)
      ||text.match(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ヶー]+(?:市|区|町|村))/u);
    return m?m[1]:'';
  }
  function isMeal(row){
    const name=first(row.raw,['名称','施設名','name','_name_original']);
    return FOOD.test(`${name} ${row.categories}`);
  }
  function isExcluded(row,regionId){
    const classification=String(row.categories||'');
    if(FOOD.test(`${row.name} ${classification}`)||LODGING.test(`${row.name} ${classification}`)||NON_VISITOR.test(`${row.name} ${classification}`))return true;
    if(regionId==='fukuoka'&&row.datasetId==='fukuoka_city_cultural_facilities'&&!CULTURAL_VISITOR.test(row.name))return true;
    return false;
  }
  function uniquePlaces(rows){
    const result=[];
    for(const item of rows){
      const duplicate=result.find(existing=>{
        if(existing.nameNorm!==item.nameNorm)return false;
        if(item.datasetId==='fuji_shizuoka_viewpoints_projected'&&existing.datasetId===item.datasetId)return true;
        return distanceKm(existing,item)<0.35;
      });
      if(!duplicate)result.push(item);
    }
    return result;
  }
  function makeAreas(items,regionId){
    const byLocality=new Map();
    for(const item of items){
      const zone=regionId==='sapporo'?first(item.raw,['エリア']):'';
      const key=`${item.municipality}::${zone}`;
      if(!byLocality.has(key))byLocality.set(key,{municipality:item.municipality,zone,places:[]});
      byLocality.get(key).places.push(item);
    }
    const areas=[];
    for(const group of byLocality.values()){
      const clusters=[];
      const ordered=[...group.places].sort((a,b)=>a.lat-b.lat||a.lon-b.lon||a.id.localeCompare(b.id));
      for(const place of ordered){
        let best=null,bestDistance=Infinity;
        for(const cluster of clusters){
          const center={lat:cluster.latTotal/cluster.places.length,lon:cluster.lonTotal/cluster.places.length};
          const d=distanceKm(center,place);
          if(d<=MAX_CLUSTER_RADIUS_KM&&d<bestDistance){best=cluster;bestDistance=d;}
        }
        if(!best){best={places:[],latTotal:0,lonTotal:0};clusters.push(best);}
        best.places.push(place);best.latTotal+=place.lat;best.lonTotal+=place.lon;
      }
      clusters.forEach((cluster,index)=>{
        const places=cluster.places;
        if(places.length<3)return;
        const label=group.zone?`${group.municipality} · ${group.zone}`:clusters.length===1?`${group.municipality} · 근거리 권역`:`${group.municipality} · 근거리 권역 ${index+1}`;
        const seed=`${regionId}|${group.municipality}|${group.zone}|${places[0].id}`;
        areas.push({id:`jp-area-${hash(seed)}`,name:label,places:places.map(item=>convertPlace(item,label,`jp-area-${hash(seed)}`))});
      });
    }
    return areas.sort((a,b)=>a.name.localeCompare(b.name,'ja'));
  }
  function stayRecommendation(item){
    const category=item.categories||'';
    if(/博物館|美術館|資料館|記念館|科学館|museum|gallery/i.test(`${item.name} ${category}`))return 90;
    if(/公園|庭園|自然|滝|湖|海岸|ビーチ|史跡|神社|寺|城|市場|展望|park|garden|beach|shrine|temple|castle/i.test(`${item.name} ${category}`))return 75;
    return 75;
  }
  function convertPlace(item,areaName,areaId){
    const row=item.raw;
    const category=item.categories||'관광 후보 · 원본 분류 미제공';
    const description=item.description||'자료에 설명이 제공되지 않습니다.';
    return {
      id:item.id,name:item.name,area:areaName,areaName,areaId,
      category,stayMinutes:stayRecommendation(item),intro:description,
      mapQuery:[item.name,item.municipality].filter(Boolean).join(' '),
      source:`${item.publisher} · ${item.sourceLabel}`,
      sourceUrl:item.sourcePage,sourceLicense:item.license,sourceRow:item.sourceRow,sourceId:item.sourceId,
      latitude:item.lat,longitude:item.lon,address:item.location,
      stayBasis:'앱 추천 체류시간',hoursNotice:'자료의 운영정보를 현재 시점에서 확인하지 않았습니다. 방문 전 최신 운영시간을 확인해 주세요.'
    };
  }
  async function loadRegion(regionId){
    if(cache.regions.has(regionId))return cache.regions.get(regionId);
    const definition=REGION_DEFS[regionId];
    if(!definition)throw new Error('자료가 실제로 확보되지 않은 여행 지역입니다.');
    const task=(async()=>{
      const settled=await Promise.all(definition.datasets.map(loadDataset));
      const catalog=await manifest();
      let tourism=[];
      for(const entry of settled){
        const dataset=entry.dataset;
        tourism.push(...sourceRows(dataset,entry.records));
      }
      const meals=[];
      for(const mealId of definition.mealDatasets||[]){
        const entry=await loadDataset(mealId);
        const parsed=sourceRows(entry.dataset,entry.records);
        for(const item of parsed){
          const flag=clean(item.raw['開業／廃業フラグ']);
          if(mealId==='fukuoka_city_yatai_food_stalls'&&flag!=='0')continue;
          if(isMeal(item))meals.push(item);
        }
      }
      if(regionId==='sango')tourism=tourism.filter(item=>!/大阪府/.test(item.location));
      const touristCandidates=uniquePlaces(tourism.filter(item=>!isExcluded(item,regionId)));
      const region={id:regionId,...definition,rows:tourism,places:touristCandidates,mealCandidates:meals,catalog,loadedAt:Date.now()};
      return region;
    })();
    cache.regions.set(regionId,task);
    try{return await task;}catch(error){cache.regions.delete(regionId);throw error;}
  }
  function destinations(region){
    const groups=new Map();
    for(const place of region.places){
      if(!groups.has(place.municipality))groups.set(place.municipality,[]);
      groups.get(place.municipality).push(place);
    }
    return [...groups.entries()].map(([name,places])=>{
      const areas=makeAreas(places,region.id);
      return {key:name,name,areaCount:areas.length,placeCount:areas.reduce((sum,area)=>sum+area.places.length,0),mealCount:region.mealCandidates.filter(item=>item.municipality===name).length};
    }).filter(item=>item.areaCount>0).sort((a,b)=>a.name.localeCompare(b.name,'ja'));
  }
  function buildCity(regionId,destinationName){
    const regionTask=cache.regions.get(regionId);
    if(!regionTask||typeof regionTask.then!=='function')throw new Error('먼저 해당 지역의 CSV 자료를 불러와 주세요.');
    throw new Error('지역 자료를 불러오는 중입니다. 잠시 후 다시 선택해 주세요.');
  }
  async function createCity(regionId,destinationName){
    const region=await loadRegion(regionId);
    const selected=region.places.filter(item=>item.municipality===destinationName);
    if(!selected.length)throw new Error('선택한 행정구역에 관광 후보가 없습니다. 다른 지역을 대신 표시하지 않았습니다.');
    const areas=makeAreas(selected,regionId);
    if(!areas.length)throw new Error('이 지역에는 같은 근거리 권역에서 구성할 수 있는 서로 다른 관광 후보가 3곳 미만입니다. 데이터 부족으로 일정을 만들 수 없습니다.');
    const encoded=encodeURIComponent(destinationName).toLowerCase();
    const cityId=`jp-data-${regionId}-${encoded}`;
    const catalog=region.catalog;
    const datasetIds=region.datasets;
    const datasetMeta=datasetIds.map(id=>catalog.datasets.find(item=>item.dataset_id===id)).filter(Boolean);
    const city={id:cityId,country:'JP',name:`${region.label} · ${destinationName}`,timezone:'Asia/Tokyo',supportedDays:Math.min(3,areas.length),sourceLabel:region.scope,sourceUrl:datasetMeta[0]?.source||'',areas,mealCandidates:region.mealCandidates.filter(item=>item.municipality===destinationName).map(item=>({name:item.name,sourcePage:item.sourcePage,license:item.license,category:'식사 후보',kind:'meal'}))};
    window.TRAVEL_DATA.cities[cityId]=city;
    const validAreas=[];
    for(const area of city.areas){
      const check=window.TravelPlanner.createItinerary({city,startDate:'2030-01-01',dayCount:1,dayAreaIds:[area.id]});
      if(check.ok)validAreas.push(area);
    }
    city.areas=validAreas;
    city.supportedDays=Math.min(3,validAreas.length);
    cache.cities.set(cityId,city);
    cache.cityOrigins.set(cityId,{regionId,destinationName});
    if(city.supportedDays===0){delete window.TRAVEL_DATA.cities[cityId];cache.cities.delete(cityId);throw new Error('이 지역의 후보 조합은 하루 18:00 종료 조건을 만족하지 않습니다. 가능한 일정으로 표시하지 않았습니다.');}
    return city;
  }
  function destinationFromCityId(cityId){
    if(typeof cityId!=='string'||!cityId.startsWith('jp-data-'))return null;
    const rest=cityId.slice('jp-data-'.length);
    const separator=rest.indexOf('-');
    if(separator<1)return null;
    const regionId=rest.slice(0,separator);
    let destinationName;
    try{destinationName=decodeURIComponent(rest.slice(separator+1));}catch(error){return null;}
    if(!REGION_DEFS[regionId]||!destinationName)return null;
    return {regionId,destinationName};
  }
  async function restoreCity(cityId){
    const existing=window.TRAVEL_DATA.cities[cityId];
    if(existing)return existing;
    const origin=destinationFromCityId(cityId);
    if(!origin)return null;
    const city=await createCity(origin.regionId,origin.destinationName);
    if(city.id!==cityId)throw new Error('저장된 지역 식별자와 현재 자료의 지역 식별자가 다릅니다.');
    return city;
  }
  function listRegions(){return Object.entries(REGION_DEFS).map(([id,value])=>({id,label:value.label,scope:value.scope}));}
  window.RegionalDataLoader={listRegions,loadRegion,destinations,createCity,restoreCity,csvRecords,regionDefinitions:REGION_DEFS};
})();

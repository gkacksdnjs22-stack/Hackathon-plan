(function(){
  'use strict';
  function create(itinerary,{title='나의 여행 계획',includeMemos=false,includeDeparture=false}={}){
    if(!itinerary?.ok||!Array.isArray(itinerary.days)||itinerary.days.length!==itinerary.dayCount)throw Error('저장할 여행 노트를 확인해 주세요.');
    const clean=(value,max)=>String(value||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,max);
    return {version:1,title:clean(title,80),cityName:clean(itinerary.cityName,80),startDate:itinerary.startDate,dayCount:itinerary.dayCount,
      days:itinerary.days.map((day,index)=>({date:new Date(Date.parse(`${itinerary.startDate}T00:00:00Z`)+index*86400000).toISOString().slice(0,10),
        provisional:Boolean(day.timesProvisional),events:day.events.map(event=>{
          // The first transfer carries arrival details, including its generated memo
          // and an editable title, even though its event type is only 'transfer'.
          const arrivalTransfer=event.id==='arrival-transfer'||(event.type==='transfer'&&Boolean(event.arrival));
          const sensitive=['departure','arrival'].includes(event.type)||arrivalTransfer||Boolean(event.departure||event.arrival);
          const title=event.type==='place'?event.place?.name:event.type==='departure'?(includeDeparture&&event.departure?`${event.departure.name}에서 출발`:'출발')
            :event.type==='arrival'?(includeDeparture?event.title||event.arrival?.name:'도착')
            :sensitive&&!includeDeparture?(arrivalTransfer?'첫 관광지로 이동':'이동'):event.title||event.meal||'일정';
          return {type:event.type,title:clean(title,240),start:event.start,end:event.end,
            address:clean(sensitive&&!includeDeparture?'':event.place?.address||event.location?.address||event.departure?.address||event.arrival?.address,500),
            memo:clean(includeMemos&&(!sensitive||includeDeparture)?event.description:'',500)};
        })}))};
  }
  window.TravelNoteSnapshot={create};
})();

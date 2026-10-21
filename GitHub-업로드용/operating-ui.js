(function(){
  'use strict';
  function mount(host,{getContext}){
    if(!host)return {refresh(){}};
    const node=(tag,text='')=>{const element=document.createElement(tag);element.textContent=text;return element;};
    const summary=node('summary','운영시간·휴무 확인'),body=node('div');body.className='sharing-body';
    const hint=node('p','현재 날짜에 담은 관광지를 5곳씩 확인해요. 제공된 운영정보와 계획 시각을 비교하며, 정보가 없거나 복잡한 조건은 확인 필요로 표시해요.');
    const check=node('button','운영정보 확인');check.type='button';check.className='button button-quiet';
    const status=node('p');status.className='sharing-status';status.setAttribute('role','status');
    const list=node('ul');list.className='operating-results';body.append(hint,check,status,list);host.append(summary,body);
    let generation=0,fingerprint='',controller=null,busy=false,cursor=0;
    const state=()=>getContext();
    const signature=value=>value?.itinerary?JSON.stringify([value.ownerId,value.dayIndex,value.projection,value.itinerary.startDate,value.itinerary.days[value.dayIndex]]):'';
    function refresh(){const value=state(),next=signature(value);if(next!==fingerprint){fingerprint=next;generation++;controller?.abort();controller=null;busy=false;cursor=0;list.replaceChildren();status.textContent='';check.textContent='운영정보 확인';}check.disabled=busy||!value?.itinerary;}
    function valid(data,event){return data?.provider==='한국관광공사 TourAPI'&&data.contentId===event.place.contentId&&String(data.contentTypeId)===String(event.place.contentTypeId)
      &&['available','unknown'].includes(data.status)&&typeof data.hoursText==='string'&&data.hoursText.length<=3000&&typeof data.closedText==='string'&&data.closedText.length<=3000
      &&Number.isFinite(Date.parse(data.fetchedAt))&&data.sourceUrl==='https://www.data.go.kr/data/15101578/openapi.do';}
    check.addEventListener('click',async()=>{
      refresh();const value=state();if(!value?.itinerary||busy)return;
      const day=value.itinerary.days[value.dayIndex],events=day.events.filter(event=>event.type==='place');
      if(cursor>=events.length){cursor=0;list.replaceChildren();}
      const version=generation,start=cursor;busy=true;const requestController=new AbortController();controller=requestController;const signal=requestController.signal;
      const timer=setTimeout(()=>requestController.abort(),45000);refresh();
      try{
        for(const event of events.slice(start,start+5)){
          if(version!==generation||signature(state())!==fingerprint)return;
          const row=node('li');row.className='operating-result';row.append(node('strong',event.place.name));
          status.textContent=`운영정보 확인 중 · ${cursor+1}/${events.length}곳`;
          try{
            if(!/^\d{1,60}$/.test(event.place.contentId)||!['12','14'].includes(String(event.place.contentTypeId)))throw Error('unavailable');
            const query=new URLSearchParams({contentId:event.place.contentId,contentTypeId:String(event.place.contentTypeId)});
            const response=await fetch(`/api/tour/place-details?${query}`,{cache:'no-store',credentials:'same-origin',signal});
            if(!response.ok)throw Error('unavailable');const data=await response.json();if(!valid(data,event))throw Error('invalid');
            const date=new Date(Date.parse(`${value.itinerary.startDate}T00:00:00Z`)+value.dayIndex*86400000).toISOString().slice(0,10);
            const result=window.TravelOperatingInfo.assess({...data,date,start:event.start,end:event.end,provisional:day.timesProvisional});
            if(value.projection)row.append(node('p','현재 경로 조회로 화면에 표시된 시각을 비교했어요. 조회를 닫거나 경로를 바꾸면 다시 확인해 주세요.'));
            row.append(node('p',`이용시간: ${data.hoursText||'정보 없음'}`),node('p',`휴무: ${data.closedText||'정보 없음'}`));
            for(const message of result.messages)row.append(node('p',message));
            const source=node('a',`한국관광공사 TourAPI · ${new Intl.DateTimeFormat('ko-KR',{dateStyle:'short',timeStyle:'short'}).format(new Date(data.fetchedAt))} 조회`);
            source.href=data.sourceUrl;source.target='_blank';source.rel='noopener noreferrer';row.append(source);
          }catch{row.append(node('p','확인 필요 · 운영정보를 확인하지 못했어요. 장소의 공식 안내를 확인하거나 다시 조회해 주세요.'));}
          if(version!==generation||signature(state())!==fingerprint)return;list.append(row);cursor++;
        }
        status.textContent=`${cursor}/${events.length}곳 확인 · 실제 운영은 방문 전에 다시 확인해 주세요.`;
        check.textContent=cursor<events.length?'다음 관광지 운영정보 확인':'운영정보 다시 확인';
      }finally{clearTimeout(timer);if(version===generation){busy=false;controller=null;refresh();}}
    });
    host.addEventListener('toggle',()=>{if(!host.open){generation++;controller?.abort();busy=false;controller=null;check.disabled=false;}});refresh();host.hidden=false;return {refresh};
  }
  window.TravelOperating={mount};
})();

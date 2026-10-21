(function(){
  'use strict';
  const point=value=>value&&Number.isFinite(value.latitude)&&Number.isFinite(value.longitude)&&value.latitude>=33&&value.latitude<=39.5&&value.longitude>=124&&value.longitude<=132;
  const same=(a,b)=>point(a)&&point(b)&&Math.abs(a.latitude-b.latitude)<0.000001&&Math.abs(a.longitude-b.longitude)<0.000001;
  function mount(host,{getContext,onApply}){
    if(!host)return {refresh(){}};
    const node=(tag,text='')=>{const element=document.createElement(tag);element.textContent=text;return element;};
    const summary=node('summary','방문 순서 제안'),body=node('div');body.className='sharing-body';
    const hint=node('p','현재 날짜의 관광지 2~5곳 사이 이동을 비교해요. 예약 완료 일정과 식사·휴식의 순서 자리는 유지해요. 적용 전에 장소 순서를 확인해 주세요.');
    const controls=node('div');controls.className='sharing-actions';const label=node('label','비교 기준 '),mode=node('select');mode.setAttribute('aria-label','방문 순서 비교 기준');
    for(const [value,text]of [['distance','가까운 순서 · 직선거리'],['car','차량 이동시간 · 현재 교통']]){const option=node('option',text);option.value=value;mode.append(option);}label.append(mode);
    const compare=node('button','순서 비교');compare.type='button';compare.className='button button-quiet';
    const apply=node('button','제안 순서 적용');apply.type='button';apply.className='button button-quiet';apply.disabled=true;controls.append(label,compare,apply);
    const status=node('p');status.className='sharing-status';status.setAttribute('role','status');const preview=node('div');preview.className='order-preview';
    body.append(hint,controls,status,preview);host.append(summary,body);
    let generation=0,fingerprint='',controller=null,busy=false,proposal=null;
    const signature=value=>value?.itinerary?JSON.stringify([value.ownerId,value.dayIndex,value.itinerary]):'';
    function clear(){proposal=null;preview.replaceChildren();apply.disabled=true;}
    function refresh(){const value=getContext(),next=signature(value);if(next!==fingerprint){fingerprint=next;generation++;controller?.abort();controller=null;busy=false;clear();status.textContent='';}compare.disabled=busy||!value?.itinerary;mode.disabled=busy;apply.disabled=busy||!proposal?.changed;}
    compare.addEventListener('click',async()=>{
      refresh();const value=getContext();if(!value?.itinerary||busy)return;const version=generation;clear();busy=true;const requestController=new AbortController();controller=requestController;const signal=requestController.signal;const timer=setTimeout(()=>requestController.abort(),45000);refresh();
      try{
        const events=value.itinerary.days[value.dayIndex].events.filter(event=>event.type==='place');
        if(events.length<2||events.length>5||events.some(event=>!point(event.place)))throw Error('좌표가 확인된 관광지가 2~5곳인 날짜에서 비교할 수 있어요.');
        const costs={};let completed=0;
        if(mode.value==='car')for(const from of events)for(const to of events){if(from===to)continue;
          status.textContent=`차량 구간 확인 중 · ${++completed}/${events.length*(events.length-1)}`;
          const query=new URLSearchParams({originLatitude:String(from.place.latitude),originLongitude:String(from.place.longitude),destinationLatitude:String(to.place.latitude),destinationLongitude:String(to.place.longitude)});
          const response=await fetch(`/api/car-route?${query}`,{credentials:'same-origin',cache:'no-store',signal});if(!response.ok)throw Error('차량 이동시간을 확인하지 못했어요. 다시 조회하거나 직선거리 기준으로 비교해 주세요.');
          const data=await response.json();if(data?.provider!=='카카오모빌리티'||data.reference!=='현재 교통 기준'||!same(data.origin,from.place)||!same(data.destination,to.place)
            ||!Number.isSafeInteger(data.durationSeconds)||data.durationSeconds<1||data.durationSeconds>86400||!Number.isFinite(Date.parse(data.fetchedAt)))throw Error('차량 조회 결과를 확인하지 못했어요. 다시 비교해 주세요.');
          costs[`${from.id}>${to.id}`]=data.durationSeconds/60;
          if(version!==generation||signature(getContext())!==fingerprint)return;
        }
        if(version!==generation||signature(getContext())!==fingerprint)return;
        const result=window.TravelPlanner.proposeVisitOrder({...value,mode:mode.value,costs});
        if(!result.ok)throw Error(result.reason);proposal=result;
        if(!result.changed){status.textContent='고정한 일정을 유지하면서 더 줄일 수 있는 순서가 없어요.';return;}
        const names=ids=>ids.map(id=>events.find(event=>event.id===id)?.place.name||'관광지').join(' → ');
        const cost=number=>result.unit==='minutes'?`${Math.round(number*10)/10}분`:`${(number/1000).toFixed(2)}km`;
        preview.append(node('p',`현재: ${names(result.beforeIds)} · ${cost(result.beforeCost)}`),node('p',`제안: ${names(result.afterIds)} · ${cost(result.afterCost)}`));
        status.textContent=mode.value==='car'?'관광지 사이 차량 이동만 현재 교통 기준으로 비교했어요. 출발·귀가 구간과 여행 당일 교통은 다를 수 있어요.':'직선거리 비교예요. 실제 도로·대중교통 시간과 다를 수 있어요.';
      }catch(error){if(version===generation)status.textContent=error.name==='AbortError'?'비교 시간이 길어 중단했어요. 다시 시도해 주세요.':error.message;}
      finally{clearTimeout(timer);if(version===generation){busy=false;controller=null;refresh();}}
    });
    mode.addEventListener('change',()=>{clear();status.textContent='기준을 바꿨어요. 다시 비교해 주세요.';});
    apply.addEventListener('click',()=>{const value=getContext();if(!proposal?.changed||busy||signature(value)!==fingerprint){refresh();return;}const result=onApply(proposal.itinerary);if(result?.ok===false)status.textContent=result.reason;});
    host.addEventListener('toggle',()=>{if(!host.open){generation++;controller?.abort();controller=null;busy=false;clear();refresh();}});refresh();host.hidden=false;return {refresh};
  }
  window.TravelVisitOrder={mount};
})();

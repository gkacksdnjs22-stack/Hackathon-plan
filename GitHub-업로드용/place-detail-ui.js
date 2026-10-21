(function(){
  'use strict';
  const node=(tag,className='',text='')=>{const element=document.createElement(tag);element.className=className;element.textContent=text;return element;};
  function safeUrl(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}}
  function mount(content,place,{candidate=false}={}){
    const host=node('details',candidate?'place-detail candidate-preview':'place-detail'),summary=node('summary','','장소 상세정보'),body=node('div','place-detail-body');
    const status=node('p','place-detail-status'),result=node('div','place-detail-result'),retry=node('button','place-detail-retry','상세정보 다시 조회');
    status.setAttribute('role','status');retry.type='button';retry.hidden=true;
    body.append(node('h4','',place.name),node('p','',place.address||'주소 정보가 제공되지 않았어요.'),status,result,retry);
    if(candidate){summary.textContent='사진·지역·소개 확인';body.prepend(node('p','candidate-region',`${place.areaName||place.area||''} · ${place.category||'관광지'}`));}
    host.append(summary,body);content.append(host);
    let version=0,controller=null,timer=null,loaded=false,destroyed=false;
    const contentId=String(place.contentId||place.id?.match(/^tourapi-(\d+)$/)?.[1]||''),contentTypeId=place.contentTypeId||(place.category==='문화시설'?'14':'12');
    function cancel(){version++;controller?.abort();controller=null;clearTimeout(timer);timer=null;}
    async function load(){
      cancel();const current=version;
      if(!/^[1-9]\d{0,11}$/.test(contentId)||!['12','14'].includes(contentTypeId)){status.textContent='이 장소는 추가 상세정보를 제공하지 않아요. 위의 이름과 주소를 참고해 주세요.';return;}
      const request=new AbortController();controller=request;let timedOut=false;
      timer=setTimeout(()=>{timedOut=true;request.abort();},35000);
      status.textContent='장소 상세정보를 불러오는 중이에요.';retry.hidden=true;
      try{
        const response=await fetch(`/api/tour/place-detail?contentId=${encodeURIComponent(contentId)}&contentTypeId=${contentTypeId}`,{signal:request.signal,headers:{Accept:'application/json'}});
        const data=await response.json();
        if(destroyed||current!==version||!host.open)return;
        if(!response.ok)throw Error('request');
        if(data?.contentId!==contentId||data.contentTypeId!==contentTypeId||typeof data.title!=='string')throw Error('format');
        result.replaceChildren();
        const description=node('p','place-detail-overview',typeof data.overview==='string'&&data.overview?(candidate?data.overview.slice(0,220):data.overview):'이 장소의 자세한 설명은 제공되지 않았어요.');result.append(description);
        const imageUrl=safeUrl(data.imageUrl);
        if(imageUrl){
          const figure=node('figure'),image=node('img','place-detail-photo');image.src=imageUrl;image.alt=`${place.name} 제공 사진`;image.loading='lazy';image.referrerPolicy='no-referrer';
          const caption=node('figcaption','','사진: 한국관광공사 TourAPI 제공');
          image.addEventListener('error',()=>{image.remove();caption.textContent='제공 사진을 불러오지 못했어요.';});figure.append(image,caption);result.append(figure);
        }else result.append(node('p','place-detail-missing','제공된 사진이 없어요.'));
        const fields=node('dl','place-detail-fields');
        for(const [label,key] of [['운영시간','hours'],['휴무일','closed'],['이용요금','fee'],['주차','parking'],['문의','phone']])fields.append(node('dt','',label),node('dd','',typeof data[key]==='string'&&data[key]?data[key]:'정보 미제공'));
        if(!candidate)result.append(fields);
        const homepage=safeUrl(data.homepage);
        if(homepage){const link=node('a','','시설 홈페이지 ↗');link.href=homepage;link.target='_blank';link.rel='noopener noreferrer';result.append(link);}
        const credit=node('p','place-detail-source'),source=node('a','','한국관광공사 TourAPI');source.href='https://www.data.go.kr/data/15101578/openapi.do';source.target='_blank';source.rel='noopener noreferrer';credit.append(source);
        if(typeof data.fetchedAt==='string'&&Number.isFinite(Date.parse(data.fetchedAt)))credit.append(node('span','',` · 조회 ${new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(data.fetchedAt))}`));
        result.append(credit,node('p','place-detail-hint','운영시간·요금은 바뀔 수 있어요. 방문 전 시설에 확인해 주세요.'));
        loaded=!data.partial;retry.hidden=loaded;status.textContent=data.partial?'기본 정보를 불러왔지만 일부 운영정보 조회에 실패했어요. 다시 조회할 수 있어요.':'';
      }catch{
        if(destroyed||current!==version||!host.open)return;
        status.textContent=timedOut?'상세정보 응답이 늦어지고 있어요. 다시 시도해 주세요.':'상세정보를 불러오지 못했어요. 이름·주소는 위에서 확인하고 다시 시도해 주세요.';retry.hidden=false;
      }finally{if(current===version){clearTimeout(timer);timer=null;controller=null;}}
    }
    host.addEventListener('toggle',()=>{if(!host.open)cancel();else if(!loaded)load();});
    retry.addEventListener('click',load);
    if(candidate)host.open=true;
    return {destroy(){destroyed=true;cancel();host.remove();}};
  }
  window.TravelPlaceDetail={mount};
})();

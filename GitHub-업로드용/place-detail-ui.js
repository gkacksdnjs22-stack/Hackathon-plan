(function(){
  'use strict';
  const node=(tag,className='',text='')=>{const element=document.createElement(tag);element.className=className;element.textContent=text;return element;};
  let sequence=0,activePopup=null;
  function safeUrl(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}}
  function mount(content,place,{candidate=false}={}){
    const host=node('details',candidate?'place-detail candidate-preview':'place-detail'),summary=node('summary','','장소 상세정보'),body=node('div','place-detail-body');
    const status=node('p','place-detail-status'),result=node('div','place-detail-result'),retry=node('button','place-detail-retry','상세정보 다시 조회');
    status.setAttribute('role','status');retry.type='button';retry.hidden=true;
    body.append(node('h4','',place.name),node('p','',place.address||'주소 정보가 제공되지 않았어요.'),status,result,retry);
    if(candidate){summary.textContent='사진·지역·소개 확인';body.prepend(node('p','candidate-region',`${place.areaName||place.area||''} · ${place.category||'관광지'}`));}
    host.append(summary,body);content.append(host);
    const dialogId=`place-detail-dialog-${++sequence}`;
    let version=0,controller=null,timer=null,loaded=false,destroyed=false,detailData=null,dialog=null,openButton=null;
    const contentId=String(place.contentId||place.id?.match(/^tourapi-(\d+)$/)?.[1]||''),contentTypeId=place.contentTypeId||(place.category==='문화시설'?'14':'12');
    function cancel(){version++;controller?.abort();controller=null;clearTimeout(timer);timer=null;}
    function closePopup({restoreFocus=true}={}){
      if(!dialog)return;
      const popup=dialog;dialog=null;
      if(activePopup===closePopup)activePopup=null;
      window.removeEventListener('hashchange',onNavigation);
      openButton?.setAttribute('aria-expanded','false');
      if(popup.open)popup.close();popup.remove();
      if(restoreFocus&&openButton?.isConnected&&host.open)openButton.focus({preventScroll:true});
    }
    function onNavigation(){closePopup({restoreFocus:false});}
    function openPopup(){
      if(destroyed||!detailData||!host.open||!host.isConnected)return;
      if(dialog?.open)return;
      activePopup?.({restoreFocus:false});
      const popup=node('dialog','place-detail-dialog');popup.id=dialogId;popup.setAttribute('aria-labelledby',`${dialogId}-title`);
      const heading=node('div','place-detail-dialog-heading'),title=node('h2','',`${place.name} — 소개·장소 정보`);title.id=`${dialogId}-title`;
      const close=node('button','place-detail-dialog-close','닫기');close.type='button';close.autofocus=true;
      heading.append(title,close);
      const full=node('div','place-detail-dialog-body');
      full.append(node('p','',place.address||'주소 정보가 제공되지 않았어요.'),node('h3','','관광지 소개'),node('p','place-detail-full-overview',overviewText(detailData)));
      const imageUrl=safeUrl(detailData.imageUrl);
      if(imageUrl){
        const figure=node('figure'),image=node('img','place-detail-photo');image.src=imageUrl;image.alt=`${place.name} 제공 사진`;image.loading='lazy';image.referrerPolicy='no-referrer';
        const caption=node('figcaption','','사진: 한국관광공사 TourAPI 제공');
        image.addEventListener('error',()=>{image.remove();caption.textContent='제공 사진을 불러오지 못했어요.';});figure.append(image,caption);full.append(figure);
      }else full.append(node('p','place-detail-missing','제공된 사진이 없어요.'));
      full.append(node('h3','','장소 정보'));
      const fields=node('dl','place-detail-fields');
      for(const [label,key] of [['운영시간','hours'],['휴무일','closed'],['이용요금','fee'],['주차','parking'],['문의','phone']])fields.append(node('dt','',label),node('dd','',typeof detailData[key]==='string'&&detailData[key]?detailData[key]:'정보 미제공'));
      full.append(fields);
      const homepage=safeUrl(detailData.homepage);
      if(homepage){const link=node('a','','시설 홈페이지 ↗');link.href=homepage;link.target='_blank';link.rel='noopener noreferrer';full.append(link);}
      const credit=node('p','place-detail-source'),source=node('a','','한국관광공사 TourAPI');source.href='https://www.data.go.kr/data/15101578/openapi.do';source.target='_blank';source.rel='noopener noreferrer';credit.append(source);
      if(typeof detailData.fetchedAt==='string'&&Number.isFinite(Date.parse(detailData.fetchedAt)))credit.append(node('span','',` · 조회 ${new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(detailData.fetchedAt))}`));
      if(detailData.partial)full.append(node('p','place-detail-status','일부 운영정보를 불러오지 못했어요. 팝업을 닫고 상세정보를 다시 조회해 주세요.'));
      full.append(credit,node('p','place-detail-hint','운영시간·요금은 바뀔 수 있어요. 방문 전 시설에 확인해 주세요.'));
      popup.append(heading,full);document.body.append(popup);dialog=popup;activePopup=closePopup;
      close.addEventListener('click',()=>closePopup());
      popup.addEventListener('cancel',event=>{event.preventDefault();closePopup();});
      popup.addEventListener('close',()=>{if(dialog===popup&&!popup.open)closePopup();});
      popup.addEventListener('click',event=>{
        if(event.target!==popup)return;const rect=popup.getBoundingClientRect();
        if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closePopup();
      });
      window.addEventListener('hashchange',onNavigation);openButton.setAttribute('aria-expanded','true');
      try{popup.showModal();close.focus({preventScroll:true});}catch{closePopup();}
    }
    function overviewText(data){return typeof data.overview==='string'&&data.overview.trim()?data.overview.trim():'이 장소의 자세한 설명은 제공되지 않았어요.';}
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
        closePopup({restoreFocus:false});detailData=data;result.replaceChildren();
        const description=node('p','place-detail-overview is-collapsed',overviewText(data));
        openButton=node('button','place-detail-open','전체 보기');openButton.type='button';openButton.setAttribute('aria-haspopup','dialog');openButton.setAttribute('aria-controls',dialogId);openButton.setAttribute('aria-expanded','false');
        openButton.addEventListener('click',openPopup);result.append(description,openButton);
        loaded=!data.partial;retry.hidden=loaded;status.textContent=data.partial?'기본 정보를 불러왔지만 일부 운영정보 조회에 실패했어요. 다시 조회할 수 있어요.':'';
      }catch{
        if(destroyed||current!==version||!host.open)return;
        status.textContent=timedOut?'상세정보 응답이 늦어지고 있어요. 다시 시도해 주세요.':'상세정보를 불러오지 못했어요. 이름·주소는 위에서 확인하고 다시 시도해 주세요.';retry.hidden=false;
      }finally{if(current===version){clearTimeout(timer);timer=null;controller=null;}}
    }
    host.addEventListener('toggle',()=>{if(!host.open){cancel();closePopup({restoreFocus:false});}else if(!loaded)load();});
    retry.addEventListener('click',load);
    if(candidate)host.open=true;
    return {destroy(){destroyed=true;cancel();closePopup({restoreFocus:false});host.remove();}};
  }
  window.TravelPlaceDetail={mount};
})();

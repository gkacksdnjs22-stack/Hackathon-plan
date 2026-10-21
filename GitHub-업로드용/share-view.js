(function(){
  'use strict';
  const host=document.getElementById('share-note'),status=document.getElementById('share-status'),reload=document.getElementById('share-reload');
  let generation=0,pending=null;
  async function load(){
    pending?.abort();const controller=new AbortController();pending=controller;
    const timer=setTimeout(()=>controller.abort(),15000);
    const version=++generation,token=window.location.hash.slice(1);host.hidden=true;host.replaceChildren();reload.disabled=true;
    status.textContent='공유한 노트를 확인하고 있어요.';
    try{
      if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error('missing');
      const response=await fetch('/api/shared-plan',{method:'POST',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
      if(!response.ok)throw Error(response.status===404?'missing':'network');
      const data=await response.json();if(version!==generation)return;
      window.TravelNoteView.render(host,data.snapshot);host.hidden=false;
      status.textContent=`${new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short'}).format(new Date(data.sharedAt))}에 공유한 사본 · 수정할 수 없어요.`;
    }catch(error){if(version===generation)status.textContent=error.message==='missing'?'공유가 해제됐거나 올바르지 않은 링크예요. 소유자에게 새 링크를 요청해 주세요.':'노트를 불러오지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.';}
    finally{clearTimeout(timer);if(pending===controller)pending=null;if(version===generation)reload.disabled=false;}
  }
  reload.addEventListener('click',load);window.addEventListener('hashchange',load);window.addEventListener('focus',load);
  window.addEventListener('pagehide',()=>{generation++;pending?.abort();host.hidden=true;host.replaceChildren();});
  window.addEventListener('pageshow',event=>{if(event.persisted)load();});load();
})();

(function(){
  'use strict';
  const node=(tag,text='')=>{const element=document.createElement(tag);element.textContent=text;return element;};
  const format=value=>new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Seoul'}).format(new Date(value));
  async function prepareViewer(){
    if(!window.isSecureContext||!navigator.serviceWorker||typeof MessageChannel!=='function')throw Error('이 브라우저에서는 오프라인 저장을 준비할 수 없어요. HTTPS 사이트나 localhost에서 지원하는 브라우저로 열어 주세요.');
    await navigator.serviceWorker.register('/service-worker.js',{scope:'/'});
    let readyTimer;const registration=await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>{readyTimer=setTimeout(()=>reject(Error('오프라인 화면 준비가 늦어요. 인터넷 연결을 확인하고 다시 저장해 주세요.')),15000);})]).finally(()=>clearTimeout(readyTimer));
    const worker=registration.active;
    if(!worker||new URL(worker.scriptURL,window.location.href).pathname!=='/service-worker.js')throw Error('오프라인 화면을 준비하지 못했어요. 새로고침한 뒤 다시 저장해 주세요.');
    await new Promise((resolve,reject)=>{
      const channel=new MessageChannel(),timer=setTimeout(()=>finish(false),15000);
      function finish(ok){clearTimeout(timer);channel.port1.close();channel.port2.close();ok?resolve():reject(Error('오프라인 화면을 준비하지 못했어요. 인터넷 연결을 확인하고 다시 저장해 주세요.'));}
      channel.port1.onmessage=event=>finish(event.data?.ok===true&&event.data.version===1);
      try{worker.postMessage({type:'GIL_PREPARE_OFFLINE',version:1},[channel.port2]);}catch{finish(false);}
    });
  }
  function mount(host,{getContext,onMessage=()=>{}}={}){
    if(!host)return {refresh(){},setOwner(){},destroy(){}};
    const store=window.TravelOfflineStore;host.replaceChildren();host.classList?.add('offline-tools');
    const body=node('div');body.className='sharing-body';
    if(host.tagName?.toLowerCase()==='details')host.append(node('summary','오프라인 여행 노트'));
    const hint=node('p','지금 노트를 읽기 전용 사본으로 이 기기에 보관해요. 메모·출발지도 포함되므로 개인 기기에서 저장해 주세요. 계정마다 최대 5개까지 보관해요.');
    const actions=node('div');actions.className='sharing-actions';
    const saveButton=node('button','오프라인으로 저장');saveButton.type='button';saveButton.className='button button-quiet';
    const open=node('a','오프라인 노트 열기');open.href='/offline.html';open.className='button button-quiet';open.target='_blank';open.rel='noopener';
    const status=node('p');status.className='sharing-status';status.setAttribute('role','status');
    actions.append(saveButton,open);body.append(hint,actions,status);host.append(body);
    let ownerKnown=false,ownerId,generation=0,busy=false,fingerprint='',destroyed=false,ownerError='';
    const state=()=>{const value=getContext?.();return ownerKnown&&value?.known===true&&value.ownerId===ownerId&&value.itinerary?.ok?value:null;};
    function snapshotFor(value){return window.TravelNoteSnapshot.create(value.itinerary,{title:value.title||value.attachment?.plan?.title||'나의 여행 계획',includeMemos:true,includeDeparture:true});}
    function signature(value){try{return value?JSON.stringify([value.ownerId,store.noteKey(value),snapshotFor(value)]):'';}catch{return '';}}
    function active(){try{return ownerKnown&&store.readActiveOwner()?.ownerId===ownerId;}catch{return false;}}
    function controls(){saveButton.disabled=busy||!state()||!active()||Boolean(ownerError);}
    function refresh(){
      if(destroyed)return;const value=state(),next=signature(value);
      if(next!==fingerprint){fingerprint=next;generation++;busy=false;status.textContent='';}
      if(ownerError)status.textContent=ownerError;
      else if(!ownerKnown)status.textContent='계정 확인이 끝나면 이 기기에 사본을 저장할 수 있어요.';
      else if(!active())status.textContent='다른 창에서 계정이 바뀌었어요. 로그인 상태를 다시 확인해 주세요.';
      else if(!value)status.textContent='여행 노트를 만든 뒤 오프라인으로 저장해 주세요.';
      else if(!busy&&!status.textContent){try{const notes=store.list(ownerId),saved=notes.find(note=>note.key===store.noteKey(value));status.textContent=saved?`마지막 사본 저장: ${format(saved.savedAt)} · 변경한 내용은 다시 저장해 주세요.`:`이 기기에 ${notes.length}/5개 보관 중이에요. 저장 후 인터넷 없이도 오프라인 노트를 새로 열 수 있어요.`;}catch(error){status.textContent=error.message;}}
      controls();
    }
    function setOwner(user){
      const known=user!==undefined,id=user===null?null:user?.id;
      if(known&&!store.validOwner(id)){user=undefined;}
      const nextKnown=user!==undefined,nextId=user===null?null:user?.id;
      if(ownerKnown===nextKnown&&ownerId===nextId&&!ownerError){refresh();return;}
      generation++;busy=false;fingerprint='';ownerKnown=nextKnown;ownerId=nextId;ownerError='';status.textContent='';
      if(ownerKnown){try{store.setActiveOwner(ownerId);}catch{ownerError='이 브라우저의 저장 공간을 사용할 수 없어요. 기존 사본은 바꾸지 않았어요.';}}
      refresh();
    }
    async function save(){
      refresh();const value=state();if(!value||saveButton.disabled)return {ok:false};
      const version=generation,expected=signature(value);let snapshot,key;
      try{snapshot=snapshotFor(value);key=store.noteKey(value);if(!store.validateSnapshot(snapshot))throw Error('오프라인으로 저장할 노트의 내용을 확인해 주세요.');}
      catch(error){status.textContent=error.message;return {ok:false};}
      busy=true;status.textContent='인터넷 없이 열 수 있도록 오프라인 화면을 준비하고 있어요.';controls();
      try{
        await prepareViewer();if(destroyed||version!==generation||signature(state())!==expected||!active())return {ok:false};
        const saved=store.save({ownerId,key,snapshot});status.textContent=`오프라인 사본을 저장했어요. 마지막 저장: ${format(saved.savedAt)}`;try{onMessage('이 기기에 오프라인 사본을 저장했어요.','success');}catch{}return {ok:true};
      }catch(error){if(version===generation&&!destroyed){status.textContent=error.message?.startsWith('오프라인')||error.message?.startsWith('이 브라우저')||error.message?.startsWith('이 기기')||error.message?.startsWith('현재 계정')?error.message:'저장 공간이 부족하거나 사용할 수 없어요. 기존 사본은 유지했어요.';}return {ok:false};}
      finally{if(version===generation&&!destroyed){busy=false;controls();}}
    }
    function storageChanged(event){if(event.key===null||event.key===store.ACTIVE_KEY){generation++;busy=false;status.textContent='';refresh();}else if(ownerKnown&&event.key===store.storageKey(ownerId)){status.textContent='';refresh();}}
    saveButton.addEventListener('click',save);window.addEventListener('storage',storageChanged);refresh();host.hidden=false;
    return {refresh,setOwner,save,destroy(){destroyed=true;generation++;window.removeEventListener('storage',storageChanged);host.replaceChildren();}};
  }
  window.TravelOffline={mount};
})();

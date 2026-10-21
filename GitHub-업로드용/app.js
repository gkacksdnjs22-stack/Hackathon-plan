(function(){
  'use strict';
  const STORAGE_KEY='travel-weave-itinerary-v1';
  const $=id=>document.getElementById(id);
  const country=$('country-select'),citySelect=$('city-select'),dateInput=$('start-date'),duration=$('day-count');
  let currentItinerary=null;
  let currentAttachment=null,displayedDraftOwner=null;
  let previousDraft=null,suppressAttachmentChange=false;
  let editorDrafts={};
  const editorCaptures=new Map();
  const collapsedDays=new Set();
  let activeDayIndex=0;
  const EDIT_HISTORY_LIMIT=20;
  const editHistory={undo:[],redo:[]};
  const editingKeys=['cityId','startDate','dayCount','dayAreaIds','selections','dayStarts','eventEdits','extraEvents','excludedEvents','eventOrders','departure','dayDepartures','dayArrivals','dayTransports'];
  let account=null;
  let activeAccountUser=null;
  const draftStorageKey=()=>activeAccountUser?`${STORAGE_KEY}:${activeAccountUser.id}`:STORAGE_KEY;
  let startupPending=true;
  let activeScreen=null;
  let requestVersion=0;
  let destinations=[];
  let destinationRequestVersion=0;
  let cityPreparationVersion=0;
  let departureWidgets=[];
  // These values belong only to currently displayed route results, never to the saved note.
  let timelineRevision=0;
  const liveTransitDurations=new Map();
  let departureDraftModes={};
  let messageTimer=null,messageKind=null,messageVersion=0;
  let activeReorder=null;
  function closeReorderControls(restoreFocus=false){
    const opened=activeReorder;
    if(!opened)return;
    if(restoreFocus)opened.trigger.focus({preventScroll:true});
    opened.close();
  }
  function destroyDepartureWidgets(){timelineRevision++;liveTransitDurations.clear();closeReorderControls();departureWidgets.forEach(widget=>widget.destroy());departureWidgets=[];}
  const submitButton=$('trip-form').querySelector('button[type="submit"]');
  function requestedScreen(){return /^#\/note(?:\/day\/\d+)?\/?$/.test(window.location.hash)?'note':'start';}
  function focusDayPage(index){
    selectDayPage(index,{focus:true,scroll:true,expand:true});
  }
  function syncDayPage(){
    const match=window.location.hash.match(/^#\/note\/day\/(\d+)\/?$/);
    const requested=match?Number(match[1])-1:0;
    const next=Math.max(0,Math.min(currentItinerary.days.length-1,requested));
    if(match&&requested!==next)window.history.replaceState(null,'',`#/note/day/${next+1}`);
    return selectDayPage(next);
  }
  function syncScreen({focus=true}={}){
    let screen=requestedScreen();
    let needsStartPrompt=false;
    if(screen==='note'&&!currentItinerary){
      if(startupPending)screen='loading';
      else{
        window.history.replaceState(null,'','#/start');
        screen='start';
        needsStartPrompt=true;
      }
    }
    const changed=screen!==activeScreen;
    if(changed&&activeScreen!==null&&(messageKind==='info'||messageKind==='success'))hideMessage();
    if(changed&&activeScreen==='note'){
      clearTransitTimePreviews();
      closeReorderControls();
      $('itinerary-section').querySelectorAll('details[open]').forEach(details=>{details.open=false;});
    }
    $('start-screen').hidden=screen!=='start';
    $('itinerary-section').hidden=screen!=='note';
    $('screen-loading').hidden=screen!=='loading';
    const dayChanged=screen==='note'?syncDayPage():false;
    syncEditHistoryControls();
    $('resume-note').hidden=!currentItinerary;
    $('empty-state').hidden=Boolean(currentItinerary);
    $('resume-summary').textContent=currentItinerary?`${currentItinerary.cityName} · ${currentItinerary.startDate}부터 ${currentItinerary.dayCount}일`:'';
    document.body.dataset.screen=screen;
    document.title=screen==='note'?'나만의 여행 노트 — 길':screen==='loading'?'여행 노트 불러오는 중 — 길':'길 — 마음이 향하는 국내 여행';
    activeScreen=screen;
    if(needsStartPrompt&&$('app-message').hidden)showMessage('먼저 여행 조건을 고르고 일정을 만들어 주세요.');
    if(changed&&focus){
      $(screen==='note'?'itinerary-title':screen==='loading'?'loading-title':'title').focus({preventScroll:true});
      window.scrollTo({top:0,left:0,behavior:'instant'});
    }else if(dayChanged&&focus)focusDayPage(activeDayIndex);
  }
  function navigate(screen,{replace=false}={}){
    const hash=screen==='note'?'#/note':'#/start';
    if(window.location.hash!==hash){
      if(replace)window.history.replaceState(null,'',hash);
      else window.location.hash=hash;
    }
    syncScreen();
  }
  function setBusy(busy,label='관광정보 불러오는 중…'){
    submitButton.disabled=busy||destinations.length===0||duration.disabled;
    submitButton.querySelector('span').textContent=busy?label:'추천으로 시작하기';
    $('trip-form').setAttribute('aria-busy',String(busy));
  }
  const today=new Date();
  dateInput.value=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  window.TravelDatePicker?.sync();
  function canStartOn(value){
    if(window.TravelDatePicker?.isSelectable)return window.TravelDatePicker.isSelectable(value);
    const now=new Date();
    const minimum=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(value)&&value>=minimum;
  }
  function rejectPastStartDate(){
    showMessage('여행 시작일은 오늘 또는 이후 날짜로 선택해 주세요.','error');
    $('date-trigger').focus({preventScroll:true});
  }

  function cityList(countryCode){return destinations.filter(city=>city.country===countryCode);}
  async function initializeDestinations(restore=true){
    const destinationVersion=++destinationRequestVersion;
    const inputVersion=requestVersion;
    citySelect.disabled=true;
    $('destinations-retry').hidden=true;
    setBusy(true,'여행지 불러오는 중…');
    if(!destinations.length){
      const option=document.createElement('option');
      option.value='';option.textContent='여행지 불러오는 중…';
      citySelect.replaceChildren(option);
    }
    try{
      const loaded=await window.TourData.loadDestinations();
      if(destinationVersion!==destinationRequestVersion)return;
      destinations=loaded;
      updateCityOptions(true);
      citySelect.disabled=false;
      setBusy(false);
      let restored=false;
      if(inputVersion===requestVersion){
        hideMessage();
        if(restore)restored=await loadItinerary();
      }
      startupPending=false;
      syncScreen();
      if(!restored)await prepareSelectedCity();
    }catch(error){
      if(destinationVersion!==destinationRequestVersion)return;
      setBusy(false);
      $('destinations-retry').hidden=false;
      showMessage(error.message||'여행지 목록을 불러오지 못했어요. 다시 시도해 주세요.','error');
      if(!destinations.length){
        const option=document.createElement('option');
        option.value='';option.textContent='여행지 목록을 다시 불러와 주세요';
        citySelect.replaceChildren(option);
      }
    }finally{
      if(destinationVersion===destinationRequestVersion){startupPending=false;syncScreen();}
    }
  }
  function syncDurationOptions(city,preferred=3){
    const maximum=Math.min(7,city.supportedDays,city.areas.length);
    duration.replaceChildren();
    for(let days=1;days<=maximum;days++){
      const option=document.createElement('option');
      option.value=String(days);option.textContent=`${days}일`;
      duration.append(option);
    }
    duration.value=String(Math.max(1,Math.min(maximum,Number(preferred)||3)));
    duration.disabled=maximum<1;
    $('duration-note').textContent=maximum?`이 지역은 최대 ${maximum}일 일정을 만들 수 있어요.`:'이 지역의 여행 기간을 확인하지 못했어요.';
  }
  async function prepareSelectedCity(){
    const city=selectedCity();
    if(!city)return;
    const version=++cityPreparationVersion;
    const preferred=Number(duration.value)||3;
    duration.disabled=true;
    const option=document.createElement('option');
    option.value='';option.textContent='여행 기간 확인 중…';
    duration.replaceChildren(option);
    $('duration-note').textContent='여행지에 맞는 기간을 확인하고 있어요.';
    setBusy(true,'여행 기간 확인 중…');
    try{
      await window.TourData.ensureCity(city.id);
      if(version!==cityPreparationVersion||selectedCity()?.id!==city.id)return;
      syncDurationOptions(city,preferred);
      $('destinations-retry').hidden=true;
      updateCityHint();
    }catch(error){
      if(version!==cityPreparationVersion||selectedCity()?.id!==city.id)return;
      option.textContent='여행지를 다시 불러와 주세요';
      $('duration-note').textContent='여행지 정보를 다시 불러오면 기간을 선택할 수 있어요.';
      $('destinations-retry').hidden=false;
      showMessage(error.message,'error');
    }finally{
      if(version===cityPreparationVersion&&selectedCity()?.id===city.id)setBusy(false);
    }
  }
  function showMessage(text,type='info'){
    hideMessage();
    const box=$('app-message');
    messageKind=type;
    box.textContent=text;
    box.className=`app-message${type==='error'?' is-error':type==='success'?' is-success':''}`;
    box.hidden=false;
    if(type!=='error'&&type!=='loading'){
      const version=messageVersion;
      messageTimer=setTimeout(()=>{if(version===messageVersion)hideMessage();},5000);
    }
  }
  function hideMessage(){
    messageVersion++;
    if(messageTimer!==null)clearTimeout(messageTimer);
    messageTimer=null;messageKind=null;
    const box=$('app-message');box.hidden=true;box.textContent='';
  }
  function dismissMessageForInput(){if(messageKind!=='loading')hideMessage();}
  function updateCityOptions(keepSelection=false){
    const previous=keepSelection?citySelect.value:'';
    citySelect.replaceChildren();
    for(const city of cityList(country.value)){
      const option=document.createElement('option');
      option.value=city.id;
      option.textContent=city.name;
      citySelect.append(option);
    }
    if(previous&&[...citySelect.options].some(option=>option.value===previous))citySelect.value=previous;
    else if(citySelect.options.length)citySelect.selectedIndex=0;
    updateCityHint();
  }
  function selectedCity(){
    const city=window.TRAVEL_DATA.cities[citySelect.value];
    return city&&city.id===citySelect.value&&city.country===country.value?city:null;
  }
  function updateCityHint(){
    const city=selectedCity();
    $('city-note').textContent=city?'한국관광공사 관광정보로 일정 생성':'';
    const status=$('data-status');
    if(city?.dataSource==='tourapi'){
      const count=city.areas.reduce((total,area)=>total+area.places.length,0);
      status.textContent=`한국관광공사 관광정보 · ${city.areas.length}개 권역 · ${count}곳의 후보`;
    }else status.textContent=city?`${city.name} 관광정보를 불러와 구성해요.`:'';
  }
  function resetDisplayedItinerary(){
    destroyDepartureWidgets();
    departureDraftModes={};
    currentItinerary=null;
    currentAttachment=null;previousDraft=null;editorDrafts={};editorCaptures.clear();displayedDraftOwner=null;
    collapsedDays.clear();
    activeDayIndex=0;
    resetEditHistory();
    account?.detach();
    $('itinerary-section').hidden=true;
    $('empty-state').hidden=false;
    $('day-list').replaceChildren();
    $('day-bookmarks')?.replaceChildren();
    $('day-bookmarks-bottom')?.replaceChildren();
    $('note-timing-notice').hidden=true;
    $('note-timing-notice').textContent='';
    syncScreen();
    refreshDraftRecovery();
  }
  function discardItineraryForChangedConditions(){
    requestVersion++;
    setBusy(false);
    hideMessage();
    showMessage(currentItinerary?'여행 조건을 바꿨어요. 기존 노트는 그대로 유지돼요. 추천으로 시작하기를 누르면 새 노트로 바뀝니다.':'바꾼 여행 조건으로 추천 장소를 살펴보세요.');
  }
  async function create(){
    hideMessage();
    const city=selectedCity();
    if(!city){showMessage('여행지를 선택해 주세요.','error');return;}
    if(!dateInput.value){showMessage('여행 시작일을 선택해 주세요.','error');$('date-trigger').focus();return;}
    if(!canStartOn(dateInput.value)){rejectPastStartDate();return;}
    const version=++requestVersion;
    const startDate=dateInput.value,dayCount=Number(duration.value);
    setBusy(true);
    if(city.dataSource!=='tourapi')showMessage(`${city.name}의 여행지를 모으고 있어요. 잠시만 기다려 주세요.`,'loading');
    try{await window.TourData.ensureCity(city.id);}
    catch(error){if(version===requestVersion)showMessage(error.message,'error');return;}
    finally{if(version===requestVersion)setBusy(false);}
    if(version!==requestVersion)return;
    if(!canStartOn(startDate)){rejectPastStartDate();return;}
    updateCityHint();
    const result=window.TravelPlanner.createItinerary({city,startDate,dayCount});
    if(!result.ok){
      showMessage(result.reason,'error');
      return;
    }
    result.dataSource=city.dataSource||'bundled';
    if(currentItinerary&&!backupWorkingNote()){
      showMessage('지금 노트를 보관하지 못해 새 노트로 바꾸지 않았어요. 저장 공간 설정을 확인해 주세요.','error');return;
    }
    departureDraftModes={};
    currentItinerary=result;
    currentAttachment=null;editorDrafts={};editorCaptures.clear();displayedDraftOwner=activeAccountUser?.id||null;
    collapsedDays.clear();
    activeDayIndex=0;
    resetEditHistory();
    account?.detach();
    renderItinerary();
    const saved=saveItinerary();
    navigate('note');
    showMessage(saved?'추천 장소를 여행 노트에 담았어요. 일정과 시간을 내 계획에 맞게 다듬어 보세요.':'추천 노트는 만들었지만 브라우저 저장에 실패했어요. 저장 공간 설정을 확인해 주세요.',saved?'success':'error');
    refreshDraftRecovery();
  }
  function localDraft(itinerary=currentItinerary){
    return {version:8,ownerId:activeAccountUser?.id||null,savedAt:new Date().toISOString(),itinerary,
      attachment:currentAttachment,editorDrafts,previous:previousDraft};
  }
  function flatDraft(value,owner=activeAccountUser?.id||null){
    if(!value||typeof value!=='object'||Array.isArray(value)||![1,2,3,4,5,6,7,8].includes(value.version)
      ||(value.ownerId||null)!==owner||!value.itinerary)return null;
    // Keep exactly one independent backup; never copy a recursive backup chain.
    return JSON.parse(JSON.stringify({version:value.version,ownerId:owner,savedAt:value.savedAt,
      itinerary:value.itinerary,attachment:value.attachment||null,editorDrafts:validatedEditorDrafts(value.editorDrafts)}));
  }
  function validatedEditorDrafts(value){
    const result={};
    if(!value||typeof value!=='object'||Array.isArray(value))return result;
    for(const [key,item] of Object.entries(value).slice(0,256)){
      if(!/^[0-6]:(?:departure|arrival-transfer|place-[0-2]|transfer-[01]|free-[01]|lunch|dinner|rest|finish|extra-[1-9]\d{0,8})$/.test(key)||!item||typeof item!=='object')continue;
      if(typeof item.base!=='string'||item.base.length>2000||typeof item.title!=='string'||item.title.length>200
        ||typeof item.description!=='string'||item.description.length>500||typeof item.minutes!=='string'||item.minutes.length>16
        ||!(item.hours===null||typeof item.hours==='string'&&item.hours.length<=16))continue;
      result[key]={base:item.base,title:item.title,description:item.description,minutes:item.minutes,hours:item.hours};
    }
    return result;
  }
  function editorIdentity(event,dayIndex){
    const day=currentItinerary.days[dayIndex],at=day.events.findIndex(item=>item.id===event.id);
    const before=event.id==='arrival-transfer'?day.arrival:day.events.slice(0,at).reverse().find(item=>item.type==='place')?.place;
    const after=day.events.slice(at+1).find(item=>item.type==='place')?.place;
    return JSON.stringify([event.type,event.place?.id||null,event.departure?.id||null,event.travelMode||null,
      event.departure?.mode||null,event.departure?.source||null,event.departure?.service||null,
      event.type==='transfer'?before?.id||null:null,event.type==='transfer'?after?.id||null:null,
      event.type==='departure'?(day.arrival||day.events.find(item=>item.type==='place')?.place)?.id||null:null]);
  }
  function pruneEditorDrafts(){
    let changed=false;
    for(const key of Object.keys(editorDrafts)){
      const [index,id]=key.split(':'),event=currentItinerary.days[Number(index)]?.events.find(item=>item.id===id);
      if(!event||editorDrafts[key].base!==editorIdentity(event,Number(index))){delete editorDrafts[key];changed=true;}
    }
    if(changed)persistDraftContext();
  }
  function persistDraftContext(){
    if(!currentItinerary||displayedDraftOwner!==(activeAccountUser?.id||null))return false;
    try{localStorage.setItem(draftStorageKey(),JSON.stringify(localDraft()));return true;}catch{return false;}
  }
  function captureEditors(){for(const capture of editorCaptures.values())capture();}
  function backupWorkingNote(){
    if(!currentItinerary)return true;
    captureEditors();
    const before=previousDraft;
    try{
      previousDraft=flatDraft(localDraft());
      // A single write preserves the working note and its backup together.
      if(!persistDraftContext())throw Error('storage');
      return true;
    }catch{previousDraft=before;return false;}
  }
  function refreshDraftRecovery(){
    const host=$('draft-recovery');if(!host)return;
    const previous=previousDraft;
    host.replaceChildren();host.hidden=!previous||previous.ownerId!==(activeAccountUser?.id||null)||!previous.itinerary;
    if(host.hidden)return;
    const copy=document.createElement('span');copy.textContent='이전에 작성하던 노트를 보관했어요.';
    const restore=document.createElement('button');restore.type='button';restore.className='button button-quiet';restore.textContent='이전 노트로 돌아가기';
    restore.addEventListener('click',async()=>{
      const owner=activeAccountUser?.id||null;restore.disabled=true;
      captureEditors();
      const before=currentItinerary?flatDraft(localDraft()):null;
      const restored=await restoreDocument(previous,{previousOverride:before,isCurrent:()=>owner===(activeAccountUser?.id||null)});
      if(!restored){restore.disabled=false;return;}
      if(!persistDraftContext()){showMessage('이전 노트는 열었지만 기기 저장에 실패했어요. 기존 저장본과 이전 노트는 기기에 그대로 남아 있어요.','error');return;}
      refreshDraftRecovery();navigate('note');showMessage('이전 노트로 돌아왔어요. 방금 보던 노트도 보관했어요.','success');
    });
    host.append(copy,restore);
  }
  function saveItinerary(itinerary=currentItinerary){
    try{
      if(!itinerary)return false;
      const city=window.TRAVEL_DATA.cities[itinerary.cityId];
      itinerary.dataSource=city?.dataSource||'bundled';
      localStorage.setItem(draftStorageKey(),JSON.stringify(localDraft(itinerary)));
      requestVersion++;
      account?.changed();
      return true;
    }catch(error){return false;}
  }
  function editingSnapshot(itinerary=currentItinerary){
    if(!itinerary)return null;
    const parameters={};
    for(const key of editingKeys){
      if(itinerary[key]!==undefined)parameters[key]=itinerary[key];
    }
    return JSON.stringify(parameters);
  }
  function syncEditHistoryControls(){
    for(const action of ['undo','redo']){
      const button=$(`${action}-button`);
      if(!button)continue;
      button.disabled=!currentItinerary||editHistory[action].length===0;
      button.title=button.disabled?(action==='undo'?'되돌릴 편집이 없어요.':'다시 실행할 편집이 없어요.'):(action==='undo'?'직전 편집 되돌리기':'되돌린 편집 다시 실행');
    }
  }
  function resetEditHistory(){
    editHistory.undo=[];editHistory.redo=[];
    syncEditHistoryControls();
  }
  function keepHistoryStep(stack,snapshot){
    stack.push(snapshot);
    if(stack.length>EDIT_HISTORY_LIMIT)stack.shift();
  }
  function saveEditedItinerary(itinerary){
    // Keep only user editing parameters in this tab; provider results and rendered days stay out of history.
    let before,after;
    try{before=editingSnapshot();after=editingSnapshot(itinerary);}catch(error){return false;}
    if(!saveItinerary(itinerary))return false;
    if(before!==null&&before!==after){
      keepHistoryStep(editHistory.undo,before);
      editHistory.redo=[];
      syncEditHistoryControls();
    }
    return true;
  }
  function applyEditHistory(action){
    const from=editHistory[action];
    if(!currentItinerary||!from?.length)return;
    let restored,before;
    try{
      const parameters=JSON.parse(from.at(-1));
      const city=window.TRAVEL_DATA.cities[currentItinerary.cityId];
      if(!city||parameters.cityId!==currentItinerary.cityId)throw Error('다른 여행 노트의 기록은 적용할 수 없어요.');
      before=editingSnapshot();
      restored=window.TravelPlanner.createItinerary({city,...parameters});
      if(!restored.ok)throw Error(restored.reason||'편집 기록을 복원하지 못했어요.');
    }catch(error){
      showMessage(`편집 기록을 적용하지 못했어요. ${error.message||'잠시 후 다시 시도해 주세요.'} 현재 노트는 유지했어요.`,'error');
      return;
    }
    if(!saveItinerary(restored)){
      showMessage('편집 기록을 저장하지 못했어요. 현재 노트와 되돌리기 기록은 유지했어요. 저장 공간 설정을 확인하고 다시 시도해 주세요.','error');
      return;
    }
    from.pop();
    keepHistoryStep(editHistory[action==='undo'?'redo':'undo'],before);
    departureDraftModes={};
    currentItinerary=restored;
    renderItinerary();
    showMessage(action==='undo'?'직전 편집을 되돌리고 일정 시각을 다시 계산했어요.':'되돌린 편집을 다시 실행하고 일정 시각을 다시 계산했어요.','success');
  }
  async function loadItinerary(){
    let raw;
    try{raw=localStorage.getItem(draftStorageKey());}catch(error){
      showMessage('브라우저 저장본에 접근하지 못했어요. 브라우저 저장 설정을 확인해 주세요. 저장본 삭제는 시도하지 않았습니다.','error');
      return false;
    }
    if(!raw)return false;
    let parsed;
    try{parsed=JSON.parse(raw);}catch(error){
      showMessage('저장된 일정을 복원하지 못했어요. 저장 데이터 형식을 읽을 수 없습니다. 저장본은 삭제하지 않았습니다.','error');
      return false;
    }
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){
      showMessage('저장된 일정을 복원하지 못했어요. 저장 데이터 형식이 올바르지 않습니다. 저장본은 삭제하지 않았습니다.','error');
      return false;
    }
    if((parsed.ownerId||null)!==(activeAccountUser?.id||null))return false;
    return restoreDocument(parsed);
  }
  async function accountUserChanged(user,{initial=false,socialReturn=false}={}){
    const previous=activeAccountUser;
    if(previous?.id!==user?.id)captureEditors();
    let guestRaw=null;
    if(!previous&&user&&(currentItinerary||initial&&socialReturn)){
      try{guestRaw=currentItinerary?JSON.stringify(localDraft()):localStorage.getItem(STORAGE_KEY);}catch{}
    }
    activeAccountUser=user||null;
    if(previous?.id!==activeAccountUser?.id)resetEditHistory();
    if(user===undefined&&!initial){
      requestVersion++;
      resetDisplayedItinerary();
      navigate('start',{replace:true});
      return;
    }
    if(guestRaw&&activeAccountUser){
      let guest=null;
      try{guest=JSON.parse(guestRaw);}catch{}
      if(guest&&guest.ownerId==null&&guest.itinerary&&[1,2,3,4,5,6,7,8].includes(guest.version)){
        try{
          const key=draftStorageKey(),existing=localStorage.getItem(key);
          let existingDraft=null;
          try{existingDraft=existing?flatDraft(JSON.parse(existing)):null;}catch{}
          const guestPrevious=flatDraft(guest.previous,null);
          const adopted={...guest,ownerId:activeAccountUser.id,attachment:null,
            previous:existingDraft||(guestPrevious?{...guestPrevious,ownerId:activeAccountUser.id,attachment:null}:null)};
          localStorage.setItem(key,JSON.stringify(adopted));
          if(currentItinerary){currentAttachment=null;previousDraft=adopted.previous;displayedDraftOwner=activeAccountUser.id;}
          localStorage.removeItem(STORAGE_KEY);refreshDraftRecovery();
          if(!initial)return;
        }catch{
          if(!initial){resetDisplayedItinerary();navigate('start',{replace:true});await loadItinerary();}
          showMessage('로그인 전 노트를 옮기지 못했어요. 기존 초안과 로그인 전 저장본은 그대로 보관했어요.','error');
          return;
        }
      }
    }
    if(initial||previous?.id===activeAccountUser?.id){refreshDraftRecovery();return;}
    requestVersion++;
    resetDisplayedItinerary();
    navigate('start',{replace:true});
    if(await loadItinerary())syncScreen({focus:false});
    refreshDraftRecovery();
  }
  function cloudDocument(){
    if(!currentItinerary)return null;
    return {version:8,itinerary:JSON.parse(editingSnapshot())};
  }
  async function restoreDocument(parsed,{remote=false,previousOverride,isCurrent=()=>true}={}){
    const version=++requestVersion;
    const fail=reason=>{
      showMessage(`저장된 일정을 복원하지 못했어요. ${reason} 저장본은 삭제하지 않았습니다.`,'error');
      return false;
    };
    const saved=parsed?.itinerary;
    if(![1,2,3,4,5,6,7,8].includes(parsed?.version)||typeof saved?.cityId!=='string'||!Number.isInteger(Number(saved.dayCount))||Number(saved.dayCount)<1||Number(saved.dayCount)>7||(!remote&&(!Array.isArray(saved.days)||saved.days.length!==Number(saved.dayCount))))
      return fail('저장 데이터의 버전 또는 날짜 목록이 올바르지 않습니다.');
    const city=window.TRAVEL_DATA.cities[saved.cityId];
    if(!city||city.id!==saved.cityId||!city.supportedDays)
      return fail('저장된 도시의 장소 데이터가 현재 준비되어 있지 않습니다.');
    const dayAreaIds=[];
    const selections={};
    if(remote){
      if(parsed.version!==8||!Array.isArray(saved.dayAreaIds)||saved.dayAreaIds.length!==saved.dayCount||saved.dayAreaIds.some(id=>typeof id!=='string'))return fail('날짜별 권역 정보가 올바르지 않습니다.');
      dayAreaIds.push(...saved.dayAreaIds);
      for(let index=0;index<saved.dayCount;index++){
        if(!Array.isArray(saved.selections?.[index])||saved.selections[index].some(id=>typeof id!=='string'))return fail(`${index+1}일차 추천 관광지 목록이 올바르지 않습니다.`);
        selections[index]=saved.selections[index];
      }
    }else for(let index=0;index<saved.days.length;index++){
      const day=saved.days[index];
      if(!day||typeof day.areaId!=='string'||!Array.isArray(day.events)||day.events.some(event=>!event||typeof event!=='object'||(event.type==='place'&&typeof event.place?.id!=='string')))
        return fail(`${index+1}일차 권역 정보가 없거나 일정 형식이 올바르지 않습니다.`);
      dayAreaIds.push(day.areaId);
      selections[index]=saved.selections?.[index]??day.events.filter(event=>event.type==='place'&&!event.id?.startsWith('extra-')).map(event=>event.place?.id);
      if(!Array.isArray(selections[index])||selections[index].some(id=>typeof id!=='string'))return fail(`${index+1}일차 추천 관광지 목록이 올바르지 않습니다.`);
      const added=day.events.filter(event=>typeof event.id==='string'&&event.id.startsWith('extra-')).map(event=>event.id);
      const records=saved.extraEvents?.[index]??[];
      if(!Array.isArray(records)||records.some(event=>!event||typeof event.id!=='string')||JSON.stringify([...added].sort())!==JSON.stringify(records.map(event=>event.id).sort()))
        return fail(`${index+1}일차 추가 일정과 저장한 항목 목록이 서로 다릅니다.`);
    }
    if(saved.dayAreaIds!==undefined&&(!Array.isArray(saved.dayAreaIds)||JSON.stringify(saved.dayAreaIds)!==JSON.stringify(dayAreaIds)))
      return fail('날짜별 권역 목록과 각 날짜 일정의 권역 정보가 서로 다릅니다.');
    if(saved.dataSource==='tourapi'||city.tourAreaCode){
      setBusy(true);
      showMessage('저장된 일정의 공공 관광정보를 불러오고 있어요.','loading');
      try{await window.TourData.ensureCity(city.id);}
      catch(error){return version===requestVersion?fail(error.message):false;}
      finally{if(version===requestVersion)setBusy(false);}
      if(version!==requestVersion)return false;
    }
    if(dayAreaIds.some(id=>!city.areas.some(area=>area.id===id))){
      const migrated=dayAreaIds.map((id,index)=>{
        if(city.areas.some(area=>area.id===id))return id;
        return city.areas.find(area=>selections[index].every(placeId=>area.places.some(place=>place.id===placeId)))?.id;
      });
      if(migrated.some(id=>!id)||new Set(migrated).size!==migrated.length)
        return fail('여행지 구성이 갱신되어 이전 일정의 권역을 그대로 연결할 수 없습니다. 여행 조건을 골라 새 일정을 만들어 주세요.');
      dayAreaIds.splice(0,dayAreaIds.length,...migrated);
    }
    const restored=window.TravelPlanner.createItinerary({city,startDate:saved.startDate,dayCount:saved.dayCount,dayAreaIds,selections,dayStarts:saved.dayStarts,eventEdits:saved.eventEdits,departure:saved.departure,dayDepartures:saved.dayDepartures,dayArrivals:saved.dayArrivals,dayTransports:saved.dayTransports,extraEvents:saved.extraEvents,excludedEvents:saved.excludedEvents,eventOrders:saved.eventOrders});
    if(!restored.ok)return fail(restored.reason);
    if(restored.days.length!==Number(saved.dayCount))return fail('저장한 여행 날짜 수와 복원 결과가 다릅니다.');
    restored.dataSource=city.dataSource||saved.dataSource||'bundled';
    if(version!==requestVersion||!isCurrent())return false;
    if(remote&&currentItinerary&&!backupWorkingNote())return fail('지금 작성하던 노트를 보관하지 못했어요.');
    departureDraftModes={};
    currentItinerary=restored;
    const restoredOwner=activeAccountUser?.id||null;
    displayedDraftOwner=restoredOwner;
    const desiredAttachment=remote?null:parsed.attachment||null;
    currentAttachment=desiredAttachment;
    if(!remote)previousDraft=flatDraft(previousOverride===undefined?parsed.previous:previousOverride);
    editorDrafts=remote?{}:validatedEditorDrafts(parsed.editorDrafts);editorCaptures.clear();
    if(!remote){
      // A recovered unlinked note must never keep the previously open plan's ID.
      suppressAttachmentChange=true;
      try{account?.detach();}finally{suppressAttachmentChange=false;}
    }
    collapsedDays.clear();
    activeDayIndex=0;
    resetEditHistory();
    let persistenceWarning='';
    if(remote){
      if(!saveItinerary(restored))persistenceWarning='계정의 계획을 열었지만 이 기기 자동저장에 실패했어요. 새로고침하면 현재 작업이 사라질 수 있으니 수정한 내용은 계정에 저장해 주세요.';
    }else account?.changed();
    country.value=city.country;
    updateCityOptions(false);
    citySelect.value=city.id;
    dateInput.value=currentItinerary.startDate;
    window.TravelDatePicker?.sync();
    syncDurationOptions(city,currentItinerary.dayCount);
    setBusy(false);
    updateCityHint();
    renderItinerary();
    refreshDraftRecovery();
    if(!remote&&desiredAttachment&&account?.restoreAttachment){
      const attachmentResult=await account.restoreAttachment(desiredAttachment);
      if(currentItinerary!==restored||restoredOwner!==(activeAccountUser?.id||null)||!isCurrent())return false;
      if(['invalid','not-owned'].includes(attachmentResult?.reason)){currentAttachment=null;persistDraftContext();}
    }
    showMessage(persistenceWarning||'저장된 여행 일정과 수정한 내용을 불러왔어요.',persistenceWarning?'error':'success');
    return persistenceWarning?{ok:true,warning:persistenceWarning}:true;
  }
  function esc(text){
    return String(text).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  }
  function mapHref(place){return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.mapQuery||place.name)}`;}
  function compactName(value,limit=26){
    const clean=String(value).replace(/\([^)]*\)|\[[^\]]*\]/g,'').replace(/\s+/g,' ').trim();
    const letters=Array.from(clean);
    return letters.length>limit?`${letters.slice(0,limit-1).join('')}…`:clean;
  }
  function areaLabel(area){
    const parts=area.name.split(' · ');
    if(parts.length<2)return compactName(area.name);
    const locality=parts.shift().trim().split(/\s+/)[0];
    const landmark=parts.join(' · ').replace(/\s*주변$/,'');
    return compactName(`${locality} · ${landmark}`);
  }
  function touristCandidates(city){
    const used=new Set([...Object.values(currentItinerary.selections||{}).flat(),...currentItinerary.days.flatMap(day=>day.events.filter(event=>event.type==='place').map(event=>event.place.id))]);
    const seen=new Set();
    const catalog=Array.isArray(city.catalogPlaces)?city.catalogPlaces:city.areas.flatMap(area=>area.places);
    return catalog.filter(place=>!used.has(place.id)&&!seen.has(place.id)&&seen.add(place.id));
  }
  function renderItinerary(){
    if(!currentItinerary)return;
    captureEditors();editorCaptures.clear();
    const city=window.TRAVEL_DATA.cities[currentItinerary.cityId];
    if(!city)return;
    $('trip-summary').textContent=`${currentItinerary.countryName} ${currentItinerary.cityName} · ${currentItinerary.startDate}부터 ${currentItinerary.dayCount}일 · 현지 시간 ${city.timezone}`;
    const countdown=document.createElement('span');countdown.className='trip-countdown';
    countdown.textContent=window.TravelNoteTools.countdown(currentItinerary.startDate,currentItinerary.dayCount,city.timezone);
    $('trip-summary').append(countdown);
    const timingNotice=$('note-timing-notice');
    const provisional=currentItinerary.days.some(day=>day.timesProvisional);
    const timingMessage=provisional?'출발지와 미정인 이동시간을 먼저 정해 주세요. 미정은 실제 이동 0분이 아니며, 도착·식사 시각은 달라질 수 있어요.':'';
    timingNotice.hidden=!provisional;
    if(timingNotice.textContent!==timingMessage)timingNotice.textContent=timingMessage;
    $('capacity-message').hidden=true;
    const list=$('day-list');
    destroyDepartureWidgets();
    list.replaceChildren();
    currentItinerary.days.forEach((day,index)=>list.append(renderDay(day,index,city)));
    activeDayIndex=Math.min(activeDayIndex,currentItinerary.days.length-1);
    for(const id of ['day-bookmarks','day-bookmarks-bottom']){
      const bookmarks=$(id);
      if(!bookmarks)continue;
      bookmarks.replaceChildren();
      currentItinerary.days.forEach((day,index)=>{
        const button=document.createElement('button');button.type='button';button.className='day-bookmark';
        button.dataset.dayIndex=String(index);
        button.textContent=`Day ${String(day.index).padStart(2,'0')}`;
        button.setAttribute('aria-label',`${day.index}일차 ${day.date} 일정으로 이동`);
        button.setAttribute('aria-controls',`travel-day-${index}`);
        button.addEventListener('click',()=>{
          window.location.hash=`#/note/day/${index+1}`;
          syncScreen({focus:false});
          focusDayPage(index);
        });
        bookmarks.append(button);
      });
    }
    selectDayPage(activeDayIndex);
    window.TravelSelect?.refresh();
    window.TravelTimePicker?.refresh();
    syncScreen();
    pruneEditorDrafts();
  }
  function selectDayPage(index,{focus=false,scroll=false,expand=false}={}){
    if(!currentItinerary||!Number.isInteger(index)||index<0||index>=currentItinerary.days.length)return false;
    const changed=index!==activeDayIndex;
    if(changed){
      clearTransitTimePreviews(activeDayIndex);
      closeReorderControls();
      const previous=document.getElementById(`travel-day-${activeDayIndex}`);
      previous?.querySelectorAll('details[open]').forEach(details=>{details.open=false;});
    }
    activeDayIndex=index;
    $('day-list').querySelectorAll('.day-card').forEach(card=>{card.hidden=Number(card.dataset.dayIndex)!==index;});
    for(const id of ['day-bookmarks','day-bookmarks-bottom']){
      $(id)?.querySelectorAll('.day-bookmark').forEach(button=>{
        button.setAttribute('aria-current',Number(button.dataset.dayIndex)===index?'page':'false');
      });
    }
    const card=document.getElementById(`travel-day-${index}`);
    if(expand&&collapsedDays.has(index))card.querySelector('.day-collapse').click();
    if(changed){window.TravelSelect?.refresh();window.TravelTimePicker?.refresh();}
    if(focus)card.focus({preventScroll:true});
    if(scroll)($('day-bookmarks')||card).scrollIntoView({block:'start',behavior:'instant'});
    return changed;
  }
  function refreshCountdown(){
    if(!currentItinerary)return;
    const badge=$('trip-summary').querySelector('.trip-countdown');
    const city=window.TRAVEL_DATA.cities[currentItinerary.cityId];
    if(badge&&city)badge.textContent=window.TravelNoteTools.countdown(currentItinerary.startDate,currentItinerary.dayCount,city.timezone);
  }
  function dayFootnote(day,end=day.end,preview=false){
    return `${formatTime(day.start)} 출발 · ${formatTime(end)} 마무리${preview?' · 경로 조회 미리보기 · 저장되지 않아요.':day.timesProvisional?'':' · 입력한 소요시간 기준이에요.'}`;
  }
  function eventTimeMarkup(start,end,duration){
    return duration===0?`<span>${timeMarkup(start)}</span>`:`<span>${timeMarkup(start)}</span><span class="time-divider">–</span><span>${timeMarkup(end)}</span>`;
  }
  function travelDurationLabel(event,day,minutes,preview=false){
    if(event.type==='departure')return `${day.arrival?'교통편 예상':'첫 관광지까지'} ${formatDuration(minutes)} · ${preview?'현재 조회':day.transport?'선택한 시간표':'계획용 예상'}`;
    const modeName=({walk:'도보','local-bus':'시내·마을버스',subway:'지하철',car:'차량','rental-car':'차량',taxi:'차량'})[event.travelMode];
    return `${modeName?`${modeName} · `:''}예상 이동 ${minutes===0?'미정':formatDuration(minutes)}${preview?' · 현재 조회':''}`;
  }
  function projectTransitTimes(dayIndex){
    const day=currentItinerary?.days[dayIndex];
    const article=$('day-list').querySelector(`[data-day-index="${dayIndex}"]`);
    if(!day||!article)return;
    const rows=new Map([...article.querySelectorAll('.timeline-row')].map(row=>[row.dataset.eventId,row]));
    let clock=day.start,preview=false;
    for(const event of day.events){
      const row=rows.get(event.id),minutes=liveTransitDurations.get(`${dayIndex}:${event.id}`);
      const duration=minutes??event.duration;
      preview=preview||minutes!==undefined;
      const labels=row?.querySelector('.timeline-time-labels');
      if(labels)labels.innerHTML=eventTimeMarkup(formatTime(clock),formatTime(clock+duration),duration);
      if(event.type==='departure'||event.type==='transfer'){
        const pill=row?.querySelector('.event-duration');
        if(pill){pill.textContent=travelDurationLabel(event,day,duration,minutes!==undefined);pill.hidden=event.type==='departure'&&duration===0;}
      }
      // Match the planner's default meal labels without changing user-entered titles or memos.
      if(event.type==='meal'&&!event.id.startsWith('extra-')){
        const local=clock%1440;
        const meal=local<600?'아침 식사':local<900?'점심 식사':local<1020?'오후 식사':local<1260?'저녁 식사':'늦은 식사';
        const edits=currentItinerary.eventEdits?.[dayIndex]?.[event.id]||{};
        const title=row?.querySelector('.event-title'),description=row?.querySelector('.event-description');
        if(title&&!Object.hasOwn(edits,'title'))title.textContent=meal;
        if(description&&!Object.hasOwn(edits,'description'))description.textContent=`${day.area}에서 ${meal} · 식당을 특정하지 않음`;
      }
      clock+=duration;
    }
    const foot=article.querySelector('.day-footnote');
    if(foot)foot.textContent=dayFootnote(day,clock,preview);
  }
  function transitTimePreview(dayIndex,eventId){
    const revision=timelineRevision,note=currentItinerary;
    return minutes=>{
      if(revision!==timelineRevision||note!==currentItinerary||activeScreen!=='note'||dayIndex!==activeDayIndex)return;
      if(minutes!==null&&(!Number.isInteger(minutes)||minutes<1||minutes>1440))return;
      const event=note.days[dayIndex]?.events.find(item=>item.id===eventId);
      if(!event||!['departure','transfer'].includes(event.type))return;
      const key=`${dayIndex}:${eventId}`;
      if(minutes===null){if(!liveTransitDurations.delete(key))return;}
      else liveTransitDurations.set(key,minutes);
      projectTransitTimes(dayIndex);
    };
  }
  function clearTransitTimePreviews(dayIndex=null){
    const days=new Set();
    for(const key of liveTransitDurations.keys()){
      const index=Number(key.split(':')[0]);
      if(dayIndex!==null&&index!==dayIndex)continue;
      days.add(index);liveTransitDurations.delete(key);
    }
    days.forEach(projectTransitTimes);
  }
  function renderDay(day,index,city){
    const article=document.createElement('article');
    article.className='day-card';
    article.id=`travel-day-${index}`;article.tabIndex=-1;
    article.dataset.dayIndex=String(index);
    article.setAttribute('aria-label',`${day.index}일차 ${day.date} 일정`);
    const head=document.createElement('div');
    head.className='day-card-header';
    const title=document.createElement('div');
    title.className='day-title';
    const date=document.createElement('strong');date.textContent=day.date;title.append(date);
    const dayLabel=document.createElement('span');dayLabel.className='day-index-label';
    dayLabel.textContent=`Day ${String(day.index).padStart(2,'0')}`;title.append(dayLabel);
    const headingCopy=document.createElement('div');headingCopy.className='day-heading-copy';
    const summary=document.createElement('p');summary.className='day-summary';
    const totals=window.TravelNoteTools.daySummary(day);
    summary.textContent=`관광지 ${totals.places}곳 · 체류 ${formatDuration(totals.stay)} · 입력된 이동 ${formatDuration(totals.travel)}${totals.pending?` · 미정 ${totals.pending}구간 별도`:''}`;
    headingCopy.append(title,summary);
    const controls=document.createElement('div');
    controls.className='day-area-controls';
    const select=document.createElement('select');
    select.className='day-area-select';
    select.setAttribute('aria-label',`${day.index}일차 방문 권역 선택`);
    for(const area of city.areas){
      const option=document.createElement('option');
      option.value=area.id;
      option.textContent=areaLabel(area);
      option.title=area.name;
      option.dataset.search=[area.name,...area.places.map(place=>place.name)].join(' ');
      select.append(option);
    }
    select.value=day.areaId;
    const apply=document.createElement('button');
    apply.type='button';
    apply.className='area-apply-button';
    apply.textContent='변경 적용';
    apply.addEventListener('click',()=>applyAreaChange(index,select.value,city));
    controls.append(select,apply);
    const body=document.createElement('div');body.className='day-card-body';body.id=`travel-day-body-${index}`;
    const toggle=document.createElement('button');toggle.type='button';toggle.className='day-collapse';
    toggle.setAttribute('aria-controls',body.id);toggle.setAttribute('aria-label',`${day.index}일차 일정 접기·펼치기`);
    function syncCollapse(){
      body.hidden=collapsedDays.has(index);toggle.textContent=body.hidden?'일정 펼치기':'일정 접기';
      if(body.hidden){
        clearTransitTimePreviews(index);
        body.querySelectorAll('.transit-route-lookup').forEach(details=>{details.open=false;});
      }
      article.classList.toggle('is-collapsed',body.hidden);
      toggle.setAttribute('aria-expanded',String(!body.hidden));
    }
    toggle.addEventListener('click',()=>{if(collapsedDays.has(index))collapsedDays.delete(index);else collapsedDays.add(index);syncCollapse();});
    syncCollapse();
    const headerActions=document.createElement('div');headerActions.className='day-header-actions';headerActions.append(controls,toggle);
    head.append(headingCopy,headerActions);
    article.append(head);
    const timeline=document.createElement('div');
    timeline.className='timeline';
    day.events.forEach(event=>timeline.append(renderEvent(event,index,city)));
    body.append(timeline);
    if(window.TravelSchedule&&window.TravelPlanner.addEvent){
      const addHost=document.createElement('div');addHost.className='schedule-add-container';
      body.append(addHost);
      departureWidgets.push(window.TravelSchedule.mount(addHost,{day,dayIndex:index,city,
        usedPlaceIds:[...Object.values(currentItinerary.selections||{}).flat(),...currentItinerary.days.flatMap(item=>item.events.filter(event=>event.type==='place').map(event=>event.place.id))],
        onAdd:input=>{
          const result=window.TravelPlanner.addEvent({city,itinerary:currentItinerary,dayIndex:index,...input});
          if(!result.ok)return result;
          if(!saveEditedItinerary(result.itinerary))return {ok:false,reason:'추가한 일정을 저장하지 못했어요. 기존 노트는 유지했어요.'};
          currentItinerary=result.itinerary;renderItinerary();
          focusEvent(index,result.eventId);
          showMessage('일정을 추가했어요. 필요한 이동시간과 뒤 일정을 확인해 주세요.','success');
          return {ok:true};
        }
      }));
    }
    if(day.hiddenEvents?.length){
      const hidden=document.createElement('details');hidden.className='schedule-restore';
      const summary=document.createElement('summary');summary.textContent=`뺀 일정 다시 담기 (${day.hiddenEvents.length})`;
      const choices=document.createElement('div');choices.className='schedule-restore-list';
      for(const event of day.hiddenEvents){
        const restore=document.createElement('button');restore.type='button';restore.textContent=`${eventName(event)} 다시 담기`;
        restore.addEventListener('click',()=>{
          const result=window.TravelPlanner.restoreEvent({city,itinerary:currentItinerary,dayIndex:index,eventId:event.id});
          if(!result.ok){showMessage(result.reason,'error');return;}
          if(!saveEditedItinerary(result.itinerary)){showMessage('다시 담은 일정을 저장하지 못했어요. 기존 노트는 유지했어요.','error');return;}
          currentItinerary=result.itinerary;renderItinerary();focusEvent(index,event.id);
          showMessage('뺀 일정을 다시 담았어요. 연결된 이동시간을 확인해 주세요.','success');
        });
        choices.append(restore);
      }
      hidden.append(summary,choices);body.append(hidden);
    }
    const foot=document.createElement('div');
    foot.className='day-footnote';
    foot.textContent=dayFootnote(day);
    body.append(foot);article.append(body);
    return article;
  }
  function applyAreaChange(dayIndex,areaId,city){
    const result=window.TravelPlanner.changeDayArea({city,itinerary:currentItinerary,dayIndex,areaId});
    if(!result.ok){showMessage(result.reason,'error');return;}
    if(!saveEditedItinerary(result.itinerary)){
      showMessage('권역 변경을 저장하지 못했어요. 기존 일정과 저장본을 그대로 유지했습니다. 저장 공간 설정을 확인해 주세요.','error');
      return;
    }
    currentItinerary=result.itinerary;
    renderItinerary();
    let message;
    if(result.swappedIndex!==null){
      message=`${dayIndex+1}일차와 ${result.swappedIndex+1}일차의 방문 권역을 교환했어요.`;
    }else{
      message=`${dayIndex+1}일차 방문 권역을 ${result.areaName}(으)로 변경했어요.`;
    }
    showMessage(`${message} 출발지와 출발 시각은 유지하고 관광 일정은 새 권역에 맞췄어요. 이동시간을 다시 확인해 주세요.`,'success');
  }
  function focusEvent(dayIndex,eventId){
    if(dayIndex!==activeDayIndex){
      window.location.hash=`#/note/day/${dayIndex+1}`;
      syncScreen({focus:false});
    }
    selectDayPage(dayIndex);
    const article=$('day-list').querySelector(`[data-day-index="${dayIndex}"]`);
    const row=[...(article?.querySelectorAll('.timeline-row')||[])].find(item=>item.dataset.eventId===eventId);
    row?.querySelector('.event-edit-button')?.focus({preventScroll:true});
  }
  function editTravelTime(dayIndex,eventId){
    const article=$('day-list').querySelector(`[data-day-index="${dayIndex}"]`);
    const row=[...(article?.querySelectorAll('.timeline-row')||[])].find(item=>item.dataset.eventId===eventId);
    const trigger=row?.querySelector('.event-edit-button');
    if(trigger&&!trigger.disabled&&trigger.getAttribute('aria-expanded')!=='true')trigger.click();
  }
  function attachReorderControls(time,row,event,dayIndex,city,position,total){
    time.className+=' has-reorder';
    const host=document.createElement('div');host.className='timeline-reorder';
    const trigger=document.createElement('button');trigger.type='button';trigger.className='timeline-dot';
    trigger.setAttribute('aria-label',`${eventName(event)} 순서 바꾸기`);
    trigger.setAttribute('aria-expanded','false');
    const controls=document.createElement('div');controls.className='timeline-move-controls';controls.hidden=true;
    controls.id=`timeline-move-${dayIndex}-${event.id}`;
    controls.setAttribute('role','group');controls.setAttribute('aria-label',`${eventName(event)} 일정 순서`);
    trigger.setAttribute('aria-controls',controls.id);
    const control={host,trigger,close:()=>setOpen(false)};
    function setOpen(open){
      if(open&&activeReorder!==control)closeReorderControls();
      controls.hidden=!open;trigger.setAttribute('aria-expanded',String(open));
      if(open){activeReorder=control;row.dataset.reordering='true';}
      else{if(activeReorder===control)activeReorder=null;delete row.dataset.reordering;}
    }
    let pointerToggle=null;
    host.addEventListener('pointerenter',pointer=>{if(pointer.pointerType==='mouse')setOpen(true);});
    host.addEventListener('pointerleave',()=>{if(!host.contains(document.activeElement))setOpen(false);});
    host.addEventListener('focusin',()=>setOpen(true));
    host.addEventListener('focusout',focus=>{if(!host.contains(focus.relatedTarget))setOpen(false);});
    trigger.addEventListener('pointerdown',()=>{pointerToggle=controls.hidden;});
    trigger.addEventListener('click',()=>{const open=pointerToggle??controls.hidden;pointerToggle=null;setOpen(open);});
    for(const [direction,caption] of [[-1,'위로'],[1,'아래로']]){
      const move=document.createElement('button');move.type='button';move.className='event-move-button';move.textContent=direction===-1?'↑':'↓';
      move.setAttribute('aria-label',`${eventName(event)} ${caption}`);move.title=`일정 ${caption}`;
      move.disabled=direction===-1?position===0:position===total-1;
      move.addEventListener('click',()=>{
        const result=window.TravelPlanner.moveEvent({city,itinerary:currentItinerary,dayIndex,eventId:event.id,direction});
        if(!result.ok){showMessage(result.reason,'error');return;}
        if(!saveEditedItinerary(result.itinerary)){showMessage('일정 순서를 저장하지 못했어요. 기존 노트는 유지했어요.','error');return;}
        currentItinerary=result.itinerary;renderItinerary();
        const article=$('day-list').querySelector(`[data-day-index="${dayIndex}"]`);
        const moved=[...(article?.querySelectorAll('.timeline-row')||[])].find(item=>item.dataset.eventId===event.id);
        moved?.querySelector('.timeline-dot')?.focus({preventScroll:true});
        showMessage('일정 순서를 바꾸고 시각을 다시 계산했어요. 장소가 달라진 구간은 이동시간을 확인해 주세요.','success');
      });
      controls.append(move);
    }
    host.append(trigger,controls);time.append(host);
  }
  function renderDayTiming(day,dayIndex,city){
    const timing=document.createElement('div');
    timing.className='day-timing';
    const originHost=document.createElement('div');
    originHost.className='day-origin-container';
    originHost.id=`day-origin-${dayIndex}`;
    const widget=window.TravelDeparture.mount(originHost,{departure:day.departure,mode:departureDraftModes[dayIndex],onChange:(departure,selection={})=>{
      const result=window.TravelPlanner.setDayDeparture({city,itinerary:currentItinerary,dayIndex,departure});
      if(!result.ok){widget.set(currentItinerary.days[dayIndex].departure);showMessage(result.reason,'error');return;}
      if(!saveEditedItinerary(result.itinerary)){widget.set(currentItinerary.days[dayIndex].departure);showMessage('출발지 변경을 저장하지 못했어요. 기존 일정은 유지했어요.','error');return;}
      departureDraftModes[dayIndex]=selection.mode||departure?.mode||'';
      currentItinerary=result.itinerary;
      renderItinerary();
      $(`day-origin-${dayIndex}`).querySelector('summary').focus({preventScroll:true});
      showMessage(departure?`${dayIndex+1}일차 출발지를 저장했어요.`:`${dayIndex+1}일차 출발지를 해제했어요.`,'success');
    }});
    departureWidgets.push(widget);
    let arrivalHost=null;
    if(window.TravelPlanner.requiresArrival(day.departure?.mode)){
      arrivalHost=document.createElement('div');
      arrivalHost.className='day-origin-container day-arrival-container';
      arrivalHost.id=`day-arrival-${dayIndex}`;
      const arrivalWidget=window.TravelDeparture.mount(arrivalHost,{role:'arrival',mode:day.departure.mode,service:day.departure.service,departure:day.arrival,onChange:arrival=>{
        const result=window.TravelPlanner.setDayArrival({city,itinerary:currentItinerary,dayIndex,arrival});
        if(!result.ok){arrivalWidget.set(currentItinerary.days[dayIndex].arrival);showMessage(result.reason,'error');return;}
        if(!saveEditedItinerary(result.itinerary)){arrivalWidget.set(currentItinerary.days[dayIndex].arrival);showMessage('도착지 변경을 저장하지 못했어요. 기존 일정은 유지했어요.','error');return;}
        currentItinerary=result.itinerary;
        renderItinerary();
        $(`day-arrival-${dayIndex}`).querySelector('summary').focus({preventScroll:true});
        showMessage(arrival?`${dayIndex+1}일차 도착지를 저장했어요. 바뀐 구간의 예상 이동시간을 입력해 주세요.`:`${dayIndex+1}일차 도착지를 해제했어요. 이동시간을 다시 정해 주세요.`,'success');
      }});
      departureWidgets.push(arrivalWidget);
    }
    const form=document.createElement('form');
    form.className='day-start-form';
    form.noValidate=true;
    const label=document.createElement('label');
    const input=document.createElement('input');
    input.type='time';input.required=true;
    input.id=`day-start-${dayIndex}`;
    input.value=currentItinerary.dayStarts?.[dayIndex]||'09:00';
    label.htmlFor=input.id;label.textContent='출발 시각';
    input.setAttribute('aria-label',`${dayIndex+1}일차 출발 시각`);
    const note=document.createElement('p');
    note.className='day-timing-note';
    note.hidden=true;
    note.setAttribute('aria-live','polite');
    form.append(label,input);
    form.addEventListener('submit',event=>event.preventDefault());
    input.addEventListener('change',()=>{
      const result=window.TravelPlanner.setDayStart({city,itinerary:currentItinerary,dayIndex,startTime:input.value});
      if(!result.ok){note.textContent=result.reason;note.hidden=false;return;}
      if(!saveEditedItinerary(result.itinerary)){note.textContent='시간을 저장하지 못했어요. 다시 시도해 주세요.';note.hidden=false;return;}
      currentItinerary=result.itinerary;
      renderItinerary();
      if(window.TravelTimePicker)window.TravelTimePicker.focus(`day-start-${dayIndex}`);
      else $(`day-start-${dayIndex}`).focus({preventScroll:true});
      showMessage(`${dayIndex+1}일차 출발 시각을 바꾸고 뒤 일정을 함께 조정했어요.`,'success');
    });
    timing.append(originHost);
    if(arrivalHost)timing.append(arrivalHost);
    timing.append(form,note);
    if(arrivalHost){
      const transportHost=document.createElement('div');transportHost.className='day-transport-container';transportHost.id=`day-transport-${dayIndex}`;
      const travelDate=new Date(`${currentItinerary.startDate}T12:00:00Z`);travelDate.setUTCDate(travelDate.getUTCDate()+dayIndex);
      const commitTransport=transport=>{
        const result=window.TravelPlanner.setDayTransport({city,itinerary:currentItinerary,dayIndex,transport});
        if(!result.ok)return result;
        if(!saveEditedItinerary(result.itinerary))return {ok:false,reason:'교통편 변경을 저장하지 못했어요. 기존 일정은 유지했어요.'};
        currentItinerary=result.itinerary;renderItinerary();
        $(`day-transport-${dayIndex}`)?.querySelector('summary')?.focus({preventScroll:true});
        showMessage(transport?'교통편 시간표로 출발·도착 시각과 뒤 일정을 조정하고 저장했어요.':'교통편 선택을 해제했어요. 현재 시간은 직접 수정할 수 있어요.','success');
        return {ok:true};
      };
      departureWidgets.push(window.TravelTransport.mount(transportHost,{date:travelDate.toISOString().slice(0,10),departure:day.departure,arrival:day.arrival,startTime:input.value,transport:day.transport?.connection?null:day.transport,onApply:commitTransport,onClear:()=>commitTransport(null)}));
      timing.append(transportHost);
      if(window.TravelConnections&&day.departure?.source==='TAGO'&&day.arrival?.source==='TAGO'&&day.departure.service===day.arrival.service){
        const connectionHost=document.createElement('div');connectionHost.className='day-connection-container';connectionHost.id=`day-connection-${dayIndex}`;
        departureWidgets.push(window.TravelConnections.mount(connectionHost,{date:travelDate.toISOString().slice(0,10),departure:day.departure,arrival:day.arrival,transport:day.transport,onApply:connection=>{
          const result=window.TravelPlanner.setDayConnection({city,itinerary:currentItinerary,dayIndex,...connection});
          if(!result.ok)return result;
          if(!saveEditedItinerary(result.itinerary))return {ok:false,reason:'환승 여정을 저장하지 못했어요. 기존 일정은 유지했어요.'};
          currentItinerary=result.itinerary;renderItinerary();
          $(`day-connection-${dayIndex}`)?.querySelector('summary')?.focus({preventScroll:true});
          showMessage('구간별 시간표와 환승 대기시간을 반영해 뒤 일정을 조정하고 저장했어요.','success');
          return {ok:true};
        }}));
        timing.append(connectionHost);
      }
    }
    if(window.TravelCarRouting&&['car','rental-car','taxi'].includes(day.departure?.mode||departureDraftModes[dayIndex])){
      mountCarRoute(timing,day.departure,day.events.find(event=>event.type==='place')?.place,dayIndex,'departure',city);
    }
    const transitMode=day.departure?.mode||departureDraftModes[dayIndex];
    if(window.TravelTransitRouting&&['local-bus','subway'].includes(transitMode)){
      const transitHost=document.createElement('div');transitHost.className='transit-route-container';
      departureWidgets.push(window.TravelTransitRouting.mount(transitHost,{origin:day.departure,destination:day.events.find(event=>event.type==='place')?.place,mode:transitMode,onEdit:()=>editTravelTime(dayIndex,'departure'),onPreviewDuration:transitTimePreview(dayIndex,'departure')}));
      timing.append(transitHost);
    }
    return timing;
  }
  function mountCarRoute(host,origin,destination,dayIndex,eventId,city){
    const routeHost=document.createElement('div');
    routeHost.className='car-route-container';
    const widget=window.TravelCarRouting.mount(routeHost,{origin,destination,onApply:route=>applyCarRoute(route,dayIndex,eventId,city)});
    departureWidgets.push(widget);
    host.append(routeHost);
  }
  function applyCarRoute(route,dayIndex,eventId,city){
      const result=window.TravelPlanner.updateEvent({city,itinerary:currentItinerary,dayIndex,eventId,duration:route.durationMinutes});
      if(!result.ok)return result;
      if(!saveEditedItinerary(result.itinerary))return {ok:false,reason:'이동시간을 저장하지 못했어요. 기존 일정은 유지했어요.'};
      currentItinerary=result.itinerary;
      renderItinerary();
      focusEvent(dayIndex,eventId);
      showMessage(`현재 교통 기준 예상 ${formatDuration(route.durationMinutes)}을 적용하고 뒤 일정을 조정했어요. 여행 당일에는 시간이 달라질 수 있어요.`,'success');
      return {ok:true};
  }
  function formatTime(minutes){return window.TravelPlanner.formatTime(minutes);}
  function formatDuration(minutes){
    const hours=Math.floor(minutes/60),rest=minutes%60;
    return [hours?`${hours}시간`:'',rest?`${rest}분`:''].filter(Boolean).join(' ')||'0분';
  }
  function timeMarkup(label){
    const parts=String(label).match(/^(.*) (\d{2}:\d{2})$/);
    return parts?`<small>${esc(parts[1])}</small>${esc(parts[2])}`:esc(label);
  }
  function eventName(event){
    if(event.type==='place')return event.place.name;
    if(event.type==='departure')return event.departure?`${event.departure.name}에서 출발`:'출발지를 선택해 주세요';
    return event.title||(event.type==='meal'?event.meal:event.type==='rest'?'잠깐 쉬어 가기':event.type==='free'?'권역에서 여유롭게 둘러보기':'이동');
  }
  function renderSelectedConnection(day){
    const transport=day.transport,connection=transport?.connection;
    if(!connection||!Array.isArray(connection.legs)||connection.legs.length!==2)return null;
    const base=Date.parse(`${transport.date}T00:00:00Z`);
    const times=connection.legs.map(trip=>{
      const offset=(Date.parse(`${trip.date}T00:00:00Z`)-base)/86400000;
      return {start:offset*1440+trip.departureMinutes,end:offset*1440+trip.arrivalMinutes};
    });
    if(times.some(time=>!Number.isInteger(time.start)||!Number.isInteger(time.end)||time.end<=time.start)||times[1].start<times[0].end)return null;
    const box=document.createElement('section');box.className='connection-preview selected-connection-summary event-description';
    box.setAttribute('aria-label','선택한 환승 여정');
    const heading=document.createElement('strong');heading.textContent=`${connection.via.name} 경유 · 1회 환승 · 총 ${formatDuration(transport.durationMinutes)}`;
    box.append(heading);
    connection.legs.forEach((trip,index)=>{
      if(index===1){
        const wait=document.createElement('p');
        wait.textContent=`${connection.via.name} 환승 · ${formatTime(times[0].end)} → ${formatTime(times[1].start)} · 대기 ${formatDuration(times[1].start-times[0].end)}`;
        box.append(wait);
      }
      const leg=document.createElement('p');
      const service=[trip.grade,trip.tripNo].filter(Boolean).join(' ');
      leg.textContent=`${index+1}구간 ${trip.departureName} → ${trip.arrivalName} · ${formatTime(times[index].start)} → ${formatTime(times[index].end)} · ${service?`${service} · `:''}${formatDuration(trip.durationMinutes)}`;
      box.append(leg);
    });
    return box;
  }
  function renderEvent(event,dayIndex,city){
    const extra=event.id.startsWith('extra-');
    const row=document.createElement('div');
    row.className=`timeline-row ${event.type==='departure'?'departure-row':event.type==='arrival'?'arrival-row':event.type==='finish'?'finish-row':event.type==='place'?'place-row':event.type==='transfer'?'transfer-row':'meal-row'}`;
    row.dataset.eventId=event.id;
    const time=document.createElement('div');
    time.className='timeline-time';
    const labels=document.createElement('span');labels.className='timeline-time-labels';
    labels.innerHTML=eventTimeMarkup(event.startLabel,event.endLabel,event.duration);time.append(labels);
    row.append(time);
    const content=document.createElement('div');
    content.className='timeline-content';
    if(event.type==='departure'){
      const title=document.createElement('h3');title.className='event-title';title.textContent=eventName(event);
      content.append(title,renderDayTiming(currentItinerary.days[dayIndex],dayIndex,city));
      const connection=renderSelectedConnection(currentItinerary.days[dayIndex]);
      if(connection)content.append(connection);
      if(event.departure&&event.description){const memo=document.createElement('p');memo.className='event-description';memo.textContent=event.description;content.append(memo);}
      const meta=document.createElement('div');meta.className='event-meta';
      const duration=document.createElement('span');duration.className='meta-pill event-duration';duration.hidden=event.duration===0;
      duration.textContent=travelDurationLabel(event,currentItinerary.days[dayIndex],event.duration);meta.append(duration);
      if(meta.childNodes.length)content.append(meta);
    }else if(event.type==='arrival'){
      const title=document.createElement('h3');title.className='event-title';title.textContent=eventName(event);
      const address=document.createElement('p');address.className='event-description';address.textContent=event.arrival.address;
      const meta=document.createElement('div');meta.className='event-meta';
      const pill=document.createElement('span');pill.className='meta-pill';pill.textContent=currentItinerary.days[dayIndex].transport?'시간표 기준 도착 예정':'예상 도착 · 입력한 이동시간 기준';
      meta.append(pill);content.append(title,address,meta);
    }else if(event.type==='place'){
      const top=document.createElement('div');
      top.className='event-top';
      const titleBox=document.createElement('div');
      titleBox.className='event-place-heading';
      titleBox.innerHTML=`<span class="place-sticker" aria-hidden="true">${event.place.category==='문화시설'?'🏛️':'📍'}</span><div class="event-copy"><h3 class="event-title">${esc(eventName(event))}</h3><span class="event-subtitle">${esc(eventName(event)!==event.place.name?`${event.place.name} · `:'')}${esc(event.place.areaName||event.place.area)} · ${esc(event.place.category)}</span></div>`;
      const actions=document.createElement('div');
      actions.className='event-actions';
      const swap=document.createElement('button');
      swap.type='button';
      swap.className='swap-button';
      swap.textContent='다른 장소로 변경';
      swap.setAttribute('aria-label',`${event.place.name} 다른 장소로 변경`);
      swap.addEventListener('click',()=>showSwapPicker(content,dayIndex,event.place.id,city));
      const map=document.createElement('a');
      map.className='map-link';
      map.href=mapHref(event.place);
      map.target='_blank';
      map.rel='noopener noreferrer';
      map.textContent='지도 검색 ↗';
      map.setAttribute('aria-label',`${event.place.name} Google Maps에서 검색`);
      if(!touristCandidates(city).length){
        swap.disabled=true;swap.title='현재 지역에서 교체할 다른 후보가 없어요. 관광 순서를 바꾸거나 이 일정을 뺄 수 있어요.';
      }
      actions.append(swap);
      actions.append(map);
      top.append(titleBox,actions);
      content.append(top);
      const desc=document.createElement('p');
      desc.className='event-description';
      desc.textContent=event.place.address||event.place.intro||'';
      content.append(desc);
      if(event.place.address)content.append(window.TravelNoteTools.addressCopy(event.place.address,event.place.name));
      if(event.description&&event.description!==event.place.intro&&event.description!==event.place.address){
        const memo=document.createElement('p');memo.className='event-description event-user-memo';memo.textContent=event.description;content.append(memo);
      }
      const meta=document.createElement('div');
      meta.className='event-meta';
      const editedDuration=currentItinerary.eventEdits?.[dayIndex]?.[event.id]?.duration!==undefined;
      meta.innerHTML=`<span class="meta-pill">체류 ${event.duration}분 · ${extra?'직접 추가':editedDuration?'직접 수정':'앱 추천값'}</span><span class="meta-pill">방문 전 운영시간 확인</span>`;
      content.append(meta);
    }else if(event.type==='finish'){
      content.innerHTML=`<h3 class="event-title">${esc(eventName(event))}</h3><p class="event-description">${esc(event.description||'')}</p>${event.duration?`<div class="event-meta"><span class="meta-pill">마무리 ${formatDuration(event.duration)}</span></div>`:''}`;
    }else{
      const name=eventName(event);
      const description=event.description??event.label??'';
      const title=document.createElement('h3');title.className='event-title';title.textContent=name;
      const desc=document.createElement('p');desc.className='event-description';desc.textContent=`${description}${event.type==='transfer'?' · 계획용 예상시간':''}`;
      const meta=document.createElement('div');meta.className='event-meta';
      const pill=document.createElement('span');pill.className='meta-pill event-duration';
      pill.textContent=event.type==='transfer'?travelDurationLabel(event,currentItinerary.days[dayIndex],event.duration):`일정 여유 ${formatDuration(event.duration)}`;
      meta.append(pill);content.append(title,desc,meta);
    }
    if(event.type==='arrival'){row.append(content);return row;}
    const edit=document.createElement('button');
    edit.type='button';edit.className='event-edit-button';
    const editAction=event.type==='departure'?(window.TravelPlanner.requiresArrival(event.departure?.mode)?'교통편 예상시간 수정':'첫 관광지까지 예상시간 수정'):event.id==='arrival-transfer'?'관광지까지 예상시간 수정':event.type==='place'?'체류시간·메모 수정':event.type==='finish'?'마무리 수정':'일정 수정';
    edit.textContent=editAction;
    edit.disabled=event.type==='departure'&&(!event.departure||(window.TravelPlanner.requiresArrival(event.departure.mode)&&!currentItinerary.days[dayIndex].arrival));
    edit.setAttribute('aria-label',`${eventName(event)} ${editAction.replace('·','과 ')}`);
    edit.setAttribute('aria-expanded','false');
    edit.addEventListener('click',()=>showEventEditor(content,event,dayIndex,city,edit));
    const footer=document.createElement('div');footer.className=`event-footer${event.type==='place'?' place-footer':''}`;
    const meta=content.querySelector('.event-meta');
    if(meta)footer.append(meta);
    footer.append(edit);content.append(footer);
    if(window.TravelPlanner.moveEvent&&!['departure','arrival','arrival-transfer','finish'].includes(event.id)){
      const editable=currentItinerary.days[dayIndex].events.filter(item=>!['departure','arrival','arrival-transfer','finish'].includes(item.id));
      const at=editable.findIndex(item=>item.id===event.id);
      attachReorderControls(time,row,event,dayIndex,city,at,editable.length);
      const remove=document.createElement('button');remove.type='button';remove.className='event-remove-button';
      remove.textContent=extra?'삭제':'빼기';remove.setAttribute('aria-label',`${eventName(event)} ${extra?'추가 일정 삭제':'일정에서 빼기'}`);
      remove.addEventListener('click',()=>{
        const result=window.TravelPlanner.removeEvent({city,itinerary:currentItinerary,dayIndex,eventId:event.id});
        if(!result.ok){showMessage(result.reason,'error');return;}
        if(!saveEditedItinerary(result.itinerary)){showMessage('삭제 내용을 저장하지 못했어요. 기존 노트는 유지했어요.','error');return;}
        currentItinerary=result.itinerary;renderItinerary();
        $('day-list').querySelector(`[data-day-index="${dayIndex}"] .schedule-add-container summary`)?.focus({preventScroll:true});
        showMessage(extra?'추가한 일정을 지우고 뒤 시각을 다시 계산했어요.':'일정에서 뺐어요. 아래의 뺀 일정 다시 담기로 복구할 수 있어요.','success');
      });
      footer.append(remove);
    }
    if(event.type==='transfer'&&window.TravelLocalTransfer){
      const events=currentItinerary.days[dayIndex].events;
      const index=events.findIndex(item=>item.id===event.id);
      const origin=event.id==='arrival-transfer'?currentItinerary.days[dayIndex].arrival:events.slice(0,index).reverse().find(item=>item.type==='place')?.place;
      const destination=events.slice(index+1).find(item=>item.type==='place')?.place;
      if(origin&&destination){
        const localHost=document.createElement('div');localHost.className='local-transfer-container';
        departureWidgets.push(window.TravelLocalTransfer.mount(localHost,{origin,destination,mode:event.travelMode,durationMinutes:event.duration,
          onApplyRoute:route=>applyCarRoute(route,dayIndex,event.id,city),
          onEditTime:()=>editTravelTime(dayIndex,event.id),
          onPreviewTransitDuration:transitTimePreview(dayIndex,event.id),
          onModeChange:mode=>{
            const result=window.TravelPlanner.setTransferMode({city,itinerary:currentItinerary,dayIndex,eventId:event.id,mode});
            if(!result.ok)return result;
            if(!saveEditedItinerary(result.itinerary))return {ok:false,reason:'이동수단을 저장하지 못했어요. 기존 일정은 유지했어요.'};
            currentItinerary=result.itinerary;renderItinerary();focusEvent(dayIndex,event.id);
            showMessage('이 구간의 이동수단을 저장했어요. 예상 이동시간을 확인해 주세요.','success');
            return {ok:true};
          }
        }));
        content.append(localHost);
      }
    }
    if(event.type==='meal'){
      const travelNotice=document.createElement('p');travelNotice.className='departure-hint';
      travelNotice.textContent='식당을 담아도 오가는 이동시간은 자동으로 더해지지 않아요. 필요한 이동 일정을 직접 추가해 주세요.';
      content.append(travelNotice);
      const day=currentItinerary.days[dayIndex];
      const mealIndex=day.events.findIndex(item=>item.id===event.id);
      const nearby=day.events.slice(0,mealIndex).reverse().find(item=>item.type==='place')?.place||day.events.find(item=>item.type==='place')?.place;
      const manualHost=document.createElement('div');manualHost.className='meal-manual-container';
      content.append(manualHost);
      const mealLabel=event.meal||'식사';
      const savedMeal=currentItinerary.eventEdits?.[dayIndex]?.[event.id]||(extra?event:null);
      const manualName=event.title?.includes(' · ')?event.title.slice(event.title.indexOf(' · ')+3):(savedMeal?.title&&savedMeal.title!==mealLabel?savedMeal.title:'');
      const saveManualMeal=(value,clear=false)=>{
        if(currentItinerary?.cityId!==city.id)return {ok:false,reason:'현재 여행 노트에서 다시 입력해 주세요.'};
        const selected=currentItinerary.days[dayIndex]?.events.find(entry=>entry.id===event.id&&entry.type==='meal');
        if(!selected)return {ok:false,reason:'식사 일정을 확인한 뒤 다시 입력해 주세요.'};
        const name=typeof value?.name==='string'?value.name.trim():'';
        const description=typeof value?.description==='string'?value.description.trim():'';
        if(!clear&&(!name||name.length>60||/[\u0000-\u001f\u007f]/.test(name)||description.length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)))return {ok:false,reason:'식당 이름은 1~60자, 주소·메모는 500자 이내로 입력해 주세요.'};
        const result=window.TravelPlanner.updateEvent({city,itinerary:currentItinerary,dayIndex,eventId:event.id,title:clear?(extra?'식사':undefined):`${selected.meal||'식사'} · ${name}`,resetTitle:clear&&!extra,description:clear?'':description});
        if(!result.ok)return result;
        if(!saveEditedItinerary(result.itinerary))return {ok:false,reason:'식당 정보를 저장하지 못했어요. 기존 노트는 유지했어요.'};
        currentItinerary=result.itinerary;renderItinerary();focusEvent(dayIndex,event.id);
        showMessage(clear?'식당 정보를 지웠어요. 식사 시간은 그대로 유지했어요.':'입력한 식당을 저장했어요. 필요한 이동시간은 직접 추가해 주세요.','success');
        return {ok:true};
      };
      departureWidgets.push(window.TravelRestaurants.mountManual(manualHost,{name:manualName,description:savedMeal?.description||'',onSave:value=>saveManualMeal(value),onClear:()=>saveManualMeal(null,true)}));
      const restaurants=document.createElement('div');restaurants.className='meal-restaurants-container';
      content.append(restaurants);
      departureWidgets.push(window.TravelRestaurants.mount(restaurants,{area:city.name,district:window.TravelRestaurants.districtFromAddress(nearby?.address),latitude:nearby?.latitude,longitude:nearby?.longitude,
        onSelect:item=>{
          if(currentItinerary?.cityId!==city.id)return {ok:false,reason:'현재 여행 노트에서 다시 골라주세요.'};
          const selected=currentItinerary.days[dayIndex]?.events.find(entry=>entry.id===event.id&&entry.type==='meal');
          if(!selected)return {ok:false,reason:'식사 일정을 확인한 뒤 다시 골라주세요.'};
          const previous=currentItinerary.eventEdits?.[dayIndex]?.[event.id]?.description??(extra?selected.description:'');
          const memo=previous.replace(/^식당 주소: [^\n]*(?:\n|$)/,'');
          const description=`식당 주소: ${item.address}${memo?`\n${memo}`:''}`;
          if(description.length>500)return {ok:false,reason:'식당 주소와 메모를 함께 담으려면 기존 식사 메모를 조금 줄여 주세요.'};
          const result=window.TravelPlanner.updateEvent({city,itinerary:currentItinerary,dayIndex,eventId:event.id,title:`${selected.meal||'식사'} · ${item.name}`.slice(0,80),description});
          if(!result.ok)return result;
          if(!saveEditedItinerary(result.itinerary))return {ok:false,reason:'선택한 식당을 저장하지 못했어요. 기존 노트는 유지했어요.'};
          currentItinerary=result.itinerary;renderItinerary();focusEvent(dayIndex,event.id);
          showMessage('식당을 담았어요. 식당까지 오가는 이동시간은 포함되지 않아요. 필요한 이동 일정을 직접 추가해 주세요.','success');
          return {ok:true};
        }
      }));
    }
    row.append(content);
    return row;
  }
  function showEventEditor(content,event,dayIndex,city,trigger){
    const old=content.querySelector('.event-editor');
    if(old){editorCaptures.get(old)?.();editorCaptures.delete(old);old.remove();trigger.setAttribute('aria-expanded','false');return;}
    for(const other of $('day-list').querySelectorAll('.event-editor')){
      editorCaptures.get(other)?.();editorCaptures.delete(other);
      other.closest('.timeline-content')?.querySelector('.event-edit-button')?.setAttribute('aria-expanded','false');
      other.remove();
    }
    const form=document.createElement('form');
    form.className='event-editor';form.noValidate=true;
    form.setAttribute('aria-label',`${eventName(event)} 수정`);
    const grid=document.createElement('div');grid.className='event-editor-grid';
    function field(text,input,wide=false){
      const label=document.createElement('label');
      label.className=`editor-field${wide?' editor-wide':''}`;
      const caption=document.createElement('span');caption.textContent=text;
      label.append(caption,input);grid.append(label);
    }
    const title=document.createElement('input');
    title.type='text';title.maxLength=80;title.required=true;title.value=eventName(event);
    title.readOnly=event.type==='place'||event.type==='departure';
    field(event.type==='departure'?'출발지':event.type==='place'?'관광지 이름':'일정 이름',title);
    const minutes=document.createElement('input');
    const maximumHours=event.type==='departure'?72:12;
    minutes.type='number';minutes.min=event.type==='departure'?'0':'1';minutes.max=String(maximumHours*60);minutes.step='1';minutes.required=true;minutes.value=String(event.duration);
    const splitDuration=event.type==='departure'||event.type==='transfer'||event.type==='finish';
    const durationLabel=event.type==='finish'?'소요시간':'이동시간';
    let hours=null;
    if(splitDuration){
      hours=document.createElement('input');
      hours.type='number';hours.min='0';hours.max=String(maximumHours);hours.step='1';hours.value=String(Math.floor(event.duration/60));
      hours.setAttribute('aria-label',`${durationLabel}: 시간`);
      minutes.min='0';minutes.max='59';minutes.value=String(event.duration%60);
      minutes.setAttribute('aria-label',`${durationLabel}: 분`);
      const group=document.createElement('fieldset');group.className='editor-field duration-field';
      const legend=document.createElement('legend');legend.textContent=event.type==='departure'?(currentItinerary.days[dayIndex].arrival?'도착지까지 예상 이동시간':'첫 관광지까지 이동시간'):event.id==='arrival-transfer'?'도착지 → 첫 관광지 예상시간':event.type==='finish'?'마무리 소요시간':'이동시간';
      const parts=document.createElement('div');parts.className='duration-parts';
      for(const [input,unit] of [[hours,'시간'],[minutes,'분']]){
        const label=document.createElement('label');label.className='duration-part';
        const caption=document.createElement('span');caption.textContent=unit;label.append(input,caption);parts.append(label);
      }
      group.append(legend,parts);grid.append(group);
    }else field('소요시간 (분)',minutes);
    const description=document.createElement('textarea');
    description.rows=2;description.maxLength=500;
    description.value=event.description??event.label??(event.type==='place'?event.place.intro:'');
    field('설명·메모',description,true);
    const updateCounter=window.TravelNoteTools.memoCounter(description);
    const draftKey=`${dayIndex}:${event.id}`,base=editorIdentity(event,dayIndex);
    const original={base,title:title.value,description:description.value,minutes:minutes.value,hours:hours?.value??null};
    const draft=editorDrafts[draftKey];
    if(draft?.base===base){
      if(!title.readOnly)title.value=draft.title;
      description.value=draft.description;minutes.value=draft.minutes;if(hours&&draft.hours!==null)hours.value=draft.hours;
      updateCounter();
    }
    const draftStatus=document.createElement('p');draftStatus.className='editor-help editor-draft-status';draftStatus.setAttribute('role','status');
    draftStatus.textContent=draft?.base===base?'저장 전 입력을 불러왔어요. 수정 저장을 누르면 일정에 반영돼요.':'';
    function capture(){
      const value={base,title:title.value,description:description.value,minutes:minutes.value,hours:hours?.value??null};
      if(JSON.stringify(value)===JSON.stringify(original))delete editorDrafts[draftKey];else editorDrafts[draftKey]=value;
      if(!persistDraftContext())draftStatus.textContent='입력 내용을 기기에 보관하지 못했어요. 이 창을 유지하고 수정 저장을 눌러 주세요.';
    }
    editorCaptures.set(form,capture);form.addEventListener('input',capture);form.addEventListener('change',capture);
    const help=document.createElement('p');help.className='editor-help';help.textContent=event.type==='departure'?(currentItinerary.days[dayIndex].arrival?'선택한 도착역·터미널 등에 내릴 때까지의 시간을 입력해 주세요. 대기·환승도 포함하고, 도착 후 관광지까지 이동은 다음 항목에서 정해요. 미정이면 0시간 0분으로 두세요.':'교통편과 대기시간을 포함해 직접 입력해 주세요. 미정이면 0시간 0분으로 두면 돼요.'):event.id==='arrival-transfer'?'도착한 곳에서 첫 관광지까지 걸리는 시간을 입력해 주세요. 미정이면 0시간 0분으로 두세요.':event.type==='transfer'?'이 구간의 예상 이동시간을 입력해 주세요. 0시간 0분은 미정이며, 뒤 시각도 임시 계획으로 표시돼요.':event.type==='finish'?'숙소 복귀나 귀가 시간을 입력하면 종료 시각에 더해져요. 마무리 표시만 남기려면 0시간 0분으로 두세요.':event.type==='place'?'관광지명은 공공정보 기준이에요. 체류시간을 바꾸면 뒤 일정도 함께 이동해요.':'소요시간을 바꾸면 뒤 일정도 함께 이동해요.';
    const actions=document.createElement('div');actions.className='editor-actions';
    const save=document.createElement('button');save.className='editor-save';save.type='submit';save.textContent='수정 저장';
    const cancel=document.createElement('button');cancel.className='editor-cancel';cancel.type='button';cancel.textContent='취소';
    const error=document.createElement('p');error.className='editor-error';error.setAttribute('role','alert');error.hidden=true;
    function close(discard=false){if(discard){delete editorDrafts[draftKey];persistDraftContext();}else capture();editorCaptures.delete(form);form.remove();trigger.setAttribute('aria-expanded','false');trigger.focus({preventScroll:true});}
    cancel.addEventListener('click',()=>close(true));
    form.addEventListener('keydown',key=>{if(key.key==='Escape'){key.preventDefault();close();}});
    form.addEventListener('submit',submission=>{
      submission.preventDefault();
      const minutePart=Number(minutes.value),hourPart=hours?Number(hours.value):0;
      const editedDuration=splitDuration?hourPart*60+minutePart:minutePart;
      if(splitDuration&&(!hours.value.trim()||!minutes.value.trim()||!Number.isInteger(hourPart)||hourPart<0||!Number.isInteger(minutePart)||minutePart<0||minutePart>59||editedDuration>maximumHours*60)){
        error.textContent=`${durationLabel}은 최대 ${maximumHours}시간이며, 시·분을 모두 입력하고 분은 0~59 사이로 정해 주세요.`;error.hidden=false;return;
      }
      const result=window.TravelPlanner.updateEvent({city,itinerary:currentItinerary,dayIndex,eventId:event.id,title:title.readOnly?undefined:title.value,description:description.value,duration:editedDuration});
      if(!result.ok){error.textContent=result.reason;error.hidden=false;return;}
      const previousDraft=editorDrafts[draftKey];delete editorDrafts[draftKey];editorCaptures.delete(form);
      if(!saveEditedItinerary(result.itinerary)){if(previousDraft)editorDrafts[draftKey]=previousDraft;editorCaptures.set(form,capture);error.textContent='수정 내용을 저장하지 못했어요. 다시 시도해 주세요.';error.hidden=false;return;}
      currentItinerary=result.itinerary;
      renderItinerary();
      focusEvent(dayIndex,event.id);
      showMessage('수정한 내용을 저장하고 뒤 일정을 함께 조정했어요.','success');
    });
    actions.append(save,cancel);
    form.append(grid,draftStatus,help,actions,error);content.append(form);
    window.TravelSelect?.refresh();
    trigger.setAttribute('aria-expanded','true');(event.type==='finish'?title:hours||(title.readOnly?minutes:title)).focus();
  }
  function showSwapPicker(content,dayIndex,placeId,city){
    const old=content.querySelector('.swap-picker');
    if(old){old.remove();return;}
    const selectedEvent=currentItinerary.days[dayIndex].events.find(event=>event.type==='place'&&event.place.id===placeId);
    const options=touristCandidates(city);
    if(!options.length){showMessage('교체할 다른 관광지가 없어요. 관광 순서를 바꾸거나 일정에서 뺄 수 있어요.');return;}
    const picker=document.createElement('div');
    picker.className='swap-picker';
    const scope=document.createElement('p');scope.className='swap-scope';scope.textContent=`${city.name} 전체 관광지에서 ${options.length}곳을 고를 수 있어요. 이미 담은 장소는 제외했어요.`;
    const select=document.createElement('select');
    select.className='day-area-select swap-place-select';
    select.setAttribute('aria-label','대체 관광지 검색과 선택');
    for(const place of options){
      const option=document.createElement('option');
      option.value=place.id;
      option.textContent=compactName(place.name);
      option.title=`${place.name} · ${place.stayMinutes}분 추천`;
      option.dataset.search=[place.name,place.areaName,place.address].filter(Boolean).join(' ');
      select.append(option);
    }
    const apply=document.createElement('button');
    apply.type='button';
    apply.textContent='교체 적용';
    apply.addEventListener('click',()=>{
      const result=window.TravelPlanner.replaceTouristEvent({city,itinerary:currentItinerary,dayIndex,eventId:selectedEvent.id,replacementId:select.value});
      if(!result.ok){showMessage(result.reason,'error');return;}
      if(!saveEditedItinerary(result.itinerary)){
        showMessage('장소 교체를 저장하지 못했어요. 기존 일정과 저장본을 그대로 유지했습니다.','error');
        return;
      }
      currentItinerary=result.itinerary;
      renderItinerary();
      focusEvent(dayIndex,result.eventId||selectedEvent.id);
      showMessage('관광지를 바꾸고 저장했어요. 바뀐 장소와 연결된 이동시간은 다시 확인해 주세요.','success');
    });
    picker.append(scope,select,apply);
    content.append(picker);
    window.TravelSelect?.refresh();
  }

  $('trip-form').addEventListener('submit',event=>{event.preventDefault();create();});
  country.addEventListener('change',()=>{updateCityOptions(false);discardItineraryForChangedConditions();});
  citySelect.addEventListener('change',()=>{updateCityHint();discardItineraryForChangedConditions();prepareSelectedCity();});
  dateInput.addEventListener('change',discardItineraryForChangedConditions);
  duration.addEventListener('change',discardItineraryForChangedConditions);
  $('destinations-retry').addEventListener('click',()=>initializeDestinations(!currentItinerary));
  $('undo-button')?.addEventListener('click',()=>applyEditHistory('undo'));
  $('redo-button')?.addEventListener('click',()=>applyEditHistory('redo'));
  $('print-button').addEventListener('click',()=>window.print());
  window.addEventListener('beforeprint',()=>{
    clearTransitTimePreviews();
    $('day-list').querySelectorAll('.transit-route-lookup').forEach(details=>{details.open=false;});
  });
  $('clear-button').addEventListener('click',()=>{
    if(!window.confirm('이 브라우저의 여행 노트와 자동저장본을 지울까요? 계정에 따로 저장하지 않은 내용은 되돌릴 수 없어요. 계정에 저장한 계획은 지워지지 않아요.'))return;
    requestVersion++;
    setBusy(false);
    try{localStorage.removeItem(draftStorageKey());}catch(error){
      showMessage('브라우저에 저장된 일정을 지우지 못했어요. 저장 공간 설정을 확인해 주세요.','error');
      return;
    }
    resetDisplayedItinerary();
    hideMessage();
    showMessage('이 브라우저에 저장된 일정만 지웠어요.','success');
    navigate('start',{replace:true});
  });

  window.addEventListener('hashchange',()=>syncScreen());
  window.addEventListener('focus',refreshCountdown);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshCountdown();});
  document.addEventListener('input',dismissMessageForInput);
  document.addEventListener('change',dismissMessageForInput);
  document.addEventListener('pointerdown',event=>{
    if(activeReorder&&!activeReorder.host.contains(event.target))closeReorderControls();
  });
  // Wait until the click target is fixed so removing a notice cannot move a pressed button.
  // Capture clears the previous notice before the target handler can show its new result.
  document.addEventListener('click',event=>{
    if(messageKind!=='error'&&messageKind!=='loading'&&event.target.closest?.('input,select,textarea,button,a,[role="option"]'))hideMessage();
  },true);
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&activeReorder){event.preventDefault();closeReorderControls(true);}
  });
  syncScreen({focus:false});
  account=window.TravelAccount?.mount({
    accountRoot:$('account-nav'),libraryRoot:$('saved-plans'),saveRoot:$('account-save'),noticeRoot:$('account-notice'),
    getDocument:cloudDocument,
    getDefaultTitle:()=>currentItinerary?`${currentItinerary.cityName} · ${currentItinerary.startDate} · ${currentItinerary.dayCount}일`:'새 여행 계획',
    loadDocument:async (document,options={})=>{
      const restored=await restoreDocument(document,{remote:true,isCurrent:options.isCurrent});
      if(restored)navigate('note');
      return restored;
    },
    onMessage:showMessage,
    onAttachmentChange:snapshot=>{
      if(suppressAttachmentChange)return;
      currentAttachment=snapshot?.ownerId===activeAccountUser?.id?snapshot:null;
      if(currentItinerary&&displayedDraftOwner===(activeAccountUser?.id||null)&&!persistDraftContext())throw Error('Attachment storage unavailable');
    },
    onUserChange:accountUserChanged
  })||null;
  duration.disabled=true;
  if(account?.ready)Promise.resolve(account.ready).then(()=>initializeDestinations());
  else initializeDestinations();
})();

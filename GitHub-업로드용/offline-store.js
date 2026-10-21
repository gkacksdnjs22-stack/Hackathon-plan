(function(){
  'use strict';
  const ACTIVE_KEY='gil-offline-active-v1',PREFIX='gil-offline-notes-v1:',MAX_NOTES=5,MAX_RECORD_BYTES=512000,MAX_STORE_BYTES=2600000;
  const TYPES=new Set(['departure','arrival','place','transfer','free','meal','rest','finish']);
  const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const keys=(value,allowed)=>record(value)&&Object.keys(value).length===allowed.length&&Object.keys(value).every(key=>allowed.includes(key));
  const owner=value=>value===null||typeof value==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(value);
  const text=(value,max,min=0)=>typeof value==='string'&&value.length>=min&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
  const instant=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value));
  const clone=value=>JSON.parse(JSON.stringify(value));
  const fail=message=>{throw Error(message);};
  function validateSnapshot(value){
    if(!keys(value,['version','title','cityName','startDate','dayCount','days'])||value.version!==1||!text(value.title,80,1)||!text(value.cityName,80,1)||!date(value.startDate)
      ||!Number.isInteger(value.dayCount)||value.dayCount<1||value.dayCount>7||!Array.isArray(value.days)||value.days.length!==value.dayCount)return false;
    return value.days.every((day,index)=>{
      const expected=new Date(Date.parse(`${value.startDate}T00:00:00Z`)+index*86400000).toISOString().slice(0,10);
      if(!keys(day,['date','provisional','events'])||day.date!==expected||typeof day.provisional!=='boolean'||!Array.isArray(day.events)||day.events.length<1||day.events.length>80)return false;
      return day.events.every((event,at)=>keys(event,['type','title','start','end','address','memo'])&&TYPES.has(event.type)&&text(event.title,240,1)&&text(event.address,500)&&text(event.memo,500)
        &&Number.isSafeInteger(event.start)&&Number.isSafeInteger(event.end)&&event.start>=0&&event.end>=event.start&&event.end<=100800
        &&(at===0?event.start<1440:event.start===day.events[at-1].end));
    });
  }
  function storage(value){return value||window.localStorage;}
  const storageKey=id=>{if(!owner(id))fail('저장할 계정을 확인해 주세요.');return `${PREFIX}${id===null?'guest':`account:${id}`}`;};
  function readActiveOwner(target){
    const raw=storage(target).getItem(ACTIVE_KEY);if(raw===null)return null;
    try{const value=JSON.parse(raw);return keys(value,['version','ownerId','checkedAt'])&&value.version===1&&owner(value.ownerId)&&instant(value.checkedAt)?clone(value):null;}catch{return null;}
  }
  function setActiveOwner(id,target,now=Date.now){
    if(!owner(id))fail('현재 계정을 확인해 주세요.');
    const current=readActiveOwner(target);if(current?.ownerId===id)return current;
    const result={version:1,ownerId:id,checkedAt:new Date(now()).toISOString()};storage(target).setItem(ACTIVE_KEY,JSON.stringify(result));return result;
  }
  function validNote(note,id){
    return keys(note,['version','ownerId','key','savedAt','snapshot'])&&note.version===1&&note.ownerId===id&&text(note.key,280,1)&&/^(?:plan|trip):[A-Za-z0-9_:-]+$/.test(note.key)
      &&instant(note.savedAt)&&validateSnapshot(note.snapshot)&&JSON.stringify(note).length<=MAX_RECORD_BYTES;
  }
  function list(id,target){
    const raw=storage(target).getItem(storageKey(id));if(raw===null)return [];
    if(raw.length>MAX_STORE_BYTES)fail('이 기기에 저장한 사본을 읽지 못했어요.');
    let value;try{value=JSON.parse(raw);}catch{fail('이 기기에 저장한 사본을 읽지 못했어요.');}
    if(!keys(value,['version','ownerId','notes'])||value.version!==1||value.ownerId!==id||!Array.isArray(value.notes)||value.notes.length>MAX_NOTES
      ||new Set(value.notes.map(note=>note?.key)).size!==value.notes.length||!value.notes.every(note=>validNote(note,id)))fail('이 기기에 저장한 사본을 읽지 못했어요.');
    return clone(value.notes).sort((a,b)=>b.savedAt.localeCompare(a.savedAt));
  }
  function requireActive(id,target){const active=readActiveOwner(target);if(!active||active.ownerId!==id)fail('현재 계정을 다시 확인한 뒤 저장해 주세요.');}
  function noteKey({ownerId,itinerary,attachment}={}){
    if(!owner(ownerId)||!itinerary||typeof itinerary.cityId!=='string'||!/^[a-z][a-z0-9-]{0,99}$/.test(itinerary.cityId)||!date(itinerary.startDate))fail('저장할 노트를 확인해 주세요.');
    const id=attachment?.ownerId===ownerId?attachment?.plan?.id:null;
    return typeof id==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(id)?`plan:${id}`:`trip:${itinerary.cityId}:${itinerary.startDate}`;
  }
  function save({ownerId,key,snapshot},target,now=Date.now){
    requireActive(ownerId,target);
    const note={version:1,ownerId,key,savedAt:new Date(now()).toISOString(),snapshot:clone(snapshot)};
    if(!validNote(note,ownerId))fail('오프라인으로 저장할 노트의 형식을 확인해 주세요.');
    const notes=list(ownerId,target),index=notes.findIndex(item=>item.key===key);
    if(index<0&&notes.length>=MAX_NOTES)fail('이 기기에는 계정마다 사본을 5개까지 보관해요. 오프라인 노트에서 필요 없는 사본을 삭제한 뒤 저장해 주세요.');
    if(index<0)notes.unshift(note);else notes[index]=note;
    const value=JSON.stringify({version:1,ownerId,notes});if(value.length>MAX_STORE_BYTES)fail('이 기기의 오프라인 저장 공간이 부족해요.');
    requireActive(ownerId,target);storage(target).setItem(storageKey(ownerId),value);return clone(note);
  }
  function remove(id,key,target){
    requireActive(id,target);const notes=list(id,target).filter(note=>note.key!==key);requireActive(id,target);
    storage(target).setItem(storageKey(id),JSON.stringify({version:1,ownerId:id,notes}));return clone(notes);
  }
  window.TravelOfflineStore={ACTIVE_KEY,PREFIX,MAX_NOTES,validateSnapshot,validOwner:owner,storageKey,readActiveOwner,setActiveOwner,noteKey,list,save,remove};
})();

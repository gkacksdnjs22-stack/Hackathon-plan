(function(){
  'use strict';
  const store=window.TravelOfflineStore,host=document.getElementById('offline-note'),list=document.getElementById('offline-notes'),status=document.getElementById('offline-status'),reload=document.getElementById('offline-reload');
  const node=(tag,text='')=>{const element=document.createElement(tag);element.textContent=text;return element;};
  const format=value=>new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Seoul'}).format(new Date(value));
  let generation=0,ownerId,known=false,selected='',destroyed=false;
  function clear(){known=false;ownerId=undefined;host.hidden=true;host.replaceChildren();list.replaceChildren();}
  function renderNotes(offline){
    if(!known)return;const notes=store.list(ownerId);list.replaceChildren();host.hidden=true;host.replaceChildren();
    if(!notes.length){status.textContent=ownerId===null?'로그인하지 않고 이 기기에 저장한 사본이 없어요. 여행 노트에서 먼저 오프라인으로 저장해 주세요.':'현재 계정으로 이 기기에 저장한 사본이 없어요. 여행 노트에서 먼저 오프라인으로 저장해 주세요.';return;}
    status.textContent=`${offline?'인터넷 연결 없이 이 기기에서 마지막으로 확인한 계정의 사본을 읽고 있어요.':'현재 계정으로 이 기기에 보관한 사본이에요.'} ${notes.length}/5개 · 저장한 시점의 내용이에요.`;
    const chosen=notes.find(note=>note.key===selected)||notes[0];selected=chosen.key;const renderedOwner=ownerId,renderedGeneration=generation;
    const current=()=>known&&ownerId===renderedOwner&&generation===renderedGeneration;
    for(const note of notes){
      const row=node('li');row.className='read-note-event';const open=node('button',note.snapshot.title);open.type='button';open.setAttribute('aria-pressed',String(note.key===selected));
      open.addEventListener('click',()=>{if(!current())return;selected=note.key;try{renderNotes(offline);}catch{clear();status.textContent='사본을 읽지 못했어요. 다시 확인해 주세요.';}});
      const copy=node('div');copy.append(node('p',`${note.snapshot.cityName} · ${note.snapshot.startDate}부터 ${note.snapshot.dayCount}일`),node('p',`마지막 저장: ${format(note.savedAt)}`));
      const remove=node('button','이 기기 사본 삭제');remove.type='button';remove.setAttribute('aria-label',`${note.snapshot.title} 이 기기 사본 삭제`);
      remove.addEventListener('click',()=>{if(!current())return;try{store.remove(renderedOwner,note.key);renderNotes(offline);}catch{clear();status.textContent='사본을 삭제하지 못했어요. 현재 계정과 저장 공간을 다시 확인해 주세요.';}});
      copy.append(remove);row.append(open,copy);list.append(row);
    }
    window.TravelNoteView.render(host,chosen.snapshot);host.hidden=false;
  }
  function lastKnown(){const value=store.readActiveOwner();if(!value){status.textContent='이 기기에서 마지막으로 확인한 계정이 없어요. 인터넷 연결 후 여행 노트에서 사본을 저장해 주세요.';return;}known=true;ownerId=value.ownerId;renderNotes(true);}
  async function load(){
    const version=++generation;clear();reload.disabled=true;status.textContent='현재 계정과 이 기기에 저장한 사본을 확인하고 있어요.';
    let timer;
    try{
      if(navigator.onLine===false){lastKnown();return;}
      const controller=new AbortController();timer=setTimeout(()=>controller.abort(),8000);
      const response=await fetch('/api/auth/session',{method:'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal:controller.signal});
      if(!response.ok)throw Error('session');const data=await response.json();if(version!==generation||destroyed)return;
      if(typeof data?.configured!=='boolean'||!(data.user===null||data.user&&typeof data.user.id==='string'&&store.validOwner(data.user.id)))throw Error('session');
      ownerId=data.user?.id||null;store.setActiveOwner(ownerId);known=true;renderNotes(false);
    }catch{if(version===generation&&!destroyed){clear();if(navigator.onLine===false){try{lastKnown();}catch{status.textContent='이 브라우저의 오프라인 사본을 읽지 못했어요.';}}else status.textContent='현재 계정을 확인하지 못해 사본을 표시하지 않았어요. 인터넷 연결을 확인하고 다시 확인해 주세요.';}}
    finally{clearTimeout(timer);if(version===generation&&!destroyed)reload.disabled=false;}
  }
  function storageChanged(event){if(event.key===null||event.key===store.ACTIVE_KEY||event.key?.startsWith(store.PREFIX)||event.key==='gil-account-session-change'){clear();load();}}
  reload.addEventListener('click',load);window.addEventListener('storage',storageChanged);window.addEventListener('online',load);window.addEventListener('offline',load);window.addEventListener('focus',load);
  let channel;try{if(typeof BroadcastChannel==='function'){channel=new BroadcastChannel('gil-account-session-change');channel.onmessage=event=>{if(event.data?.type==='session-changed'){clear();load();}};}}catch{}
  window.addEventListener('pagehide',()=>{generation++;destroyed=true;clear();channel?.close();});load();
  window.addEventListener('pageshow',event=>{if(event.persisted){destroyed=false;load();}});
})();

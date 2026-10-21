(function(){
  'use strict';
  let sequence=0;
  function mount({root,groups=[],getScope=()=> 'note'}={}){
    if(!root)return {refresh(){},close(){},destroy(){}};
    const node=(tag,className,text)=>{const element=document.createElement(tag);element.className=className;if(text)element.textContent=text;return element;};
    const id=`note-tools-dialog-${++sequence}`,slots=new Map();
    const entries=groups.filter(group=>group&&typeof group.id==='string'&&typeof group.label==='string'&&Array.isArray(group.hosts))
      .map(group=>({...group,hosts:group.hosts.filter(Boolean)})).filter(group=>group.hosts.length);
    root.replaceChildren();root.classList.add('note-toolbar');root.setAttribute('aria-label','여행 노트 도구');
    const dialog=node('dialog','note-tool-dialog');dialog.id=id;dialog.setAttribute('aria-labelledby',`${id}-title`);
    const header=node('div','note-tool-dialog-heading'),title=node('h2','note-tool-dialog-title');title.id=`${id}-title`;
    const closeButton=node('button','note-tool-dialog-close','닫기');closeButton.type='button';closeButton.setAttribute('aria-label','닫기');closeButton.autofocus=true;
    header.append(title,closeButton);const content=node('div','note-tool-dialog-body');dialog.append(header,content);document.body.append(dialog);
    let active=null,openedScope=null,returnFocus=null,version=0,destroyed=false,frame=null;
    const scope=()=>{try{return getScope()??null;}catch{return null;}};
    const eligible=entry=>entry.hosts.some(host=>!host.hidden);
    function restoreHosts(entry){
      for(const host of entry.hosts){const marker=slots.get(host);if(marker?.parentNode)marker.parentNode.insertBefore(host,marker.nextSibling);}
    }
    function close({restoreFocus=true}={}){
      if(!active)return;
      const entry=active,focus=returnFocus;active=null;openedScope=null;returnFocus=null;version++;
      if(frame!==null){window.cancelAnimationFrame(frame);frame=null;}
      for(const details of content.querySelectorAll('details')){
        details.open=false;
        // Details toggle events can be coalesced across a fast close/reopen.
        // Notify existing widgets while closed so they abort stale requests now.
        details.dispatchEvent(new Event('toggle'));
      }
      restoreHosts(entry);content.replaceChildren();entry.button.setAttribute('aria-expanded','false');
      if(dialog.open)dialog.close();
      // Native close dispatches later. Cleanup and focus happen exactly once,
      // allowing the caller to focus a timeline row immediately after close().
      if(restoreFocus&&focus?.isConnected&&!focus.disabled&&!focus.closest('[hidden]'))focus.focus({preventScroll:true});
    }
    function open(entry){
      const currentScope=scope();if(destroyed||currentScope===null||!eligible(entry))return;
      if(active===entry&&dialog.open)return;
      close({restoreFocus:false});
      active=entry;openedScope=currentScope;returnFocus=entry.button;const operation=++version;
      title.textContent=entry.label;content.replaceChildren(...entry.hosts);entry.button.setAttribute('aria-expanded','true');
      try{dialog.showModal();}catch{close();return;}
      closeButton.focus({preventScroll:true});
      // Open the actual details after the modal is visible. Their native toggle
      // events preserve existing lazy-loading/cancellation behavior without
      // running an extra synthetic toggle or cloning any controls.
      for(const details of content.querySelectorAll('details'))details.open=true;
      frame=window.requestAnimationFrame(()=>{
        frame=window.requestAnimationFrame(()=>{
          frame=null;if(destroyed||operation!==version||!dialog.open)return;
          // Leaflet measures its container only after it has visible dimensions.
          window.dispatchEvent(new Event('resize'));
        });
      });
    }
    for(const entry of entries){
      for(const host of entry.hosts)if(!slots.has(host)){
        const marker=document.createComment(`note-tool:${entry.id}`);host.parentNode?.insertBefore(marker,host);slots.set(host,marker);
      }
      const button=node('button','note-toolbar-button',entry.label);button.type='button';button.dataset.toolGroup=entry.id;
      button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-controls',id);button.setAttribute('aria-expanded','false');
      button.addEventListener('click',()=>open(entry));entry.button=button;root.append(button);
    }
    function refresh(){
      if(destroyed)return;const currentScope=scope();
      if(active&&(currentScope===null||currentScope!==openedScope||!eligible(active)))close({restoreFocus:false});
      for(const entry of entries){const available=eligible(entry);entry.button.hidden=!available;entry.button.disabled=!available;}
      root.hidden=currentScope===null||!entries.some(eligible);
    }
    closeButton.addEventListener('click',()=>close());
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.addEventListener('close',()=>{if(!dialog.open&&active)close();});
    dialog.addEventListener('click',event=>{
      if(event.target!==dialog)return;const rect=dialog.getBoundingClientRect();
      if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();
    });
    refresh();
    return {refresh,close,destroy(){if(destroyed)return;close({restoreFocus:false});destroyed=true;for(const marker of slots.values())marker.remove();dialog.remove();root.replaceChildren();root.hidden=true;}};
  }
  window.TravelNoteToolbar={mount};
})();

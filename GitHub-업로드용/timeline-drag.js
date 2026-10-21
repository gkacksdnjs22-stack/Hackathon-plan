(function(){
  'use strict';
  function mount(timeline,{onMove,onStart=()=>{}}={}){
    const status=document.createElement('p');status.className='timeline-drag-status';status.hidden=true;
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');timeline.append(status);
    let gesture=null,scrollTimer=null;
    const rows=()=>[...timeline.querySelectorAll('.timeline-row')].filter(row=>row.querySelector('.timeline-dot'));
    function clearTargets(){rows().forEach(row=>{delete row.dataset.drop;});}
    function locate(){
      if(!gesture?.active)return;
      clearTargets();
      const bounds=timeline.getBoundingClientRect();
      gesture.valid=gesture.x>=bounds.left-48&&gesture.x<=bounds.right+48;
      if(!gesture.valid){status.textContent='일정 밖이에요. 놓으면 이동을 취소해요.';return;}
      const others=rows().filter(row=>row!==gesture.row);
      const at=others.findIndex(row=>{const box=row.getBoundingClientRect();return gesture.y<box.top+box.height/2;});
      gesture.destination=at<0?others.length:at;
      const target=others[gesture.destination]||others.at(-1);
      if(target)target.dataset.drop=gesture.destination===others.length?'after':'before';
      status.textContent=`${gesture.name} · ${gesture.destination+1}번째 위치에 놓기 · Esc로 취소`;
    }
    function scroll(){
      scrollTimer=null;if(!gesture?.active)return;
      const height=window.innerHeight;
      const speed=gesture.y<72?-Math.ceil((72-gesture.y)/6):gesture.y>height-72?Math.ceil((gesture.y-height+72)/6):0;
      if(speed&&gesture.valid)window.scrollBy({top:Math.max(-18,Math.min(18,speed)),behavior:'instant'});
      locate();scrollTimer=setTimeout(scroll,16);
    }
    // Browsers may synthesize a click after pointerup, even if rendering replaces the button.
    function blockClick(){
      let timer;
      const clear=()=>{document.removeEventListener('click',block,true);document.removeEventListener('pointerdown',clear,true);clearTimeout(timer);};
      const block=event=>{if(event.detail===0)return;event.preventDefault();event.stopImmediatePropagation();clear();};
      document.addEventListener('click',block,true);document.addEventListener('pointerdown',clear,true);
      timer=setTimeout(clear,500);
    }
    function finish(commit=false){
      const ended=gesture;if(!ended)return;
      gesture=null;clearTimeout(scrollTimer);scrollTimer=null;
      document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);
      document.removeEventListener('pointercancel',cancel);document.removeEventListener('keydown',key);
      window.removeEventListener('blur',cancel);window.removeEventListener('hashchange',cancel);window.removeEventListener('beforeprint',cancel);
      ended.trigger.removeEventListener('lostpointercapture',cancel);
      if(ended.trigger.hasPointerCapture?.(ended.id))ended.trigger.releasePointerCapture(ended.id);
      delete timeline.dataset.dragging;delete ended.row.dataset.dragging;clearTargets();status.hidden=true;
      if(ended.active){
        blockClick();
        if(commit&&ended.valid&&ended.destination!==ended.position)onMove(ended.row.dataset.eventId,ended.destination);
        else ended.trigger.focus({preventScroll:true});
      }
    }
    function cancel(event){if(event?.pointerId!==undefined&&gesture?.id!==event.pointerId)return;finish(false);}
    function key(event){if(event.key==='Escape'){event.preventDefault();cancel();}}
    function move(event){
      if(!gesture||event.pointerId!==gesture.id)return;
      gesture.x=event.clientX;gesture.y=event.clientY;
      if(!gesture.active){
        if(Math.hypot(gesture.x-gesture.startX,gesture.y-gesture.startY)<8)return;
        gesture.active=true;onStart();timeline.dataset.dragging='true';gesture.row.dataset.dragging='true';status.hidden=false;
        scrollTimer=setTimeout(scroll,16);
      }
      event.preventDefault();locate();
    }
    function up(event){if(gesture&&event.pointerId===gesture.id){if(gesture.active){gesture.x=event.clientX;gesture.y=event.clientY;locate();}finish(true);}}
    function down(event){
      const trigger=event.target.closest?.('.timeline-dot');
      if(!trigger||!timeline.contains(trigger)||event.isPrimary===false||event.button!==0||gesture)return;
      const row=trigger.closest('.timeline-row'),list=rows();
      if(list.length<2)return;
      gesture={id:event.pointerId,trigger,row,position:list.indexOf(row),destination:list.indexOf(row),
        name:row.querySelector('.event-title')?.textContent||'일정',startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY,active:false,valid:true};
      trigger.setPointerCapture?.(event.pointerId);
      trigger.addEventListener('lostpointercapture',cancel);
      document.addEventListener('pointermove',move,{passive:false});document.addEventListener('pointerup',up);
      document.addEventListener('pointercancel',cancel);document.addEventListener('keydown',key);
      window.addEventListener('blur',cancel);window.addEventListener('hashchange',cancel);window.addEventListener('beforeprint',cancel);
    }
    timeline.addEventListener('pointerdown',down);
    return {cancel,destroy(){cancel();timeline.removeEventListener('pointerdown',down);status.remove();}};
  }
  window.TravelTimelineDrag={mount};
})();

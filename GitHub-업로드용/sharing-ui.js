(function(){
  'use strict';
  function mount(host,{getContext}){
    if(!host)return {refresh(){}};
    const node=(tag,text='')=>{const el=document.createElement(tag);el.textContent=text;return el;};
    const summary=node('summary','읽기 전용 공유 링크'),body=node('div');body.className='sharing-body';host.append(summary,body);
    const hint=node('p','계정에 저장한 버전의 사본을 공유해요. 링크를 아는 누구나 읽을 수 있어요. 수정한 내용을 공개하려면 새 링크를 만들어 주세요.');
    const options=node('div');options.className='sharing-options';
    const option=caption=>{const label=node('label'),input=node('input');input.type='checkbox';label.append(input,node('span',caption));options.append(label);return input;};
    const memos=option('메모 포함'),departure=option('출발지·도착지 포함');
    const actions=node('div');actions.className='sharing-actions';
    const previewButton=node('button','공유 내용 미리보기'),publish=node('button','공유 링크 만들기'),revoke=node('button','공유 해제');
    for(const button of [previewButton,publish,revoke]){button.type='button';button.className='button button-quiet';}actions.append(previewButton,publish,revoke);
    const status=node('p');status.className='sharing-status';status.setAttribute('role','status');
    const linkRow=node('div');linkRow.className='sharing-link-row';linkRow.hidden=true;
    const link=node('input');link.className='sharing-link';link.readOnly=true;link.setAttribute('aria-label','공유 링크');
    const copy=node('button','링크 복사');copy.type='button';const open=node('a','공유 화면 열기');open.target='_blank';open.rel='noopener noreferrer';linkRow.append(link,copy,open);
    const preview=node('div');preview.className='sharing-preview';preview.hidden=true;
    body.append(hint,options,actions,status,linkRow,preview);
    let fingerprint='',privacyScope='',generation=0,busy=false,snapshot=null,previewDocument=null;
    const context=()=>{const state=getContext();return state?.ownerId&&state.attachment?.ownerId===state.ownerId&&state.itinerary?state:null;};
    const signature=state=>state?JSON.stringify([state.ownerId,state.attachment.plan.id,state.attachment.plan.revision,state.document]):'';
    function controls(){const eligible=Boolean(context());previewButton.disabled=!eligible||busy;publish.disabled=!eligible||busy||!snapshot;revoke.disabled=!eligible||busy;memos.disabled=departure.disabled=busy;}
    function clearPreview(){snapshot=null;previewDocument=null;preview.hidden=true;preview.replaceChildren();controls();}
    function refresh(){
      const state=context(),next=signature(state);
      const scope=state?`${state.ownerId}:${state.attachment.plan.id}`:'';
      if(scope!==privacyScope){privacyScope=scope;memos.checked=false;departure.checked=false;}
      if(next!==fingerprint){fingerprint=next;generation++;busy=false;linkRow.hidden=true;link.value='';open.removeAttribute('href');clearPreview();
        status.textContent=state?(memos.checked||departure.checked?'선택한 공개 범위와 내용을 다시 미리 확인해 주세요.':'메모와 출발지는 기본으로 제외돼요. 공개할 내용을 미리 확인해 주세요.'):'공유하려면 소셜 로그인 후 계획을 계정에 저장해 주세요.';}
      controls();
    }
    async function api(state,method,body){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
      try{const response=await fetch(`/api/plans/${encodeURIComponent(state.attachment.plan.id)}/share`,{method,credentials:'same-origin',cache:'no-store',signal:controller.signal,
        headers:{Accept:'application/json','X-Gil-Expected-User':state.ownerId,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
        if(!response.ok)throw Error(response.status===409?'계정에 최신 변경사항을 저장한 뒤 다시 시도해 주세요.':response.status===401?'로그인 상태를 다시 확인해 주세요.':'공유 설정을 확인하지 못했어요. 다시 시도해 주세요.');return response.json();
      }finally{clearTimeout(timer);}
    }
    async function check(){refresh();const state=context();if(!state)return;const version=generation;
      try{const data=await api(state,'GET');if(version!==generation||signature(context())!==fingerprint)return;
        if(data.shared)status.textContent=`공유 중 · 저장 버전 ${data.revision}의 사본이에요. 새 링크를 만들면 이전 링크는 해제돼요.`;
      }catch(error){if(version===generation)status.textContent=error.message;}
    }
    previewButton.addEventListener('click',()=>{refresh();const state=context();if(!state)return;
      try{snapshot=window.TravelNoteSnapshot.create(state.itinerary,{title:state.attachment.plan.title,includeMemos:memos.checked,includeDeparture:departure.checked});
        previewDocument=JSON.parse(JSON.stringify(state.document));window.TravelNoteView.render(preview,snapshot);preview.hidden=false;status.textContent='아래 내용이 공개돼요. 확인한 뒤 공유 링크 만들기를 눌러 주세요.';controls();
      }catch(error){status.textContent=error.message;}
    });
    for(const input of [memos,departure])input.addEventListener('change',()=>{clearPreview();status.textContent='공개 범위가 바뀌었어요. 공유 내용을 다시 미리 확인해 주세요.';});
    publish.addEventListener('click',async()=>{const state=context();if(!state||!snapshot||busy)return;
      if(signature(state)!==fingerprint){refresh();return;}const version=generation,payload={revision:state.attachment.plan.revision,document:previewDocument,snapshot};busy=true;controls();
      try{const data=await api(state,'POST',payload);if(version!==generation||signature(context())!==fingerprint)return;
        if(!/^[A-Za-z0-9_-]{43}$/.test(data.token))throw Error('링크를 확인하지 못했어요. 공유 해제 후 다시 만들어 주세요.');
        link.value=new URL(`./share.html#${data.token}`,window.location.href).href;open.href=link.value;linkRow.hidden=false;
        status.textContent='공유 링크를 만들었어요. 이 사본은 읽기 전용이며, 이전 링크는 해제됐어요.';
      }catch(error){if(version===generation)status.textContent=error.name==='AbortError'?'응답이 늦어요. 공유 상태를 다시 확인해 주세요.':error.message;}
      finally{if(version===generation){busy=false;controls();}}
    });
    revoke.addEventListener('click',async()=>{const state=context();if(!state||busy)return;const version=generation;busy=true;controls();
      try{await api(state,'DELETE',{});if(version!==generation||signature(context())!==fingerprint)return;linkRow.hidden=true;link.value='';open.removeAttribute('href');
        status.textContent='공유를 해제했어요. 이미 복사하거나 내려받은 내용까지 회수되지는 않아요.';
      }catch(error){if(version===generation)status.textContent=error.message;}
      finally{if(version===generation){busy=false;controls();}}
    });
    copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(link.value);status.textContent='링크를 복사했어요.';}catch{link.focus();link.select();status.textContent='링크를 선택했어요. 직접 복사해 주세요.';}});
    host.addEventListener('toggle',()=>{if(host.open)check();});refresh();host.hidden=false;return {refresh};
  }
  window.TravelSharing={mount};
})();

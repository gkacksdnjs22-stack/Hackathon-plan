(function(){
  'use strict';
  const categories={transport:'교통',stay:'숙박',food:'식비',admission:'입장·체험',other:'기타'};
  const won=value=>`${new Intl.NumberFormat('ko-KR').format(value)}원`;
  const node=(tag,className='',text='')=>{const element=document.createElement(tag);element.className=className;element.textContent=text;return element;};
  function mount(host,{onChange}){
    const summary=node('summary'),body=node('div','budget-body'),totals=node('p','budget-totals'),days=node('ul','budget-days');
    const limitForm=node('form','budget-limit-form'),limit=node('input','budget-limit'),limitLabel=node('label','','여행 전체 예산 (원)');
    limit.type='number';limit.min='0';limit.max='1000000000000';limit.step='1';limit.placeholder='설정하지 않음';limitLabel.append(limit);
    const limitSave=node('button','','예산 설정');limitSave.type='submit';limitForm.append(limitLabel,limitSave);limitForm.noValidate=true;
    const form=node('form','budget-entry-form');form.noValidate=true;
    const day=node('select','budget-day'),category=node('select','budget-category'),title=node('input','budget-title'),amount=node('input','budget-amount');
    title.type='text';title.maxLength=80;title.required=true;title.placeholder='예: 숙소 1박';
    amount.type='number';amount.min='0';amount.max='1000000000';amount.step='1';amount.required=true;amount.placeholder='0';
    for(const [value,text] of Object.entries(categories)){const option=node('option','',text);option.value=value;category.append(option);}
    for(const [caption,input] of [['날짜',day],['분류',category],['항목',title],['예상 비용 (원)',amount]]){const label=node('label','',caption);label.append(input);form.append(label);}
    const submit=node('button','budget-submit','비용 추가'),cancel=node('button','budget-cancel','수정 취소');submit.type='submit';cancel.type='button';cancel.hidden=true;form.append(submit,cancel);
    const status=node('p','budget-status');status.setAttribute('role','status');
    const list=node('ul','budget-items'),hint=node('p','budget-hint','직접 입력한 예상 비용이에요. 금액은 원화 기준이며 실제 결제 금액과 다를 수 있어요.');
    body.append(totals,days,limitForm,form,status,list,hint);host.append(summary,body);
    let note=null,value={limit:null,items:[]},editing=null,daySignature='',printOpen=null,limitDirty=false;
    form.addEventListener('input',()=>{status.textContent='입력 중이에요. 비용 추가 또는 수정 저장을 누르면 일정에 반영돼요.';});
    limit.addEventListener('input',()=>{limitDirty=true;status.textContent='전체 예산 입력 중이에요. 예산 설정을 누르면 반영돼요.';});
    function clearForm(){editing=null;title.value='';amount.value='';submit.textContent='비용 추가';cancel.hidden=true;}
    function commit(next){
      const result=onChange(next);
      status.textContent=result.ok?'예산을 기기에 저장했어요. 계정 저장 상태도 확인해 주세요.':result.reason;
      return result.ok;
    }
    function amountValue(input,maximum,empty=false){return empty&&input.value.trim()===''?null:/^\d+$/.test(input.value.trim())&&Number.isSafeInteger(Number(input.value))&&Number(input.value)<=maximum?Number(input.value):NaN;}
    limitForm.addEventListener('submit',event=>{
      event.preventDefault();const total=amountValue(limit,1000000000000,true);
      if(Number.isNaN(total)){status.textContent='전체 예산은 0~1조 원의 정수로 입력해 주세요.';return;}
      if(commit({...value,limit:total}))limitDirty=false;
    });
    form.addEventListener('submit',event=>{
      event.preventDefault();const cost=amountValue(amount,1000000000);
      if(!title.value.trim()||title.value.length>80||Number.isNaN(cost)){status.textContent='항목 이름과 0~10억 원의 정수 금액을 입력해 주세요.';return;}
      const item={id:editing||`cost-${window.crypto.randomUUID()}`,dayIndex:Number(day.value),category:category.value,title:title.value.trim(),amount:cost};
      const items=editing?value.items.map(entry=>entry.id===editing?item:entry):[...value.items,item];
      if(commit({...value,items}))clearForm();
    });
    cancel.addEventListener('click',clearForm);
    function render(itinerary,activeDay=0){
      note=itinerary;host.hidden=!note;if(!note)return;
      value=note.budget||{limit:null,items:[]};
      if(editing&&!value.items.some(item=>item.id===editing))clearForm();
      const signature=JSON.stringify(note.days.map(item=>item.date));
      if(signature!==daySignature){day.replaceChildren();note.days.forEach((item,index)=>{const option=node('option','',`Day ${String(index+1).padStart(2,'0')} · ${item.date}`);option.value=String(index);day.append(option);});daySignature=signature;}
      if(!editing&&!title.value&&!amount.value)day.value=String(activeDay);
      if(!limitDirty&&document.activeElement!==limit)limit.value=value.limit===null?'':String(value.limit);
      const sum=value.items.reduce((total,item)=>total+item.amount,0);
      summary.textContent=`여행 예산 · 예상 ${won(sum)}`;
      totals.textContent=`전체 예상 비용 ${won(sum)}${value.limit===null?' · 전체 예산 미설정':sum>value.limit?` · 예산보다 ${won(sum-value.limit)} 초과`:` · 남은 예산 ${won(value.limit-sum)}`}`;
      totals.dataset.overBudget=String(value.limit!==null&&sum>value.limit);
      days.replaceChildren();note.days.forEach((item,index)=>days.append(node('li','',`Day ${String(index+1).padStart(2,'0')} · ${won(value.items.filter(cost=>cost.dayIndex===index).reduce((total,cost)=>total+cost.amount,0))}`)));
      list.replaceChildren();
      if(!value.items.length)list.append(node('li','budget-empty','아직 입력한 비용이 없어요.'));
      value.items.forEach(item=>{
        const row=node('li','budget-item'),copy=node('span','budget-item-copy',`Day ${String(item.dayIndex+1).padStart(2,'0')} · ${categories[item.category]} · ${item.title}`),cost=node('strong','budget-item-amount',won(item.amount));
        row.dataset.costId=item.id;
        const edit=node('button','budget-edit','수정'),remove=node('button','budget-remove','삭제');edit.type=remove.type='button';
        edit.setAttribute('aria-label',`${item.title} 비용 수정`);remove.setAttribute('aria-label',`${item.title} 비용 삭제`);
        edit.addEventListener('click',()=>{editing=item.id;day.value=String(item.dayIndex);category.value=item.category;title.value=item.title;amount.value=String(item.amount);submit.textContent='비용 수정 저장';cancel.hidden=false;title.focus();});
        remove.addEventListener('click',()=>commit({...value,items:value.items.filter(entry=>entry.id!==item.id)}));
        row.append(copy,cost,edit,remove);list.append(row);
      });
    }
    return {render,reset(){note=null;value={limit:null,items:[]};daySignature='';limitDirty=false;clearForm();limit.value='';status.textContent='';host.open=false;host.hidden=true;},
      preparePrint(){printOpen=host.open;host.open=true;},finishPrint(){if(printOpen!==null)host.open=printOpen;printOpen=null;}};
  }
  window.TravelBudget={mount};
})();

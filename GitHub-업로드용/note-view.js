(function(){
  'use strict';
  const node=(tag,className,text)=>{const element=document.createElement(tag);element.className=className;if(text!==undefined)element.textContent=text;return element;};
  function clock(minutes){const offset=Math.floor(minutes/1440),time=minutes%1440;return `${offset?`${offset}일 후 `:''}${String(Math.floor(time/60)).padStart(2,'0')}:${String(time%60).padStart(2,'0')}`;}
  function render(host,snapshot){
    host.replaceChildren();
    host.append(node('h1','read-note-title',snapshot.title),node('p','read-note-summary',`${snapshot.cityName} · ${snapshot.startDate}부터 ${snapshot.dayCount}일 · 한국 시간`));
    snapshot.days.forEach((day,index)=>{
      const section=node('section','read-note-day');section.append(node('h2','',`Day ${String(index+1).padStart(2,'0')} · ${day.date}`));
      if(day.provisional)section.append(node('p','read-note-notice','출발지·이동시간이 미정인 임시 시각이 포함돼 있어요.'));
      const list=node('ol','read-note-events');
      day.events.forEach(event=>{
        const item=node('li','read-note-event');item.append(node('span','read-note-time',`${clock(event.start)}${event.end>event.start?`–${clock(event.end)}`:''}`));
        const copy=node('div','');copy.append(node('h3','',event.title));
        if(event.address)copy.append(node('p','read-note-address',event.address));
        if(event.memo)copy.append(node('p','read-note-memo',event.memo));
        item.append(copy);list.append(item);
      });section.append(list);host.append(section);
    });
  }
  window.TravelNoteView={render};
})();

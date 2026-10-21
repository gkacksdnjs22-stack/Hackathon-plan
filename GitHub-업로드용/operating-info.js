(function(){
  'use strict';
  const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
  function assess({hoursText='',closedText='',date,start,end,provisional=false}){
    const result={closed:false,hoursConflict:false,uncertain:false,messages:[]};
    const midnight=Date.parse(`${date}T00:00:00Z`);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(midnight)||new Date(midnight).toISOString().slice(0,10)!==date
      ||!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>60480){result.uncertain=true;result.messages.push('계획 날짜와 시간을 확인해 주세요.');return result;}
    const closed=clean(closedText),hours=clean(hoursText);
    const weekdays=['일','월','화','수','목','금','토'];
    const weekly=/^(?:매주\s*)?[일월화수목금토]요일(?:\s*[,·/]\s*[일월화수목금토]요일)*\s*(?:휴무)?$/.test(closed)
      ?[...closed.matchAll(/([일월화수목금토])요일/g)].map(match=>weekdays.indexOf(match[1])):null;
    const exactMatch=/^(\d{4}-\d{2}-\d{2})(?:\s*휴무)?$/.exec(closed);
    const exact=exactMatch&&Number.isFinite(Date.parse(`${exactMatch[1]}T00:00:00Z`))&&new Date(`${exactMatch[1]}T00:00:00Z`).toISOString().slice(0,10)===exactMatch[1]?exactMatch:null;
    const first=Math.floor(start/1440),last=Math.floor(Math.max(start,end-1)/1440);
    if(weekly||exact){for(let offset=first;offset<=last;offset++){
      const value=new Date(midnight+offset*86400000),day=value.toISOString().slice(0,10);
      if(weekly?.includes(value.getUTCDay())||exact?.[1]===day){result.closed=true;result.messages.push(`${day} 방문이 안내된 휴무일과 겹쳐요.`);break;}
    }}else if(!/^(?:연중무휴|휴무\s*없음|없음)$/.test(closed))result.uncertain=true;
    const range=/^(\d{1,2}):(\d{2})\s*[~–-]\s*(\d{1,2}):(\d{2})$/.exec(hours);
    let validHours=false;
    if(range){const [,h1,m1,h2,m2]=range.map(Number),open=h1*60+m1,close=h2*60+m2;
      if(h1<24&&m1<60&&h2<=24&&m2<60&&(h2<24||m2===0)&&open<close){
        validHours=true;
        const wholeDay=open===0&&close===1440;
        result.hoursConflict=!wholeDay&&(first!==last||start%1440<open||(end-first*1440)>close);
        if(result.hoursConflict)result.messages.push('계획한 방문 시각이 안내된 이용시간을 벗어나요.');
      }
    }
    if(!validHours)result.uncertain=true;
    if(result.uncertain)result.messages.push('정보가 없거나 계절·공휴일 등 추가 조건이 있어 확인이 필요해요.');
    if(!result.closed&&!result.hoursConflict&&!result.uncertain)result.messages.push('단순 휴무·시간 안내와 겹치는 사항은 없어요. 예약·임시 휴무는 방문 전에 확인해 주세요.');
    if(provisional)result.messages.push('이동시간 등이 미정인 임시 계획 시각으로 비교했어요.');
    return result;
  }
  window.TravelOperatingInfo={assess};
})();

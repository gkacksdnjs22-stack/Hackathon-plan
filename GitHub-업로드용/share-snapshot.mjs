const fields=(value,names)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==names.length||names.some(name=>!Object.hasOwn(value,name)))throw Error('Invalid snapshot');
};
const text=(value,max)=>{if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw Error('Invalid text');return value;};
const dayDate=(start,index)=>new Date(Date.parse(`${start}T00:00:00Z`)+index*86400000).toISOString().slice(0,10);
export function validateShareSnapshot(value){
  fields(value,['version','title','cityName','startDate','dayCount','days']);
  if(value.version!==1||!Number.isInteger(value.dayCount)||value.dayCount<1||value.dayCount>7
    ||!/^\d{4}-\d{2}-\d{2}$/.test(value.startDate)||!Number.isFinite(Date.parse(`${value.startDate}T00:00:00Z`))
    ||dayDate(value.startDate,0)!==value.startDate||!Array.isArray(value.days)||value.days.length!==value.dayCount)throw Error('Invalid days');
  const result={version:1,title:text(value.title,80),cityName:text(value.cityName,80),startDate:value.startDate,dayCount:value.dayCount,
    days:value.days.map((day,index)=>{
      fields(day,['date','provisional','events']);
      if(day.date!==dayDate(value.startDate,index)||typeof day.provisional!=='boolean'||!Array.isArray(day.events)||day.events.length>40)throw Error('Invalid day');
      return {date:day.date,provisional:day.provisional,events:day.events.map(event=>{
        fields(event,['type','title','start','end','address','memo']);
        if(!['departure','arrival','transfer','place','meal','free','rest','finish','custom'].includes(event.type)
          ||!Number.isInteger(event.start)||!Number.isInteger(event.end)||event.start<0||event.end<event.start||event.end>60480)throw Error('Invalid event');
        return {type:event.type,title:text(event.title,240),start:event.start,end:event.end,address:text(event.address,500),memo:text(event.memo,500)};
      })};
    })};
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>210000)throw Error('Snapshot too large');
  return result;
}

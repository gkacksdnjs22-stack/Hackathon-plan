import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=name=>readFileSync(new URL(name,import.meta.url),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const settle=async()=>{for(let index=0;index<35;index++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const snapshot=(title='서울 여행',startDate='2026-10-21')=>({version:1,title,cityName:'서울',startDate,dayCount:1,days:[{date:startDate,provisional:true,events:[
  {type:'departure',title:'조치원에서 출발',start:540,end:600,address:'세종시 조치원',memo:'내 출발 메모'},
  {type:'place',title:'경복궁',start:600,end:660,address:'서울 종로구',memo:'내 여행 메모'},
  {type:'finish',title:'마무리',start:660,end:660,address:'',memo:''}]}]});
function memoryStorage(){
  const values=new Map();let failWrite=false,writes=0;
  return {values,get writes(){return writes;},getItem:key=>values.get(key)??null,setItem(key,value){if(failWrite)throw Error('QuotaExceededError: private detail');values.set(key,String(value));writes++;},removeItem:key=>values.delete(key),set failWrite(value){failWrite=value;}};
}
function storeRuntime(storage=memoryStorage()){
  const window={localStorage:storage},context=vm.createContext({window,Date,Set,Map,JSON,Error});vm.runInContext(source('offline-store.js'),context);
  return {store:window.TravelOfflineStore,window,storage,context};
}
function saveFixture(store,ownerId,title='서울 여행',key='trip:seoul:2026-10-21'){
  store.setActiveOwner(ownerId);return store.save({ownerId,key,snapshot:snapshot(title)});
}

test('offline store validates bounded readonly snapshots and rejects raw responses, invalid dates, clocks and types',()=>{
  const {store}=storeRuntime();assert.equal(store.validateSnapshot(snapshot()),true);
  for(const mutate of [value=>value.rawApi={token:'not-a-snapshot'},value=>value.startDate='2026-02-30',value=>value.days[0].events[0].type='script',
    value=>value.days[0].events[1].start=599,value=>value.days[0].events[0].start=-1,value=>value.days[0].events[0].end=100801,
    value=>value.days[0].events[0].memo='a'.repeat(501),value=>value.days[0].events[0].accessToken='secret',value=>value.days[0].date='2026-10-22',
    value=>value.days[0].events=[],value=>value.days.push(clone(value.days[0]))]){
    const value=snapshot();mutate(value);assert.equal(store.validateSnapshot(value),false);
  }
});
test('guest and every account have distinct storage; current known owner is required to save or delete',()=>{
  const {store}=storeRuntime();saveFixture(store,null,'방문자 노트');saveFixture(store,'guest','계정 guest 노트');saveFixture(store,'user-a','A 노트');
  assert.equal(store.list(null)[0].snapshot.title,'방문자 노트');assert.equal(store.list('guest')[0].snapshot.title,'계정 guest 노트');
  assert.equal(store.list('user-a')[0].snapshot.title,'A 노트');assert.deepEqual(clone(store.list('user-b')),[]);
  assert.throws(()=>store.save({ownerId:'user-b',key:'trip:seoul:2026-10-21',snapshot:snapshot()}),/현재 계정/);
  assert.throws(()=>store.remove(null,'trip:seoul:2026-10-21'),/현재 계정/);assert.equal(store.list(null).length,1);
});
test('same attachment or city/date replaces one of five notes; a sixth new note preserves all previous copies',()=>{
  const {store}=storeRuntime();store.setActiveOwner('a');
  for(let index=0;index<5;index++)store.save({ownerId:'a',key:`plan:p${index}`,snapshot:snapshot(`노트 ${index}`)});
  const before=clone(store.list('a'));assert.throws(()=>store.save({ownerId:'a',key:'plan:p5',snapshot:snapshot('여섯 번째')}),/5개/);
  assert.deepEqual(clone(store.list('a')),before);store.save({ownerId:'a',key:'plan:p2',snapshot:snapshot('갱신한 노트')});
  assert.equal(store.list('a').length,5);assert.equal(store.list('a').find(note=>note.key==='plan:p2').snapshot.title,'갱신한 노트');
  assert.equal(store.noteKey({ownerId:'a',itinerary:{cityId:'seoul',startDate:'2026-10-21'},attachment:{ownerId:'a',plan:{id:'plan-one'}}}),'plan:plan-one');
  assert.equal(store.noteKey({ownerId:'a',itinerary:{cityId:'seoul',startDate:'2026-10-21'},attachment:{ownerId:'b',plan:{id:'plan-one'}}}),'trip:seoul:2026-10-21');
});
test('quota failure and corrupt envelopes never overwrite the saved copy',()=>{
  const {store,storage}=storeRuntime();saveFixture(store,'a');const key=store.storageKey('a'),before=storage.getItem(key);storage.failWrite=true;
  assert.throws(()=>store.save({ownerId:'a',key:'trip:seoul:2026-10-21',snapshot:snapshot('바꾼 메모')}));assert.equal(storage.getItem(key),before);
  storage.failWrite=false;storage.setItem(key,'{"version":1,"ownerId":"b","notes":[]}');const corrupt=storage.getItem(key);
  assert.throws(()=>store.save({ownerId:'a',key:'trip:seoul:2026-10-21',snapshot:snapshot()}),/읽지 못/);assert.equal(storage.getItem(key),corrupt);
});
test('active owner is a last-known device pointer and duplicate verification does not cause cross-tab write loops',()=>{
  const {store,storage}=storeRuntime();assert.equal(store.readActiveOwner(),null);assert.throws(()=>store.setActiveOwner(undefined));
  store.setActiveOwner('a');const writes=storage.writes;store.setActiveOwner('a');assert.equal(storage.writes,writes);
  store.setActiveOwner(null);assert.equal(store.readActiveOwner().ownerId,null);assert.equal(storage.writes,writes+1);
  storage.setItem(store.ACTIVE_KEY,'{"version":1,"ownerId":"a","checkedAt":"bad","authenticated":true}');assert.equal(store.readActiveOwner(),null);
});

function workerRuntime({failedPath,jsonPath}={}){
  const handlers=new Map(),buckets=new Map(),fetches=[];
  const caches={async open(name){if(!buckets.has(name))buckets.set(name,new Map());const bucket=buckets.get(name);return {match:async key=>bucket.get(String(key))?.clone(),put:async(key,response)=>bucket.set(String(key),response.clone())};},keys:async()=>[...buckets.keys()],delete:async name=>buckets.delete(name)};
  const self={location:{origin:'https://trip.example'},addEventListener:(type,listener)=>handlers.set(type,listener),skipWaiting:async()=>{},clients:{claim:async()=>{}}};
  const context=vm.createContext({self,caches,Set,URL,Request,Error,fetch:async request=>{const path=new URL(request.url).pathname;fetches.push({path,credentials:request.credentials,redirect:request.redirect});if(path===failedPath)throw Error('network');return new Response(`public shell ${path}`,{headers:{'Content-Type':path===jsonPath?'application/json':path.endsWith('.html')?'text/html':path.endsWith('.css')?'text/css':'text/javascript'}});}});
  vm.runInContext(source('service-worker.js'),context);
  const event=(type,extra={})=>{let promise;const value={waitUntil:next=>{promise=next;},...extra};handlers.get(type)(value);return promise;};
  const fetchEvent=(path,options={})=>{let response;handlers.get('fetch')({request:{url:new URL(path,self.location.origin).href,method:'GET',mode:'cors',...options},respondWith:promise=>{response=promise;}});return response;};
  return {event,fetchEvent,buckets,fetches};
}
test('service worker prepares only explicit viewer assets with omitted credentials; private URLs and main app are untouched',async()=>{
  const worker=workerRuntime();await worker.event('install');
  assert.deepEqual(worker.fetches.map(value=>value.path).sort(),['/note-view.css','/note-view.js','/offline-store.js','/offline-view.js','/offline.html']);
  assert.ok(worker.fetches.every(value=>value.credentials==='omit'&&value.redirect==='error'));
  for(const path of ['/','/index.html','/api/auth/session','/api/auth/session?returnTo=/offline.html','/api/plans','/api/shared-plan','/share.html','/share.html?v=1','/day-map.js','/api/transit-routes','https://external.example/offline.html'])assert.equal(worker.fetchEvent(path),undefined,path);
  assert.equal(worker.fetchEvent('/offline.html',{method:'POST'}),undefined);
  assert.equal(await(await worker.fetchEvent('/offline/',{mode:'navigate'})).text(),'public shell /offline.html');
  assert.equal(await(await worker.fetchEvent('/offline-view.js?v=1')).text(),'public shell /offline-view.js');
  assert.equal(await(await worker.fetchEvent('/offline-view.js?v=2')).text(),'public shell /offline-view.js');
  assert.equal(worker.fetches.length,5);assert.equal(worker.buckets.get('gil-offline-shell-v1').size,5);
});
test('service worker preparation cannot succeed with missing assets and activation deletes only prior offline-shell caches',async()=>{
  const failed=workerRuntime({failedPath:'/note-view.js'});await assert.rejects(failed.event('install'),/network/);let acknowledgment;
  await failed.event('message',{data:{type:'GIL_PREPARE_OFFLINE',version:1},ports:[{postMessage:value=>{acknowledgment=value;}}]});assert.equal(acknowledgment.ok,false);
  const worker=workerRuntime();worker.buckets.set('gil-offline-shell-v0',new Map());worker.buckets.set('unrelated-cache',new Map());await worker.event('install');await worker.event('activate');
  assert.equal(worker.buckets.has('gil-offline-shell-v0'),false);assert.equal(worker.buckets.has('unrelated-cache'),true);
  await worker.event('message',{data:{type:'GIL_PREPARE_OFFLINE',version:1},ports:[{postMessage:value=>{acknowledgment=value;}}]});assert.equal(acknowledgment.ok,true);
});
test('an authentication JSON response cannot enter the viewer shell cache even at an allowlisted path',async()=>{
  const worker=workerRuntime({jsonPath:'/offline.html'});await assert.rejects(worker.event('install'),/unavailable/);
  assert.equal(worker.buckets.get('gil-offline-shell-v1').has('/offline.html'),false);
});

class Element{
  constructor(tagName){this.tagName=tagName;this.children=[];this.listeners=new Map();this.attributes=new Map();this._text='';this.hidden=false;this.disabled=false;this.className='';}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}set textContent(value){this._text=String(value);this.children=[];}
  append(...children){this.children.push(...children);}replaceChildren(...children){this.children=[...children];this._text='';}
  set innerHTML(_value){throw Error('Offline data must be rendered as text');}
  setAttribute(name,value){this.attributes.set(name,String(value));}getAttribute(name){return this.attributes.get(name)??null;}
  addEventListener(type,listener){this.listeners.set(type,listener);}click(){if(!this.disabled)return this.listeners.get('click')?.();}
}
function browserRuntime({online=true,storage=memoryStorage(),session,ready,ack=true,registerError=false}={}){
  const events=new Map(),elements=new Map(['offline-note','offline-notes','offline-status','offline-reload'].map(id=>[id,new Element('div')]));
  const document={createElement:tag=>new Element(tag),getElementById:id=>elements.get(id)},timers=new Map();let timerSequence=0;
  const window={localStorage:storage,isSecureContext:true,location:{href:'https://trip.example/#/note'},addEventListener(type,handler){if(!events.has(type))events.set(type,new Set());events.get(type).add(handler);},removeEventListener(type,handler){events.get(type)?.delete(handler);}};
  const registrations=[],worker={scriptURL:'https://trip.example/service-worker.js',postMessage(_message,ports){Promise.resolve().then(()=>ports[0].peer.onmessage?.({data:{ok:ack,version:1}}));}};
  const navigator={onLine:online,serviceWorker:{register:async(...args)=>{registrations.push(args);if(registerError)throw Error('upstream private detail');return {active:worker};},ready:ready||Promise.resolve({active:worker})}};
  class MessageChannel{constructor(){this.port1={close(){}};this.port2={close(){},peer:this.port1};}}
  const requests=[];let sessionHandler=session||(()=>({ok:true,json:async()=>({configured:true,user:null})}));
  const context=vm.createContext({window,document,navigator,Date,Intl,Map,Set,JSON,Error,URL,AbortController,MessageChannel,
    setTimeout(fn){const id=++timerSequence;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    fetch:async(...args)=>{requests.push(args);return sessionHandler(...args);}});
  for(const name of ['offline-store.js','note-view.js','note-snapshot.js'])vm.runInContext(source(name),context);
  const dispatch=(type,value={})=>{for(const listener of events.get(type)||[])listener(value);};
  return {window,context,document,elements,navigator,storage,requests,registrations,dispatch,load:name=>vm.runInContext(source(name),context),setSession:handler=>{sessionHandler=handler;}};
}
const itinerary=()=>({ok:true,cityId:'seoul',cityName:'서울',startDate:'2026-10-21',dayCount:1,days:[{timesProvisional:true,events:[
  {type:'departure',departure:{name:'조치원',address:'세종 조치원'},title:'출발',description:'출발 메모',start:540,end:600},
  {type:'place',place:{name:'경복궁',address:'서울 종로구'},description:'꼭 볼 곳',start:600,end:660},
  {type:'finish',title:'마무리',description:'',start:660,end:660}]}]});
function mounted(options={}){
  const runtime=browserRuntime(options);runtime.load('offline-ui.js');const host=new Element('details'),messages=[];
  let current={ownerId:'a',known:true,itinerary:itinerary(),title:'내 노트',attachment:null};
  const controller=runtime.window.TravelOffline.mount(host,{getContext:()=>current,onMessage:(...args)=>messages.push(args)});controller.setOwner({id:'a'});
  return {...runtime,host,messages,controller,setContext:value=>{current=value;},get current(){return current;}};
}
test('offline save includes departure and memos only after shell readiness; same note updates its saved timestamp',async()=>{
  const wait=deferred(),runtime=mounted({ready:wait.promise}),pending=runtime.controller.save();await settle();
  assert.equal(runtime.window.TravelOfflineStore.list('a').length,0);assert.doesNotMatch(runtime.host.textContent,/사본을 저장했어요/);
  wait.resolve({active:{scriptURL:'https://trip.example/service-worker.js',postMessage(_data,ports){ports[0].peer.onmessage({data:{ok:true,version:1}});}}});
  assert.equal((await pending).ok,true);const notes=runtime.window.TravelOfflineStore.list('a');assert.equal(notes.length,1);
  assert.equal(notes[0].snapshot.days[0].events[0].title,'조치원에서 출발');assert.equal(notes[0].snapshot.days[0].events[0].memo,'출발 메모');assert.equal(notes[0].snapshot.days[0].events[1].memo,'꼭 볼 곳');
  assert.equal(runtime.registrations[0][0],'/service-worker.js');assert.equal(runtime.messages[0][1],'success');assert.match(runtime.host.textContent,/마지막 저장/);
});
test('failed preparation and storage failure preserve previous copies without claiming success',async()=>{
  for(const options of [{ack:false},{registerError:true}]){
    const runtime=mounted(options);saveFixture(runtime.window.TravelOfflineStore,'a','이전 사본');const before=runtime.storage.getItem(runtime.window.TravelOfflineStore.storageKey('a'));
    assert.equal((await runtime.controller.save()).ok,false);assert.equal(runtime.storage.getItem(runtime.window.TravelOfflineStore.storageKey('a')),before);assert.equal(runtime.messages.length,0);
  }
  const runtime=mounted();saveFixture(runtime.window.TravelOfflineStore,'a','이전 사본');const before=runtime.storage.getItem(runtime.window.TravelOfflineStore.storageKey('a'));runtime.storage.failWrite=true;
  assert.equal((await runtime.controller.save()).ok,false);assert.equal(runtime.storage.getItem(runtime.window.TravelOfflineStore.storageKey('a')),before);assert.equal(runtime.messages.length,0);
});
test('owner or itinerary changes while preparing never save the stale note',async()=>{
  const wait=deferred(),runtime=mounted({ready:wait.promise}),pending=runtime.controller.save();await settle();runtime.setContext({...runtime.current,ownerId:'b'});runtime.controller.setOwner({id:'b'});
  wait.resolve({active:{scriptURL:'https://trip.example/service-worker.js',postMessage(_data,ports){ports[0].peer.onmessage({data:{ok:true,version:1}});}}});
  assert.equal((await pending).ok,false);assert.equal(runtime.window.TravelOfflineStore.list('a').length,0);assert.equal(runtime.window.TravelOfflineStore.list('b').length,0);
  const next=mounted();const copy=next.current;next.setContext({...copy,itinerary:{...copy.itinerary,cityName:'부산'}});next.controller.refresh();assert.equal((await next.controller.save()).ok,true);
  assert.equal(next.window.TravelOfflineStore.list('a')[0].snapshot.cityName,'부산');
});
test('unknown owner and cross-tab account changes disable saving until the authoritative account callback',async()=>{
  const runtime=mounted();runtime.controller.setOwner(undefined);assert.equal((await runtime.controller.save()).ok,false);
  runtime.controller.setOwner({id:'a'});runtime.window.TravelOfflineStore.setActiveOwner('b');runtime.dispatch('storage',{key:runtime.window.TravelOfflineStore.ACTIVE_KEY});
  assert.match(runtime.host.textContent,/다른 창/);assert.equal((await runtime.controller.save()).ok,false);assert.equal(runtime.window.TravelOfflineStore.list('b').length,0);
});

test('offline viewer opens last-known device copy in a new runtime without any API fetch',async()=>{
  const runtime=browserRuntime({online:false}),store=runtime.window.TravelOfflineStore;saveFixture(store,'a','A의 오프라인 노트');runtime.load('offline-view.js');await settle();
  assert.equal(runtime.requests.length,0);assert.equal(runtime.elements.get('offline-note').hidden,false);assert.match(runtime.elements.get('offline-note').textContent,/A의 오프라인 노트/);
  assert.match(runtime.elements.get('offline-note').textContent,/내 여행 메모/);assert.match(runtime.elements.get('offline-status').textContent,/마지막으로 확인한 계정/);
});
test('online viewer revalidates the session before rendering and never falls back after server errors',async()=>{
  const response=deferred(),runtime=browserRuntime({session:()=>response.promise}),store=runtime.window.TravelOfflineStore;saveFixture(store,'b','B의 노트');saveFixture(store,'a','A의 노트');runtime.load('offline-view.js');await settle();
  assert.equal(runtime.elements.get('offline-note').hidden,true);assert.equal(runtime.elements.get('offline-note').textContent,'');
  response.resolve({ok:true,json:async()=>({configured:true,user:{id:'b'}})});await settle();assert.match(runtime.elements.get('offline-note').textContent,/B의 노트/);assert.doesNotMatch(runtime.elements.get('offline-note').textContent,/A의 노트/);
  assert.equal(runtime.requests[0][0],'/api/auth/session');assert.equal(runtime.requests[0][1].cache,'no-store');assert.equal(runtime.requests[0][1].credentials,'same-origin');
  runtime.setSession(()=>({ok:false,status:500}));runtime.dispatch('focus');assert.equal(runtime.elements.get('offline-note').textContent,'');await settle();assert.match(runtime.elements.get('offline-status').textContent,/표시하지 않았어요/);
});
test('account switch and logout clear displayed offline content synchronously across tabs',async()=>{
  const runtime=browserRuntime({online:false}),store=runtime.window.TravelOfflineStore;saveFixture(store,null,'방문자 노트');saveFixture(store,'b','B 노트');saveFixture(store,'a','A 노트');runtime.load('offline-view.js');await settle();
  const staleDelete=runtime.elements.get('offline-notes').children[0].children[1].children.at(-1);
  store.setActiveOwner('b');runtime.dispatch('storage',{key:store.ACTIVE_KEY});await settle();assert.doesNotMatch(runtime.elements.get('offline-note').textContent,/A 노트/);assert.match(runtime.elements.get('offline-note').textContent,/B 노트/);
  staleDelete.click();assert.equal(store.list('b').length,1);
  store.setActiveOwner(null);runtime.dispatch('storage',{key:store.ACTIVE_KEY});await settle();assert.match(runtime.elements.get('offline-note').textContent,/방문자 노트/);assert.doesNotMatch(runtime.elements.get('offline-note').textContent,/[AB] 노트/);
});
test('stale online account responses cannot restore the previous account after a tab switch',async()=>{
  const a=deferred(),b=deferred();let calls=0;const runtime=browserRuntime({session:()=>++calls===1?a.promise:b.promise}),store=runtime.window.TravelOfflineStore;
  saveFixture(store,'a','A 노트');saveFixture(store,'b','B 노트');runtime.load('offline-view.js');await settle();runtime.dispatch('storage',{key:store.ACTIVE_KEY});await settle();
  b.resolve({ok:true,json:async()=>({configured:true,user:{id:'b'}})});await settle();a.resolve({ok:true,json:async()=>({configured:true,user:{id:'a'}})});await settle();
  assert.match(runtime.elements.get('offline-note').textContent,/B 노트/);assert.doesNotMatch(runtime.elements.get('offline-note').textContent,/A 노트/);assert.equal(store.readActiveOwner().ownerId,'b');
});
test('malformed stored copies fail closed and deleting a copy does not modify its source plan',async()=>{
  const runtime=browserRuntime({online:false}),store=runtime.window.TravelOfflineStore;saveFixture(store,'a');const key=store.storageKey('a'),value=JSON.parse(runtime.storage.getItem(key));value.notes[0].snapshot.days[0].events[0].html='<script>bad</script>';runtime.storage.setItem(key,JSON.stringify(value));
  runtime.load('offline-view.js');await settle();assert.equal(runtime.elements.get('offline-note').hidden,true);assert.equal(runtime.elements.get('offline-note').textContent,'');assert.equal(runtime.requests.length,0);
  runtime.storage.removeItem(key);saveFixture(store,'a');runtime.dispatch('storage',{key});await settle();runtime.elements.get('offline-notes').children[0].children[1].children.at(-1).click();
  assert.equal(store.list('a').length,0);assert.equal(runtime.requests.length,0);assert.match(runtime.elements.get('offline-status').textContent,/사본이 없어요/);
});

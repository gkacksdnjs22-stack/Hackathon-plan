import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('./travel-backdrop.js', import.meta.url), 'utf8');
class Element {
  constructor() { this.listeners = new Map(); this.children = []; this.hidden = true; this.dataset = {}; this.classes = new Set(); this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) }; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name) { this.listeners.delete(name); }
  emit(name) { this.listeners.get(name)?.(); }
  setAttribute(name, value) { this[name] = value; }
  append(child) { child.parent = this; this.children.push(child); }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  replaceChildren() { this.children = []; }
}
const photo = (n, patch = {}) => ({ title: `명소 ${n}`, imageName:`사진 ${n}`, author:'사진가', imageUrl:`https://tong.visitkorea.or.kr/cms/resource/01/${n}_image3_1.jpg`, cpyrhtDivCd:'Type1', license:'공공누리 제1유형 (출처표시)', sourceUrl:'https://www.data.go.kr/data/15101578/openapi.do', ...patch });
async function harness(items=[], {failure=false, reduced=false, saveData=false}={}) {
  const document = new Element(); document.body = new Element(); document.body.dataset.screen='start'; document.hidden=false;
  document.createElement = () => new Element(); document.getElementById=()=>null;
  const motion=new Element(); motion.matches=reduced;
  const window={matchMedia:()=>motion,navigator:{connection:{saveData}}};
  let calls=0, nextId=0, observer;
  const timers=new Map();
  const context={window,document,URL,AbortController,Set,fetch:async()=>{calls++;if(failure)throw Error('offline');return {ok:true,json:async()=>({items})};},setTimeout:(fn,ms)=>{timers.set(++nextId,{fn,ms});return nextId;},clearTimeout:id=>timers.delete(id),MutationObserver:class{constructor(fn){observer=fn;}observe(){}disconnect(){observer=null;}}};
  vm.runInNewContext(source,context);
  const els={host:new Element(),controls:new Element(),caption:new Element(),toggle:new Element(),next:new Element()};
  const mounted=window.TravelBackdrop.mount(els);await mounted.ready;
  const h={...els,mounted,document,motion,timers,get calls(){return calls;},load:()=>els.host.children.forEach(i=>i.emit('load')),screen(value){document.body.dataset.screen=value;observer?.();},tick(){const entry=[...timers].find(([,t])=>t.ms===10000);assert.ok(entry,'expected 10 second timer');timers.delete(entry[0]);entry[1].fn();},cycling:()=>[...timers.values()].some(t=>t.ms===10000)};
  return h;
}
test('empty and request failure keep optional background empty',async()=>{
  for(const options of [{},{failure:true}]) {const h=await harness([],options);assert.equal(h.host.children.length,0);assert.equal(h.controls.hidden,true);assert.equal(h.cycling(),false);h.mounted.destroy();}
});
test('unknown/Type3 licenses and untrusted images are excluded',async()=>{
  const h=await harness([photo(1,{cpyrhtDivCd:undefined}),photo(2,{cpyrhtDivCd:'Type3'}),photo(3,{imageUrl:'https://evil.test/a.jpg'})]);assert.equal(h.host.children.length,0);h.mounted.destroy();
});
test('bounded to three photos, no animation until loaded; load failure removed',async()=>{
  const h=await harness([photo(1),photo(2),photo(3),photo(4)]);assert.equal(h.host.children.length,3);assert.equal(h.cycling(),false);
  h.host.children[0].emit('error');assert.equal(h.host.children.length,2);h.load();assert.equal(h.controls.hidden,false);assert.equal(h.cycling(),true);h.mounted.destroy();
});
test('10 second cycling only on visible start screen; pause and next controls',async()=>{
  const h=await harness([photo(1),photo(2)]);h.load();assert.equal(h.cycling(),true);
  const first=h.caption.textContent;h.tick();assert.notEqual(h.caption.textContent,first);
  h.screen('plan');assert.equal(h.cycling(),false);h.screen('start');assert.equal(h.cycling(),true);
  h.document.hidden=true;h.document.emit('visibilitychange');assert.equal(h.cycling(),false);h.document.hidden=false;h.document.emit('visibilitychange');assert.equal(h.cycling(),true);
  h.toggle.emit('click');assert.equal(h.cycling(),false);const paused=h.caption.textContent;h.next.emit('click');assert.notEqual(h.caption.textContent,paused);assert.equal(h.cycling(),false);
  h.toggle.emit('click');assert.equal(h.cycling(),true);h.mounted.destroy();assert.equal(h.timers.size,0);assert.equal(h.host.children.length,0);
});
test('reduced motion avoids auto cycling but permits explicit next',async()=>{
  const h=await harness([photo(1),photo(2)],{reduced:true});h.load();assert.equal(h.cycling(),false);assert.equal(h.toggle.disabled,true);
  const before=h.caption.textContent;h.next.emit('click');assert.notEqual(h.caption.textContent,before);assert.equal(h.cycling(),false);h.mounted.destroy();
});
test('data saver makes no photo API request',async()=>{
  const h=await harness([photo(1)],{saveData:true});assert.equal(h.calls,0);assert.equal(h.host.children.length,0);assert.equal(h.timers.size,0);h.mounted.destroy();
});
test('backend author/image name metadata appears in credits',async()=>{
  const h=await harness([photo(1)]);h.load();assert.match(h.caption.textContent,/사진가/);assert.match(h.caption.textContent,/사진 1/);assert.equal(h.caption.href,'https://www.data.go.kr/data/15101578/openapi.do');h.mounted.destroy();
});

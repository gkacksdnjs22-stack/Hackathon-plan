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
const photo = (n, patch = {}) => ({ title: `명소 ${n}`, description:`명소 ${n}의 풍경을 만나 보세요.`, imageName:`사진 ${n}`, author:'사진가', imageUrl:`https://tong.visitkorea.or.kr/cms/resource/01/${n}_image3_1.jpg`, cpyrhtDivCd:'Type1', license:'공공누리 제1유형 (출처표시)', sourceUrl:'https://www.data.go.kr/data/15101578/openapi.do', ...patch });
const localFilename = n => `./travel-backdrop-${String(n).padStart(2, '0')}.jpg`;
const packagedPhoto = (n, patch = {}) => photo(n, {
  imageUrl: localFilename(n), cpyrhtDivCd: undefined,
  sourceUrl: `https://commons.wikimedia.org/wiki/File:Destination_${n}.jpg`,
  license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  ...patch
});
async function harness(items=[], {failure=false, reduced=false, saveData=false, packaged=null, withStory=true}={}) {
  const document = new Element(); document.body = new Element(); document.body.dataset.screen='start'; document.hidden=false;
  document.createElement = () => new Element(); document.getElementById=()=>null;
  const motion=new Element(); motion.matches=reduced;
  const window={matchMedia:()=>motion,navigator:{connection:{saveData}},GIL_BACKDROP_FALLBACK_ITEMS:packaged};
  let calls=0, nextId=0, observer;
  const timers=new Map();
  const context={window,document,URL,AbortController,Set,fetch:async()=>{calls++;if(failure)throw Error('offline');return {ok:true,json:async()=>({items})};},setTimeout:(fn,ms)=>{timers.set(++nextId,{fn,ms});return nextId;},clearTimeout:id=>timers.delete(id),MutationObserver:class{constructor(fn){observer=fn;}observe(){}disconnect(){observer=null;}}};
  vm.runInNewContext(source,context);
  const els={host:new Element(),...(withStory?{story:new Element(),storyTitle:new Element(),storyDescription:new Element()}: {})};
  const mounted=window.TravelBackdrop.mount(els);await mounted.ready;
  const h={...els,mounted,document,motion,timers,get calls(){return calls;},load:()=>els.host.children.forEach(i=>i.emit('load')),screen(value){document.body.dataset.screen=value;observer?.();},tick(){const entry=[...timers].find(([,t])=>t.ms===15000);assert.ok(entry,'expected 15 second timer');timers.delete(entry[0]);entry[1].fn();},cycling:()=>[...timers.values()].some(t=>t.ms===15000)};
  return h;
}
test('empty and request failure keep optional background empty',async()=>{
  for(const options of [{},{failure:true}]) {const h=await harness([],options);assert.equal(h.host.children.length,0);assert.equal(h.story.hidden,true);assert.equal(h.cycling(),false);h.mounted.destroy();}
});
test('unknown/Type3 licenses and untrusted images are excluded',async()=>{
  const h=await harness([photo(1,{cpyrhtDivCd:undefined}),photo(2,{cpyrhtDivCd:'Type3'}),photo(3,{imageUrl:'https://evil.test/a.jpg'})]);assert.equal(h.host.children.length,0);h.mounted.destroy();
});
test('bounded to three photos, no animation until loaded; load failure removed',async()=>{
  const h=await harness([photo(1),photo(2),photo(3),photo(4)]);assert.equal(h.host.children.length,3);assert.equal(h.cycling(),false);
  h.host.children[0].emit('error');assert.equal(h.host.children.length,2);h.load();assert.equal(h.story.hidden,false);assert.equal(h.cycling(),true);h.mounted.destroy();
});
test('15 second automatic cycling only on start; note hides photos and returns to the same slide',async()=>{
  const h=await harness([photo(1),photo(2)]);h.load();assert.equal(h.cycling(),true);
  const first=h.storyTitle.textContent;h.tick();assert.notEqual(h.storyTitle.textContent,first);
  assert.equal(h.storyTitle.textContent,'명소 2');assert.equal(h.storyDescription.textContent,'명소 2의 풍경을 만나 보세요.');
  const current=h.storyTitle.textContent;
  h.screen('note');assert.equal(h.cycling(),false);assert.equal(h.host.hidden,true);assert.equal(h.story.hidden,true);
  assert.equal(h.storyTitle.textContent,current);
  h.screen('start');assert.equal(h.cycling(),true);assert.equal(h.host.hidden,false);assert.equal(h.story.hidden,false);assert.equal(h.storyTitle.textContent,current);
  h.document.hidden=true;h.document.emit('visibilitychange');assert.equal(h.cycling(),false);h.document.hidden=false;h.document.emit('visibilitychange');assert.equal(h.cycling(),true);
  h.tick();assert.notEqual(h.storyTitle.textContent,current);assert.equal(h.storyTitle.textContent,'명소 1');assert.equal(h.cycling(),true);
  h.mounted.destroy();assert.equal(h.timers.size,0);assert.equal(h.host.children.length,0);assert.equal(h.story.hidden,true);
});
test('reduced motion holds the current image and reacts to preference changes',async()=>{
  const h=await harness([photo(1),photo(2)],{reduced:true});h.load();assert.equal(h.cycling(),false);
  const before=h.storyTitle.textContent;h.motion.emit('change');assert.equal(h.storyTitle.textContent,before);assert.equal(h.cycling(),false);
  h.motion.matches=false;h.motion.emit('change');assert.equal(h.cycling(),true);h.tick();assert.notEqual(h.storyTitle.textContent,before);
  h.motion.matches=true;h.motion.emit('change');assert.equal(h.cycling(),false);h.mounted.destroy();
});
test('data saver makes no photo API request',async()=>{
  for(const packaged of [null,[packagedPhoto(1)]]){
    const h=await harness([photo(1)],{saveData:true,packaged});assert.equal(h.calls,0);assert.equal(h.host.children.length,0);assert.equal(h.timers.size,0);assert.equal(h.story.hidden,true);h.mounted.destroy();
  }
});
test('gallery mounts and cycles without any controls, credit bar or story nodes',async()=>{
  const h=await harness([photo(1),photo(2)],{withStory:false});assert.ok(h.mounted);h.load();assert.equal(h.cycling(),true);
  assert.equal(h.host.children[0].classes.has('is-current'),true);assert.equal(h.host.children[1].classes.has('is-current'),false);
  h.tick();assert.equal(h.host.children[0].classes.has('is-current'),false);assert.equal(h.host.children[1].classes.has('is-current'),true);
  h.screen('note');assert.equal(h.host.hidden,true);assert.equal(h.cycling(),false);h.mounted.destroy();assert.equal(h.timers.size,0);
});

test('current photo title and optional description stay synchronized without interpreting HTML',async()=>{
  const h=await harness([photo(1,{title:'<제목>',description:'<img src=x> 여행 이야기'}),photo(2,{description:undefined})]);
  h.load();assert.equal(h.story.hidden,false);assert.equal(h.storyTitle.textContent,'<제목>');assert.equal(h.storyDescription.textContent,'<img src=x> 여행 이야기');assert.equal(h.storyDescription.children.length,0);assert.equal(h.storyDescription.hidden,false);
  h.tick();assert.equal(h.storyTitle.textContent,'명소 2');assert.equal(h.storyDescription.textContent,'');assert.equal(h.storyDescription.hidden,true);
  h.mounted.destroy();
});

test('invalid optional description is omitted without discarding an eligible photo',async()=>{
  for(const description of ['a'.repeat(301),'줄\n바꿈',7,null]){
    const h=await harness([photo(1,{description})]);h.load();assert.equal(h.host.children.length,1);assert.equal(h.storyTitle.textContent,'명소 1');assert.equal(h.story.hidden,false);assert.equal(h.storyDescription.hidden,true);assert.equal(h.storyDescription.textContent,'');h.mounted.destroy();
  }
});

test('packaged licensed originals display immediately without a backdrop API request',async()=>{
  const filenames=Array.from({length:10},(_,index)=>localFilename(index+1));
  const packaged=filenames.map((imageUrl,index)=>packagedPhoto(index+1,{imageUrl}));
  const h=await harness([], {failure:true,packaged});
  assert.equal(h.calls,0);assert.deepEqual(h.host.children.map(image=>image.src),filenames);assert.equal(h.timers.size,0);
  h.load();assert.equal(h.storyTitle.textContent,'명소 1');assert.equal(h.storyDescription.textContent,'명소 1의 풍경을 만나 보세요.');assert.equal(h.cycling(),true);
  h.tick();assert.equal(h.storyTitle.textContent,'명소 2');
  h.screen('note');assert.equal(h.host.hidden,true);assert.equal(h.story.hidden,true);assert.equal(h.cycling(),false);
  h.screen('start');assert.equal(h.host.hidden,false);assert.equal(h.storyTitle.textContent,'명소 2');assert.equal(h.cycling(),true);h.mounted.destroy();
});

test('all ten packaged photos cycle once before wrapping to the first photo',async()=>{
  const h=await harness([],{packaged:Array.from({length:10},(_,index)=>packagedPhoto(index+1))});
  assert.equal(h.calls,0);assert.equal(h.host.children.length,10);h.load();
  for(let index=0;index<10;index++){
    assert.equal(h.storyTitle.textContent,`명소 ${index+1}`);
    assert.equal(h.storyDescription.textContent,`명소 ${index+1}의 풍경을 만나 보세요.`);
    assert.deepEqual(h.host.children.filter(image=>image.classes.has('is-current')).map(image=>image.src),[localFilename(index+1)]);
    h.tick();
  }
  assert.equal(h.storyTitle.textContent,'명소 1');assert.equal(h.cycling(),true);h.mounted.destroy();
});

test('packaged input is capped at ten entries including an invalid entry before an eleventh valid photo',async()=>{
  const firstTen=[packagedPhoto(1,{author:''}),...Array.from({length:9},(_,index)=>packagedPhoto(index+2))];
  const h=await harness([photo(20)],{packaged:[...firstTen,packagedPhoto(1)]});
  assert.equal(h.calls,0);assert.equal(h.host.children.length,9);
  assert.deepEqual(h.host.children.map(image=>image.src),Array.from({length:9},(_,index)=>localFilename(index+2)));
  h.load();assert.equal(h.storyTitle.textContent,'명소 2');h.mounted.destroy();
});

test('packaged Commons photos accept canonical CC BY, CC BY-SA and CC0 licenses with an author',async()=>{
  const licenses=[
    ['CC BY 2.0','https://creativecommons.org/licenses/by/2.0/'],
    ['CC BY 3.0','https://creativecommons.org/licenses/by/3.0/'],
    ['CC BY 4.0','https://creativecommons.org/licenses/by/4.0/'],
    ['CC BY-SA 2.0','https://creativecommons.org/licenses/by-sa/2.0/'],
    ['CC BY-SA 3.0','https://creativecommons.org/licenses/by-sa/3.0/'],
    ['CC BY-SA 4.0','https://creativecommons.org/licenses/by-sa/4.0/'],
    ['CC0 1.0','https://creativecommons.org/publicdomain/zero/1.0/']
  ];
  for(const [license,licenseUrl] of licenses){
    const h=await harness([],{packaged:[packagedPhoto(1,{license,licenseUrl})]});
    assert.equal(h.calls,0,license);assert.equal(h.host.children.length,1,license);
    h.load();assert.equal(h.storyTitle.textContent,'명소 1');assert.equal(h.story.hidden,false);h.mounted.destroy();
  }
});

test('packaged image allowlist excludes altered paths and unlicensed entries; absent safe items use API',async()=>{
  for(const patch of [
    {imageUrl:'./travel-backdrop-01.jpg?extra=1'},
    {imageUrl:'/travel-backdrop-01.jpg'},
    {imageUrl:'./travel-backdrop-1.jpg'},
    {imageUrl:'./travel-backdrop-11.jpg'},
    {imageUrl:'./nested/../travel-backdrop-01.jpg'},
    {imageUrl:'./travel-backdrop-hanok.jpg'},
    {imageUrl:'./other.jpg'},
    {imageUrl:'https://tong.visitkorea.or.kr/cms/resource/01/1_image3_1.jpg'},
    {license:'CC BY-NC 4.0'},
    {license:'CC BY-ND 4.0'},
    {license:undefined},
    {licenseUrl:undefined},
    {licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0'},
    {licenseUrl:'https://creativecommons.org/licenses/by-sa/3.0/'},
    {licenseUrl:'https://evil.test/licenses/by-sa/4.0/'},
    {licenseUrl:'http://creativecommons.org/licenses/by-sa/4.0/'},
    {author:undefined},
    {author:''},
    {author:'   '},
    {sourceUrl:'https://evil.test/wiki/File:Destination.jpg'},
    {sourceUrl:'https://commons.wikimedia.org.evil.test/wiki/File:Destination.jpg'},
    {sourceUrl:'https://commons.wikimedia.org@evil.test/wiki/File:Destination.jpg'},
    {sourceUrl:'https://user@commons.wikimedia.org/wiki/File:Destination.jpg'},
    {sourceUrl:'http://commons.wikimedia.org/wiki/File:Destination.jpg'},
    {sourceUrl:'https://commons.wikimedia.org/wiki/Category:Jeju'},
    {sourceUrl:'not a URL'}
  ]){
    const h=await harness([photo(2)],{packaged:[packagedPhoto(1,patch)]});assert.equal(h.calls,1,JSON.stringify(patch));assert.equal(h.host.children.length,1);assert.equal(h.host.children[0].src,photo(2).imageUrl);h.load();assert.equal(h.storyTitle.textContent,'명소 2');h.mounted.destroy();
  }
});

test('Commons licenses cannot authorize photographs returned by the photo API',async()=>{
  const commons=packagedPhoto(1);
  for(const imageUrl of [commons.imageUrl,photo(1).imageUrl,'https://upload.wikimedia.org/wikipedia/commons/a/ab/Destination.jpg']){
    const h=await harness([{...commons,imageUrl}]);
    assert.equal(h.calls,1);assert.equal(h.host.children.length,0);assert.equal(h.story.hidden,true);assert.equal(h.cycling(),false);h.mounted.destroy();
  }
});

test('failed packaged images leave the paper fallback without a misleading story or retry loop',async()=>{
  const h=await harness([],{packaged:[packagedPhoto(1)]});
  h.host.children[0].emit('error');assert.equal(h.host.children.length,0);assert.equal(h.story.hidden,true);assert.equal(h.calls,0);assert.equal(h.cycling(),false);h.mounted.destroy();
});

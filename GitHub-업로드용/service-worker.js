'use strict';
// Only this small, read-only viewer is cached. Plans, account APIs, the main app,
// maps and shared links always use their normal network handling.
const CACHE_NAME='gil-offline-shell-v1';
const ASSETS=['/offline.html','/offline-store.js','/offline-view.js','/note-view.js','/note-view.css'];
const PATHS=new Set(ASSETS),NAVIGATIONS=new Set(['/offline','/offline/','/offline.html']);
async function prepare(){
  const cache=await caches.open(CACHE_NAME);
  for(const path of ASSETS){
    if(await cache.match(path))continue;
    const response=await fetch(new Request(new URL(path,self.location.origin),{credentials:'omit',cache:'reload',redirect:'error'}));
    const contentType=response.headers.get('content-type')||'',expected=path.endsWith('.html')?'text/html':path.endsWith('.css')?'text/css':'text/javascript';
    if(!response.ok||response.type==='opaque'||response.redirected||contentType.split(';')[0].trim().toLowerCase()!==expected)throw Error('Offline viewer unavailable');
    await cache.put(path,response);
  }
  for(const path of ASSETS)if(!await cache.match(path))throw Error('Offline viewer incomplete');
}
self.addEventListener('install',event=>event.waitUntil(prepare().then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const name of await caches.keys())if(name.startsWith('gil-offline-shell-')&&name!==CACHE_NAME)await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('message',event=>{
  if(event.data?.type!=='GIL_PREPARE_OFFLINE'||event.data.version!==1||!event.ports?.[0])return;
  event.waitUntil(prepare().then(()=>event.ports[0].postMessage({ok:true,version:1}),()=>event.ports[0].postMessage({ok:false,version:1})));
});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
  const path=event.request.mode==='navigate'&&NAVIGATIONS.has(url.pathname)?'/offline.html':PATHS.has(url.pathname)?url.pathname:null;
  if(!path)return;
  event.respondWith((async()=>{
    const cached=await (await caches.open(CACHE_NAME)).match(path);if(cached)return cached;
    // A missing shell file is not replaced with the app or a private response.
    return fetch(new Request(new URL(path,self.location.origin),{credentials:'omit',redirect:'error'}));
  })());
});

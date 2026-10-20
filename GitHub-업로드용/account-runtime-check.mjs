// Explicit smoke check against real local workerd + D1, without public APIs,
// production credentials, persistent user data, or a deployed Cloudflare account.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const compiled=await build({entryPoints:[fileURLToPath(new URL('./cloudflare-worker.mjs',import.meta.url))],bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});
const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-20',
  d1Databases:['DB'],bindings:{AUTH_SECRET:'runtime-check-only-synthetic-pepper-32-characters'}}));
const origin='https://gil-runtime.example';
const document={version:8,itinerary:{cityId:'sejong',startDate:'2026-10-20',dayCount:1,
  dayAreaIds:['tour-cluster-8-1'],selections:{0:['tourapi-100','tourapi-101','tourapi-102']}}};
async function call(path,{method='GET',body,cookie}={}){
  return runtime.dispatchFetch(origin+path,{method,headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.42',
    ...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
}
const cookieFrom=response=>response.headers.get('set-cookie').split(';')[0];
try{
  const db=await runtime.getD1Database('DB');
  const schema=await readFile(new URL('./account-schema.sql',import.meta.url),'utf8');
  for(const sql of schema.split(';').map(item=>item.trim()).filter(Boolean))await db.prepare(sql).run();
  const registered=await call('/api/auth/signup',{method:'POST',body:{username:'runtime_a',password:'runtime-test-password'}});
  assert.equal(registered.status,201);const cookieA=cookieFrom(registered);
  const saved=await call('/api/plans',{method:'POST',cookie:cookieA,body:{title:'런타임 검증 계획',document}});
  assert.equal(saved.status,201);const {plan}=await saved.json();
  const another=await call('/api/auth/signup',{method:'POST',body:{username:'runtime_b',password:'runtime-test-password'}});
  assert.equal(another.status,201);const cookieB=cookieFrom(another);
  assert.deepEqual((await (await call('/api/plans',{cookie:cookieB})).json()).plans,[]);
  for(const method of ['GET','PUT','DELETE']){
    const body=method==='PUT'?{title:'차단',document,revision:1}:method==='DELETE'?{revision:1}:undefined;
    assert.equal((await call(`/api/plans/${plan.id}`,{method,cookie:cookieB,body})).status,404);
  }
  const login=await call('/api/auth/login',{method:'POST',body:{username:'runtime_a',password:'runtime-test-password'}});
  assert.equal(login.status,200);const otherDeviceCookie=cookieFrom(login);
  const loaded=await (await call(`/api/plans/${plan.id}`,{cookie:otherDeviceCookie})).json();
  assert.equal(loaded.plan.title,'런타임 검증 계획');
  assert.equal(loaded.plan.document.itinerary.cityId,'sejong');
  assert.equal((await call(`/api/plans/${plan.id}`,{method:'PUT',cookie:otherDeviceCookie,body:{title:'수정',document,revision:1}})).status,200);
  assert.equal((await call(`/api/plans/${plan.id}`,{method:'PUT',cookie:cookieA,body:{title:'이전 버전',document,revision:1}})).status,409);
  await call('/api/auth/logout',{method:'POST',cookie:otherDeviceCookie,body:{}});
  assert.equal((await (await call('/api/auth/session',{cookie:otherDeviceCookie})).json()).user,null);
  console.log('workerd + D1: signup/login, cross-session plan load, owner isolation, revision conflict and logout passed.');
}finally{await runtime.dispose();}

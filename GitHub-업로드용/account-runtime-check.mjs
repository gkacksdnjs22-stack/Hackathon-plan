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
async function seedSession(db,owner){
  const value=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('base64url');
  await db.prepare('INSERT INTO gil_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(digest,owner,Date.now()+86400000,Date.now()).run();
  return 'gil_session='+value;
}
async function seedSocialOwner(db,label){
  const owner=crypto.randomUUID();
  await db.batch([
    db.prepare('INSERT INTO gil_users(id,username,password_salt,password_hash,created_at) VALUES(?,?,?,?,?)').bind(owner,'kakao_'+label,'unused','social-only-v1',Date.now()),
    db.prepare('INSERT INTO gil_oauth_identities(provider,subject_hash,user_id,created_at) VALUES(?,?,?,?)').bind('kakao','synthetic-'+owner,owner,Date.now())
  ]);
  return owner;
}
try{
  const db=await runtime.getD1Database('DB');
  const schema=await readFile(new URL('./account-schema.sql',import.meta.url),'utf8');
  for(const sql of schema.replace(/^\s*--.*$/gm,'').split(';').map(item=>item.trim()).filter(Boolean))await db.prepare(sql).run();
  for(const endpoint of ['/api/auth/signup','/api/auth/login'])assert.equal((await call(endpoint,{method:'POST',body:{username:'retired',password:'runtime-test-password'}})).status,410);
  // Callback verification is covered by OAuth integration/E2E tests. This
  // workerd smoke test seeds verified identities directly in its temporary D1.
  const ownerA=await seedSocialOwner(db,'runtime_a'),cookieA=await seedSession(db,ownerA);
  const saved=await call('/api/plans',{method:'POST',cookie:cookieA,body:{title:'런타임 검증 계획',document}});
  assert.equal(saved.status,201);const {plan}=await saved.json();
  const snapshot={version:1,title:plan.title,cityName:'세종',startDate:'2026-10-20',dayCount:1,days:[{date:'2026-10-20',provisional:true,
    events:[{type:'place',title:'합성 검증 장소',start:540,end:600,address:'공개 검증 주소',memo:''}]}]};
  const published=await call(`/api/plans/${plan.id}/share`,{method:'POST',cookie:cookieA,body:{revision:1,document,snapshot}});
  assert.equal(published.status,201);const firstLink=await published.json();
  assert.equal((await call('/api/shared-plan',{method:'POST',body:{token:firstLink.token}})).status,200);
  const ownerB=await seedSocialOwner(db,'runtime_b'),cookieB=await seedSession(db,ownerB);
  assert.deepEqual((await (await call('/api/plans',{cookie:cookieB})).json()).plans,[]);
  assert.equal((await call(`/api/plans/${plan.id}/share`,{cookie:cookieB})).status,404);
  assert.equal((await call(`/api/plans/${plan.id}/share`,{method:'DELETE',cookie:cookieB,body:{}})).status,404);
  for(const method of ['GET','PUT','DELETE']){
    const body=method==='PUT'?{title:'차단',document,revision:1}:method==='DELETE'?{revision:1}:undefined;
    assert.equal((await call(`/api/plans/${plan.id}`,{method,cookie:cookieB,body})).status,404);
  }
  const otherDeviceCookie=await seedSession(db,ownerA);
  const loaded=await (await call(`/api/plans/${plan.id}`,{cookie:otherDeviceCookie})).json();
  assert.equal(loaded.plan.title,'런타임 검증 계획');
  assert.equal(loaded.plan.document.itinerary.cityId,'sejong');
  assert.equal((await call(`/api/plans/${plan.id}`,{method:'PUT',cookie:otherDeviceCookie,body:{title:'수정',document,revision:1}})).status,200);
  assert.equal((await (await call('/api/shared-plan',{method:'POST',body:{token:firstLink.token}})).json()).snapshot.title,plan.title);
  const republished=await call(`/api/plans/${plan.id}/share`,{method:'POST',cookie:cookieA,body:{revision:2,document,snapshot:{...snapshot,title:'수정'}}});
  assert.equal(republished.status,201);const secondLink=await republished.json();
  assert.equal((await call('/api/shared-plan',{method:'POST',body:{token:firstLink.token}})).status,404);
  assert.equal((await call(`/api/plans/${plan.id}/share`,{method:'DELETE',cookie:cookieA,body:{}})).status,200);
  assert.equal((await call('/api/shared-plan',{method:'POST',body:{token:secondLink.token}})).status,404);
  assert.equal((await call(`/api/plans/${plan.id}`,{method:'PUT',cookie:cookieA,body:{title:'이전 버전',document,revision:1}})).status,409);
  await call('/api/auth/logout',{method:'POST',cookie:otherDeviceCookie,body:{}});
  assert.equal((await (await call('/api/auth/session',{cookie:otherDeviceCookie})).json()).user,null);
  await db.prepare('DELETE FROM gil_oauth_identities WHERE user_id=?').bind(ownerA).run();
  assert.equal((await (await call('/api/auth/session',{cookie:cookieA})).json()).user,null);
  assert.equal((await call('/api/plans',{cookie:cookieA})).status,401);
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM gil_plans').first()).total,1);
  console.log('workerd + D1: social-only sessions, legacy-session denial, owner/revision isolation, fixed shared snapshots, link rotation/revocation and logout passed.');
}finally{await runtime.dispose();}

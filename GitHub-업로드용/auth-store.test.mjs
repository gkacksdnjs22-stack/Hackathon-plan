import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDatabase } from './local-db.mjs';
import { createAccountHandler } from './auth-store.mjs';

const SECRET='SYNTHETIC-ACCOUNT-SECRET-256-BITS-PRIVATE';
const RETIRED_PASSWORD='synthetic-retired-password';
const doc=()=>({version:8,itinerary:{cityId:'seoul',startDate:'2026-10-20',dayCount:1,dayAreaIds:['tour-cluster-1'],selections:{0:['tourapi-1','tourapi-2','tourapi-3']}}});
function fixture(options={}){
  const db=options.db??createLocalDatabase();let clock=Date.UTC(2026,9,20);
  const handle=createAccountHandler({db,secret:SECRET,now:()=>clock,...options});
  async function call(endpoint,{method='GET',cookie,body,origin='https://gil.example',ip='192.0.2.1',headers={}}={}){
    const requestHeaders={...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),Origin:origin,'CF-Connecting-IP':ip,...headers};
    const response=await handle(new Request('https://gil.example'+endpoint,{method,headers:requestHeaders,...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}));
    const text=response?await response.text():'';const data=text?JSON.parse(text):null;
    for(const value of [SECRET,RETIRED_PASSWORD])assert.equal(text.includes(value),false,'credentials never appear in responses');
    return {response,status:response?.status,data,cookie:response?.headers.get('set-cookie')?.split(';')[0]};
  }
  // Authorization fixtures seed only verified social identities; OAuth callback
  // issuance itself is exercised separately in oauth-login.test.mjs.
  const socialLogin=async(username)=>{
    const normalized=username.toLowerCase();
    let owner=await db.prepare('SELECT id,username FROM gil_users WHERE username=?').bind(normalized).first();
    if(!owner){owner={id:crypto.randomUUID(),username:normalized};await db.batch([
      db.prepare('INSERT INTO gil_users(id,username,password_salt,password_hash,created_at) VALUES(?,?,?,?,?)').bind(owner.id,owner.username,'unused','social-only-v1',clock),
      db.prepare('INSERT INTO gil_oauth_identities(provider,subject_hash,user_id,created_at) VALUES(?,?,?,?)').bind('kakao','synthetic-'+owner.id,owner.id,clock)
    ]);}
    const raw=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))).toString('base64url');
    await db.prepare('INSERT INTO gil_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(digest,owner.id,clock+7*86400000,clock).run();
    const cookie='gil_session='+raw,result=await call('/api/auth/session',{cookie});return {...result,cookie};
  };
  return {db,call,socialLogin,advance:milliseconds=>{clock+=milliseconds;}};
}

test('social-only authorization retains verified sessions but rejects legacy sessions without deleting any users or plans', async t=>{
  const f=fixture();t.after(()=>f.db.close());const legacy=await f.socialLogin('legacy'),social=await f.socialLogin('social');
  const saved=await f.call('/api/plans',{method:'POST',cookie:legacy.cookie,body:{title:'이전 계정의 보관 노트',document:doc()}});assert.equal(saved.status,201);
  await f.db.prepare('DELETE FROM gil_oauth_identities WHERE user_id=?').bind(legacy.data.user.id).run();
  await f.db.prepare('UPDATE gil_users SET password_hash=? WHERE id=?').bind('pbkdf2-sha256-100000+hmac-v1.synthetic-legacy-hash',legacy.data.user.id).run();
  assert.deepEqual((await f.call('/api/auth/session',{cookie:legacy.cookie})).data,{configured:true,user:null});
  for(const endpoint of ['/api/plans',`/api/plans/${saved.data.plan.id}`,`/api/plans/${saved.data.plan.id}/share`])assert.equal((await f.call(endpoint,{cookie:legacy.cookie})).status,401);
  assert.equal((await f.call('/api/auth/session',{cookie:social.cookie})).data.user.id,social.data.user.id);
  assert.equal((await f.call(`/api/plans/${saved.data.plan.id}`,{cookie:social.cookie})).status,404);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS total FROM gil_users').first()).total,2);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS total FROM gil_sessions').first()).total,2);
  assert.equal((await f.db.prepare('SELECT title FROM gil_plans').first()).title,'이전 계정의 보관 노트');
});

test('personalization survives account save, update and load without leaking through plan lists or to another owner', async t=>{
  const f=fixture();t.after(()=>f.db.close());const owner=await f.socialLogin('Personal'),other=await f.socialLogin('Other');
  const document=doc();document.itinerary.personalization={checklist:[{id:'item-1',text:'예약 확인서',done:false}],favoritePlaceIds:['tourapi-4'],eventTags:{0:{lunch:'booked'}}};
  const created=await f.call('/api/plans',{method:'POST',cookie:owner.cookie,body:{title:'개인 여행',document}});
  assert.equal(created.status,201);const id=created.data.plan.id;
  const loaded=await f.call(`/api/plans/${id}`,{cookie:owner.cookie});
  assert.deepEqual(loaded.data.plan.document.itinerary.personalization,document.itinerary.personalization);
  document.itinerary.personalization.checklist[0].done=true;
  const updated=await f.call(`/api/plans/${id}`,{method:'PUT',cookie:owner.cookie,body:{title:'개인 여행',document,revision:1}});
  assert.equal(updated.status,200);
  assert.equal((await f.call(`/api/plans/${id}`,{cookie:owner.cookie})).data.plan.document.itinerary.personalization.checklist[0].done,true);
  assert.equal((await f.call(`/api/plans/${id}`,{cookie:other.cookie})).status,404);
  const list=await f.call('/api/plans',{cookie:owner.cookie});assert.equal(JSON.stringify(list.data).includes('예약 확인서'),false);
});

test('account create, update and load preserve coordinate-free restaurant identities and reject invalid references without overwriting the plan', async t=>{
  const f=fixture();t.after(()=>f.db.close());const owner=await f.socialLogin('restaurant-ref');
  const first={id:'tour-food-1',name:'동명 식당',address:'첫 지점 주소'},second={id:'tour-food-2',name:'동명 식당',address:'둘째 지점 주소'};
  const document=doc();document.itinerary.eventEdits={0:{lunch:{description:'기존 예약 메모',duration:75,restaurantRef:first}}};
  document.itinerary.extraEvents={0:[{id:'extra-1',type:'meal',duration:45,description:'추가 일정 메모',restaurantRef:second}]};
  document.itinerary.personalization={eventTags:{0:{lunch:'booked','extra-1':'must'}}};
  const created=await f.call('/api/plans',{method:'POST',cookie:owner.cookie,body:{title:'식당 선택 보존',document}});
  assert.equal(created.status,201);const id=created.data.plan.id;
  let loaded=await f.call(`/api/plans/${id}`,{cookie:owner.cookie});assert.equal(loaded.status,200);
  assert.deepEqual(loaded.data.plan.document.itinerary.eventEdits[0].lunch.restaurantRef,first);
  assert.deepEqual(loaded.data.plan.document.itinerary.extraEvents[0][0].restaurantRef,second);
  document.itinerary.eventEdits[0].lunch.restaurantRef=second;document.itinerary.extraEvents[0][0].restaurantRef=first;
  const updated=await f.call(`/api/plans/${id}`,{method:'PUT',cookie:owner.cookie,body:{title:'식당 선택 보존',document,revision:1}});assert.equal(updated.status,200);
  loaded=await f.call(`/api/plans/${id}`,{cookie:owner.cookie});const preserved=loaded.data.plan.document;
  assert.deepEqual(preserved.itinerary.eventEdits[0].lunch,{description:'기존 예약 메모',duration:75,restaurantRef:second});
  assert.deepEqual(preserved.itinerary.extraEvents[0][0].restaurantRef,first);
  assert.deepEqual(preserved.itinerary.personalization.eventTags,document.itinerary.personalization.eventTags);
  for(const meal of [preserved.itinerary.eventEdits[0].lunch,preserved.itinerary.extraEvents[0][0]])assert.equal(Object.hasOwn(meal,'location'),false);
  const invalidRefs=[{...first,latitude:37.5},{...first,id:''},{...first,name:'n'.repeat(161)},{...first,address:'a'.repeat(501)}];
  const invalidDocuments=invalidRefs.map(restaurantRef=>{const value=JSON.parse(JSON.stringify(preserved));value.itinerary.eventEdits[0].lunch.restaurantRef=restaurantRef;return value;});
  const nonMeal=JSON.parse(JSON.stringify(preserved));nonMeal.itinerary.eventEdits[0]['place-0']={restaurantRef:first};invalidDocuments.push(nonMeal);
  const extraNonMeal=JSON.parse(JSON.stringify(preserved));extraNonMeal.itinerary.extraEvents[0][0].type='free';invalidDocuments.push(extraNonMeal);
  for(const invalid of invalidDocuments)for(const method of ['POST','PUT']){
    const response=await f.call(method==='POST'?'/api/plans':`/api/plans/${id}`,{method,cookie:owner.cookie,body:{title:'덮어쓰면 안 됨',document:invalid,...(method==='PUT'?{revision:2}:{})}});
    assert.equal(response.status,400);assert.equal(response.data.error.code,'INVALID_PLAN');
  }
  loaded=await f.call(`/api/plans/${id}`,{cookie:owner.cookie});assert.equal(loaded.data.plan.revision,2);assert.equal(loaded.data.plan.title,'식당 선택 보존');assert.deepEqual(loaded.data.plan.document,preserved);
  assert.equal((await f.call('/api/plans',{cookie:owner.cookie})).data.plans.length,1);
  document.itinerary.eventEdits[0].lunch.restaurantRef=null;document.itinerary.extraEvents[0][0].restaurantRef=null;
  assert.equal((await f.call(`/api/plans/${id}`,{method:'PUT',cookie:owner.cookie,body:{title:'식당 선택 보존',document,revision:2}})).status,200);
  loaded=await f.call(`/api/plans/${id}`,{cookie:owner.cookie});assert.equal(loaded.data.plan.revision,3);
  assert.equal(loaded.data.plan.document.itinerary.eventEdits[0].lunch.restaurantRef,null);assert.equal(loaded.data.plan.document.itinerary.extraEvents[0][0].restaurantRef,null);
});

test('retired signup and password login return 410 for every method without reading credentials or querying the database', async()=>{
  let reads=0;const handle=createAccountHandler({secret:SECRET,db:{prepare(){reads++;throw Error('must not query');},batch(){reads++;}}});
  for(const endpoint of ['/api/auth/signup','/api/auth/login'])for(const method of ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']){
    const response=await handle(new Request('https://gil.example'+endpoint,{method,...(!['GET','HEAD'].includes(method)?{body:JSON.stringify({username:'legacy',password:RETIRED_PASSWORD})}:{})}));
    assert.equal(response.status,410);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.has('set-cookie'),false);
    const text=await response.text();assert.equal(text.includes(RETIRED_PASSWORD),false);if(method!=='HEAD')assert.equal(JSON.parse(text).error.code,'LOGIN_METHOD_REMOVED');
  }
  const unconfigured=createAccountHandler({});assert.equal((await unconfigured(new Request('https://gil.example/api/auth/signup',{method:'POST',body:'not-json'}))).status,410);
  assert.equal(reads,0);
});

test('each account owns list, read, update and delete operations even when another plan UUID is known', async t=>{
  const f=fixture();t.after(()=>f.db.close());const alice=await f.socialLogin('alice'),bob=await f.socialLogin('bob','192.0.2.2');
  const created=await f.call('/api/plans',{method:'POST',cookie:alice.cookie,body:{title:'서울 개인 여행',document:doc()}});
  assert.equal(created.status,201);const plan=created.data.plan;
  assert.equal(plan.revision,1);assert.equal(plan.document,undefined);
  const list=await f.call('/api/plans',{cookie:alice.cookie});assert.deepEqual(list.data.plans,[plan]);assert.equal(JSON.stringify(list.data).includes('selections'),false);
  assert.deepEqual((await f.call('/api/plans',{cookie:bob.cookie})).data,{plans:[]});
  for(const method of ['GET','PUT','DELETE']){
    const result=await f.call(`/api/plans/${plan.id}`,{method,cookie:bob.cookie,...(method==='GET'?{}:{body:method==='PUT'?{title:'침범',document:doc(),revision:1}:{revision:1}})});
    assert.equal(result.status,404,method);assert.equal(result.data.error.code,'NOT_FOUND');
  }
  const own=await f.call(`/api/plans/${plan.id}`,{cookie:alice.cookie});assert.equal(own.status,200);assert.equal(own.data.plan.title,'서울 개인 여행');assert.equal(own.data.plan.document.version,8);
  const unauthenticated=await f.call(`/api/plans/${plan.id}`);assert.equal(unauthenticated.status,401);
});

test('revisions reject stale updates and deletes while preserving the newest saved plan', async t=>{
  const f=fixture();t.after(()=>f.db.close());const owner=await f.socialLogin('owner');
  const first=await f.call('/api/plans',{method:'POST',cookie:owner.cookie,body:{title:'처음',document:doc()}});const id=first.data.plan.id;
  f.advance(1000);
  const update=await f.call(`/api/plans/${id}`,{method:'PUT',cookie:owner.cookie,body:{title:'두 번째',document:doc(),revision:1}});
  assert.equal(update.status,200);assert.equal(update.data.plan.revision,2);assert.notEqual(update.data.plan.updatedAt,update.data.plan.createdAt);
  for(const method of ['PUT','DELETE']){
    const result=await f.call(`/api/plans/${id}`,{method,cookie:owner.cookie,body:method==='PUT'?{title:'덮어쓰기',document:doc(),revision:1}:{revision:1}});
    assert.equal(result.status,409);assert.equal(result.data.error.code,'CONFLICT');
  }
  assert.equal((await f.call(`/api/plans/${id}`,{cookie:owner.cookie})).data.plan.title,'두 번째');
  assert.equal((await f.call(`/api/plans/${id}`,{method:'DELETE',cookie:owner.cookie,body:{revision:2}})).status,200);
  assert.equal((await f.call(`/api/plans/${id}`,{cookie:owner.cookie})).status,404);
});

test('hidden duplicate recommendations cannot be created or overwrite a valid saved account plan', async t=>{
  const f=fixture();t.after(()=>f.db.close());const owner=await f.socialLogin('duplicate-review');
  const created=await f.call('/api/plans',{method:'POST',cookie:owner.cookie,body:{title:'정상 여행',document:doc()}});
  assert.equal(created.status,201);const id=created.data.plan.id;
  for(const hidden of [['place-0'],['place-1'],['place-0','place-1']]) {
    const document=doc();document.itinerary.selections[0]=['tourapi-1','tourapi-1','tourapi-3'];
    document.itinerary.excludedEvents={0:hidden};
    for(const method of ['POST','PUT']) {
      const path=method==='POST'?'/api/plans':`/api/plans/${id}`;
      const response=await f.call(path,{method,cookie:owner.cookie,body:{title:'중복 여행',document,...(method==='PUT'?{revision:1}:{})}});
      assert.equal(response.status,400);assert.equal(response.data.error.code,'INVALID_PLAN');
    }
  }
  const loaded=await f.call(`/api/plans/${id}`,{cookie:owner.cookie});
  assert.equal(loaded.status,200);assert.equal(loaded.data.plan.revision,1);assert.equal(loaded.data.plan.title,'정상 여행');
  assert.deepEqual(loaded.data.plan.document.itinerary.selections[0],doc().itinerary.selections[0]);
  assert.equal((await f.call('/api/plans',{cookie:owner.cookie})).data.plans.length,1);
});

test('malformed excluded rows return input errors on create and update without changing saved plans', async t=>{
  const f=fixture();t.after(()=>f.db.close());const owner=await f.socialLogin('excluded-review');
  const created=await f.call('/api/plans',{method:'POST',cookie:owner.cookie,body:{title:'보존할 여행',document:doc()}});
  assert.equal(created.status,201);const id=created.data.plan.id;
  for(const value of [{},1,true,null,'place-0',['departure']]) {
    const document=doc();document.itinerary.excludedEvents={0:value};
    for(const method of ['POST','PUT']) {
      const path=method==='POST'?'/api/plans':`/api/plans/${id}`;
      const response=await f.call(path,{method,cookie:owner.cookie,body:{title:'잘못된 여행',document,...(method==='PUT'?{revision:1}:{})}});
      assert.equal(response.status,400);assert.equal(response.data.error.code,'INVALID_PLAN');
    }
  }
  const loaded=await f.call(`/api/plans/${id}`,{cookie:owner.cookie});
  assert.equal(loaded.status,200);assert.equal(loaded.data.plan.title,'보존할 여행');assert.equal(loaded.data.plan.revision,1);
  assert.deepEqual(loaded.data.plan.document.itinerary.selections[0],doc().itinerary.selections[0]);
  assert.equal((await f.call('/api/plans',{cookie:owner.cookie})).data.plans.length,1);
});

test('expected owner guards stale tab reads and writes with another accounts current cookie', async t=>{
  const f=fixture();t.after(()=>f.db.close());
  const alice=await f.socialLogin('alice'),bob=await f.socialLogin('bob','192.0.2.2');
  const make=(owner,title)=>f.call('/api/plans',{method:'POST',cookie:owner.cookie,headers:{'X-Gil-Expected-User':owner.data.user.id},body:{title,document:doc()}});
  const alicePlan=await make(alice,'Alice private note'),bobPlan=await make(bob,'Bob private note');
  assert.equal(alicePlan.status,201);assert.equal(bobPlan.status,201);
  const stale={'X-Gil-Expected-User':alice.data.user.id};
  for(const path of ['/api/plans',`/api/plans/${bobPlan.data.plan.id}`]){
    for(const method of ['GET','HEAD']){
      const denied=await f.call(path,{method,cookie:bob.cookie,headers:stale});
      assert.equal(denied.status,409);
      if(method==='GET'){
        assert.equal(denied.data.error.code,'SESSION_CHANGED');
        assert.equal(JSON.stringify(denied.data).includes('Bob private note'),false);
        assert.equal(JSON.stringify(denied.data).includes('selections'),false);
      }else assert.equal(denied.data,null);
      const actualBob=await f.call(path,{method,cookie:bob.cookie,headers:{'X-Gil-Expected-User':bob.data.user.id}});
      assert.equal(actualBob.status,200);
      if(method==='GET')assert.equal(path==='/api/plans'?actualBob.data.plans[0].title:actualBob.data.plan.title,'Bob private note');
      else assert.equal(actualBob.data,null);
    }
  }
  for(const [path,method,body]of [
    ['/api/plans','POST',{title:'Alice content must not be copied into Bob',document:doc()}],
    [`/api/plans/${bobPlan.data.plan.id}`,'PUT',{title:'stale overwrite',document:doc(),revision:1}],
    [`/api/plans/${bobPlan.data.plan.id}`,'DELETE',{revision:1}]
  ]){
    const result=await f.call(path,{method,cookie:bob.cookie,headers:stale,body});
    assert.equal(result.status,409);assert.equal(result.data.error.code,'SESSION_CHANGED');
  }
  const list=await f.call('/api/plans',{cookie:bob.cookie});
  assert.deepEqual(list.data.plans.map(plan=>[plan.title,plan.revision]),[['Bob private note',1]]);
  const unauthenticated=await f.call('/api/plans',{method:'POST',headers:stale,body:{title:'no cookie',document:doc()}});
  assert.equal(unauthenticated.status,401,'an owner header never authenticates a request');
  assert.equal((await f.call('/api/plans',{headers:stale})).status,401,'read headers cannot authenticate a request either');
  const forged=await f.call(`/api/plans/${alicePlan.data.plan.id}`,{method:'PUT',cookie:bob.cookie,headers:{'X-Gil-Expected-User':bob.data.user.id},body:{title:'forged access',document:doc(),revision:1}});
  assert.equal(forged.status,404,'matching a cookie owner cannot bypass SQL plan ownership');
  for(const value of ['',`${bob.data.user.id},${alice.data.user.id}`]){
    assert.equal((await f.call('/api/plans',{method:'POST',cookie:bob.cookie,headers:{'X-Gil-Expected-User':value},body:{title:'invalid expected owner',document:doc()}})).data.error.code,'SESSION_CHANGED');
  }
  const updated=await f.call(`/api/plans/${bobPlan.data.plan.id}`,{method:'PUT',cookie:bob.cookie,headers:{'X-Gil-Expected-User':bob.data.user.id},body:{title:'Bob updated',document:doc(),revision:1}});
  assert.equal(updated.status,200);assert.equal(updated.data.plan.revision,2);
  const removed=await f.call(`/api/plans/${bobPlan.data.plan.id}`,{method:'DELETE',cookie:bob.cookie,headers:{'X-Gil-Expected-User':bob.data.user.id},body:{revision:2}});
  assert.equal(removed.status,200);
});

test('same-origin JSON checks protect logout and all plan mutations', async t=>{
  const f=fixture();t.after(()=>f.db.close());const owner=await f.socialLogin('owner');
  for(const endpoint of ['/api/auth/logout','/api/plans'])assert.equal((await f.call(endpoint,{method:'POST',cookie:owner.cookie,origin:'https://attacker.example',body:{}})).status,403);
  assert.equal((await f.call('/api/plans',{method:'POST',cookie:owner.cookie,body:{title:'검사',document:doc()},headers:{'Content-Type':'text/plain'}})).status,400);
  assert.equal((await f.call('/api/auth/logout',{method:'POST',body:{},headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await f.call('/api/auth/session',{method:'POST',body:{}})).status,405);
  assert.equal((await f.call('/api/plans',{method:'PATCH',cookie:owner.cookie,body:{}})).status,405);
});

test('logout and seven-day expiry revoke access without caching personal responses', async t=>{
  const f=fixture();t.after(()=>f.db.close());let signed=await f.socialLogin('expiry');
  f.advance(7*86400000);assert.equal((await f.call('/api/auth/session',{cookie:signed.cookie})).data.user,null);
  signed=await f.socialLogin('expiry');assert.equal(signed.status,200);
  const logout=await f.call('/api/auth/logout',{method:'POST',cookie:signed.cookie,body:{}});assert.equal(logout.status,200);assert.ok(logout.response.headers.get('set-cookie').includes('Max-Age=0'));
  assert.equal((await f.call('/api/plans',{cookie:signed.cookie})).status,401);
});

test('OAuth start IP counters remain durable across handlers and expire by their window', async t=>{
  const db=createLocalDatabase();t.after(()=>db.close());const options={db,oauthEnv:{SOCIAL_AUTH_BASE_URL:'https://gil.example',KAKAO_LOGIN_CLIENT_ID:'synthetic-id',KAKAO_LOGIN_CLIENT_SECRET:'synthetic-secret'}};
  const f=fixture(options);for(let i=0;i<30;i++)assert.equal((await f.call('/api/auth/oauth/kakao/start')).status,303);
  assert.equal((await f.call('/api/auth/oauth/kakao/start')).status,429);
  const second=fixture(options);assert.equal((await second.call('/api/auth/oauth/kakao/start')).status,429);
  const rows=JSON.stringify((await db.prepare('SELECT * FROM gil_rate_limits').all()).results);assert.doesNotMatch(rows,/192\.0\.2\.1|synthetic-id/);
  f.advance(900000);assert.equal((await f.call('/api/auth/oauth/kakao/start')).status,303);
});

test('simultaneous OAuth starts cannot exceed the per-IP budget and another IP remains independent', async t=>{
  const f=fixture({oauthEnv:{SOCIAL_AUTH_BASE_URL:'https://gil.example',KAKAO_LOGIN_CLIENT_ID:'synthetic-id',KAKAO_LOGIN_CLIENT_SECRET:'synthetic-secret'}});t.after(()=>f.db.close());
  const results=await Promise.all(Array.from({length:40},()=>f.call('/api/auth/oauth/kakao/start')));
  assert.equal(results.filter(row=>row.status===303).length,30);assert.equal(results.filter(row=>row.status===429).length,10);
  assert.equal((await f.call('/api/auth/oauth/kakao/start',{ip:'198.51.100.2'})).status,303);
});

test('duplicate and malformed session cookies never authenticate a social account', async t=>{
  const f=fixture();t.after(()=>f.db.close());const owner=await f.socialLogin('owner');
  for(const cookie of [owner.cookie+'; '+owner.cookie,'gil_session=bad','gil_session='+('A'.repeat(42)+'B')]){
    assert.equal((await f.call('/api/auth/session',{cookie})).data.user,null);assert.equal((await f.call('/api/plans',{cookie})).status,401);
  }
  assert.equal((await f.call('/api/auth/session',{cookie:owner.cookie})).data.user.id,owner.data.user.id);
});

test('a copied single final LF or CRLF keeps configured social sessions available', async t=>{
  const original=fixture();t.after(()=>original.db.close());const owner=await original.socialLogin('original_owner');
  for(const lineEnding of ['\n','\r\n']){
    const copied=fixture({db:original.db,secret:SECRET+lineEnding});assert.deepEqual((await copied.call('/api/auth/session',{cookie:owner.cookie})).data,{configured:true,user:owner.data.user});
  }
});

test('secret normalization rejects extra line content and controls, checks the normalized byte length, and preserves spaces', async t=>{
  const original=fixture();t.after(()=>original.db.close());await original.socialLogin('owner');
  for(const secret of [`\n${SECRET}`,`${SECRET.slice(0,8)}\n${SECRET.slice(8)}`,`${SECRET}\n\n`,`${SECRET}\r\n\r\n`,
    `${SECRET}\r`,`${SECRET}\0`,`${SECRET}\t\n`,'x'.repeat(31)+'\n','x'.repeat(513)+'\r\n']){
    const invalid=fixture({db:original.db,secret});
    assert.deepEqual((await invalid.call('/api/auth/session')).data,{configured:false,user:null});
    assert.equal((await invalid.call('/api/plans')).status,503);
  }
  for(const length of [32,512]){
    const boundary=fixture({db:original.db,secret:'x'.repeat(length)+'\r\n'});
    assert.deepEqual((await boundary.call('/api/auth/session')).data,{configured:true,user:null});
  }
  const spaced=fixture({db:original.db,secret:` ${SECRET} `});
  assert.deepEqual((await spaced.call('/api/auth/session')).data,{configured:true,user:null});
  assert.equal((await spaced.call('/api/plans')).status,401);
});

test('one hundred plans are enforced atomically per account, and another owner has a separate quota', async t=>{
  const f=fixture();t.after(()=>f.db.close());const alice=await f.socialLogin('alice'),bob=await f.socialLogin('bob','192.0.2.2');
  const requests=Array.from({length:101},(_,index)=>f.call('/api/plans',{method:'POST',cookie:alice.cookie,body:{title:`여행 ${index}`,document:doc()}}));
  const results=await Promise.all(requests);assert.equal(results.filter(result=>result.status===201).length,100);assert.equal(results.filter(result=>result.data?.error?.code==='PLAN_LIMIT').length,1);
  assert.equal((await f.call('/api/plans',{cookie:alice.cookie})).data.plans.length,100);
  assert.equal((await f.call('/api/plans',{method:'POST',cookie:bob.cookie,body:{title:'별도 여행',document:doc()}})).status,201);
});

test('invalid inputs and overlarge bodies cannot write raw routing data or user-selected owner IDs', async t=>{
  const f=fixture();t.after(()=>f.db.close());const owner=await f.socialLogin('owner');
  for(const body of [{title:'제목',document:doc(),userId:'other'},{title:'제목',document:{...doc(),routes:[]}},{title:' ',document:doc()},
    {title:'제목',document:{version:8,itinerary:{...doc().itinerary,eventEdits:{0:{lunch:{provider:'카카오맵',routes:[]}}}}}}]){
    const result=await f.call('/api/plans',{method:'POST',cookie:owner.cookie,body});assert.equal(result.status,400);
  }
  const big=await f.call('/api/plans',{method:'POST',cookie:owner.cookie,body:'x'.repeat(280*1024)});assert.equal(big.status,413);
  const retired=await f.call('/api/auth/signup',{method:'POST',body:{username:"x' OR 1=1--",password:RETIRED_PASSWORD}});assert.equal(retired.status,410);
  assert.deepEqual((await f.call('/api/plans',{cookie:owner.cookie})).data.plans,[]);
});

test('missing configuration and raw database errors return fixed messages without exception details', async t=>{
  const f=fixture({secret:undefined});t.after(()=>f.db.close());assert.deepEqual((await f.call('/api/auth/session')).data,{configured:false,user:null});assert.equal((await f.call('/api/plans')).status,503);
  const broken=createAccountHandler({secret:SECRET,db:{prepare(){throw new Error('PRIVATE raw SQL '+SECRET);},batch(){throw new Error('PRIVATE');}}});
  const response=await broken(new Request('https://gil.example/api/plans',{headers:{Cookie:'gil_session='+'A'.repeat(43)}}));
  assert.equal(response.status,500);const text=await response.text();assert.equal(text.includes('PRIVATE'),false);assert.equal(text.includes(SECRET),false);
});

test('retired credential requests cannot change a verified account or invalidate its active social session', async t=>{
  const f=fixture();t.after(()=>f.db.close());const signed=await f.socialLogin('retained');
  for(const endpoint of ['/api/auth/signup','/api/auth/login'])assert.equal((await f.call(endpoint,{method:'POST',cookie:signed.cookie,body:{username:'retained',password:RETIRED_PASSWORD}})).status,410);
  assert.equal((await f.call('/api/auth/session',{cookie:signed.cookie})).data.user.id,signed.data.user.id);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS total FROM gil_users').first()).total,1);
});

test('local SQLite persists across reopening and batch failures roll back preceding changes', async()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'gil-account-test-')),filename=path.join(directory,'accounts.sqlite');let db;
  try{
    db=createLocalDatabase({filename});const f=fixture({db}),owner=await f.socialLogin('persisted');
    await f.call('/api/plans',{method:'POST',cookie:owner.cookie,body:{title:'재시작 후에도 저장',document:doc()}});db.close();
    db=createLocalDatabase({filename});assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM gil_users').first()).total,1);assert.equal((await db.prepare('SELECT title FROM gil_plans').first()).title,'재시작 후에도 저장');
    await assert.rejects(db.batch([db.prepare('DELETE FROM gil_plans'),db.prepare('INSERT INTO nonexistent_table VALUES(1)')]));
    assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM gil_plans').first()).total,1);
  }finally{db?.close();rmSync(directory,{recursive:true,force:true});}
});

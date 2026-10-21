import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDatabase } from './local-db.mjs';
import { createAccountHandler } from './auth-store.mjs';

const SECRET='SYNTHETIC-ACCOUNT-SECRET-256-BITS-PRIVATE';
const PASSWORD='  password with spaces  ';
const doc=()=>({version:8,itinerary:{cityId:'seoul',startDate:'2026-10-20',dayCount:1,dayAreaIds:['tour-cluster-1'],selections:{0:['tourapi-1','tourapi-2','tourapi-3']}}});
function fixture(options={}){
  const db=options.db??createLocalDatabase();let clock=Date.UTC(2026,9,20);
  const handle=createAccountHandler({db,secret:SECRET,now:()=>clock,...options});
  async function call(endpoint,{method='GET',cookie,body,origin='https://gil.example',ip='192.0.2.1',headers={}}={}){
    const requestHeaders={...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),Origin:origin,'CF-Connecting-IP':ip,...headers};
    const response=await handle(new Request('https://gil.example'+endpoint,{method,headers:requestHeaders,...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}));
    const text=response?await response.text():'';const data=text?JSON.parse(text):null;
    for(const value of [SECRET,PASSWORD])assert.equal(text.includes(value),false,'credentials never appear in responses');
    return {response,status:response?.status,data,cookie:response?.headers.get('set-cookie')?.split(';')[0]};
  }
  const signup=async(username,ip='192.0.2.1')=>call('/api/auth/signup',{method:'POST',body:{username,password:PASSWORD},ip});
  return {db,call,signup,advance:milliseconds=>{clock+=milliseconds;}};
}

test('signup hashes passwords and opaque sessions, normalizes usernames and keeps sessions private and uncached', async t=>{
  const f=fixture();t.after(()=>f.db.close());
  const result=await f.signup('Traveller');assert.equal(result.status,201);assert.equal(result.data.user.username,'traveller');
  const header=result.response.headers.get('set-cookie');for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/','Max-Age=604800'])assert.ok(header.includes(flag));
  const user=await f.db.prepare('SELECT * FROM gil_users').first(),session=await f.db.prepare('SELECT * FROM gil_sessions').first();
  assert.equal(user.password_salt.length,22);assert.ok(user.password_hash.startsWith('pbkdf2-sha256-100000+hmac-v1.'));
  assert.equal(JSON.stringify(user).includes(PASSWORD),false);assert.equal(JSON.stringify(user).includes(SECRET),false);
  assert.notEqual(session.token_hash,result.cookie.split('=')[1]);assert.equal(session.token_hash.length,43);
  const state=await f.call('/api/auth/session',{cookie:result.cookie});assert.deepEqual(state.data,{configured:true,user:result.data.user});
  assert.equal(state.response.headers.get('cache-control'),'no-store');
  assert.deepEqual((await f.call('/api/auth/session')).data,{configured:true,user:null});
});

test('password spaces are preserved, login failures are generic and successful login rotates a supplied session', async t=>{
  const f=fixture();t.after(()=>f.db.close());const signed=await f.signup('Alice');
  const wrong=await f.call('/api/auth/login',{method:'POST',body:{username:'alice',password:PASSWORD.trim()}});
  const absent=await f.call('/api/auth/login',{method:'POST',body:{username:'unknown',password:PASSWORD}});
  assert.equal(wrong.status,401);assert.deepEqual(wrong.data,absent.data);
  const login=await f.call('/api/auth/login',{method:'POST',cookie:signed.cookie,body:{username:'ALICE',password:PASSWORD}});
  assert.equal(login.status,200);assert.notEqual(login.cookie,signed.cookie);
  assert.equal((await f.call('/api/auth/session',{cookie:signed.cookie})).data.user,null);
  assert.equal((await f.call('/api/auth/session',{cookie:login.cookie})).data.user.username,'alice');
});

test('each account owns list, read, update and delete operations even when another plan UUID is known', async t=>{
  const f=fixture();t.after(()=>f.db.close());const alice=await f.signup('alice'),bob=await f.signup('bob','192.0.2.2');
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
  const f=fixture();t.after(()=>f.db.close());const owner=await f.signup('owner');
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

test('same-origin JSON checks protect signup, login, logout and all plan mutations', async t=>{
  const f=fixture();t.after(()=>f.db.close());const owner=await f.signup('owner');
  for(const endpoint of ['/api/auth/signup','/api/auth/login','/api/auth/logout','/api/plans']){
    const result=await f.call(endpoint,{method:'POST',cookie:owner.cookie,origin:'https://attacker.example',body:{username:'owner',password:PASSWORD}});
    assert.equal(result.status,403,endpoint);
  }
  assert.equal((await f.call('/api/plans',{method:'POST',cookie:owner.cookie,body:{title:'검사',document:doc()},headers:{'Content-Type':'text/plain'}})).status,400);
  assert.equal((await f.call('/api/auth/login',{method:'POST',body:{username:'owner',password:PASSWORD},headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await f.call('/api/auth/session',{method:'POST',body:{}})).status,405);
  assert.equal((await f.call('/api/plans',{method:'PATCH',cookie:owner.cookie,body:{}})).status,405);
});

test('logout and seven-day expiry revoke access without caching personal responses', async t=>{
  const f=fixture();t.after(()=>f.db.close());let signed=await f.signup('expiry');
  f.advance(7*86400000);assert.equal((await f.call('/api/auth/session',{cookie:signed.cookie})).data.user,null);
  signed=await f.call('/api/auth/login',{method:'POST',body:{username:'expiry',password:PASSWORD}});assert.equal(signed.status,200);
  const logout=await f.call('/api/auth/logout',{method:'POST',cookie:signed.cookie,body:{}});assert.equal(logout.status,200);assert.ok(logout.response.headers.get('set-cookie').includes('Max-Age=0'));
  assert.equal((await f.call('/api/plans',{cookie:signed.cookie})).status,401);
});

test('durable username and IP counters stop repeated logins across handler instances and expire by window', async t=>{
  const f=fixture();t.after(()=>f.db.close());
  for(let index=0;index<10;index++)assert.equal((await f.call('/api/auth/login',{method:'POST',body:{username:'missing',password:PASSWORD}})).status,401);
  const blocked=await f.call('/api/auth/login',{method:'POST',body:{username:'missing',password:PASSWORD}});assert.equal(blocked.status,429);
  const second=fixture({db:f.db});assert.equal((await second.call('/api/auth/login',{method:'POST',body:{username:'missing',password:PASSWORD},ip:'192.0.2.99'})).status,429);
  const rows=await f.db.prepare('SELECT * FROM gil_rate_limits').all();const text=JSON.stringify(rows);assert.equal(text.includes('192.0.2.'),false);assert.equal(text.includes('missing'),false);assert.equal(text.includes(SECRET),false);
  f.advance(900000);assert.equal((await f.call('/api/auth/login',{method:'POST',body:{username:'missing',password:PASSWORD}})).status,401);
});

test('IP counters prevent username rotation and concurrent requests cannot exceed a username budget', async t=>{
  const f=fixture();t.after(()=>f.db.close());
  for(let index=0;index<30;index++)assert.equal((await f.call('/api/auth/login',{method:'POST',body:{username:`unknown_${index}`,password:PASSWORD}})).status,401);
  assert.equal((await f.call('/api/auth/login',{method:'POST',body:{username:'another_name',password:PASSWORD}})).status,429);
  const requests=Array.from({length:15},(_,index)=>f.call('/api/auth/login',{method:'POST',body:{username:'shared_target',password:PASSWORD},ip:`198.51.100.${index+1}`}));
  const results=await Promise.all(requests);
  assert.equal(results.filter(result=>result.status===401).length,10);assert.equal(results.filter(result=>result.status===429).length,5);
});

test('unknown users perform the same KDF work and a different server pepper cannot verify stored credentials', async t=>{
  const db=createLocalDatabase();t.after(()=>db.close());let derives=0;
  const cryptoImpl={getRandomValues:globalThis.crypto.getRandomValues.bind(globalThis.crypto),subtle:new Proxy(globalThis.crypto.subtle,{
    get(target,property){const value=Reflect.get(target,property,target);return typeof value==='function'?(...args)=>{if(property==='deriveBits')derives++;return Reflect.apply(value,target,args);}:value;}
  })};
  const f=fixture({db,cryptoImpl});await f.signup('owner');
  derives=0;const missing=await f.call('/api/auth/login',{method:'POST',body:{username:'absent',password:PASSWORD}});assert.equal(missing.status,401);assert.equal(derives,1);
  derives=0;const wrong=await f.call('/api/auth/login',{method:'POST',body:{username:'owner',password:'incorrect password'}});assert.equal(wrong.status,401);assert.equal(derives,1);
  const other=fixture({db,secret:'A-DIFFERENT-SYNTHETIC-SECRET-32-BYTES'});
  assert.equal((await other.call('/api/auth/login',{method:'POST',body:{username:'owner',password:PASSWORD}})).status,401);
});

test('a copied single final LF or CRLF keeps existing accounts and newly created passwords on the same server key', async t=>{
  const original=fixture();t.after(()=>original.db.close());
  const owner=await original.signup('original_owner');assert.equal(owner.status,201);
  for(const [index,lineEnding]of ['\n','\r\n'].entries()){
    const copied=fixture({db:original.db,secret:SECRET+lineEnding});
    const session=await copied.call('/api/auth/session',{cookie:owner.cookie});
    assert.deepEqual(session.data,{configured:true,user:owner.data.user});
    const login=await copied.call('/api/auth/login',{method:'POST',body:{username:'original_owner',password:PASSWORD}});
    assert.equal(login.status,200);
    assert.equal((await copied.signup(`copied_owner_${index}`)).status,201);
    const unchanged=await original.call('/api/auth/login',{method:'POST',body:{username:`copied_owner_${index}`,password:PASSWORD}});
    assert.equal(unchanged.status,200);
  }
});

test('secret normalization rejects extra line content and controls, checks the normalized byte length, and preserves spaces', async t=>{
  const original=fixture();t.after(()=>original.db.close());await original.signup('owner');
  for(const secret of [`\n${SECRET}`,`${SECRET.slice(0,8)}\n${SECRET.slice(8)}`,`${SECRET}\n\n`,`${SECRET}\r\n\r\n`,
    `${SECRET}\r`,`${SECRET}\0`,`${SECRET}\t\n`,'x'.repeat(31)+'\n','x'.repeat(513)+'\r\n']){
    const invalid=fixture({db:original.db,secret});
    assert.deepEqual((await invalid.call('/api/auth/session')).data,{configured:false,user:null});
    assert.equal((await invalid.signup('blocked')).status,503);
  }
  for(const length of [32,512]){
    const boundary=fixture({db:original.db,secret:'x'.repeat(length)+'\r\n'});
    assert.deepEqual((await boundary.call('/api/auth/session')).data,{configured:true,user:null});
  }
  const spaced=fixture({db:original.db,secret:` ${SECRET} `});
  assert.deepEqual((await spaced.call('/api/auth/session')).data,{configured:true,user:null});
  assert.equal((await spaced.call('/api/auth/login',{method:'POST',body:{username:'owner',password:PASSWORD}})).status,401);
});

test('one hundred plans are enforced atomically per account, and another owner has a separate quota', async t=>{
  const f=fixture();t.after(()=>f.db.close());const alice=await f.signup('alice'),bob=await f.signup('bob','192.0.2.2');
  const requests=Array.from({length:101},(_,index)=>f.call('/api/plans',{method:'POST',cookie:alice.cookie,body:{title:`여행 ${index}`,document:doc()}}));
  const results=await Promise.all(requests);assert.equal(results.filter(result=>result.status===201).length,100);assert.equal(results.filter(result=>result.data?.error?.code==='PLAN_LIMIT').length,1);
  assert.equal((await f.call('/api/plans',{cookie:alice.cookie})).data.plans.length,100);
  assert.equal((await f.call('/api/plans',{method:'POST',cookie:bob.cookie,body:{title:'별도 여행',document:doc()}})).status,201);
});

test('invalid inputs and overlarge bodies cannot write raw routing data or user-selected owner IDs', async t=>{
  const f=fixture();t.after(()=>f.db.close());const owner=await f.signup('owner');
  for(const body of [{title:'제목',document:doc(),userId:'other'},{title:'제목',document:{...doc(),routes:[]}},{title:' ',document:doc()},
    {title:'제목',document:{version:8,itinerary:{...doc().itinerary,eventEdits:{0:{lunch:{provider:'카카오맵',routes:[]}}}}}}]){
    const result=await f.call('/api/plans',{method:'POST',cookie:owner.cookie,body});assert.equal(result.status,400);
  }
  const big=await f.call('/api/plans',{method:'POST',cookie:owner.cookie,body:'x'.repeat(280*1024)});assert.equal(big.status,413);
  const signup=await f.call('/api/auth/signup',{method:'POST',body:{username:"x' OR 1=1--",password:PASSWORD}});assert.equal(signup.status,400);
  assert.deepEqual((await f.call('/api/plans',{cookie:owner.cookie})).data.plans,[]);
});

test('missing configuration and raw database errors return fixed messages with no credentials or exception details', async t=>{
  const f=fixture({secret:undefined});t.after(()=>f.db.close());assert.deepEqual((await f.call('/api/auth/session')).data,{configured:false,user:null});assert.equal((await f.signup('owner')).status,503);
  const broken=createAccountHandler({secret:SECRET,db:{prepare(){throw new Error('PRIVATE raw SQL '+SECRET);},batch(){throw new Error('PRIVATE');}}});
  const response=await broken(new Request('https://gil.example/api/auth/login',{method:'POST',headers:{Origin:'https://gil.example','Content-Type':'application/json'},body:JSON.stringify({username:'owner',password:PASSWORD})}));
  assert.equal(response.status,500);const text=await response.text();assert.equal(text.includes('PRIVATE'),false);assert.equal(text.includes(SECRET),false);
});

test('duplicate signup does not replace another account or invalidate an existing authenticated session', async t=>{
  const f=fixture();t.after(()=>f.db.close());const signed=await f.signup('duplicate');
  const rejected=await f.call('/api/auth/signup',{method:'POST',cookie:signed.cookie,body:{username:'DUPLICATE',password:'different password'}});
  assert.equal(rejected.status,409);assert.equal((await f.call('/api/auth/session',{cookie:signed.cookie})).data.user.id,signed.data.user.id);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS total FROM gil_users').first()).total,1);
});

test('local SQLite persists across reopening and batch failures roll back preceding changes', async()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'gil-account-test-')),filename=path.join(directory,'accounts.sqlite');let db;
  try{
    db=createLocalDatabase({filename});const f=fixture({db}),owner=await f.signup('persisted');
    await f.call('/api/plans',{method:'POST',cookie:owner.cookie,body:{title:'재시작 후에도 저장',document:doc()}});db.close();
    db=createLocalDatabase({filename});assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM gil_users').first()).total,1);assert.equal((await db.prepare('SELECT title FROM gil_plans').first()).title,'재시작 후에도 저장');
    await assert.rejects(db.batch([db.prepare('DELETE FROM gil_plans'),db.prepare('INSERT INTO nonexistent_table VALUES(1)')]));
    assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM gil_plans').first()).total,1);
  }finally{db?.close();rmSync(directory,{recursive:true,force:true});}
});

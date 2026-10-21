import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppServer} from './server.mjs';
import {createPagesWorker} from './cloudflare-worker.mjs';
import {createAccountHandler} from './auth-store.mjs';
import {createLocalDatabase} from './local-db.mjs';

const secret='integration-only-secret-32-characters-long';
const document={version:8,itinerary:{cityId:'sejong',startDate:'2026-10-20',dayCount:1,
  dayAreaIds:['tour-area-8-1'],selections:{0:['tourapi-101','tourapi-102','tourapi-103']}}};

async function exercise(send,origin){
  const mutation=(method,body,cookie)=>({method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  for(const endpoint of ['/api/auth/signup','/api/auth/login'])assert.equal((await send(endpoint,mutation('POST',{username:'retired',password:'test-password-2026'}))).status,410);
  const start=await send('/api/auth/oauth/kakao/start',{redirect:'manual'});
  assert.equal(start.status,303);
  const state=new URL(start.headers.get('location')).searchParams.get('state');
  const login=await send(`/api/auth/oauth/kakao/callback?code=synthetic-code&state=${state}`,{redirect:'manual',headers:{Cookie:start.headers.getSetCookie()[0].split(';')[0]}});
  assert.equal(login.status,303);
  const sessionHeader=login.headers.getSetCookie().find(value=>value.startsWith('gil_session='));
  assert.match(sessionHeader,/HttpOnly/);
  const cookie=sessionHeader.split(';')[0];
  const created=await send('/api/plans',mutation('POST',{title:'계정 여행 노트',document},cookie));
  assert.equal(created.status,201);
  const {plan}=await created.json();
  const list=await send('/api/plans',{headers:{Cookie:cookie}});
  assert.deepEqual((await list.json()).plans.map(row=>row.title),['계정 여행 노트']);
  const unsigned=await send(`/api/plans/${plan.id}`);
  assert.equal(unsigned.status,401);
  const csrf=await send('/api/plans',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({title:'차단',document})});
  assert.equal(csrf.status,403);
  const details=await send(`/api/plans/${plan.id}`,{headers:{Cookie:cookie}});
  assert.equal((await details.json()).plan.document.itinerary.cityId,'sejong');
  const owner=(await(await send('/api/auth/session',{headers:{Cookie:cookie}})).json()).user;
  for(const path of ['/api/plans',`/api/plans/${plan.id}`]){
    for(const method of ['GET','HEAD']){
      const denied=await send(path,{method,headers:{Cookie:cookie,'X-Gil-Expected-User':'different-account-owner'}});
      assert.equal(denied.status,409);
      if(method==='GET')assert.equal((await denied.json()).error.code,'SESSION_CHANGED');
      else assert.equal(await denied.text(),'');
      const allowed=await send(path,{method,headers:{Cookie:cookie,'X-Gil-Expected-User':owner.id}});
      assert.equal(allowed.status,200);
    }
  }
  for(const [path,method,body]of [
    ['/api/plans','POST',{title:'stale tab',document}],
    [`/api/plans/${plan.id}`,'PUT',{title:'stale tab overwrite',document,revision:1}],
    [`/api/plans/${plan.id}`,'DELETE',{revision:1}]
  ]){
    const options=mutation(method,body,cookie);options.headers['X-Gil-Expected-User']='different-account-owner';
    const rejected=await send(path,options);
    assert.equal(rejected.status,409);assert.equal((await rejected.json()).error.code,'SESSION_CHANGED');
  }
  const unchanged=await send(`/api/plans/${plan.id}`,{headers:{Cookie:cookie}});
  assert.equal((await unchanged.json()).plan.revision,1);
  for(const path of ['/auth-store.mjs','/oauth-login.mjs','/oauth-login.test.mjs','/social-login-setup.md','/account-schema.sql','/local-db.mjs','/plan-document.mjs','/setup-account-db.mjs','/.local/gil.sqlite','/.local/AUTH_SECRET.txt']){
    assert.equal((await send(path)).status,404,path);
  }
  assert.equal((await send('/api/tour/areas',mutation('POST',{},cookie))).status,405);
  assert.equal((await send('/index.html',mutation('PUT',{},cookie))).status,405);
  await send('/api/auth/logout',mutation('POST',{},cookie));
  assert.equal((await (await send('/api/auth/session',{headers:{Cookie:cookie}})).json()).user,null);
}

test('Node account routes retain cookies, enforce origin and keep database files private',async t=>{
  const db=createLocalDatabase();let accountHandler;
  const server=createAppServer({accountHandler:request=>accountHandler(request)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  const origin=`http://127.0.0.1:${server.address().port}`;
  accountHandler=createAccountHandler({db,secret,oauthEnv:socialSettings(origin),fetchImpl:socialFetch});
  await exercise((path,options)=>fetch(origin+path,options),origin);
});

test('Cloudflare Worker uses its D1 binding for the same authenticated account API',async t=>{
  const db=createLocalDatabase();t.after(()=>db.close());
  const worker=createPagesWorker({authFetch:socialFetch}),origin='https://gil-test.pages.dev';
  await exercise((path,options)=>worker.fetch(new Request(origin+path,options),{DB:db,AUTH_SECRET:secret,...socialSettings(origin)}),origin);
});

test('missing deployment DB settings leave tourism intact and report account setup without secrets',async()=>{
  const worker=createPagesWorker();
  const response=await worker.fetch(new Request('https://gil-test.pages.dev/api/auth/session'),{});
  assert.deepEqual(await response.json(),{configured:false,user:null});
  assert.equal(response.headers.get('cache-control'),'no-store');
});

const socialSettings=origin=>({SOCIAL_AUTH_BASE_URL:origin,KAKAO_LOGIN_CLIENT_ID:'synthetic-client-id',KAKAO_LOGIN_CLIENT_SECRET:'synthetic-client-secret'});
async function socialFetch(url,options){
  assert.equal(options.redirect,'error');
  if(url==='https://kauth.kakao.com/oauth/token'){
    const body=new URLSearchParams(options.body);
    assert.equal(options.method,'POST');assert.equal(body.get('client_secret'),'synthetic-client-secret');
    return Response.json({access_token:'synthetic-kakao-access',token_type:'bearer'});
  }
  assert.equal(url,'https://kapi.kakao.com/v2/user/me');assert.equal(options.headers.Authorization,'Bearer synthetic-kakao-access');
  return Response.json({id:987654});
}
async function socialExercise(send,origin){
  const providers=await send('/api/auth/providers');
  assert.deepEqual((await providers.json()).providers.map(item=>item.id),['kakao']);
  const start=await send('/api/auth/oauth/kakao/start?returnTo=%2F%23%2Fnote%2Fday%2F1',{redirect:'manual'});
  assert.equal(start.status,303);
  const authorization=new URL(start.headers.get('location')),state=authorization.searchParams.get('state');
  assert.equal(authorization.searchParams.get('redirect_uri'),`${origin}/api/auth/oauth/kakao/callback`);
  const finish=await send(`/api/auth/oauth/kakao/callback?code=synthetic-code&state=${state}`,{redirect:'manual',headers:{Cookie:start.headers.getSetCookie()[0].split(';')[0]}});
  assert.equal(finish.status,303);assert.equal(finish.headers.get('location'),`${origin}/?social=success#/note/day/1`);
  const cookies=finish.headers.getSetCookie();assert.equal(cookies.length,2,'Node and Worker preserve separate state/session cookies');
  assert.ok(cookies.some(cookie=>cookie.startsWith('gil_oauth_kakao=;')));assert.ok(cookies.some(cookie=>cookie.startsWith('gil_session=')));
  const sessionCookie=cookies.find(cookie=>cookie.startsWith('gil_session=')).split(';')[0];
  const session=await send('/api/auth/session',{headers:{Cookie:sessionCookie}});
  assert.match((await session.json()).user.username,/^kakao_[0-9a-f]{16}$/);
  const logout=await send('/api/auth/logout',{method:'POST',headers:{Origin:origin,Cookie:sessionCookie,'Content-Type':'application/json'},body:'{}'});
  assert.equal(logout.status,200);
  assert.equal((await(await send('/api/auth/session',{headers:{Cookie:sessionCookie}})).json()).user,null);
}

test('Node OAuth callback emits separate state/session cookies and its session works with the existing account API',async t=>{
  const db=createLocalDatabase();let accountHandler;
  const server=createAppServer({accountHandler:request=>accountHandler(request)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  const origin=`http://127.0.0.1:${server.address().port}`;
  accountHandler=createAccountHandler({db,secret,oauthEnv:socialSettings(origin),fetchImpl:socialFetch});
  await socialExercise((path,options)=>fetch(origin+path,options),origin);
});

test('Worker OAuth uses configured secrets/D1 without serving provider tokens to the browser',async t=>{
  const db=createLocalDatabase();t.after(()=>db.close());
  const origin='https://gil-social.pages.dev',worker=createPagesWorker({authFetch:socialFetch});
  const env={DB:db,AUTH_SECRET:secret,...socialSettings(origin)};
  await socialExercise((path,options)=>worker.fetch(new Request(origin+path,options),env),origin);
  const missing={DB:db,AUTH_SECRET:secret};
  assert.deepEqual(await(await worker.fetch(new Request(origin+'/api/auth/providers'),missing)).json(),{configured:false,providers:[]});
});

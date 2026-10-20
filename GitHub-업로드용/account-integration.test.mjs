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
  const signup=await send('/api/auth/signup',mutation('POST',{username:'integration',password:'test-password-2026'}));
  assert.equal(signup.status,201);
  assert.match(signup.headers.get('set-cookie'),/HttpOnly/);
  const cookie=signup.headers.get('set-cookie').split(';')[0];
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
  for(const path of ['/auth-store.mjs','/account-schema.sql','/local-db.mjs','/plan-document.mjs','/setup-account-db.mjs','/.local/gil.sqlite','/.local/AUTH_SECRET.txt']){
    assert.equal((await send(path)).status,404,path);
  }
  assert.equal((await send('/api/tour/areas',mutation('POST',{},cookie))).status,405);
  assert.equal((await send('/index.html',mutation('PUT',{},cookie))).status,405);
  await send('/api/auth/logout',mutation('POST',{},cookie));
  assert.equal((await (await send('/api/auth/session',{headers:{Cookie:cookie}})).json()).user,null);
}

test('Node account routes retain cookies, enforce origin and keep database files private',async t=>{
  const db=createLocalDatabase(),server=createAppServer({accountHandler:createAccountHandler({db,secret})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  const origin=`http://127.0.0.1:${server.address().port}`;
  await exercise((path,options)=>fetch(origin+path,options),origin);
});

test('Cloudflare Worker uses its D1 binding for the same authenticated account API',async t=>{
  const db=createLocalDatabase();t.after(()=>db.close());
  const worker=createPagesWorker(),origin='https://gil-test.pages.dev';
  await exercise((path,options)=>worker.fetch(new Request(origin+path,options),{DB:db,AUTH_SECRET:secret}),origin);
});

test('missing deployment DB settings leave tourism intact and report account setup without secrets',async()=>{
  const worker=createPagesWorker();
  const response=await worker.fetch(new Request('https://gil-test.pages.dev/api/auth/session'),{});
  assert.deepEqual(await response.json(),{configured:false,user:null});
  assert.equal(response.headers.get('cache-control'),'no-store');
});

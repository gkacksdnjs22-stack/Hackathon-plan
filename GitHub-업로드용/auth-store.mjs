import { normalizePlanDocument, normalizePlanTitle, PlanDocumentError } from './plan-document.mjs';

const ENCODER = new TextEncoder();
const SESSION_AGE = 7 * 86400000;
const BODY_LIMIT = 270 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COOKIE = 'gil_session';
const HASH_PREFIX = 'pbkdf2-sha256-100000+hmac-v1.';
const ERRORS = {
  UNAVAILABLE:[503,'계정 저장 서비스 설정이 아직 완료되지 않았어요.'],
  BAD_REQUEST:[400,'입력한 정보의 형식을 확인해 주세요.'], INVALID_CREDENTIALS:[401,'아이디 또는 비밀번호를 확인해 주세요.'],
  USERNAME_TAKEN:[409,'이미 사용 중인 아이디예요. 다른 아이디를 입력해 주세요.'],
  AUTH_REQUIRED:[401,'로그인한 뒤 이용해 주세요.'], FORBIDDEN:[403,'현재 사이트에서 다시 시도해 주세요.'],
  RATE_LIMIT:[429,'시도 횟수가 많아요. 잠시 후 다시 시도해 주세요.'],
  NOT_FOUND:[404,'저장한 계획을 찾을 수 없어요.'], CONFLICT:[409,'다른 창이나 기기에서 변경한 계획이에요. 목록을 새로 불러와 주세요.'],
  PLAN_LIMIT:[409,'계획은 계정당 최대 100개까지 저장할 수 있어요.'],
  PAYLOAD_TOO_LARGE:[413,'저장 요청의 용량이 너무 커요.'], METHOD_NOT_ALLOWED:[405,'허용되지 않은 요청 방식입니다.'],
  INTERNAL_ERROR:[500,'저장 서비스에 일시적인 문제가 있어요. 잠시 후 다시 시도해 주세요.']
};
class AccountError extends Error {
  constructor(code) { const safe=Object.hasOwn(ERRORS,code)?code:'INTERNAL_ERROR'; super(ERRORS[safe][1]);this.code=safe;this.status=ERRORS[safe][0]; }
}
const fail = code => { throw new AccountError(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const changes = result => Number(result?.meta?.changes ?? 0);
function only(value, allowed, required = allowed) {
  if (!record(value) || Object.keys(value).some(key=>!allowed.includes(key)) || required.some(key=>!Object.hasOwn(value,key))) fail('BAD_REQUEST');
}
function b64(bytes) {
  let result='';for(const byte of bytes)result+=String.fromCharCode(byte);
  return btoa(result).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function unb64(value, size) {
  if (typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {const bytes=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),character=>character.charCodeAt(0));return bytes.length===size&&b64(bytes)===value?bytes:null;}catch{return null;}
}
function credentials(value) {
  only(value,['username','password']);
  if(typeof value.username!=='string'||! /^[A-Za-z0-9_]{3,24}$/.test(value.username)
    ||typeof value.password!=='string'||value.password.length<10||value.password.length>128)fail('BAD_REQUEST');
  return {username:value.username.toLowerCase(),password:value.password};
}
function revision(value) {if(!Number.isSafeInteger(value)||value<1||value>=Number.MAX_SAFE_INTEGER)fail('BAD_REQUEST');return value;}
async function readJson(request, maximum = BODY_LIMIT) {
  const declared=request.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum))fail('PAYLOAD_TOO_LARGE');
  const chunks=[];let size=0;
  const reader=request.body?.getReader();
  if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum){await reader.cancel();fail('PAYLOAD_TOO_LARGE');}chunks.push(value);}
  if(!size)return {};
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('BAD_REQUEST');}
  if(!record(body))fail('BAD_REQUEST');return body;
}
function mutation(request,url){
  if(request.headers.get('origin')!==url.origin||request.headers.get('sec-fetch-site')==='cross-site')fail('FORBIDDEN');
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')fail('BAD_REQUEST');
}
function metadata(row){return {id:row.id,title:row.title,cityId:row.city_id,startDate:row.start_date,dayCount:row.day_count,
  revision:row.revision,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};}
const PLAN_COLUMNS='id,title,city_id,start_date,day_count,revision,created_at,updated_at';

/** Cookie API contract: GET /api/auth/session; POST /api/auth/signup|login
 * {username,password}; POST /api/auth/logout {}. GET/POST /api/plans and
 * GET/PUT/DELETE /api/plans/:uuid use {title,document,revision?} / {revision}.
 * Lists contain metadata only; a single GET adds its canonical document.
 * Node integration must overwrite CF-Connecting-IP from its trusted socket,
 * rather than accepting the incoming browser's header.
 */
export function createAccountHandler({db,secret,cryptoImpl=globalThis.crypto,now=Date.now}={}){
  const configured=Boolean(db?.prepare&&db?.batch&&typeof secret==='string'&&ENCODER.encode(secret).byteLength>=32
    &&ENCODER.encode(secret).byteLength<=512&&!/[\u0000-\u001f\u007f]/.test(secret)&&cryptoImpl?.subtle&&cryptoImpl?.getRandomValues);
  let pepper;
  const key=()=>pepper??=(cryptoImpl.subtle.importKey('raw',ENCODER.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']));
  const random=size=>cryptoImpl.getRandomValues(new Uint8Array(size));
  const hash=async value=>b64(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',ENCODER.encode(value))));
  const hmac=async value=>b64(new Uint8Array(await cryptoImpl.subtle.sign('HMAC',await key(),ENCODER.encode(value))));
  function uuid(){const bytes=random(16);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;}
  async function derive(password,salt){
    const material=await cryptoImpl.subtle.importKey('raw',ENCODER.encode(password),'PBKDF2',false,['deriveBits']);
    const derived=new Uint8Array(await cryptoImpl.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:100000,salt},material,256));
    const prefix=ENCODER.encode('gil-password-v1\0'),message=new Uint8Array(prefix.length+derived.length);message.set(prefix);message.set(derived,prefix.length);return message;
  }
  async function passwordHash(password){
    const salt=random(16),message=await derive(password,salt);
    return {salt:b64(salt),hash:HASH_PREFIX+b64(new Uint8Array(await cryptoImpl.subtle.sign('HMAC',await key(),message)))};
  }
  async function verify(password,row){
    const salt=unb64(row?.password_salt,16),signature=typeof row?.password_hash==='string'&&row.password_hash.startsWith(HASH_PREFIX)
      ?unb64(row.password_hash.slice(HASH_PREFIX.length),32):null;
    const message=await derive(password,salt??new Uint8Array(16));
    const matched=await cryptoImpl.subtle.verify('HMAC',await key(),signature??new Uint8Array(32),message);
    return Boolean(row&&salt&&signature&&matched);
  }
  function json(request,status,body,extra={}){
    return new Response(request.method==='HEAD'?null:JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin',...extra}});
  }
  function cookie(request,token,age=SESSION_AGE/1000){return `${COOKIE}=${token}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Strict${new URL(request.url).protocol==='https:'?'; Secure':''}`;}
  function token(request){
    const values=(request.headers.get('cookie')??'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(`${COOKIE}=`));
    if(values.length!==1)return null;
    const value=values[0].slice(COOKIE.length+1);return unb64(value,32)?value:null;
  }
  async function user(request){
    const session=token(request);if(!session)return null;
    const row=await db.prepare('SELECT u.id,u.username FROM gil_sessions s JOIN gil_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').bind(await hash(session),now()).first();
    return row?{id:row.id,username:row.username}:null;
  }
  async function limit(request,username,kind){
    const time=now(),windowMs=kind==='signup'?3600000:900000,start=Math.floor(time/windowMs)*windowMs;
    const ip=(request.headers.get('cf-connecting-ip')??'unknown').slice(0,128);
    const scopes=[['ip',ip,kind==='signup'?10:30],['username',username,kind==='signup'?5:10]];
    const statements=[db.prepare('DELETE FROM gil_rate_limits WHERE window_start<?').bind(time-86400000),
      db.prepare('DELETE FROM gil_sessions WHERE expires_at<=?').bind(time)];
    for(const [scope,value,maximum]of scopes){
      const bucket=await hmac(`gil-rate-v1\0${kind}\0${scope}\0${value}`);
      statements.push(db.prepare(`INSERT INTO gil_rate_limits(bucket,window_start,attempts) VALUES(?,?,1)
        ON CONFLICT(bucket) DO UPDATE SET window_start=excluded.window_start,
        attempts=CASE WHEN gil_rate_limits.window_start=excluded.window_start THEN gil_rate_limits.attempts+1 ELSE 1 END
        WHERE gil_rate_limits.window_start<>excluded.window_start OR gil_rate_limits.attempts<?`).bind(bucket,start,maximum));
    }
    const results=await db.batch(statements);
    if(results.slice(2).some(result=>changes(result)!==1))fail('RATE_LIMIT');
  }
  async function startSession(request,owner,additional=[]){
    const value=b64(random(32)),time=now();
    const tokenHash=await hash(value);
    const statements=[...additional,db.prepare('INSERT INTO gil_sessions(token_hash,user_id,expires_at,created_at) SELECT ?,id,?,? FROM gil_users WHERE id=?')
      .bind(tokenHash,time+SESSION_AGE,time,owner.id)];
    const old=token(request);
    if(old)statements.push(db.prepare('DELETE FROM gil_sessions WHERE token_hash=? AND EXISTS(SELECT 1 FROM gil_sessions WHERE token_hash=?)').bind(await hash(old),tokenHash));
    const results=await db.batch(statements);
    if(additional.length&&changes(results[0])!==1)fail('USERNAME_TAKEN');
    if(changes(results[additional.length])!==1)fail('INTERNAL_ERROR');
    return json(request,additional.length?201:200,{user:owner},{'Set-Cookie':cookie(request,value)});
  }
  async function owned(id,owner,includeDocument=false){
    const row=await db.prepare(`SELECT ${PLAN_COLUMNS}${includeDocument?',document_json':''} FROM gil_plans WHERE id=? AND user_id=?`).bind(id,owner.id).first();
    if(!row)fail('NOT_FOUND');return row;
  }
  return async function handle(request){
    const url=new URL(request.url),path=url.pathname;
    if(!['/api/auth/session','/api/auth/signup','/api/auth/login','/api/auth/logout','/api/plans'].includes(path)&&!path.startsWith('/api/plans/'))return null;
    try{
      const id=path.startsWith('/api/plans/')?path.slice('/api/plans/'.length):null;
      const allowed=path==='/api/auth/session'?['GET','HEAD']:path.startsWith('/api/auth/')?['POST']:
        id===null?['GET','HEAD','POST']:['GET','HEAD','PUT','DELETE'];
      if(!allowed.includes(request.method))return json(request,405,{error:{code:'METHOD_NOT_ALLOWED',message:ERRORS.METHOD_NOT_ALLOWED[1]}},{Allow:allowed.join(', ')});
      if(!configured){if(path==='/api/auth/session')return json(request,200,{configured:false,user:null});fail('UNAVAILABLE');}
      if(id!==null&&!UUID.test(id))fail('BAD_REQUEST');
      if(!['GET','HEAD'].includes(request.method))mutation(request,url);
      if(path==='/api/auth/session')return json(request,200,{configured:true,user:await user(request)});
      if(path==='/api/auth/signup'||path==='/api/auth/login'){
        const input=credentials(await readJson(request,2048));
        await limit(request,input.username,path.endsWith('signup')?'signup':'login');
        if(path.endsWith('signup')){
          const password=await passwordHash(input.password),owner={id:uuid(),username:input.username};
          return await startSession(request,owner,[db.prepare('INSERT INTO gil_users(id,username,password_salt,password_hash,created_at) VALUES(?,?,?,?,?) ON CONFLICT(username) DO NOTHING')
            .bind(owner.id,owner.username,password.salt,password.hash,now())]);
        }
        const row=await db.prepare('SELECT id,username,password_salt,password_hash FROM gil_users WHERE username=?').bind(input.username).first();
        if(!await verify(input.password,row))fail('INVALID_CREDENTIALS');
        return await startSession(request,{id:row.id,username:row.username});
      }
      if(path==='/api/auth/logout'){
        const body=await readJson(request,2048);only(body,[]);
        const session=token(request);if(session)await db.prepare('DELETE FROM gil_sessions WHERE token_hash=?').bind(await hash(session)).run();
        return json(request,200,{ok:true},{'Set-Cookie':cookie(request,'',0)});
      }
      const owner=await user(request);if(!owner)fail('AUTH_REQUIRED');
      if(id===null&&['GET','HEAD'].includes(request.method)){
        const result=await db.prepare(`SELECT ${PLAN_COLUMNS} FROM gil_plans WHERE user_id=? ORDER BY updated_at DESC,id LIMIT 100`).bind(owner.id).all();
        return json(request,200,{plans:result.results.map(metadata)});
      }
      if(id!==null&&['GET','HEAD'].includes(request.method)){
        const row=await owned(id,owner,true),document=normalizePlanDocument(JSON.parse(row.document_json));
        return json(request,200,{plan:{...metadata(row),document}});
      }
      const input=await readJson(request);
      if(request.method==='DELETE'){
        only(input,['revision']);const expected=revision(input.revision);
        const result=await db.prepare('DELETE FROM gil_plans WHERE id=? AND user_id=? AND revision=?').bind(id,owner.id,expected).run();
        if(changes(result)!==1){await owned(id,owner);fail('CONFLICT');}
        return json(request,200,{ok:true});
      }
      only(input,request.method==='POST'?['title','document']:['title','document','revision']);
      const title=normalizePlanTitle(input.title),document=normalizePlanDocument(input.document),text=JSON.stringify(document),data=document.itinerary,time=now();
      if(request.method==='POST'){
        const planId=uuid();
        const result=await db.prepare(`INSERT INTO gil_plans(id,user_id,title,document_json,city_id,start_date,day_count,revision,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,1,?,? WHERE (SELECT COUNT(*) FROM gil_plans WHERE user_id=?)<100`)
          .bind(planId,owner.id,title,text,data.cityId,data.startDate,data.dayCount,time,time,owner.id).run();
        if(changes(result)!==1)fail('PLAN_LIMIT');
        return json(request,201,{plan:metadata(await owned(planId,owner))});
      }
      const expected=revision(input.revision);
      const result=await db.prepare(`UPDATE gil_plans SET title=?,document_json=?,city_id=?,start_date=?,day_count=?,revision=revision+1,updated_at=?
        WHERE id=? AND user_id=? AND revision=?`).bind(title,text,data.cityId,data.startDate,data.dayCount,time,id,owner.id,expected).run();
      if(changes(result)!==1){await owned(id,owner);fail('CONFLICT');}
      return json(request,200,{plan:metadata(await owned(id,owner))});
    }catch(error){
      const safe=error instanceof AccountError||error instanceof PlanDocumentError?error:new AccountError('INTERNAL_ERROR');
      return json(request,safe.status,{error:{code:safe.code,message:safe.message}},safe.code==='RATE_LIMIT'?{'Retry-After':'900'}:{});
    }
  };
}

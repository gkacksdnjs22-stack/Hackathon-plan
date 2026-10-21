import { normalizePlanDocument, normalizePlanTitle, PlanDocumentError } from './plan-document.mjs';
import { createSocialAuthHandler } from './oauth-login.mjs';
import { createPlanSharingHandler } from './plan-sharing.mjs';

const ENCODER = new TextEncoder();
const SESSION_AGE = 7 * 86400000;
const BODY_LIMIT = 270 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COOKIE = 'gil_session';
const ERRORS = {
  UNAVAILABLE:[503,'계정 저장 서비스 설정이 아직 완료되지 않았어요.'],
  BAD_REQUEST:[400,'입력한 정보의 형식을 확인해 주세요.'],
  LOGIN_METHOD_REMOVED:[410,'소셜 계정으로 로그인해 주세요.'],
  AUTH_REQUIRED:[401,'로그인한 뒤 이용해 주세요.'], FORBIDDEN:[403,'현재 사이트에서 다시 시도해 주세요.'],
  RATE_LIMIT:[429,'시도 횟수가 많아요. 잠시 후 다시 시도해 주세요.'],
  NOT_FOUND:[404,'저장한 계획을 찾을 수 없어요.'], CONFLICT:[409,'다른 창이나 기기에서 변경한 계획이에요. 목록을 새로 불러와 주세요.'],
  SESSION_CHANGED:[409,'다른 창에서 로그인 계정이 바뀌었어요. 현재 계정을 다시 확인한 뒤 저장해 주세요.'],
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

/** Cookie API contract: GET /api/auth/session; provider authorization-code
 * login only; POST /api/auth/logout {}. GET/POST /api/plans and
 * GET/PUT/DELETE /api/plans/:uuid use {title,document,revision?} / {revision}.
 * Lists contain metadata only; a single GET adds its canonical document.
 * Node integration must overwrite CF-Connecting-IP from its trusted socket,
 * rather than accepting the incoming browser's header.
 */
export function createAccountHandler({db,secret,oauthEnv={},fetchImpl=globalThis.fetch,cryptoImpl=globalThis.crypto,now=Date.now}={}){
  // Copying a one-line secret file can include its final line ending. Do not
  // trim spaces or any other content, which would change an existing key.
  const signingSecret=typeof secret==='string'?secret.replace(/\r?\n$/,''):secret;
  const configured=Boolean(db?.prepare&&db?.batch&&typeof signingSecret==='string'&&ENCODER.encode(signingSecret).byteLength>=32
    &&ENCODER.encode(signingSecret).byteLength<=512&&!/[\u0000-\u001f\u007f]/.test(signingSecret)&&cryptoImpl?.subtle&&cryptoImpl?.getRandomValues);
  let pepper;
  const key=()=>pepper??=(cryptoImpl.subtle.importKey('raw',ENCODER.encode(signingSecret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']));
  const random=size=>cryptoImpl.getRandomValues(new Uint8Array(size));
  const hash=async value=>b64(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',ENCODER.encode(value))));
  const hmac=async value=>b64(new Uint8Array(await cryptoImpl.subtle.sign('HMAC',await key(),ENCODER.encode(value))));
  function uuid(){const bytes=random(16);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;}
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
    const row=await db.prepare(`SELECT u.id,u.username FROM gil_sessions s JOIN gil_users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND EXISTS(SELECT 1 FROM gil_oauth_identities i WHERE i.user_id=u.id)`).bind(await hash(session),now()).first();
    return row?{id:row.id,username:row.username}:null;
  }
  async function limit(request){
    const time=now(),windowMs=900000,start=Math.floor(time/windowMs)*windowMs;
    const ip=(request.headers.get('cf-connecting-ip')??'unknown').slice(0,128);
    const statements=[db.prepare('DELETE FROM gil_rate_limits WHERE window_start<?').bind(time-86400000),
      db.prepare('DELETE FROM gil_sessions WHERE expires_at<=?').bind(time)];
    for(const [scope,value,maximum]of [['ip',ip,30]]){
      const bucket=await hmac(`gil-rate-v1\0oauth\0${scope}\0${value}`);
      statements.push(db.prepare(`INSERT INTO gil_rate_limits(bucket,window_start,attempts) VALUES(?,?,1)
        ON CONFLICT(bucket) DO UPDATE SET window_start=excluded.window_start,
        attempts=CASE WHEN gil_rate_limits.window_start=excluded.window_start THEN gil_rate_limits.attempts+1 ELSE 1 END
        WHERE gil_rate_limits.window_start<>excluded.window_start OR gil_rate_limits.attempts<?`).bind(bucket,start,maximum));
    }
    const results=await db.batch(statements);
    if(results.slice(2).some(result=>changes(result)!==1))fail('RATE_LIMIT');
  }
  async function startSession(request,owner){
    const value=b64(random(32)),time=now();
    const tokenHash=await hash(value);
    const statements=[db.prepare(`INSERT INTO gil_sessions(token_hash,user_id,expires_at,created_at) SELECT ?,id,?,? FROM gil_users
      WHERE id=? AND EXISTS(SELECT 1 FROM gil_oauth_identities i WHERE i.user_id=gil_users.id)`)
      .bind(tokenHash,time+SESSION_AGE,time,owner.id)];
    const old=token(request);
    if(old)statements.push(db.prepare('DELETE FROM gil_sessions WHERE token_hash=? AND EXISTS(SELECT 1 FROM gil_sessions WHERE token_hash=?)').bind(await hash(old),tokenHash));
    const results=await db.batch(statements);
    if(changes(results[0])!==1)fail('INTERNAL_ERROR');
    return json(request,200,{user:owner},{'Set-Cookie':cookie(request,value)});
  }
  async function owned(id,owner,includeDocument=false){
    const row=await db.prepare(`SELECT ${PLAN_COLUMNS}${includeDocument?',document_json':''} FROM gil_plans WHERE id=? AND user_id=?`).bind(id,owner.id).first();
    if(!row)fail('NOT_FOUND');return row;
  }
  const socialAuth=createSocialAuthHandler({db,env:oauthEnv,configured,cryptoImpl,now,fetchImpl,hash,hmac,uuid,startSession,limit});
  const sharing=createPlanSharingHandler({db,configured,user,hash,random,now});
  return async function handle(request){
    const url=new URL(request.url),path=url.pathname;
    // Retired endpoints never parse credentials or issue sessions, including
    // stale clients and requests received before account setup is ready.
    if(path==='/api/auth/signup'||path==='/api/auth/login')return json(request,410,{error:{code:'LOGIN_METHOD_REMOVED',message:ERRORS.LOGIN_METHOD_REMOVED[1]}});
    if(path==='/api/auth/providers'||path.startsWith('/api/auth/oauth/'))return socialAuth(request);
    if(path==='/api/shared-plan'||/^\/api\/plans\/[^/]+\/share$/.test(path))return sharing(request);
    if(!['/api/auth/session','/api/auth/logout','/api/plans'].includes(path)&&!path.startsWith('/api/plans/'))return null;
    try{
      const id=path.startsWith('/api/plans/')?path.slice('/api/plans/'.length):null;
      const allowed=path==='/api/auth/session'?['GET','HEAD']:path.startsWith('/api/auth/')?['POST']:
        id===null?['GET','HEAD','POST']:['GET','HEAD','PUT','DELETE'];
      if(!allowed.includes(request.method))return json(request,405,{error:{code:'METHOD_NOT_ALLOWED',message:ERRORS.METHOD_NOT_ALLOWED[1]}},{Allow:allowed.join(', ')});
      if(!configured){if(path==='/api/auth/session')return json(request,200,{configured:false,user:null});fail('UNAVAILABLE');}
      if(id!==null&&!UUID.test(id))fail('BAD_REQUEST');
      if(!['GET','HEAD'].includes(request.method))mutation(request,url);
      if(path==='/api/auth/session')return json(request,200,{configured:true,user:await user(request)});
      if(path==='/api/auth/logout'){
        const body=await readJson(request,2048);only(body,[]);
        const session=token(request);if(session)await db.prepare('DELETE FROM gil_sessions WHERE token_hash=?').bind(await hash(session)).run();
        return json(request,200,{ok:true},{'Set-Cookie':cookie(request,'',0)});
      }
      const owner=await user(request);if(!owner)fail('AUTH_REQUIRED');
      // This is an additional race guard, never an authorization credential.
      // A tab can still display account A while another tab replaces the
      // browser cookie with account B. Reject before exposing B's plans or
      // writing A's document under B. Legacy clients without this optional
      // header retain the existing cookie/CSRF/SQL ownership checks.
      const expectedOwner=request.headers.get('x-gil-expected-user');
      if(expectedOwner!==null&&expectedOwner!==owner.id)fail('SESSION_CHANGED');
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

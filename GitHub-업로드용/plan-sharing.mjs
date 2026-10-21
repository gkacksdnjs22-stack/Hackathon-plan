import { normalizePlanDocument, PlanDocumentError } from './plan-document.mjs';
import { validateShareSnapshot } from './share-snapshot.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BODY_LIMIT = 270000;
const ERRORS = {
  UNAVAILABLE: [503, '여행 공유 서비스 설정이 아직 완료되지 않았어요.'],
  BAD_REQUEST: [400, '공유할 여행 계획의 형식을 확인해 주세요.'],
  AUTH_REQUIRED: [401, '로그인한 뒤 이용해 주세요.'],
  FORBIDDEN: [403, '현재 사이트에서 다시 시도해 주세요.'],
  SESSION_CHANGED: [409, '다른 창에서 로그인 계정이 바뀌었어요. 현재 계정을 다시 확인해 주세요.'],
  NOT_FOUND: [404, '공유한 여행 계획을 찾을 수 없어요.'],
  CONFLICT: [409, '계획을 먼저 저장하고 최신 내용으로 다시 공유해 주세요.'],
  PAYLOAD_TOO_LARGE: [413, '공유할 내용이 너무 커요. 메모나 일정을 줄여 주세요.'],
  INTERNAL_ERROR: [500, '여행 공유에 일시적인 문제가 있어요. 잠시 후 다시 시도해 주세요.']
};
class SharingError extends Error {
  constructor(code) { super(ERRORS[code][1]); this.code = code; this.status = ERRORS[code][0]; }
}
const fail = code => { throw new SharingError(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function only(value, fields) {
  if (!record(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail('BAD_REQUEST');
}
function base64url(bytes) {
  let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function validToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), letter => letter.charCodeAt(0));
    return bytes.length === 32 && base64url(bytes) === value;
  } catch { return false; }
}
function json(request, status, body, extra = {}) {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...extra
  } });
}
function mutation(request, url) {
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') fail('FORBIDDEN');
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('BAD_REQUEST');
}
async function readJson(request, maximum = BODY_LIMIT) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) fail('PAYLOAD_TOO_LARGE');
  const chunks = []; let size = 0;
  const reader = request.body?.getReader();
  if (reader) while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel(); fail('PAYLOAD_TOO_LARGE'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = size ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : {}; }
  catch { fail('BAD_REQUEST'); }
  if (!record(value)) fail('BAD_REQUEST'); return value;
}

// Authentication remains owned by auth-store. Sharing uses that exact cookie
// owner check, including future restrictions to supported login methods.
export function createPlanSharingHandler({ db, configured, user, hash, random, now = Date.now } = {}) {
  return async function sharing(request) {
    const url = new URL(request.url), path = url.pathname;
    const match = /^\/api\/plans\/([^/]+)\/share$/.exec(path);
    const publicRead = path === '/api/shared-plan';
    if (!match && !publicRead) return null;
    try {
      const allowed = publicRead ? ['POST'] : ['GET', 'HEAD', 'POST', 'DELETE'];
      if (!allowed.includes(request.method)) return json(request, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '허용되지 않은 요청 방식입니다.' } }, { Allow: allowed.join(', ') });
      if (!configured) fail('UNAVAILABLE');
      if (!['GET', 'HEAD'].includes(request.method)) mutation(request, url);
      if (publicRead) {
        const input = await readJson(request, 2048); only(input, ['token']);
        if (!validToken(input.token)) fail('NOT_FOUND');
        const row = await db.prepare('SELECT snapshot_json,created_at FROM gil_plan_shares WHERE token_hash=?').bind(await hash(input.token)).first();
        if (!row) fail('NOT_FOUND');
        let snapshot;
        try { snapshot = validateShareSnapshot(JSON.parse(row.snapshot_json)); } catch { fail('NOT_FOUND'); }
        return json(request, 200, { snapshot, sharedAt: new Date(row.created_at).toISOString() });
      }
      const id = match[1]; if (!UUID.test(id)) fail('BAD_REQUEST');
      const owner = await user(request); if (!owner) fail('AUTH_REQUIRED');
      const expectedOwner = request.headers.get('x-gil-expected-user');
      if (expectedOwner !== null && expectedOwner !== owner.id) fail('SESSION_CHANGED');
      const plan = await db.prepare('SELECT id,title,document_json,start_date,day_count,revision FROM gil_plans WHERE id=? AND user_id=?').bind(id, owner.id).first();
      if (!plan) fail('NOT_FOUND');
      if (['GET', 'HEAD'].includes(request.method)) {
        const row = await db.prepare('SELECT revision,created_at FROM gil_plan_shares WHERE plan_id=?').bind(id).first();
        return json(request, 200, row ? { shared: true, revision: row.revision, createdAt: new Date(row.created_at).toISOString() } : { shared: false });
      }
      if (request.method === 'DELETE') {
        only(await readJson(request, 2048), []);
        await db.prepare('DELETE FROM gil_plan_shares WHERE plan_id=? AND EXISTS(SELECT 1 FROM gil_plans WHERE id=? AND user_id=?)').bind(id, id, owner.id).run();
        return json(request, 200, { ok: true });
      }
      const input = await readJson(request); only(input, ['revision', 'document', 'snapshot']);
      if (!Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision >= Number.MAX_SAFE_INTEGER) fail('BAD_REQUEST');
      const canonical = JSON.stringify(normalizePlanDocument(input.document));
      if (input.revision !== plan.revision || canonical !== plan.document_json) fail('CONFLICT');
      let snapshot;
      try { snapshot = validateShareSnapshot(input.snapshot); } catch { fail('BAD_REQUEST'); }
      if (snapshot.title !== plan.title || snapshot.startDate !== plan.start_date || snapshot.dayCount !== plan.day_count) fail('BAD_REQUEST');
      const value = base64url(random(32)), time = now();
      // The final conditional SELECT prevents a save/delete racing the initial
      // read from publishing a stale or different document. Republish replaces
      // its token in the same statement, immediately revoking the former link.
      const result = await db.prepare(`INSERT INTO gil_plan_shares(plan_id,token_hash,snapshot_json,revision,created_at)
        SELECT id,?,?,revision,? FROM gil_plans WHERE id=? AND user_id=? AND revision=? AND document_json=?
        ON CONFLICT(plan_id) DO UPDATE SET token_hash=excluded.token_hash,snapshot_json=excluded.snapshot_json,revision=excluded.revision,created_at=excluded.created_at`)
        .bind(await hash(value), JSON.stringify(snapshot), time, id, owner.id, input.revision, canonical).run();
      if (Number(result?.meta?.changes ?? 0) !== 1) fail('CONFLICT');
      return json(request, 201, { token: value, createdAt: new Date(time).toISOString(), revision: input.revision });
    } catch (error) {
      const safe = error instanceof SharingError || error instanceof PlanDocumentError ? error : new SharingError('INTERNAL_ERROR');
      return json(request, safe.status, { error: { code: safe.code, message: safe.message } });
    }
  };
}

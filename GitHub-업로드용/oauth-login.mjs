// Server-only authorization-code login. Provider tokens never reach the browser
// or database; a verified provider subject creates an independent local owner.
const ENCODER = new TextEncoder();
const STATE_AGE = 10 * 60 * 1000;
const TOKEN_LIMIT = 64 * 1024;
const PROVIDERS = Object.freeze({
  google: { label: 'Google', id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET', authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token' },
  kakao: { label: '카카오', id: 'KAKAO_LOGIN_CLIENT_ID', secret: 'KAKAO_LOGIN_CLIENT_SECRET', authorize: 'https://kauth.kakao.com/oauth/authorize', token: 'https://kauth.kakao.com/oauth/token', profile: 'https://kapi.kakao.com/v2/user/me' },
  naver: { label: '네이버', id: 'NAVER_CLIENT_ID', secret: 'NAVER_CLIENT_SECRET', authorize: 'https://nid.naver.com/oauth2.0/authorize', token: 'https://nid.naver.com/oauth2.0/token', profile: 'https://openapi.naver.com/v1/nid/me' }
});
const text = (value, max = 2048) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0020\u007f]/.test(value);
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid token');
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
  if (b64(bytes) !== value) throw new Error('Invalid token');
  return bytes;
}
const jwtJson = value => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(value)));
function baseOrigin(value) {
  if (!text(value, 256)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    return url.origin;
  } catch { return null; }
}
const returnPath = value => typeof value === 'string' && /^\/#\/(?:start|note(?:\/day\/[1-7])?)$/.test(value) ? value : null;
function browserToken(request, provider) {
  const name = `gil_oauth_${provider}=`;
  const values = (request.headers.get('cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(name));
  return values.length === 1 && opaque(values[0].slice(name.length)) ? values[0].slice(name.length) : null;
}
function stateCookie(provider, value, base, age = STATE_AGE / 1000) {
  return `gil_oauth_${provider}=${value}; Max-Age=${age}; Path=/api/auth/oauth/${provider}/callback; HttpOnly; SameSite=Lax${base.startsWith('https:') ? '; Secure' : ''}`;
}
function json(request, status, body, extra = {}) {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra
  } });
}
function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

export function createSocialAuthHandler({ db, env = {}, configured = false, cryptoImpl = globalThis.crypto, now = Date.now, fetchImpl = globalThis.fetch, hash, hmac, uuid, startSession, limit } = {}) {
  const base = baseOrigin(env.SOCIAL_AUTH_BASE_URL);
  const settings = Object.entries(PROVIDERS).flatMap(([id, provider]) => {
    const clientId = env[provider.id], clientSecret = env[provider.secret];
    return text(clientId, 512) && text(clientSecret, 1024) ? [{ ...provider, id, clientId, clientSecret }] : [];
  });
  const enabled = Boolean(configured && base && settings.length);
  const random = () => b64(cryptoImpl.getRandomValues(new Uint8Array(32)));
  const outcome = (path, value) => `${base}/?social=${value}${(returnPath(path) || '/#/start').slice(1)}`;

  // Bound every upstream response and disable redirects so a provider error can
  // never forward a client secret or bearer token to another host.
  async function upstream(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (!response.ok || !response.body) throw new Error('Provider unavailable');
      const reader = response.body.getReader(), chunks = []; let length = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > TOKEN_LIMIT) { await reader.cancel(); throw new Error('Provider response too large'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid provider response');
      return result;
    } finally { clearTimeout(timer); }
  }

  async function googleSubject(idToken, provider, nonce) {
    if (!text(idToken, 16384)) throw new Error('Invalid ID token');
    const parts = idToken.split('.'); if (parts.length !== 3) throw new Error('Invalid ID token');
    const header = jwtJson(parts[0]), claims = jwtJson(parts[1]);
    if (header.alg !== 'RS256' || !text(header.kid, 256)) throw new Error('Invalid ID token');
    const seconds = Math.floor(now() / 1000);
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)
      || claims.aud !== provider.clientId || (claims.azp !== undefined && claims.azp !== provider.clientId)
      || !Number.isSafeInteger(claims.exp) || claims.exp <= seconds || !Number.isSafeInteger(claims.iat) || claims.iat > seconds + 60
      || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds))
      || claims.nonce !== nonce || !text(claims.sub, 255)) throw new Error('Invalid ID token');
    const keySet = await upstream('https://www.googleapis.com/oauth2/v3/certs');
    if (!Array.isArray(keySet.keys) || keySet.keys.length > 20) throw new Error('Invalid signing keys');
    const matches = keySet.keys.filter(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
    if (matches.length !== 1) throw new Error('Invalid signing key');
    const key = await cryptoImpl.subtle.importKey('jwk', matches[0], { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await cryptoImpl.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), ENCODER.encode(`${parts[0]}.${parts[1]}`))) throw new Error('Invalid signature');
    return claims.sub;
  }

  async function subject(provider, code, state, stored) {
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: provider.clientId, client_secret: provider.clientSecret,
      code, redirect_uri: `${base}/api/auth/oauth/${provider.id}/callback` });
    if (provider.id === 'google') body.set('code_verifier', stored.pkce_verifier);
    if (provider.id === 'naver') body.set('state', state);
    const token = await upstream(provider.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() });
    if (token.error || !text(token.access_token, 8192) || String(token.token_type).toLowerCase() !== 'bearer') throw new Error('Invalid access token');
    if (provider.id === 'google') return googleSubject(token.id_token, provider, stored.nonce);
    const info = await upstream(provider.profile, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' } });
    if (provider.id === 'kakao') {
      // Kakao IDs are integers. Reject unsafe JSON numbers rather than rounding
      // two distinct provider identities into the same local account.
      if (!Number.isSafeInteger(info.id) || info.id < 1) throw new Error('Invalid subject');
      return String(info.id);
    }
    if (info.resultcode !== '00' || !text(info.response?.id, 255)) throw new Error('Invalid subject');
    return info.response.id;
  }

  async function ownerFor(provider, subjectId) {
    const subjectHash = await hmac(`gil-social-sub-v1\0${provider}\0${subjectId}`);
    const query = () => db.prepare('SELECT u.id,u.username FROM gil_oauth_identities i JOIN gil_users u ON u.id=i.user_id WHERE i.provider=? AND i.subject_hash=?').bind(provider, subjectHash).first();
    let owner = await query(); if (owner) return owner;
    const id = uuid(), username = `${provider}_${uuid().replace(/-/g, '').slice(0, 16)}`, time = now();
    // Both statements are one transaction. A concurrent first login for the
    // same identity observes the winner and cannot create an orphan owner.
    await db.batch([
      db.prepare(`INSERT INTO gil_users(id,username,password_salt,password_hash,created_at)
        SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM gil_oauth_identities WHERE provider=? AND subject_hash=?)`)
        .bind(id, username, random(), 'social-only-v1', time, provider, subjectHash),
      db.prepare('INSERT INTO gil_oauth_identities(provider,subject_hash,user_id,created_at) SELECT ?,?,id,? FROM gil_users WHERE id=?')
        .bind(provider, subjectHash, time, id)
    ]);
    owner = await query(); if (!owner) throw new Error('Account unavailable'); return owner;
  }

  return async function socialAuth(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path !== '/api/auth/providers' && !path.startsWith('/api/auth/oauth/')) return null;
    const match = /^\/api\/auth\/oauth\/(google|kakao|naver)\/(start|callback)$/.exec(path);
    const callback = match?.[2] === 'callback';
    const provider = settings.find(item => item.id === match?.[1]);
    const cleared = match ? [stateCookie(match[1], '', base || url.origin, 0)] : [];
    let destination = '/#/start';
    try {
      const allowed = path === '/api/auth/providers' ? ['GET', 'HEAD'] : ['GET'];
      if (!allowed.includes(request.method)) return json(request, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '허용되지 않은 요청 방식입니다.' } }, { Allow: allowed.join(', ') });
      if (path === '/api/auth/providers') {
        // A missing additive migration keeps the buttons hidden until setup is
        // complete. Local guest editing remains independent of login setup.
        if (enabled && url.origin === base) {
          await db.prepare('SELECT state_hash FROM gil_oauth_states LIMIT 1').first();
          await db.prepare('SELECT subject_hash FROM gil_oauth_identities LIMIT 1').first();
          return json(request, 200, { configured: true, providers: settings.map(({ id, label }) => ({ id, label, startUrl: `/api/auth/oauth/${id}/start` })) });
        }
        return json(request, 200, { configured: false, providers: [] });
      }
      if (!match) return json(request, 404, { error: { code: 'NOT_FOUND', message: '요청한 기능을 찾을 수 없어요.' } });
      if (!enabled || !provider || url.origin !== base) return json(request, 503, { error: { code: 'SOCIAL_UNAVAILABLE', message: '이 로그인 방식은 아직 준비 중이에요.' } });
      if (!callback) {
        // A cross-site navigation may not silently start a login in this
        // browser. Direct address-bar visits and same-origin links are allowed.
        if (['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site'))
          || (request.headers.has('origin') && request.headers.get('origin') !== base)) return json(request, 403, { error: { code: 'FORBIDDEN', message: '현재 사이트에서 다시 시도해 주세요.' } });
        if ([...url.searchParams.keys()].some(key => key !== 'returnTo') || url.searchParams.getAll('returnTo').length > 1) throw new Error('Invalid return path');
        destination = url.searchParams.has('returnTo') ? returnPath(url.searchParams.get('returnTo')) : '/#/start';
        if (!destination) throw new Error('Invalid return path');
        await limit(request, provider.id, 'oauth');
        const state = random(), browser = random(), nonce = random(), verifier = random(), time = now();
        await db.batch([
          db.prepare('DELETE FROM gil_oauth_states WHERE expires_at<=?').bind(time),
          db.prepare('INSERT INTO gil_oauth_states(state_hash,provider,browser_hash,return_to,nonce,pkce_verifier,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)')
            .bind(await hash(state), provider.id, await hash(browser), destination, nonce, verifier, time + STATE_AGE, time)
        ]);
        const authorization = new URL(provider.authorize);
        authorization.search = new URLSearchParams({ response_type: 'code', client_id: provider.clientId, redirect_uri: `${base}/api/auth/oauth/${provider.id}/callback`, state });
        if (provider.id === 'google') {
          authorization.searchParams.set('scope', 'openid'); authorization.searchParams.set('nonce', nonce);
          authorization.searchParams.set('code_challenge', await hash(verifier)); authorization.searchParams.set('code_challenge_method', 'S256');
        }
        return redirect(authorization.href, [stateCookie(provider.id, browser, base)]);
      }
      const state = url.searchParams.get('state'), browser = browserToken(request, provider.id);
      if (url.searchParams.getAll('state').length !== 1 || !opaque(state) || !browser) throw new Error('Invalid state');
      // DELETE RETURNING atomically consumes the state before any network work,
      // including provider denial, and prevents concurrent/replayed callbacks.
      const stored = await db.prepare(`DELETE FROM gil_oauth_states WHERE state_hash=? AND provider=? AND browser_hash=? AND expires_at>? RETURNING return_to,nonce,pkce_verifier`)
        .bind(await hash(state), provider.id, await hash(browser), now()).first();
      if (!stored || !returnPath(stored.return_to)) throw new Error('Expired state');
      destination = stored.return_to;
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || url.searchParams.getAll('code').length !== 1 || !text(code, 4096)) throw new Error('Authorization failed');
      const owner = await ownerFor(provider.id, await subject(provider, code, state, stored));
      const session = await startSession(request, owner);
      if (!session.ok) throw new Error('Account unavailable');
      return redirect(outcome(destination, 'success'), [...cleared, ...session.headers.getSetCookie()]);
    } catch (error) {
      if (callback && enabled && url.origin === base) return redirect(outcome(destination, 'failed'), cleared);
      if (path === '/api/auth/providers') return json(request, 200, { configured: false, providers: [] });
      const limited = error?.code === 'RATE_LIMIT';
      return json(request, limited ? 429 : 400, { error: { code: limited ? 'RATE_LIMIT' : 'SOCIAL_LOGIN_FAILED', message: limited ? '시도 횟수가 많아요. 잠시 후 다시 시도해 주세요.' : '소셜 로그인을 시작하지 못했어요. 현재 사이트에서 다시 시도해 주세요.' } }, limited ? { 'Retry-After': '900' } : {});
    }
  };
}

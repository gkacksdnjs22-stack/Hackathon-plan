import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDatabase } from './local-db.mjs';
import { createAccountHandler } from './auth-store.mjs';

const BASE = 'https://gil.example';
const SECRET = 'SYNTHETIC-SOCIAL-SERVER-SECRET-FOR-TESTS-ONLY';
const ENV = { SOCIAL_AUTH_BASE_URL: BASE, GOOGLE_CLIENT_ID: 'google-test-client', GOOGLE_CLIENT_SECRET: 'google-test-secret',
  KAKAO_LOGIN_CLIENT_ID: 'kakao-test-client', KAKAO_LOGIN_CLIENT_SECRET: 'kakao-test-secret', NAVER_CLIENT_ID: 'naver-test-client', NAVER_CLIENT_SECRET: 'naver-test-secret' };
const b64 = value => Buffer.from(value).toString('base64url');
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'synthetic-signing-key', alg: 'RS256', use: 'sig' };
const document = () => ({ version: 8, itinerary: { cityId: 'seoul', startDate: '2026-10-21', dayCount: 1, dayAreaIds: ['tour-cluster-1'], selections: { 0: ['tourapi-1', 'tourapi-2', 'tourapi-3'] } } });

function fixture(t, options = {}) {
  const db = createLocalDatabase(); t.after(() => db.close());
  let clock = Date.UTC(2026, 9, 21), calls = [], overrides = {}, tokenClaims = new Map();
  const profile = { kakao: { id: 123456, kakao_account: { email: 'same@example.com' } }, naver: { resultcode: '00', response: { id: '123456', email: 'same@example.com' } } };
  async function signedToken(claims, header = {}) {
    const encoded = `${b64(JSON.stringify({ alg: 'RS256', kid: jwk.kid, ...header }))}.${b64(JSON.stringify(claims))}`;
    return `${encoded}.${b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(encoded)))}`;
  }
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    if (overrides[url]) return overrides[url](init);
    const form = new URLSearchParams(init.body);
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = { iss: 'https://accounts.google.com', aud: ENV.GOOGLE_CLIENT_ID, sub: '123456', exp: Math.floor(clock / 1000) + 3600, iat: Math.floor(clock / 1000), ...tokenClaims.get(form.get('code')) };
      return Response.json({ access_token: 'synthetic-google-token', token_type: 'Bearer', id_token: await signedToken(claims) });
    }
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    if (url === 'https://kauth.kakao.com/oauth/token' || url === 'https://nid.naver.com/oauth2.0/token') return Response.json({ access_token: 'synthetic-provider-token', refresh_token: 'synthetic-refresh-token', token_type: 'bearer' });
    if (url === 'https://kapi.kakao.com/v2/user/me') return Response.json(profile.kakao);
    if (url === 'https://openapi.naver.com/v1/nid/me') return Response.json(profile.naver);
    throw new Error('Unexpected upstream endpoint');
  }
  const handle = createAccountHandler({ db, secret: SECRET, oauthEnv: ENV, now: () => clock, fetchImpl, ...options });
  async function call(path, { method = 'GET', cookie, headers = {}, body, base = BASE } = {}) {
    const response = await handle(new Request(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers,
      ...(body ? { Origin: base, 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const responseText = await response.clone().text();
    const serialized = responseText + [...response.headers].map(pair => pair.join(':')).join('\n');
    for (const secret of [SECRET, ENV.GOOGLE_CLIENT_SECRET, ENV.KAKAO_LOGIN_CLIENT_SECRET, ENV.NAVER_CLIENT_SECRET, 'synthetic-provider-token', 'synthetic-refresh-token']) assert.equal(serialized.includes(secret), false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { response, status: response.status, data: responseText ? JSON.parse(responseText) : null, location: response.headers.get('location'), cookies: response.headers.getSetCookie() };
  }
  async function start(provider = 'google', returnTo = '/#/note/day/2', opts = {}) {
    const result = await call(`/api/auth/oauth/${provider}/start?returnTo=${encodeURIComponent(returnTo)}`, opts);
    return { ...result, provider, auth: result.location ? new URL(result.location) : null, cookie: result.cookies[0]?.split(';')[0] };
  }
  async function complete(started, { code = `synthetic-code-${crypto.randomUUID()}`, claims = {}, cookie = started.cookie, state = started.auth?.searchParams.get('state'), suffix = '', ...opts } = {}) {
    tokenClaims.set(code, { nonce: started.auth?.searchParams.get('nonce'), ...claims });
    return call(`/api/auth/oauth/${started.provider}/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}${suffix}`, { cookie, ...opts });
  }
  const sessionCookie = result => result.cookies.find(cookie => cookie.startsWith('gil_session='))?.split(';')[0];
  const who = async result => (await call('/api/auth/session', { cookie: sessionCookie(result) })).data.user;
  return { db, call, start, complete, who, sessionCookie, signedToken, profile, calls, overrides, advance: ms => { clock += ms; } };
}

test('provider discovery exposes only complete configured providers, never credentials or an unregistered request origin', async t => {
  const f = fixture(t);
  const result = await f.call('/api/auth/providers');
  assert.deepEqual(result.data, { configured: true, providers: [
    { id: 'google', label: 'Google', startUrl: '/api/auth/oauth/google/start' },
    { id: 'kakao', label: '카카오', startUrl: '/api/auth/oauth/kakao/start' },
    { id: 'naver', label: '네이버', startUrl: '/api/auth/oauth/naver/start' }
  ] });
  assert.deepEqual((await f.call('/api/auth/providers', { base: 'https://untrusted.example' })).data, { configured: false, providers: [] });
  assert.equal((await f.call('/api/auth/providers', { method: 'HEAD' })).data, null);
  const partial = fixture(t, { oauthEnv: { ...ENV, GOOGLE_CLIENT_SECRET: '', NAVER_CLIENT_ID: '' } });
  assert.deepEqual((await partial.call('/api/auth/providers')).data.providers.map(provider => provider.id), ['kakao']);
});

test('missing settings and non-origin, insecure or credentialed deployment URLs disable social login without disabling password accounts', async t => {
  for (const value of ['', 'http://gil.example', 'https://gil.example/path', 'https://gil.example?bad=1', 'https://gil.example/#bad', 'https://user:password@gil.example', ' https://gil.example']) {
    const f = fixture(t, { oauthEnv: { ...ENV, SOCIAL_AUTH_BASE_URL: value } });
    assert.deepEqual((await f.call('/api/auth/providers')).data, { configured: false, providers: [] });
    assert.equal((await f.start()).status, 503);
    assert.equal((await f.call('/api/auth/session')).data.configured, true);
  }
  const missing = fixture(t, { secret: '' });
  assert.equal((await missing.call('/api/auth/providers')).data.configured, false);
});

test('a missing social migration safely hides its buttons while existing password login remains usable', async t => {
  const f = fixture(t);
  await f.call('/api/auth/signup', { method: 'POST', body: { username: 'password_owner', password: 'synthetic-password-2026' } });
  await f.db.prepare('DROP TABLE gil_oauth_states').run();
  assert.deepEqual((await f.call('/api/auth/providers')).data, { configured: false, providers: [] });
  assert.equal((await f.call('/api/auth/login', { method: 'POST', body: { username: 'password_owner', password: 'synthetic-password-2026' } })).status, 200);
});

test('Google authorization uses one-time browser state, nonce and S256 PKCE with a registered callback and minimal scope', async t => {
  const f = fixture(t), started = await f.start();
  assert.equal(started.status, 303); assert.equal(started.auth.origin, 'https://accounts.google.com');
  const params = started.auth.searchParams;
  assert.equal(params.get('redirect_uri'), `${BASE}/api/auth/oauth/google/callback`); assert.equal(params.get('scope'), 'openid');
  assert.equal(params.get('code_challenge_method'), 'S256'); assert.match(params.get('state'), /^[A-Za-z0-9_-]{43}$/); assert.match(params.get('nonce'), /^[A-Za-z0-9_-]{43}$/);
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=600', 'Path=/api/auth/oauth/google/callback']) assert.ok(started.cookies[0].includes(attribute));
  const state = await f.db.prepare('SELECT * FROM gil_oauth_states').first();
  assert.notEqual(state.state_hash, params.get('state')); assert.equal(state.return_to, '/#/note/day/2');
  assert.equal(params.get('code_challenge'), b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state.pkce_verifier))));
  assert.equal(f.calls.length, 0);
});

test('a valid signed Google ID token creates an OAuth-only owner and private Strict session while clearing state', async t => {
  const f = fixture(t), started = await f.start(), stored = await f.db.prepare('SELECT * FROM gil_oauth_states').first(), finished = await f.complete(started);
  assert.equal(finished.location, `${BASE}/?social=success#/note/day/2`); assert.equal(finished.cookies.length, 2);
  assert.ok(finished.cookies.find(cookie => cookie.startsWith('gil_session=')).includes('SameSite=Strict'));
  assert.ok(finished.cookies.find(cookie => cookie.startsWith('gil_oauth_google=')).includes('Max-Age=0'));
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM gil_oauth_states').first('n'), 0);
  const owner = await f.who(finished); assert.match(owner.username, /^google_[0-9a-f]{16}$/);
  const user = await f.db.prepare('SELECT * FROM gil_users').first(); assert.equal(user.password_hash, 'social-only-v1');
  const identity = await f.db.prepare('SELECT * FROM gil_oauth_identities').first(); assert.equal(identity.provider, 'google'); assert.notEqual(identity.subject_hash, '123456');
  const exchange = new URLSearchParams(f.calls[0].init.body); assert.equal(exchange.get('code_verifier'), stored.pkce_verifier);
  assert.equal(exchange.get('client_secret'), ENV.GOOGLE_CLIENT_SECRET);
  for (const call of f.calls) { assert.equal(call.init.redirect, 'error'); assert.equal(call.init.cache, 'no-store'); assert.ok(call.init.signal); }
  assert.equal((await f.call('/api/auth/login', { method: 'POST', body: { username: owner.username, password: 'synthetic-password-2026' } })).status, 401);
});

test('Kakao and NAVER exchange codes server-side and identify users only with verified profile IDs', async t => {
  const f = fixture(t);
  for (const provider of ['kakao', 'naver']) {
    const started = await f.start(provider, '/#/start');
    assert.equal(started.auth.searchParams.get('scope'), null); assert.equal(started.auth.searchParams.get('nonce'), null);
    const finished = await f.complete(started), owner = await f.who(finished);
    assert.ok(owner.username.startsWith(`${provider}_`)); assert.equal(finished.location, `${BASE}/?social=success#/start`);
    const tokenRequest = f.calls.find(call => call.url === (provider === 'kakao' ? 'https://kauth.kakao.com/oauth/token' : 'https://nid.naver.com/oauth2.0/token'));
    assert.equal(tokenRequest.init.method, 'POST'); assert.equal(new URLSearchParams(tokenRequest.init.body).get('redirect_uri'), `${BASE}/api/auth/oauth/${provider}/callback`);
    if (provider === 'naver') assert.equal(new URLSearchParams(tokenRequest.init.body).get('state'), started.auth.searchParams.get('state'));
  }
  const dump = JSON.stringify((await f.db.prepare('SELECT * FROM gil_oauth_identities').all()).results) + JSON.stringify((await f.db.prepare('SELECT * FROM gil_users').all()).results);
  for (const forbidden of ['same@example.com', 'synthetic-provider-token', 'synthetic-refresh-token']) assert.equal(dump.includes(forbidden), false);
});

test('same-provider repeat login reuses its owner, but equal IDs or emails across providers never merge accounts or expose plans', async t => {
  const f = fixture(t), password = await f.call('/api/auth/signup', { method: 'POST', body: { username: 'password_owner', password: 'synthetic-password-2026' } });
  const first = await f.complete(await f.start('google')), repeated = await f.complete(await f.start('google'));
  assert.equal((await f.who(first)).id, (await f.who(repeated)).id);
  const kakao = await f.complete(await f.start('kakao')), naver = await f.complete(await f.start('naver'));
  const owner = await f.who(first), other = await f.who(kakao), third = await f.who(naver);
  assert.equal(new Set([owner.id, other.id, third.id, password.data.user.id]).size, 4);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM gil_users').first('n'), 4);
  const saved = await f.call('/api/plans', { method: 'POST', cookie: f.sessionCookie(first), body: { title: 'private social plan', document: document() } });
  assert.equal(saved.status, 201);
  for (const result of [kakao, naver]) {
    assert.deepEqual((await f.call('/api/plans', { cookie: f.sessionCookie(result) })).data.plans, []);
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await f.call(`/api/plans/${saved.data.plan.id}`, { method, cookie: f.sessionCookie(result),
        ...(method === 'PUT' ? { body: { title: 'overwrite', document: document(), revision: 1 } } : method === 'DELETE' ? { body: { revision: 1 } } : {}) });
      assert.equal(response.status, 404);
    }
  }
});

test('concurrent first logins for one verified identity create one owner without orphan users', async t => {
  const f=fixture(t), first=await f.start('kakao'), second=await f.start('kakao');
  const results=await Promise.all([f.complete(first),f.complete(second)]);
  assert.ok(results.every(result=>result.location.includes('social=success')));
  assert.equal((await f.who(results[0])).id,(await f.who(results[1])).id);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM gil_users').first('n'),1);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM gil_oauth_identities').first('n'),1);
});

test('callback requires a unique matching state and browser cookie; wrong-browser login CSRF never reaches providers', async t => {
  const f = fixture(t), started = await f.start();
  for (const cookie of [undefined, 'gil_oauth_google=malformed', `gil_oauth_google=${'A'.repeat(43)}`, `${started.cookie}; ${started.cookie}`]) {
    const denied = await f.complete(started, { cookie: cookie || '' }); assert.equal(denied.location, `${BASE}/?social=failed#/start`);
  }
  assert.equal((await f.complete(started, { suffix: `&state=${started.auth.searchParams.get('state')}` })).location, `${BASE}/?social=failed#/start`);
  assert.equal(f.calls.length, 0); assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM gil_users').first('n'), 0);
  assert.equal((await f.complete(started)).location, `${BASE}/?social=success#/note/day/2`);
});

test('state is consumed once atomically, including parallel callbacks, expiration and user cancellation', async t => {
  const f = fixture(t), started = await f.start('kakao');
  const responses = await Promise.all([f.complete(started), f.complete(started)]);
  assert.equal(responses.filter(result => result.location.includes('social=success')).length, 1);
  assert.equal(f.calls.filter(call => call.url === 'https://kauth.kakao.com/oauth/token').length, 1);
  const expired = await f.start('naver'); f.advance(600000);
  assert.ok((await f.complete(expired)).location.includes('social=failed'));
  const cancelled = await f.start('naver');
  const denial = await f.call(`/api/auth/oauth/naver/callback?state=${cancelled.auth.searchParams.get('state')}&error=access_denied&error_description=RAW_PRIVATE_ERROR`, { cookie: cancelled.cookie });
  assert.equal(denial.location, `${BASE}/?social=failed#/note/day/2`); assert.equal(denial.location.includes('RAW_PRIVATE_ERROR'), false);
  assert.ok((await f.complete(cancelled)).location.includes('social=failed'));
});

test('provider mix-up, missing/duplicated code, token endpoint failure and token type tampering cannot create sessions', async t => {
  const f = fixture(t), google = await f.start('google'), naver = await f.start('naver');
  assert.ok((await f.complete({ ...naver, auth: google.auth })).location.includes('social=failed'));
  for (const suffix of ['&code=duplicate', '&error=access_denied']) assert.ok((await f.complete(await f.start('kakao'), { suffix })).location.includes('social=failed'));
  const missing = await f.start('kakao');
  assert.ok((await f.call(`/api/auth/oauth/kakao/callback?state=${missing.auth.searchParams.get('state')}`, { cookie: missing.cookie })).location.includes('social=failed'));
  f.overrides['https://kauth.kakao.com/oauth/token'] = () => Response.json({ access_token: 'synthetic-provider-token', token_type: 'other' });
  assert.ok((await f.complete(await f.start('kakao'))).location.includes('social=failed'));
  f.overrides['https://kauth.kakao.com/oauth/token'] = () => new Response('RAW_PROVIDER_SECRET_ERROR', { status: 502 });
  assert.ok((await f.complete(await f.start('kakao'))).location.includes('social=failed'));
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM gil_users').first('n'), 0);
});

test('Google rejects wrong issuer, audience, nonce, expiry, timestamps and missing or malformed subjects', async t => {
  const f = fixture(t);
  for (const claims of [{ iss: 'https://attacker.example' }, { aud: 'another-client' }, { aud: [ENV.GOOGLE_CLIENT_ID, 'another-client'] }, { azp: 'another-client' },
    { nonce: 'wrong' }, { exp: Math.floor(Date.UTC(2026, 9, 21) / 1000) }, { exp: 'forever' }, { iat: Math.floor(Date.UTC(2026, 9, 22) / 1000) },
    { nbf: Math.floor(Date.UTC(2026, 9, 22) / 1000) }, { sub: '' }, { sub: null }]) {
    assert.ok((await f.complete(await f.start('google'), { claims })).location.includes('social=failed'), JSON.stringify(claims));
  }
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM gil_users').first('n'), 0);
});

test('Google signature, algorithm and signing-key substitution are rejected', async t => {
  const f = fixture(t);
  for (const kind of ['signature', 'algorithm', 'kid']) {
    const started = await f.start();
    const token = await f.signedToken({ iss: 'https://accounts.google.com', aud: ENV.GOOGLE_CLIENT_ID, sub: '123456', nonce: started.auth.searchParams.get('nonce'), iat: Math.floor(Date.UTC(2026, 9, 21) / 1000), exp: Math.floor(Date.UTC(2026, 9, 22) / 1000) }, kind === 'algorithm' ? { alg: 'HS256' } : kind === 'kid' ? { kid: 'attacker-key' } : {});
    f.overrides['https://oauth2.googleapis.com/token'] = () => Response.json({ access_token: 'synthetic-google-token', token_type: 'bearer', id_token: kind === 'signature' ? `${token.slice(0, -10)}${'A'.repeat(10)}` : token });
    assert.ok((await f.complete(started)).location.includes('social=failed'));
  }
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM gil_users').first('n'), 0);
});

test('Kakao unsafe IDs and NAVER failed or missing IDs never become local identities', async t => {
  const f = fixture(t);
  for (const id of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, '123456', null]) {
    f.profile.kakao.id = id; assert.ok((await f.complete(await f.start('kakao'))).location.includes('social=failed'));
  }
  for (const response of [{ resultcode: '01', response: { id: '123456' } }, { resultcode: '00', response: { email: 'same@example.com' } }, { resultcode: '00', response: { id: '' } }]) {
    f.profile.naver = response; assert.ok((await f.complete(await f.start('naver'))).location.includes('social=failed'));
  }
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM gil_oauth_identities').first('n'), 0);
});

test('start rejects cross-site initiation, external or malformed return locations and untrusted Host without a provider request', async t => {
  const f = fixture(t);
  for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'https://attacker.example' }]) assert.equal((await f.start('google', '/#/start', { headers })).status, 403);
  for (const path of ['//attacker.example', 'https://attacker.example', '/?next=bad#/start', '/#/note/day/8', '/#/note/day/1?next=https://attacker.example', '/#\\evil', '/sources.html']) assert.equal((await f.start('google', path)).status, 400);
  assert.equal((await f.start('google', '/#/start', { base: 'https://attacker.example' })).status, 503);
  assert.equal((await f.call('/api/auth/oauth/google/start?returnTo=%2F%23%2Fstart&returnTo=%2F%23%2Fnote')).status, 400);
  assert.equal((await f.call('/api/auth/oauth/google/start?redirect_uri=https://attacker.example')).status, 400);
  assert.equal(f.calls.length, 0);
});

test('GET-only OAuth endpoints reject POST and HEAD without consuming state, and unknown providers are unavailable', async t => {
  const f = fixture(t), started = await f.start('kakao');
  for (const method of ['POST', 'HEAD']) {
    assert.equal((await f.call('/api/auth/oauth/kakao/start', { method })).status, 405);
    assert.equal((await f.complete(started, { method })).status, 405);
  }
  assert.equal((await f.call('/api/auth/oauth/attacker/start')).status, 404);
  assert.ok((await f.complete(started)).location.includes('social=success'));
});

test('start rates are durable per IP, not a shared provider-wide username limit', async t => {
  const f = fixture(t);
  for (let index = 0; index < 30; index++) assert.equal((await f.start('google', '/#/start', { headers: { 'CF-Connecting-IP': '192.0.2.1' } })).status, 303);
  assert.equal((await f.start('google', '/#/start', { headers: { 'CF-Connecting-IP': '192.0.2.1' } })).status, 429);
  for (let index = 0; index < 12; index++) assert.equal((await f.start('google', '/#/start', { headers: { 'CF-Connecting-IP': `198.51.100.${index + 1}` } })).status, 303);
});

test('provider response size limits, invalid JSON and network errors fail generically and cannot retain a replayable state', async t => {
  const f = fixture(t);
  for (const override of [() => new Response('x'.repeat(65537)), () => new Response('not JSON'), () => { throw new Error('private upstream failure'); }]) {
    f.overrides['https://nid.naver.com/oauth2.0/token'] = override;
    const started = await f.start('naver'), finished = await f.complete(started);
    assert.equal(finished.location, `${BASE}/?social=failed#/note/day/2`);
    assert.equal((await f.complete(started)).location, `${BASE}/?social=failed#/start`);
  }
});

test('explicit localhost origin supports non-Secure development cookies but does not trust an alternate loopback origin', async t => {
  const base = 'http://localhost:3000', f = fixture(t, { oauthEnv: { ...ENV, SOCIAL_AUTH_BASE_URL: base } });
  assert.equal((await f.call('/api/auth/providers', { base })).data.configured, true);
  const started = await f.start('kakao', '/#/start', { base });
  assert.equal(started.status, 303); assert.equal(started.cookies[0].includes('Secure'), false);
  assert.equal(started.auth.searchParams.get('redirect_uri'), `${base}/api/auth/oauth/kakao/callback`);
  assert.equal((await f.call('/api/auth/providers', { base: 'http://127.0.0.1:3000' })).data.configured, false);
});

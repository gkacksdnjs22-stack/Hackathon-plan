import { test as base, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function watchPageHealth(page, issues, expectedScriptFailures = new Set()) {
  page.on('pageerror', error => issues.push(`pageerror: ${error.message}`));
  page.on('response', response => {
    if (response.request().resourceType() === 'script' && !response.ok()) issues.push(`script ${response.status()}: ${new URL(response.url()).pathname}`);
  });
  page.on('requestfailed', request => {
    const pathname = new URL(request.url()).pathname;
    if (request.resourceType() === 'script' && !expectedScriptFailures.has(pathname)) issues.push(`script failed: ${pathname}`);
  });
}

async function isolatePage(page, baseURL, identity, issues, expectedScriptFailures) {
  watchPageHealth(page, issues, expectedScriptFailures);
  // The isolated browser must never call actual providers, maps or tourism APIs.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === baseURL && url.pathname === '/api/auth/oauth/kakao/start') {
      // The browser never makes even an initial request to a real provider.
      const started = await route.fetch({ maxRedirects: 0 });
      expect(started.status()).toBe(303);
      const authorization = new URL(started.headers().location);
      expect(authorization.origin).toBe('https://kauth.kakao.com');
      const callback = new URL('/api/auth/oauth/kakao/callback', baseURL);
      callback.searchParams.set('state', authorization.searchParams.get('state') || '');
      callback.searchParams.set('code', `browser-scenario-${identity.account}`);
      return route.fulfill({ response: started, headers: { ...started.headers(), location: callback.href } });
    }
    if (url.origin === baseURL || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    issues.push(`unexpected external request: ${url.origin}${url.pathname}`);
    return route.abort();
  });
}

const test = base.extend({
  socialIdentity: async ({}, use) => { await use({ account: 1 }); },
  expectedScriptFailures: async ({}, use) => { await use(new Set()); },
  browserHealth: [async ({ page, baseURL, socialIdentity, expectedScriptFailures }, use) => {
    const issues = [];
    await isolatePage(page, baseURL, socialIdentity, issues, expectedScriptFailures);
    await use(issues);
    expect(issues, 'No runtime errors or missing JavaScript may be hidden by a working shell').toEqual([]);
  }, { auto: true }]
});

async function createNote(page, days = 2, preferences = []) {
  await page.goto('/#/start');
  await expect(page.locator('#city-select')).toBeEnabled();
  await expect(page.locator('#day-count')).toBeEnabled();
  await page.locator('#day-count').selectOption(String(days));
  for (const [value, label] of [['nature', '자연'], ['culture', '문화'], ['rest', '휴식']]) {
    await page.locator('#travel-preferences').getByLabel(label, { exact: true }).setChecked(preferences.includes(value));
  }
  await page.getByRole('button', { name: '추천으로 시작하기' }).click();
  await expect(page.locator('#itinerary-section')).toBeVisible();
  await expect(page.locator('#travel-day-0 .event-title').filter({ hasText: '합성' })).toHaveCount(3);
}

async function editFirstPlace(page, memo, minutes = 90) {
  await closeToolDialog(page);
  const card = page.locator('.day-card:visible');
  await card.getByRole('button', { name: /체류시간과 메모 수정/ }).first().click();
  const editor = card.locator('.event-editor');
  await editor.getByLabel('설명·메모').fill(memo);
  await editor.getByLabel('소요시간 (분)').fill(String(minutes));
  await editor.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect(card.locator('.event-description').filter({ hasText: memo })).toBeVisible();
}

async function socialLogin(page) {
  await page.locator('#account-nav').getByRole('button', { name: /로그인/ }).click();
  await page.getByRole('button', { name: /카카오/ }).click();
  await expect(page.locator('#account-nav').getByRole('button', { name: '로그아웃' })).toBeVisible();
}

async function saveAccountNote(page, title) {
  await closeToolDialog(page);
  await page.locator('#account-save').getByRole('button', { name: /^(계획표 저장|변경사항 저장)$/ }).click();
  await page.getByLabel('계획표 이름').fill(title);
  await page.getByRole('dialog').getByRole('button', { name: /^(계정에 저장|변경사항 저장)$/ }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('#account-save').getByRole('button', { name: '변경사항 저장', exact: true })).toBeVisible();
}

const toolGroupNames = /^(공유·보관|일정 점검|여행 준비|지도)$/;
async function closeToolDialog(page) {
  const dialog = page.getByRole('dialog', { name: toolGroupNames });
  if (await dialog.isVisible()) { await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); }
}
async function openTool(page, id) {
  const group = ['note-sharing', 'offline-tools', 'note-export'].includes(id) ? '공유·보관'
    : ['pending-transfers', 'visit-order-tools', 'operating-tools'].includes(id) ? '일정 점검'
    : id === 'personal-tools' ? '여행 준비' : '지도';
  const dialog = page.getByRole('dialog', { name: group, exact: true });
  if (!await dialog.isVisible()) {
    await closeToolDialog(page);
    await page.locator('#note-toolbar').getByRole('button', { name: group, exact: true }).click();
  }
  await expect(dialog).toBeVisible();
  await expect(page.locator(`#${id}`)).toBeVisible();
}

async function assertToolHeadings(page) {
  for (const [id, title, action] of [
    ['note-sharing', '읽기 전용 공유 링크', '공유 내용 미리보기'],
    ['offline-tools', '오프라인 여행 노트', '오프라인으로 저장'],
    ['visit-order-tools', '방문 순서 제안', '순서 비교'],
    ['operating-tools', '운영시간·휴무 확인', '운영정보 확인']
  ]) {
    const host = page.locator(`#${id}`);
    await expect(host.locator(':scope > summary'), `${id} must not show the browser's generic details title or duplicate headings`).toHaveCount(1);
    await expect(host.locator(':scope > summary')).toHaveText(title);
    // The title alone cannot mask an interrupted startup: each tool must also
    // have its mounted action, even when the details element is collapsed.
    await expect(host.getByRole('button', { name: action, exact: true, includeHidden: true })).toHaveCount(1);
  }
}

test('create → edit → reload → reopen preserves local note and independent DAY pages', async ({ page, context }) => {
  await createNote(page);
  await assertToolHeadings(page);
  await editFirstPlace(page, '첫째 날에만 남긴 브라우저 검증 메모');
  await page.locator('#day-bookmarks-bottom').getByRole('button', { name: /^2일차/ }).click();
  await expect(page).toHaveURL(/#\/note\/day\/2$/);
  await expect(page.locator('#travel-day-0')).toBeHidden();
  await expect(page.locator('#travel-day-1')).toBeVisible();
  await expect(page.locator('#day-bookmarks .day-bookmark').nth(1)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#day-bookmarks-bottom .day-bookmark').nth(1)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#travel-day-1')).not.toContainText('첫째 날에만 남긴 브라우저 검증 메모');
  await assertToolHeadings(page);
  await page.reload();
  await expect(page.locator('#travel-day-1')).toBeVisible();
  await assertToolHeadings(page);
  await page.locator('#day-bookmarks').getByRole('button', { name: /^1일차/ }).click();
  await expect(page.locator('#travel-day-0')).toContainText('첫째 날에만 남긴 브라우저 검증 메모');

  // A new tab has fresh page memory but the same isolated origin storage.
  const reopened = await context.newPage();
  const errors = [];
  reopened.on('pageerror', error => errors.push(error.message));
  await reopened.goto('/#/note/day/1');
  await expect(reopened.locator('#travel-day-0')).toContainText('첫째 날에만 남긴 브라우저 검증 메모');
  await assertToolHeadings(reopened);
  expect(errors).toEqual([]);
  await reopened.close();
});

test('missing optional tool scripts leave no generic blank details and keep the editable note usable', async ({ page, expectedScriptFailures }) => {
  const scripts = ['/sharing-ui.js', '/offline-ui.js', '/visit-order-ui.js', '/operating-ui.js'];
  const blocked = new Set();
  scripts.forEach(script => expectedScriptFailures.add(script));
  await page.route('**/*.js*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (expectedScriptFailures.has(pathname)) { blocked.add(pathname); return route.abort('failed'); }
    return route.fallback();
  });
  await createNote(page, 2);
  expect([...blocked].sort()).toEqual([...scripts].sort());
  async function assertNoEmptyTools() {
    for (const id of ['note-sharing', 'offline-tools', 'visit-order-tools', 'operating-tools']) {
      await expect(page.locator(`#${id}`)).toBeHidden();
      await expect(page.locator(`#${id} > summary`)).toHaveCount(0);
    }
  }
  await assertNoEmptyTools();
  await editFirstPlace(page, '선택 도구 파일 누락에도 보관되는 노트 메모');
  await page.locator('#day-bookmarks').getByRole('button', { name: /^2일차/ }).click();
  await expect(page.locator('#travel-day-1')).toBeVisible();
  await assertNoEmptyTools();
  await page.reload();
  await expect(page.locator('#travel-day-1')).toBeVisible();
  await assertNoEmptyTools();
  await page.locator('#day-bookmarks').getByRole('button', { name: /^1일차/ }).click();
  await expect(page.locator('#travel-day-0')).toContainText('선택 도구 파일 누락에도 보관되는 노트 메모');
});

test('compact note toolbar opens accessible groups, returns focus on Escape and closes on DAY navigation', async ({ page }) => {
  await createNote(page, 2);
  const toolbar = page.locator('#note-toolbar');
  const labels = ['공유·보관', '일정 점검', '여행 준비', '지도'];
  await expect(toolbar.getByRole('button')).toHaveCount(4);
  for (const label of labels) {
    const trigger = toolbar.getByRole('button', { name: label, exact: true });
    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  }
  await expect(page.locator('#note-tool-panels')).toBeHidden();
  const share = toolbar.getByRole('button', { name: '공유·보관', exact: true });
  await share.click();
  const sharingDialog = page.getByRole('dialog', { name: '공유·보관', exact: true });
  await expect(sharingDialog).toBeVisible();
  await expect(sharingDialog.locator('#note-sharing')).toBeVisible();
  await expect(sharingDialog.locator('#offline-tools')).toBeVisible();
  await expect(sharingDialog.locator('#note-export')).toBeVisible();
  await expect(share).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(sharingDialog).toBeHidden();
  await expect(share).toBeFocused();
  await expect(share).toHaveAttribute('aria-expanded', 'false');

  await openTool(page, 'operating-tools');
  const checkingDialog = page.getByRole('dialog', { name: '일정 점검', exact: true });
  await expect(checkingDialog.locator('#visit-order-tools')).toBeVisible();
  await page.goto('/#/note/day/2');
  await expect(checkingDialog).toBeHidden();
  await expect(page.locator('#travel-day-1')).toBeVisible();
  await expect(page.locator('#day-bookmarks .day-bookmark').nth(1)).toHaveAttribute('aria-current', 'page');
  await assertToolHeadings(page);
  await toolbar.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.resolve('artifacts/feature-review-desktop.png'), fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await toolbar.scrollIntoViewIfNeeded();
  const buttonRects = await toolbar.getByRole('button').evaluateAll(buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect(); return { top: Math.round(rect.top), height: rect.height };
  }));
  expect(new Set(buttonRects.map(rect => rect.top)).size).toBeLessThanOrEqual(2);
  expect(buttonRects.every(rect => rect.height >= 40)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const toolbarRect = await toolbar.boundingBox(), dayRect = await page.locator('#travel-day-1').boundingBox();
  expect(dayRect.y - toolbarRect.y - toolbarRect.height).toBeLessThan(300);
  await page.screenshot({ path: path.resolve('artifacts/feature-review-mobile.png'), fullPage: false });

  // Render the real Leaflet map inside the modal without contacting the tile
  // provider. A tiny fixture tile is enough to check its measured dimensions.
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=', 'base64')
  }));
  await openTool(page, 'day-map');
  const map = page.locator('#day-map .day-map-canvas.leaflet-container');
  await expect(map).toBeVisible();
  const mapRect = await map.boundingBox();
  expect(mapRect.width).toBeGreaterThan(200);
  expect(mapRect.height).toBeGreaterThan(200);
  await expect(map.locator('.day-map-pin')).toHaveCount(3);
  expect(await page.getByRole('dialog', { name: '지도', exact: true }).evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await closeToolDialog(page);
  await expect(toolbar.getByRole('button', { name: '지도', exact: true })).toBeFocused();
});

test('synthetic social login → account save → fresh browser context restores account document', async ({ page, browser, baseURL }) => {
  await createNote(page);
  await socialLogin(page);
  await expect(page.locator('#itinerary-section')).toBeVisible();
  await editFirstPlace(page, '계정 저장 후 재접속 검증 메모');
  await page.locator('#account-save').getByRole('button', { name: '계획표 저장', exact: true }).click();
  await page.getByLabel('계획표 이름').fill('브라우저 자동 검증 여행');
  await page.getByRole('button', { name: '계정에 저장', exact: true }).click();
  await expect(page.locator('#account-save').getByRole('button', { name: '변경사항 저장', exact: true })).toBeVisible();

  // Retain only HttpOnly session cookies, with no localStorage or page memory.
  const cookies = await page.context().cookies();
  const fresh = await browser.newContext({ baseURL, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  try {
    await fresh.addCookies(cookies);
    const reopened = await fresh.newPage();
    const errors = [];
    reopened.on('pageerror', error => errors.push(error.message));
    await reopened.goto('/#/start');
    const saved = reopened.locator('.account-plan-card').filter({ hasText: '브라우저 자동 검증 여행' });
    await expect(saved).toBeVisible();
    await saved.getByRole('button', { name: '불러오기', exact: true }).click();
    const dialog = reopened.getByRole('dialog');
    if (await dialog.isVisible()) await dialog.getByRole('button', { name: /불러오기/ }).click();
    await expect(reopened.locator('#itinerary-section')).toBeVisible();
    await expect(reopened.locator('#travel-day-0')).toContainText('계정 저장 후 재접속 검증 메모');
    expect(errors).toEqual([]);
  } finally { await fresh.close(); }
});

test('share preview excludes private fields; published snapshot is frozen, rotated and revoked for guests', async ({ page, browser, baseURL }) => {
  const markupMemo = '<img src=x onerror="document.body.dataset.injected=1"> 합성 비공개 메모';
  await createNote(page, 1);
  await socialLogin(page);
  const origin = page.locator('#travel-day-0 .day-origin').first();
  await origin.locator('summary').click();
  await origin.locator('.departure-mode-select').selectOption('car');
  await origin.locator('.origin-query').fill('비공개 숙소');
  await origin.getByRole('button', { name: '검색', exact: true }).click();
  await origin.locator('.origin-result').click();
  await expect(page.locator('#travel-day-0')).toContainText('비공개 합성 숙소');
  await editFirstPlace(page, markupMemo);
  await saveAccountNote(page, '공유 브라우저 검증 여행');

  const sharing = page.locator('#note-sharing');
  await openTool(page, 'note-sharing');
  await expect(sharing.getByLabel('메모 포함', { exact: true })).not.toBeChecked();
  await expect(sharing.getByLabel('출발지·도착지 포함', { exact: true })).not.toBeChecked();
  await sharing.getByRole('button', { name: '공유 내용 미리보기' }).click();
  const preview = sharing.locator('.sharing-preview');
  await expect(preview).toBeVisible();
  await expect(preview).not.toContainText('비공개 합성 숙소');
  await expect(preview).not.toContainText('비공개숙소길');
  await expect(preview).not.toContainText('합성 비공개 메모');
  await sharing.getByRole('button', { name: '공유 링크 만들기' }).click();
  const link = sharing.getByLabel('공유 링크', { exact: true });
  await expect(link).toBeVisible();
  const firstLink = await link.inputValue();

  const guest = await browser.newContext({ baseURL, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const guestIssues = [];
  try {
    const reader = await guest.newPage();
    reader.on('pageerror', error => guestIssues.push(error.message));
    reader.on('response', response => {
      if (response.request().resourceType() === 'script' && !response.ok()) guestIssues.push(`missing script: ${new URL(response.url()).pathname}`);
    });
    await reader.goto(firstLink);
    const shared = reader.locator('#share-note');
    await expect(shared).toBeVisible();
    await expect(shared).toContainText('합성 문화공원');
    await expect(shared).not.toContainText('비공개 합성 숙소');
    await expect(shared).not.toContainText('비공개숙소길');
    await expect(shared).not.toContainText('합성 비공개 메모');
    await expect(shared.locator('input,textarea,select,button,[contenteditable=true]')).toHaveCount(0);
    const frozen = await shared.textContent();

    await editFirstPlace(page, markupMemo, 120);
    await saveAccountNote(page, '공유 브라우저 검증 여행');
    await reader.reload();
    await expect(shared).toHaveText(frozen);

    await openTool(page, 'note-sharing');
    await sharing.getByLabel('메모 포함', { exact: true }).check();
    await sharing.getByRole('button', { name: '공유 내용 미리보기' }).click();
    await expect(preview).toContainText(markupMemo);
    await expect(preview.locator('img')).toHaveCount(0);
    await sharing.getByRole('button', { name: '공유 링크 만들기' }).click();
    await expect(link).toBeVisible();
    const secondLink = await link.inputValue();
    expect(secondLink).not.toBe(firstLink);
    await reader.reload();
    await expect(reader.locator('#share-status')).toContainText('공유가 해제됐거나');
    await expect(shared).toBeHidden();
    await reader.goto(secondLink);
    await expect(shared).toContainText(markupMemo);
    await expect(shared.locator('img')).toHaveCount(0);
    await expect(shared).not.toContainText('비공개숙소길');
    await reader.goto('/sources.html');
    await sharing.getByRole('button', { name: '공유 해제', exact: true }).click();
    await expect(sharing.locator('.sharing-status')).toContainText('공유를 해제했어요.');
    await reader.goBack();
    await expect(reader.locator('#share-status')).toContainText('공유가 해제됐거나');
    await expect(shared).toBeHidden();
    await reader.reload();
    await expect(reader.locator('#share-status')).toContainText('공유가 해제됐거나');
    await expect(shared).toBeHidden();
    expect(guestIssues).toEqual([]);
  } finally { await guest.close(); }
});

test('social-only login has no password form and switching accounts keeps their notes separate', async ({ page, baseURL, socialIdentity }) => {
  await createNote(page, 1);
  await page.locator('#account-nav').getByRole('button', { name: /로그인/ }).click();
  const login = page.getByRole('dialog', { name: '소셜 로그인' });
  await expect(login.getByRole('button', { name: /카카오/ })).toBeVisible();
  await expect(login.locator('form,input[type=password],input[autocomplete=username],.account-dialog-tabs')).toHaveCount(0);
  await expect(login).not.toContainText('비밀번호');
  for (const endpoint of ['signup', 'login']) {
    const response = await page.request.post(`/api/auth/${endpoint}`, {
      headers: { Origin: baseURL }, data: { username: 'retired-browser-account', password: 'synthetic-password-2026' }
    });
    expect(response.status(), `Retired ${endpoint} endpoint must not accept credentials`).toBe(410);
  }
  await login.getByRole('button', { name: /카카오/ }).click();
  await expect(page.locator('#account-nav').getByRole('button', { name: '로그아웃' })).toBeVisible();
  await editFirstPlace(page, '합성 계정 A만 보는 비공개 메모');
  await saveAccountNote(page, '합성 A 전용 여행');
  const privacy = page.locator('#note-sharing');
  await openTool(page, 'note-sharing');
  await privacy.getByLabel('메모 포함', { exact: true }).check();
  await privacy.getByLabel('출발지·도착지 포함', { exact: true }).check();
  await closeToolDialog(page);

  await page.locator('#account-nav').getByRole('button', { name: '로그아웃' }).click();
  await expect(page.locator('#account-nav').getByRole('button', { name: /로그인/ })).toBeVisible();
  await expect(privacy.getByLabel('메모 포함', { exact: true })).not.toBeChecked();
  await expect(privacy.getByLabel('출발지·도착지 포함', { exact: true })).not.toBeChecked();
  socialIdentity.account = 2;
  await socialLogin(page);
  await expect(page.locator('#saved-plans')).not.toContainText('합성 A 전용 여행');
  await expect(page.locator('#itinerary-section')).toBeHidden();
  await createNote(page, 1);
  await editFirstPlace(page, '합성 계정 B만 보는 비공개 메모');
  await saveAccountNote(page, '합성 B 전용 여행');
  await page.reload();
  await expect(page.locator('#travel-day-0')).toContainText('합성 계정 B만 보는 비공개 메모');
  await expect(page.locator('#travel-day-0')).not.toContainText('합성 계정 A만 보는 비공개 메모');

  await page.locator('#account-nav').getByRole('button', { name: '로그아웃' }).click();
  await expect(page.locator('#account-nav').getByRole('button', { name: /로그인/ })).toBeVisible();
  socialIdentity.account = 1;
  await socialLogin(page);
  await expect(page.locator('#saved-plans')).not.toContainText('합성 B 전용 여행');
  await page.getByRole('link', { name: '여행 노트 보기 →' }).click();
  await expect(page.locator('#itinerary-section')).toBeVisible();
  await expect(page.locator('#travel-day-0')).toContainText('합성 계정 A만 보는 비공개 메모');
  await expect(page.locator('#travel-day-0')).not.toContainText('합성 계정 B만 보는 비공개 메모');
});

test('offline note survives a full isolated browser restart without network and respects account changes', async ({ baseURL }, testInfo) => {
  test.setTimeout(60_000);
  // Chromium's on-disk CacheStorage can exceed Windows path limits beneath a
  // long project/test-result directory. A short disposable profile also keeps
  // the test completely separate from the user's real browser directories.
  const profileRoot = path.resolve(tmpdir());
  const userDataDir = await mkdtemp(path.join(profileRoot, 'gil-browser-e2e-'));
  const options = { baseURL, headless: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul', serviceWorkers: 'allow' };
  const identity = { account: 1 }, issues = [];
  let persistent = await chromium.launchPersistentContext(userDataDir, options);
  try {
    const writer = persistent.pages()[0] || await persistent.newPage();
    await isolatePage(writer, baseURL, identity, issues);
    await createNote(writer, 2);
    await socialLogin(writer);
    await editFirstPlace(writer, '오프라인 첫째 날 보관 메모');
    await saveAccountNote(writer, '오프라인 재시작 검증 여행');
    await writer.locator('#day-bookmarks').getByRole('button', { name: /^2일차/ }).click();
    await editFirstPlace(writer, '오프라인 둘째 날 보관 메모');
    const tools = writer.locator('#offline-tools');
    await openTool(writer, 'offline-tools');
    await tools.getByRole('button', { name: '오프라인으로 저장', exact: true }).click();
    try {
      await expect(tools.locator('[role=status]')).toContainText('오프라인 사본을 저장했어요.', { timeout: 20_000 });
    } catch (error) {
      const diagnostic = await writer.evaluate(async () => ({
        registrations: (await navigator.serviceWorker.getRegistrations()).map(registration => ({
          installing: registration.installing?.state, waiting: registration.waiting?.state, active: registration.active?.state
        })),
        cached: await (async () => { try { return (await (await caches.open('gil-offline-shell-v1')).keys()).map(request => new URL(request.url).pathname); } catch { return ['cache-storage-unavailable']; } })()
      }));
      await testInfo.attach('offline-shell-diagnostic', { body: JSON.stringify(diagnostic), contentType: 'application/json' });
      throw error;
    }
    const cachedPaths = await writer.evaluate(async () => {
      const cache = await caches.open('gil-offline-shell-v1');
      return (await cache.keys()).map(request => new URL(request.url).pathname).sort();
    });
    expect(cachedPaths).toEqual(['/note-view.css', '/note-view.js', '/offline-store.js', '/offline-view.js', '/offline.html']);
    await persistent.close();

    // Reuse only this test's disk profile: no live page, renderer memory or
    // network remains available, just as reopening the browser while travelling.
    persistent = await chromium.launchPersistentContext(userDataDir, options);
    await persistent.setOffline(true);
    const reader = persistent.pages()[0] || await persistent.newPage();
    await isolatePage(reader, baseURL, identity, issues);
    await reader.goto('/offline.html');
    const offlineNote = reader.locator('#offline-note');
    await expect(offlineNote).toBeVisible();
    await expect(offlineNote).toContainText('오프라인 첫째 날 보관 메모');
    await expect(offlineNote).toContainText('오프라인 둘째 날 보관 메모');
    await expect(offlineNote.locator('.read-note-day')).toHaveCount(2);
    await expect(reader.locator('#offline-notes')).toContainText('마지막 저장:');
    await expect(reader.locator('#offline-status')).toContainText('인터넷 연결 없이');
    await expect(offlineNote.locator('input,textarea,select,button,[contenteditable=true]')).toHaveCount(0);
    await reader.screenshot({ path: testInfo.outputPath('offline-reader.png'), fullPage: true });

    await persistent.setOffline(false);
    const accountPage = await persistent.newPage();
    await isolatePage(accountPage, baseURL, identity, issues);
    await accountPage.goto('/#/start');
    await accountPage.locator('#account-nav').getByRole('button', { name: '로그아웃' }).click();
    await expect(accountPage.locator('#account-nav').getByRole('button', { name: /로그인/ })).toBeVisible();
    await expect(offlineNote).toBeHidden();
    await expect(reader.locator('#offline-notes')).not.toContainText('오프라인 재시작 검증 여행');
    identity.account = 2;
    await socialLogin(accountPage);
    await expect(offlineNote).toBeHidden();
    await expect(reader.locator('#offline-notes')).not.toContainText('오프라인 재시작 검증 여행');
    await persistent.setOffline(true);
    await reader.reload();
    await expect(offlineNote).toBeHidden();
    await expect(reader.locator('#offline-status')).toContainText('현재 계정으로 이 기기에 저장한 사본이 없어요.');
    expect(issues).toEqual([]);
  } finally {
    await persistent.close();
    if (path.dirname(path.resolve(userDataDir)) !== profileRoot || !path.basename(userDataDir).startsWith('gil-browser-e2e-')) throw new Error('Unexpected disposable browser profile path');
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('optional travel preference changes new recommendations and the chosen places survive reload', async ({ page }) => {
  await createNote(page, 1);
  const titles = page.locator('#travel-day-0 .place-row .event-title');
  const neutral = await titles.allTextContents();
  expect(neutral).toEqual(['합성 문화공원', '합성 역사박물관', '합성 산책정원']);
  await createNote(page, 1, ['culture']);
  const cultural = await titles.allTextContents();
  expect(cultural).not.toEqual(neutral);
  expect(cultural).toContain('합성 역사박물관');
  expect(cultural).toContain('합성 미술관');
  expect(cultural).not.toContain('합성 문화공원');
  await expect(page.locator('#travel-day-0 .recommendation-reason').filter({ hasText: '문화' })).toHaveCount(2);
  await page.reload();
  await expect(titles).toHaveText(cultural);
});

test('directional vehicle comparison waits for confirmation, preserves non-place slots and supports undo without saving route metrics', async ({ page }) => {
  const vehicleRequests = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/car-route') vehicleRequests.push(request); });
  await createNote(page, 2);
  await socialLogin(page);
  const day = page.locator('#travel-day-0');
  const titles = day.locator('.place-row .event-title');
  await expect(titles).toHaveCount(3);
  const before = await titles.allTextContents();
  const nonPlaceOrder = await day.locator('.timeline-row:not(.place-row)').evaluateAll(rows => rows.map(row => row.dataset.eventId));
  expect(vehicleRequests).toHaveLength(0);
  const order = page.locator('#visit-order-tools');
  const reserved = day.getByRole('combobox', { name: '1일차 합성 역사박물관 색상 태그', exact: true });
  await reserved.selectOption('booked');
  await openTool(page, 'visit-order-tools');
  await order.getByLabel('방문 순서 비교 기준').selectOption('car');
  await order.getByRole('button', { name: '순서 비교', exact: true }).click();
  await expect(order.locator('[role=status]')).toContainText('더 줄일 수 있는 순서가 없어요.');
  await expect(order.getByRole('button', { name: '제안 순서 적용', exact: true })).toBeDisabled();
  await expect(titles).toHaveText(before);
  await closeToolDialog(page);
  await reserved.selectOption('');
  await openTool(page, 'visit-order-tools');
  await order.getByRole('button', { name: '순서 비교', exact: true }).click();
  await expect(order.locator('.order-preview')).toContainText('제안:');
  expect(vehicleRequests).toHaveLength(12);
  await expect(titles).toHaveText(before);
  const after = ['합성 산책정원', '합성 문화공원', '합성 역사박물관'];
  await order.getByRole('button', { name: '제안 순서 적용', exact: true }).click();
  await expect(titles).toHaveText(after);
  expect(await day.locator('.timeline-row:not(.place-row)').evaluateAll(rows => rows.map(row => row.dataset.eventId))).toEqual(nonPlaceOrder);
  await closeToolDialog(page);
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(titles).toHaveText(before);
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  await expect(titles).toHaveText(after);
  const saving = page.waitForRequest(request => new URL(request.url()).pathname === '/api/plans' && request.method() === 'POST');
  await saveAccountNote(page, '차량 순서 비교 검증 여행');
  const document = (await saving).postDataJSON().document;
  expect(JSON.stringify(document)).not.toMatch(/durationSeconds|beforeCost|afterCost|현재 교통 기준|카카오모빌리티/);
});

test('operating checks are explicit, report available warnings and discard results after changing DAY', async ({ page }) => {
  const detailRequests = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/tour/place-details') detailRequests.push(request); });
  await createNote(page, 2);
  expect(detailRequests).toHaveLength(0);
  const operating = page.locator('#operating-tools');
  await openTool(page, 'operating-tools');
  expect(detailRequests).toHaveLength(0);
  await operating.getByRole('button', { name: '운영정보 확인', exact: true }).click();
  const rows = operating.locator('.operating-results > li');
  await expect(rows).toHaveCount(3);
  expect(detailRequests).toHaveLength(3);
  await expect(operating).toContainText('계획한 방문 시각이 안내된 이용시간을 벗어나요.');
  await expect(operating).toContainText('방문이 안내된 휴무일과 겹쳐요.');
  await expect(operating).toContainText('정보가 없거나 계절·공휴일 등 추가 조건이 있어 확인이 필요해요.');
  await expect(rows.locator('a')).toHaveCount(3);

  const order = page.locator('#visit-order-tools');
  await openTool(page, 'visit-order-tools');
  await order.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.resolve('artifacts/feature-review-dialog-desktop.png'), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await order.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: path.resolve('artifacts/feature-review-dialog-mobile.png'), fullPage: false });

  let release, started, finished;
  const held = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  const completed = new Promise(resolve => { finished = resolve; });
  let delayed = false;
  await page.route('**/api/tour/place-details?*', async route => {
    if (!delayed) { delayed = true; started(); await held; }
    try { await route.continue(); } catch { /* Aborted by the real DAY change. */ } finally { finished(); }
  });
  await operating.getByRole('button', { name: '운영정보 다시 확인', exact: true }).click();
  await requested;
  await page.goto('/#/note/day/2');
  await expect(rows).toHaveCount(0);
  release();
  await completed;
  await expect(operating.locator('[role=status]')).toHaveText('');
  await expect(rows).toHaveCount(0);
});

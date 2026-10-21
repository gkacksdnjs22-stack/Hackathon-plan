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

test('dragged saved-note order stays highlighted until account save and matches sharing and offline copies', async ({ page, context }) => {
  await createNote(page, 1);
  await socialLogin(page);
  await saveAccountNote(page, '드래그 통합 검증 여행');
  const day = page.locator('#travel-day-0'), rows = day.locator('.timeline-row');
  const before = await rows.evaluateAll(items => items.map(item => item.dataset.eventId));
  const expected = before.filter(id => id !== 'free-0'); expected.splice(expected.indexOf('transfer-0'), 0, 'free-0');
  const moved = day.locator('[data-event-id="free-0"]');
  const handle = moved.locator('.timeline-dot'), target = day.locator('[data-event-id="transfer-0"]');
  await target.scrollIntoViewIfNeeded();
  await handle.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox(), to = await target.boundingBox();
  expect(from).not.toBeNull(); expect(to).not.toBeNull();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + 10, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => rows.evaluateAll(items => items.map(item => item.dataset.eventId))).toEqual(expected);
  await expect(moved).toHaveAttribute('data-moved', 'true');
  await expect(moved.locator('.event-moved-status')).toHaveText('순서 변경 · 계정 저장 전');
  await expect(page.locator('#account-save')).toContainText('계정에 저장하지 않은 수정이 있어요.');
  await page.reload();
  await expect(moved).toHaveAttribute('data-moved', 'true');
  await expect.poll(() => rows.evaluateAll(items => items.map(item => item.dataset.eventId))).toEqual(expected);
  const titles = await rows.locator('.event-title').allTextContents(); titles[0] = '출발';
  await openTool(page, 'note-sharing');
  await page.locator('#note-sharing').getByRole('button', { name: '공유 내용 미리보기' }).click();
  await expect(page.locator('.sharing-preview .read-note-event h3')).toHaveText(titles);
  await page.locator('#offline-tools').getByRole('button', { name: '오프라인으로 저장', exact: true }).click();
  await expect(page.locator('#offline-tools [role=status]')).toContainText('오프라인 사본을 저장했어요.', { timeout: 20_000 });
  const reader = await context.newPage();
  try {
    await reader.goto('/offline.html');
    await expect(reader.locator('#offline-note .read-note-event h3')).toHaveText(titles);
  } finally { await reader.close(); }
  await saveAccountNote(page, '드래그 통합 검증 여행');
  await expect(moved).not.toHaveAttribute('data-moved', 'true');
  await expect(day.locator('.event-moved-status')).toHaveCount(0);
  await expect(page.locator('#account-save')).toContainText('계정에 저장했어요.');
  await openTool(page, 'note-sharing');
  await page.locator('#note-sharing').getByRole('button', { name: '공유 내용 미리보기' }).click();
  await expect(page.locator('.sharing-preview .read-note-event h3')).toHaveText(titles);
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

async function guestNote(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('travel-weave-itinerary-v1')).itinerary);
}
async function openRowEditor(page, row) {
  await row.locator('.event-edit-button').click();
  return row.locator('.event-editor');
}

test('insert between rows and original dot controls preserve booked tags and memo through undo, reload and account save', async ({ page, browser, baseURL }) => {
  await createNote(page);
  await page.locator('#travel-day-0 .schedule-insert-button[aria-label="합성 역사박물관 앞에 일정 추가"]').click();
  const form=page.locator('#travel-day-0 .schedule-insert .schedule-form');
  const addSummary=page.locator('#travel-day-0 .schedule-insert details > summary');
  await expect(addSummary).toHaveText('＋ 여기에 추가');
  await expect(addSummary.locator('.schedule-summary-mark')).toHaveCount(0);
  await form.locator('.schedule-title-input').fill('14시 예약 체험');
  await form.locator('.schedule-description-input').fill('예약번호 ABC / 소중한 메모');
  await form.getByRole('button',{name:'일정에 추가',exact:true}).click();
  const row=page.locator('#travel-day-0 [data-event-id="extra-1"]');
  let note=await guestNote(page);let ids=note.days[0].events.map(e=>e.id);
  expect(ids.indexOf('extra-1')+1).toBe(ids.indexOf('place-1'));
  await row.locator('.event-tag-select').selectOption('booked');
  await row.locator('.timeline-dot').click();
  await expect(row.locator('.timeline-move-controls')).toBeVisible();
  await row.getByRole('button',{name:'14시 예약 체험 아래로',exact:true}).click();
  note=await guestNote(page);ids=note.days[0].events.map(e=>e.id);expect(ids.indexOf('extra-1')).toBeGreaterThan(ids.indexOf('place-1'));
  await expect(row.locator('.timeline-dot')).toHaveText('');
  await expect(page.locator('#travel-day-0 .timeline-guide')).toContainText('점 클릭: ↑↓ 이동');
  await expect(row.locator('.event-move-day')).toHaveCount(0);
  await expect(row.locator('.timeline-move-controls select')).toHaveCount(0);
  const moved=note.days[0].events.find(e=>e.title==='14시 예약 체험');
  expect(note.days.flatMap(d=>d.events).filter(e=>e.title==='14시 예약 체험')).toHaveLength(1);
  expect(moved.description).toBe('예약번호 ABC / 소중한 메모');expect(moved.duration).toBe(60);expect(note.personalization.eventTags[0][moved.id]).toBe('booked');
  await page.locator('#undo-button').click();
  ids=(await guestNote(page)).days[0].events.map(e=>e.id);expect(ids.indexOf('extra-1')+1).toBe(ids.indexOf('place-1'));
  await page.locator('#redo-button').click();
  ids=(await guestNote(page)).days[0].events.map(e=>e.id);expect(ids.indexOf('extra-1')).toBeGreaterThan(ids.indexOf('place-1'));
  await page.reload();await expect(page.locator('#itinerary-section')).toBeVisible();
  note=await guestNote(page);expect(note.days[0].events.find(e=>e.id===moved.id).description).toBe('예약번호 ABC / 소중한 메모');
  await socialLogin(page);await saveAccountNote(page,'중간 삽입과 예약 검증');
  const fresh=await browser.newContext({baseURL,locale:'ko-KR',timezoneId:'Asia/Seoul'});
  try{
    await fresh.addCookies(await page.context().cookies());const reopened=await fresh.newPage();await reopened.goto('/#/start');
    await reopened.locator('.account-plan-card').filter({hasText:'중간 삽입과 예약 검증'}).getByRole('button',{name:'불러오기',exact:true}).click();
    const dialog=reopened.getByRole('dialog');if(await dialog.isVisible())await dialog.getByRole('button',{name:/불러오기/}).click();
    await expect(reopened.locator('#itinerary-section')).toBeVisible();
    const stored=await reopened.evaluate(()=>Object.keys(localStorage).map(k=>{try{return JSON.parse(localStorage.getItem(k));}catch{return null;}}).find(v=>v?.itinerary?.extraEvents?.[0]?.some(e=>e.description==='예약번호 ABC / 소중한 메모')).itinerary);
    const saved=stored.extraEvents[0].find(e=>e.description==='예약번호 ABC / 소중한 메모');expect(saved.description).toBe('예약번호 ABC / 소중한 메모');expect(stored.personalization.eventTags[0][saved.id]).toBe('booked');
  }finally{await fresh.close();}
});

test('compact mode keeps unfinished inputs, booked tags and pending travel while ordinary duration edits recalculate later rows',async({page})=>{
  await createNote(page);
  const later=page.locator('#travel-day-0 [data-event-id="place-1"]');
  await later.locator('.event-tag-select').selectOption('booked');
  const initial=await guestNote(page),before=initial.days[0].events.find(event=>event.id==='place-1').start;
  const first=page.locator('#travel-day-0 [data-event-id="place-0"]');let editor=await openRowEditor(page,first);
  await expect(editor.locator('input[type="time"], input[type="checkbox"]')).toHaveCount(0);
  await editor.getByLabel('소요시간 (분)').fill('400');await editor.getByLabel('설명·메모').fill('인쇄할 확정 메모');await editor.getByRole('button',{name:'수정 저장',exact:true}).click();
  const updated=await guestNote(page),next=updated.days[0].events.find(event=>event.id==='place-1');
  expect(next.start).toBe(before+340);expect(updated.days[0].events.find(event=>event.id==='rest').start).toBe(next.end);expect(updated.personalization.eventTags[0]['place-1']).toBe('booked');
  const expectedTime=`${String(Math.floor(next.start/60)).padStart(2,'0')}:${String(next.start%60).padStart(2,'0')}`;
  await expect(later.locator('.timeline-time-labels')).toContainText(expectedTime);
  editor=await openRowEditor(page,first);await editor.getByLabel('설명·메모').fill('아직 저장하지 않은 편집');
  await page.locator('#travel-day-0 .day-view-toggle').click();await expect(editor.getByLabel('설명·메모')).toHaveValue('아직 저장하지 않은 편집');
  const transfer=page.locator('#travel-day-0 [data-event-id="transfer-0"]');
  await expect(transfer.locator('.compact-event-alerts')).toContainText('이동시간 미정');
  await page.locator('#travel-day-0 .day-view-toggle').click();await expect(editor.getByLabel('설명·메모')).toHaveValue('아직 저장하지 않은 편집');
  await editor.getByRole('button',{name:'취소',exact:true}).click();await page.locator('#travel-day-0 .day-view-toggle').click();
  await page.emulateMedia({media:'print'});await expect(first.locator('.event-user-memo')).toBeVisible();await expect(first.locator('.event-personal-controls')).toBeHidden();await expect(later.locator('.event-tag-badge')).toHaveText('예약 완료');await page.emulateMedia({media:'screen'});
  await page.reload();
  await expect(later.locator('.timeline-time-labels')).toContainText(expectedTime);await expect(later.locator('.event-tag-badge')).toHaveText('예약 완료');
});

test('restaurant, origin and lodging map to real positions and restaurant route legs follow visit order',async({page})=>{
  await createNote(page);
  const origin=page.locator('#travel-day-0 .day-origin-container');await origin.locator('summary').click();await origin.locator('.departure-mode-select').selectOption('walk');await origin.locator('.origin-query').fill('합성 숙소');await origin.locator('.origin-search').click();await origin.locator('.origin-result').click();
  // Only the map tiles are synthetic; marker data comes from the saved itinerary.
  await page.route('**://tile.openstreetmap.org/**',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')}));
  const lunch=page.locator('#travel-day-0 [data-event-id="lunch"]');
  await lunch.locator('.restaurant-lookup:not(.restaurant-manual) > summary').click();
  await expect(lunch.locator('.restaurant-food')).toContainText('합성 정식');
  await lunch.getByRole('button',{name:'합성 점심 식당 식사 일정에 담기',exact:true}).click();
  let note=await guestNote(page);expect(note.eventEdits[0].lunch.location.latitude).toBe(37.575);
  await expect(page.locator('#travel-day-0 .schedule-leg-add').filter({hasText:'합성 점심 식당 → 합성 역사박물관'})).toBeVisible();
  await page.locator('#travel-day-0 .schedule-leg-add').filter({hasText:'합성 점심 식당 → 합성 역사박물관'}).click();
  await page.locator('#travel-day-0 .event-editor').getByRole('button',{name:'취소',exact:true}).click();
  const route=page.locator('#travel-day-0 [data-event-id="extra-1"] .local-transfer-container');await expect(route).toContainText('합성 점심 식당');await expect(route).toContainText('합성 역사박물관');
  const free=page.locator('#travel-day-0 [data-event-id="free-1"]');const editor=await openRowEditor(page,free);
  await editor.getByLabel('장소 종류',{exact:true}).selectOption('stay');await editor.getByLabel('위치 이름',{exact:true}).fill('확인한 숙소');await editor.getByLabel('위치 주소',{exact:true}).fill('서울특별시 종로구 숙소길');await editor.getByLabel('확인한 위도',{exact:true}).fill('37.58');await editor.getByLabel('확인한 경도',{exact:true}).fill('126.99');await editor.getByRole('button',{name:'수정 저장',exact:true}).click();
  await lunch.locator('.event-show-map').click();
  await expect(page.getByRole('dialog',{name:'지도',exact:true})).toBeVisible();await expect(page.locator('.day-map-place-copy').filter({hasText:'비공개 합성 숙소'})).toContainText('🚩');await expect(page.locator('.day-map-place-copy').filter({hasText:'합성 점심 식당'})).toContainText('🍽');await expect(page.locator('.day-map-place-copy').filter({hasText:'확인한 숙소'})).toContainText('🛏');
  await page.locator('.day-map-place').filter({hasText:'합성 점심 식당'}).getByRole('button',{name:/일정으로 이동/}).click();await expect(page.getByRole('dialog',{name:'지도',exact:true})).toBeHidden();await expect(lunch.locator('.event-edit-button')).toBeFocused();
});

test('touch taps and keyboard activation operate the handle; pointer dragging changes order on a mobile layout',async({browser,baseURL})=>{
  const context=await browser.newContext({baseURL,hasTouch:true,isMobile:true,viewport:{width:390,height:844},locale:'ko-KR',timezoneId:'Asia/Seoul'});
  const page=await context.newPage(),issues=[];await isolatePage(page,baseURL,{account:1},issues);
  try{
    await createNote(page);const dot=page.locator('#travel-day-0 [data-event-id="place-0"] .timeline-dot');
    await dot.tap();await expect(dot).toHaveAttribute('aria-expanded','true');
    await page.locator('#travel-day-0 [data-event-id="place-0"] .event-move-button').last().tap();
    let note=await guestNote(page);expect(note.eventOrders[0].indexOf('place-0')).toBeGreaterThan(note.eventOrders[0].indexOf('transfer-0'));
    await page.keyboard.press('Escape');await dot.focus();await page.keyboard.press('Enter');
    await expect(dot).toHaveAttribute('aria-expanded','true');
    await expect(page.locator('#travel-day-0 .timeline-move-controls:visible .event-move-button').first()).toBeInViewport();
    await page.keyboard.press('Escape');
    const target=page.locator('#travel-day-0 [data-event-id="transfer-0"]');await dot.evaluate(element=>element.scrollIntoView({block:'center',behavior:'instant'}));
    const start=await dot.boundingBox(),end=await target.boundingBox();
    const touch=await context.newCDPSession(page),x=start.x+start.width/2,y=start.y+start.height/2,toY=end.y+5;
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(let step=1;step<=12;step++)await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+(toY-y)*step/12}]});
    await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await touch.detach();
    note=await guestNote(page);expect(note.eventOrders[0].indexOf('place-0')).toBeLessThan(note.eventOrders[0].indexOf('transfer-0'));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:'artifacts/usability-mobile.png',fullPage:true});expect(issues).toEqual([]);
  }finally{await context.close();}
});

test('candidate photos can fail without blocking name search or explicit replacement',async({page,baseURL})=>{
  await createNote(page);
  await page.route('**/api/tour/place-detail?**',route=>{
    const url=new URL(route.request().url());
    return route.fulfill({json:{contentId:url.searchParams.get('contentId'),contentTypeId:url.searchParams.get('contentTypeId'),title:'합성 미술관',overview:'제공기관에서 확인한 짧은 소개. 비교한 뒤 직접 선택합니다.',imageUrl:baseURL+'/missing-candidate-photo.jpg',partial:false}});
  });
  const row=page.locator('#travel-day-0 [data-event-id="place-0"]');await row.locator('.swap-button').click();
  const picker=row.locator('.swap-picker');await expect(picker.locator('.candidate-region')).toContainText('문화시설');
  await expect(picker.locator('.place-detail-overview')).toContainText('제공기관에서 확인한 짧은 소개');await expect(picker.locator('figcaption')).toHaveText('제공 사진을 불러오지 못했어요.');
  await expect(row.locator('.event-title')).toHaveText('합성 문화공원');
  await picker.locator('.select-trigger').click();await picker.locator('.select-search-input').fill('미술관');await expect(picker.getByRole('option',{name:/합성 미술관/})).toBeVisible();await page.keyboard.press('Escape');
  await picker.getByRole('button',{name:'교체 적용',exact:true}).click();await expect(row.locator('.event-title')).toHaveText('합성 미술관');
  await page.locator('#travel-day-0 .day-view-toggle').click();
  await expect(row.locator('.compact-event-toggle')).toHaveText(/\d{2}:\d{2} \(합성 미술관\)/);
  await expect(row.locator('.timeline-content')).toBeHidden();
  await page.screenshot({path:'artifacts/usability-desktop.png',fullPage:true});
});


test('compact view shows only time and place rows, expands on demand and preserves itinerary and unfinished inputs',async({page})=>{
  await createNote(page);
  const day=page.locator('#travel-day-0'),first=day.locator('[data-event-id="place-0"]');
  const before=await guestNote(page);
  await day.locator('.day-view-toggle').click();
  const rows=day.locator('.timeline-row'),summaries=rows.locator('.compact-event-toggle');
  await expect(summaries).toHaveCount(before.days[0].events.length);
  await expect(first.locator('.compact-event-toggle')).toHaveText('09:00 (합성 문화공원)');
  await expect(first.locator('.timeline-time')).toBeHidden();await expect(first.locator('.timeline-content')).toBeHidden();
  await expect(day.locator('.schedule-insert-button').first()).toBeHidden();
  expect(await first.boundingBox()).not.toBeNull();
  const compactHeight=(await day.boundingBox()).height;
  await first.locator('.compact-event-toggle').click();await expect(first.locator('.timeline-content')).toBeVisible();
  const editor=await openRowEditor(page,first);await editor.getByLabel('설명·메모').fill('간단한 목록에서도 유지할 작성 중 메모');
  await day.locator('.day-view-toggle').click();await expect(editor.getByLabel('설명·메모')).toHaveValue('간단한 목록에서도 유지할 작성 중 메모');
  const detailedHeight=(await day.boundingBox()).height;expect(compactHeight).toBeLessThan(detailedHeight/2);
  await day.locator('.day-view-toggle').click();await expect(editor.getByLabel('설명·메모')).toHaveValue('간단한 목록에서도 유지할 작성 중 메모');
  expect(await guestNote(page)).toEqual(before);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await editor.getByRole('button',{name:'취소',exact:true}).click();await first.locator('.compact-event-toggle').click();
  await expect(first.locator('.timeline-content')).toBeHidden();await expect(first.locator('.compact-event-toggle')).toBeVisible();
  await page.screenshot({path:'artifacts/usability-compact-mobile.png',fullPage:true});
});

test('manual restaurant memo edits retain the selected coordinates and travel estimate while rename and clear invalidate them',async({page})=>{
  await createNote(page);
  const lunch=page.locator('#travel-day-0 [data-event-id="lunch"]');
  async function selectRestaurant(){
    await lunch.locator('.restaurant-lookup:not(.restaurant-manual) > summary').click();
    await lunch.getByRole('button',{name:'합성 점심 식당 식사 일정에 담기',exact:true}).click();
  }
  async function enterTravelTime(){
    const travel=page.locator('#travel-day-0 [data-event-id="transfer-0"]'),editor=await openRowEditor(page,travel);
    await editor.getByLabel('이동시간: 시간',{exact:true}).fill('0');await editor.getByLabel('이동시간: 분',{exact:true}).fill('25');
    await editor.getByRole('button',{name:'수정 저장',exact:true}).click();
  }
  await selectRestaurant();await enterTravelTime();
  const before=await guestNote(page),selected=before.eventEdits[0].lunch;
  expect(selected.location.name).toBe('합성 점심 식당');expect(before.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(25);
  await lunch.locator('.restaurant-manual > summary').click();
  await expect(lunch.locator('.restaurant-manual-name')).toHaveValue('합성 점심 식당');
  const memo=lunch.locator('.restaurant-manual-description');await memo.fill(`${await memo.inputValue()}\n알레르기 없음`);
  await lunch.locator('.restaurant-manual-save').click();
  await expect(lunch.locator('.event-description')).toContainText('알레르기 없음');
  let note=await guestNote(page);expect(note.eventEdits[0].lunch.title).toBe(selected.title);expect(note.eventEdits[0].lunch.location).toEqual(selected.location);expect(note.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(25);
  await page.reload();await expect(page.locator('#itinerary-section')).toBeVisible();
  note=await guestNote(page);expect(note.eventEdits[0].lunch.location).toEqual(selected.location);expect(note.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(25);
  await lunch.locator('.restaurant-manual > summary').click();await lunch.locator('.restaurant-manual-name').fill('직접 바꾼 식당');await lunch.locator('.restaurant-manual-save').click();
  await expect(lunch.locator('.event-title')).toContainText('직접 바꾼 식당');
  note=await guestNote(page);expect(note.eventEdits[0].lunch.location).toBeNull();expect(note.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(0);
  await selectRestaurant();await enterTravelTime();
  await lunch.locator('.restaurant-manual > summary').click();await lunch.locator('.restaurant-manual-clear').click();
  note=await guestNote(page);expect(note.eventEdits[0].lunch.location).toBeNull();expect(note.eventEdits[0].lunch.description).toBe('');expect(note.eventEdits[0].lunch.title||'').not.toContain('합성 점심 식당');expect(note.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(0);
});

test('changing restaurants discards only the former restaurant draft and keeps the new location through editing and reload',async({page})=>{
  await page.route('**/api/restaurants?**',async route=>{
    const response=await route.fetch();expect(response.status()).toBe(200);
    const data=await response.json(),first=data.items[0];
    data.items=[first,{...first,id:'tour-food-901',name:'합성 둘째 식당',address:'서울특별시 종로구 둘째식당길 91',latitude:37.585,longitude:126.995}];
    await route.fulfill({response,json:data});
  });
  for(const reloadBeforeOpen of [false,true]){
    if(reloadBeforeOpen){await page.evaluate(()=>localStorage.clear());await page.reload();}
    await createNote(page);
    const lunch=page.locator('#travel-day-0 [data-event-id="lunch"]');
    async function selectRestaurant(name){
      await lunch.locator('.restaurant-lookup:not(.restaurant-manual) > summary').click();
      await lunch.getByRole('button',{name:`${name} 식사 일정에 담기`,exact:true}).click();
    }
    await selectRestaurant('합성 점심 식당');
    let editor=await openRowEditor(page,lunch);await editor.getByLabel('설명·메모').fill('A에서 작성 중이던 메모');await page.keyboard.press('Escape');
    editor=await openRowEditor(page,lunch);await expect(editor.getByLabel('설명·메모')).toHaveValue('A에서 작성 중이던 메모');await page.keyboard.press('Escape');
    await selectRestaurant('합성 둘째 식당');
    const selected=(await guestNote(page)).eventEdits[0].lunch;
    expect(selected.location.name).toBe('합성 둘째 식당');expect(selected.location.latitude).toBe(37.585);
    if(reloadBeforeOpen){await page.reload();await expect(page.locator('#itinerary-section')).toBeVisible();}
    editor=await openRowEditor(page,lunch);
    await expect(editor.getByLabel('일정 이름',{exact:true})).toHaveValue(selected.title);await expect(editor.getByLabel('위치 이름',{exact:true})).toHaveValue('합성 둘째 식당');await expect(editor.getByLabel('확인한 위도',{exact:true})).toHaveValue('37.585');await expect(editor.getByLabel('확인한 경도',{exact:true})).toHaveValue('126.995');await expect(editor.getByLabel('설명·메모')).not.toHaveValue('A에서 작성 중이던 메모');
    await editor.getByLabel('소요시간 (분)').fill('70');await editor.getByRole('button',{name:'수정 저장',exact:true}).click();
    let saved=(await guestNote(page)).eventEdits[0].lunch;expect(saved.title).toBe(selected.title);expect(saved.location).toEqual(selected.location);expect(saved.duration).toBe(70);
    editor=await openRowEditor(page,lunch);await editor.getByLabel('설명·메모').fill('B에서 취소할 초안');await editor.getByRole('button',{name:'취소',exact:true}).click();
    editor=await openRowEditor(page,lunch);await expect(editor.getByLabel('설명·메모')).toHaveValue(saved.description);await editor.getByRole('button',{name:'취소',exact:true}).click();
    await page.reload();await expect(page.locator('#itinerary-section')).toBeVisible();
    saved=(await guestNote(page)).eventEdits[0].lunch;expect(saved.title).toBe(selected.title);expect(saved.location).toEqual(selected.location);expect(saved.duration).toBe(70);
  }
});

test('changing the first restaurant invalidates only its departure travel draft before editing or reload',async({page})=>{
  await page.route('**/api/restaurants?**',async route=>{
    const response=await route.fetch();expect(response.status()).toBe(200);
    const data=await response.json(),first=data.items[0];
    data.items=[first,{...first,id:'tour-food-901',name:'합성 둘째 식당',address:'서울특별시 종로구 둘째식당길 91',latitude:37.585,longitude:126.995}];
    await route.fulfill({response,json:data});
  });
  for(const reloadBeforeOpen of [false,true]){
    if(reloadBeforeOpen){await page.evaluate(()=>localStorage.clear());await page.reload();}
    await createNote(page);
    await page.locator('#travel-day-0 .schedule-insert-button[aria-label="합성 문화공원 앞에 일정 추가"]').click();
    const form=page.locator('#travel-day-0 .schedule-insert .schedule-form');
    await form.locator('.schedule-type-select').selectOption('meal');await form.locator('.schedule-title-input').fill('첫 식당에서 식사');
    await form.getByRole('button',{name:'일정에 추가',exact:true}).click();
    const firstMeal=page.locator('#travel-day-0 [data-event-id="extra-1"]'),departure=page.locator('#travel-day-0 [data-event-id="departure"]');
    const origin=page.locator('#travel-day-0 .day-origin-container');await origin.locator('summary').click();await origin.locator('.departure-mode-select').selectOption(reloadBeforeOpen?'car':'walk');await origin.locator('.origin-query').fill('합성 숙소');await origin.locator('.origin-search').click();await origin.locator('.origin-result').click();
    async function selectRestaurant(name){
      await firstMeal.locator('.restaurant-lookup:not(.restaurant-manual) > summary').click();
      await firstMeal.getByRole('button',{name:`${name} 식사 일정에 담기`,exact:true}).click();
    }
    await selectRestaurant('합성 점심 식당');
    let note=await guestNote(page),firstVisit=note.days[0].events.find(event=>['place','meal'].includes(event.type));
    expect(firstVisit.id).toBe('extra-1');expect(firstVisit.location.name).toBe('합성 점심 식당');
    let editor=await openRowEditor(page,departure);
    await editor.getByLabel('이동시간: 시간',{exact:true}).fill('1');await editor.getByLabel('이동시간: 분',{exact:true}).fill('35');await page.keyboard.press('Escape');
    note=await guestNote(page);expect(note.days[0].events.find(event=>event.id==='departure').duration).toBe(0);
    editor=await openRowEditor(page,departure);await expect(editor.getByLabel('이동시간: 시간',{exact:true})).toHaveValue('1');await expect(editor.getByLabel('이동시간: 분',{exact:true})).toHaveValue('35');await page.keyboard.press('Escape');
    await selectRestaurant('합성 둘째 식당');
    note=await guestNote(page);const selected=note.days[0].events.find(event=>event.id==='extra-1').location;
    expect(selected.name).toBe('합성 둘째 식당');expect(selected.latitude).toBe(37.585);expect(note.days[0].events.find(event=>event.id==='departure').duration).toBe(0);
    if(reloadBeforeOpen){await page.reload();await expect(page.locator('#itinerary-section')).toBeVisible();}
    editor=await openRowEditor(page,departure);await expect(editor.getByLabel('이동시간: 시간',{exact:true})).toHaveValue('0');await expect(editor.getByLabel('이동시간: 분',{exact:true})).toHaveValue('0');
    await editor.getByRole('button',{name:'수정 저장',exact:true}).click();
    note=await guestNote(page);expect(note.days[0].events.find(event=>event.id==='departure').duration).toBe(0);expect(note.days[0].events.find(event=>event.id==='extra-1').location).toEqual(selected);
    await page.reload();await expect(page.locator('#itinerary-section')).toBeVisible();
    note=await guestNote(page);expect(note.days[0].events.find(event=>event.id==='departure').duration).toBe(0);expect(note.days[0].events.find(event=>event.id==='extra-1').location).toEqual(selected);
  }
});

test('renaming a restaurant without coordinates clears its saved travel time and draft while same-name memo edits preserve them',async({page})=>{
  for(const reloadBeforeOpen of [false,true]){
    if(reloadBeforeOpen){await page.evaluate(()=>localStorage.clear());await page.reload();}
    await createNote(page);
    const lunch=page.locator('#travel-day-0 [data-event-id="lunch"]'),travel=page.locator('#travel-day-0 [data-event-id="transfer-0"]');
    async function saveTravelTime(eventId,minutes){
      const editor=await openRowEditor(page,page.locator(`#travel-day-0 [data-event-id="${eventId}"]`));
      await editor.getByLabel('이동시간: 시간',{exact:true}).fill('0');await editor.getByLabel('이동시간: 분',{exact:true}).fill(String(minutes));await editor.getByRole('button',{name:'수정 저장',exact:true}).click();
    }
    await lunch.locator('.restaurant-manual > summary').click();await lunch.locator('.restaurant-manual-name').fill('직접 입력 식당 A');await lunch.locator('.restaurant-manual-description').fill('직접 확인한 예약 메모');await lunch.locator('.restaurant-manual-save').click();
    let note=await guestNote(page);expect(note.eventEdits[0].lunch.location).toBeNull();expect(note.eventEdits[0].lunch.title).toContain('직접 입력 식당 A');
    await saveTravelTime('transfer-0',25);await saveTravelTime('transfer-1',35);
    let editor=await openRowEditor(page,travel);await editor.getByLabel('이동시간: 분',{exact:true}).fill('45');await page.keyboard.press('Escape');
    await lunch.locator('.restaurant-manual > summary').click();await expect(lunch.locator('.restaurant-manual-name')).toHaveValue('직접 입력 식당 A');await lunch.locator('.restaurant-manual-description').fill('직접 확인한 예약 메모\n같은 식당의 메모만 수정');await lunch.locator('.restaurant-manual-save').click();
    note=await guestNote(page);expect(note.eventEdits[0].lunch.location).toBeNull();expect(note.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(25);expect(note.days[0].events.find(event=>event.id==='transfer-1').duration).toBe(35);
    editor=await openRowEditor(page,travel);await expect(editor.getByLabel('이동시간: 시간',{exact:true})).toHaveValue('0');await expect(editor.getByLabel('이동시간: 분',{exact:true})).toHaveValue('45');await page.keyboard.press('Escape');
    await lunch.locator('.restaurant-manual > summary').click();await lunch.locator('.restaurant-manual-name').fill('직접 입력 식당 B');await lunch.locator('.restaurant-manual-save').click();
    note=await guestNote(page);expect(note.eventEdits[0].lunch.title).toContain('직접 입력 식당 B');expect(note.eventEdits[0].lunch.location).toBeNull();expect(note.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(0);expect(note.days[0].events.find(event=>event.id==='transfer-1').duration).toBe(35);
    if(reloadBeforeOpen){await page.reload();await expect(page.locator('#itinerary-section')).toBeVisible();}
    editor=await openRowEditor(page,travel);await expect(editor.getByLabel('이동시간: 시간',{exact:true})).toHaveValue('0');await expect(editor.getByLabel('이동시간: 분',{exact:true})).toHaveValue('0');await editor.getByRole('button',{name:'수정 저장',exact:true}).click();
    note=await guestNote(page);expect(note.eventEdits[0].lunch.title).toContain('직접 입력 식당 B');expect(note.eventEdits[0].lunch.location).toBeNull();expect(note.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(0);expect(note.days[0].events.find(event=>event.id==='transfer-1').duration).toBe(35);
    await page.reload();await expect(page.locator('#itinerary-section')).toBeVisible();
    note=await guestNote(page);expect(note.eventEdits[0].lunch.title).toContain('직접 입력 식당 B');expect(note.eventEdits[0].lunch.location).toBeNull();expect(note.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(0);
  }
});

const sameNameRestaurantA={id:'tour-food-910',name:'합성 동명식당',address:'서울특별시 종로구 동명식당A길 10'};
const sameNameRestaurantB={id:'tour-food-911',name:'합성 동명식당',address:'서울특별시 종로구 동명식당B길 11'};
async function useSameNameRestaurantResults(page){
  await page.route('**/api/restaurants?**',async route=>{
    const response=await route.fetch();expect(response.status()).toBe(200);
    const data=await response.json(),first=data.items[0];
    data.items=[sameNameRestaurantA,sameNameRestaurantB].map(item=>({...first,...item,latitude:null,longitude:null}));
    await route.fulfill({response,json:data});
  });
}
async function selectSameNameRestaurant(page,address){
  const lunch=page.locator('#travel-day-0 [data-event-id="lunch"]');
  await lunch.locator('.restaurant-lookup:not(.restaurant-manual) > summary').click();
  await lunch.locator('.restaurant-card').filter({hasText:address}).getByRole('button',{name:'합성 동명식당 식사 일정에 담기',exact:true}).click();
}
async function saveSameNameRestaurantTravel(page,minutes){
  const travel=page.locator('#travel-day-0 [data-event-id="transfer-0"]'),editor=await openRowEditor(page,travel);
  await editor.getByLabel('이동시간: 시간',{exact:true}).fill('0');await editor.getByLabel('이동시간: 분',{exact:true}).fill(String(minutes));await editor.getByRole('button',{name:'수정 저장',exact:true}).click();
}

test('same-name restaurants without coordinates keep distinct references and discard former place and travel drafts',async({page})=>{
  await useSameNameRestaurantResults(page);
  for(const reloadBeforeOpen of [false,true]){
    if(reloadBeforeOpen){await page.evaluate(()=>localStorage.clear());await page.reload();}
    await createNote(page);
    const lunch=page.locator('#travel-day-0 [data-event-id="lunch"]'),travel=page.locator('#travel-day-0 [data-event-id="transfer-0"]');
    await selectSameNameRestaurant(page,sameNameRestaurantA.address);await saveSameNameRestaurantTravel(page,25);
    let editor=await openRowEditor(page,travel);await editor.getByLabel('이동시간: 분',{exact:true}).fill('45');await page.keyboard.press('Escape');
    await lunch.locator('.restaurant-manual > summary').click();await expect(lunch.locator('.restaurant-manual-name')).toHaveValue(sameNameRestaurantA.name);
    const memo=lunch.locator('.restaurant-manual-description');await memo.fill(`${await memo.inputValue()}\n같은 A 식당의 메모만 수정`);await lunch.locator('.restaurant-manual-save').click();
    let note=await guestNote(page);expect(note.eventEdits[0].lunch.restaurantRef).toEqual(sameNameRestaurantA);expect(note.eventEdits[0].lunch.location).toBeNull();expect(note.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(25);
    editor=await openRowEditor(page,travel);await expect(editor.getByLabel('이동시간: 분',{exact:true})).toHaveValue('45');await page.keyboard.press('Escape');
    editor=await openRowEditor(page,lunch);await editor.getByLabel('설명·메모').fill('A에서 작성 중인 식당 초안');await editor.getByLabel('위치 이름',{exact:true}).fill('A에서 작성 중인 위치');await editor.getByLabel('확인한 위도',{exact:true}).fill('37.51');await editor.getByLabel('확인한 경도',{exact:true}).fill('126.91');await page.keyboard.press('Escape');
    await selectSameNameRestaurant(page,sameNameRestaurantB.address);
    note=await guestNote(page);expect(note.eventEdits[0].lunch.restaurantRef).toEqual(sameNameRestaurantB);expect(note.eventEdits[0].lunch.location).toBeNull();expect(note.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(0);
    if(reloadBeforeOpen){await page.reload();await expect(page.locator('#itinerary-section')).toBeVisible();}
    editor=await openRowEditor(page,lunch);await expect(editor.getByLabel('설명·메모')).toHaveValue(new RegExp(sameNameRestaurantB.address));await expect(editor.getByLabel('설명·메모')).not.toHaveValue('A에서 작성 중인 식당 초안');await expect(editor.getByLabel('위치 이름',{exact:true})).toHaveValue('');await expect(editor.getByLabel('위치 주소',{exact:true})).toHaveValue('');await expect(editor.getByLabel('확인한 위도',{exact:true})).toHaveValue('');await expect(editor.getByLabel('확인한 경도',{exact:true})).toHaveValue('');
    await editor.getByLabel('소요시간 (분)').fill('70');await editor.getByRole('button',{name:'수정 저장',exact:true}).click();
    editor=await openRowEditor(page,travel);await expect(editor.getByLabel('이동시간: 시간',{exact:true})).toHaveValue('0');await expect(editor.getByLabel('이동시간: 분',{exact:true})).toHaveValue('0');await editor.getByRole('button',{name:'수정 저장',exact:true}).click();
    note=await guestNote(page);expect(note.eventEdits[0].lunch.restaurantRef).toEqual(sameNameRestaurantB);expect(note.eventEdits[0].lunch.location).toBeNull();expect(note.eventEdits[0].lunch.duration).toBe(70);expect(note.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(0);
    await page.reload();await expect(page.locator('#itinerary-section')).toBeVisible();
    note=await guestNote(page);expect(note.eventEdits[0].lunch.restaurantRef).toEqual(sameNameRestaurantB);expect(note.eventEdits[0].lunch.location).toBeNull();expect(note.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(0);
  }
});

test('account save and a fresh browser preserve the chosen same-name restaurant reference without inventing coordinates',async({page,browser,baseURL})=>{
  await useSameNameRestaurantResults(page);await createNote(page);
  await selectSameNameRestaurant(page,sameNameRestaurantA.address);await saveSameNameRestaurantTravel(page,25);await selectSameNameRestaurant(page,sameNameRestaurantB.address);
  const selected=await guestNote(page);expect(selected.eventEdits[0].lunch.restaurantRef).toEqual(sameNameRestaurantB);expect(selected.eventEdits[0].lunch.location).toBeNull();expect(selected.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(0);
  await socialLogin(page);await saveAccountNote(page,'동명 식당 식별정보 검증');
  const fresh=await browser.newContext({baseURL,locale:'ko-KR',timezoneId:'Asia/Seoul'}),issues=[];
  try{
    await fresh.addCookies(await page.context().cookies());const reopened=await fresh.newPage();await isolatePage(reopened,baseURL,{account:1},issues);await reopened.goto('/#/start');
    await reopened.locator('.account-plan-card').filter({hasText:'동명 식당 식별정보 검증'}).getByRole('button',{name:'불러오기',exact:true}).click();
    const dialog=reopened.getByRole('dialog');if(await dialog.isVisible())await dialog.getByRole('button',{name:/불러오기/}).click();await expect(reopened.locator('#itinerary-section')).toBeVisible();
    const restored=await reopened.evaluate(()=>Object.keys(localStorage).map(key=>{try{return JSON.parse(localStorage.getItem(key));}catch{return null;}}).find(value=>value?.itinerary?.eventEdits?.[0]?.lunch?.restaurantRef?.id==='tour-food-911')?.itinerary);
    expect(restored).toBeTruthy();expect(restored.eventEdits[0].lunch.restaurantRef).toEqual(sameNameRestaurantB);expect(restored.eventEdits[0].lunch.location).toBeNull();expect(restored.days[0].events.find(event=>event.id==='transfer-0').duration).toBe(0);
    await expect(reopened.locator('#travel-day-0 [data-event-id="lunch"] .event-description')).toContainText(sameNameRestaurantB.address);expect(issues).toEqual([]);
  }finally{await fresh.close();}
});

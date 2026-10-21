(function () {
  'use strict';
  let sequence = 0;
  const line = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
  const usernameValid = value => typeof value === 'string' && /^[a-z0-9_]{3,24}$/i.test(value);
  const validUser = user => user && line(user.id, 128) && usernameValid(user.username);
  function validPlan(plan) {
    return plan && line(plan.id, 128) && line(plan.title, 80) && line(plan.cityId, 128)
      && typeof plan.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(plan.startDate)
      && Number.isInteger(plan.dayCount) && plan.dayCount >= 1 && plan.dayCount <= 7
      && Number.isSafeInteger(plan.revision) && plan.revision >= 1
      && [plan.createdAt, plan.updatedAt].every(value => line(value, 64) && Number.isFinite(Date.parse(value)));
  }
  function copyDocument(document) {
    const itinerary = document?.itinerary;
    if (document?.version !== 8 || !itinerary || !line(itinerary.cityId, 128) || !Number.isInteger(itinerary.dayCount)
      || itinerary.dayCount < 1 || itinerary.dayCount > 7 || !Array.isArray(itinerary.dayAreaIds)
      || itinerary.dayAreaIds.length !== itinerary.dayCount || itinerary.dayAreaIds.some(id => !line(id, 160))
      || !itinerary.selections || typeof itinerary.selections !== 'object' || Array.isArray(itinerary.selections)
      || Array.from({ length: itinerary.dayCount }, (_, index) => itinerary.selections[index]).some(ids => !Array.isArray(ids) || ids.length !== 3 || ids.some(id => !line(id, 160))))
      throw { code: 'INVALID_DOCUMENT' };
    let json;
    try { json = JSON.stringify(document); } catch (_error) { throw { code: 'INVALID_DOCUMENT' }; }
    if (new TextEncoder().encode(json).byteLength > 256 * 1024) throw { code: 'DOCUMENT_TOO_LARGE' };
    return JSON.parse(json);
  }
  function errorText(error, fallback) {
    if (error?.code === 'DOCUMENT_TOO_LARGE') return '계획표가 너무 커서 저장할 수 없어요. 메모나 추가 일정을 조금 줄여 주세요.';
    if (error?.code === 'INVALID_DOCUMENT') return '저장할 여행 노트를 먼저 만들어 주세요.';
    if (error?.status === 401) return '로그인이 만료됐어요. 다시 로그인해 주세요.';
    if (error?.status === 429) return '요청이 많아요. 잠시 후 다시 시도해 주세요.';
    if (error?.code === 'TIMEOUT') return '응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.';
    return fallback;
  }

  function mount({ accountRoot, libraryRoot, saveRoot, noticeRoot, getDocument, getDefaultTitle = () => '나의 여행 계획', loadDocument, onMessage = () => {}, onUserChange = async () => {}, onAttachmentChange = () => {} } = {}) {
    if (!accountRoot || !libraryRoot || !saveRoot || typeof getDocument !== 'function' || typeof loadDocument !== 'function')
      throw new Error('Account UI requires its three hosts and document callbacks.');
    const id = `travel-account-${++sequence}`;
    let destroyed = false, configured = null, sessionPending = true, sessionFailed = false, user = null;
    let epoch = 0, listVersion = 0, operation = 0, attachment = 0, draftVersion = 0, dirty = true;
    let currentPlan = null, plans = [], listPending = false, listError = '', savePending = false, initialReported = false;
    let attachmentState = 'none';
    let planSort = 'updated';
    let dialogVersion = 0, dialogBusy = false, dialogControls = [], returnFocus = null;
    let verifying = false, verifyAgain = false, probingVisibility = false, signalVersion = 0;
    const sessionSignalKey = 'gil-account-session-change';
    const socialPendingKey = 'gil-social-login-pending';
    let channel = null;
    try { if (typeof window.BroadcastChannel === 'function') channel = new window.BroadcastChannel(sessionSignalKey); } catch (_error) {}
    const requests = new Set();
    const node = (tag, className = '', text = '') => {
      const result = document.createElement(tag); result.className = className; if (text) result.textContent = text; return result;
    };
    const button = (text, action, className = '') => {
      const result = node('button', `account-button ${className}`.trim(), text); result.type = 'button'; result.addEventListener('click', action); return result;
    };
    const nav = node('div', 'account-nav'); accountRoot.replaceChildren(nav);
    const library = node('section', 'account-library'); libraryRoot.replaceChildren(library);
    const saveActions = node('div', 'account-save-actions'); saveRoot.replaceChildren(saveActions);
    const backdrop = node('div', 'account-dialog-backdrop'); backdrop.hidden = true;
    const dialog = node('section', 'account-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', `${id}-title`); backdrop.append(dialog); document.body.append(backdrop);

    async function api(path, method = 'GET', body) {
      const controller = new AbortController(); requests.add(controller); let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, path === '/api/auth/session' ? 8000 : 15000);
      try {
        const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(/^\/api\/plans(?:\/|$)/.test(path) && user ? { 'X-Gil-Expected-User': user.id } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        let data;
        try { data = await response.json(); } catch (_error) { throw { status: response.status, code: 'INVALID_RESPONSE' }; }
        if (!response.ok) throw { status: response.status, code: typeof data?.error?.code === 'string' ? data.error.code : 'REQUEST_FAILED' };
        return data;
      } catch (error) {
        if (error?.status || error?.code) throw error;
        throw { code: timedOut ? 'TIMEOUT' : controller.signal.aborted ? 'ABORTED' : 'NETWORK_ERROR' };
      } finally { clearTimeout(timer); requests.delete(controller); }
    }
    function abortRequests() { for (const request of requests) request.abort(); }
    function announceSession() {
      const signal = { type: 'session-changed', nonce: `${Date.now()}-${++signalVersion}-${Math.random().toString(36).slice(2)}` };
      try {
        if (channel) channel.postMessage(signal);
        else localStorage.setItem(sessionSignalKey, signal.nonce);
      } catch (_error) { /* A blocked cross-tab signal never blocks sign-in. */ }
    }
    async function recheckSession() {
      if (destroyed) return;
      if (verifying) { verifyAgain = true; return; }
      verifying = true;
      do {
        verifyAgain = false;
        closeDialog(true);
        await resetAccount(null, { known: false });
        if (!destroyed) await initialize();
      } while (!destroyed && verifyAgain);
      verifying = false;
    }
    function sessionSignal(event) { if (event.data?.type === 'session-changed') recheckSession(); }
    function storageSignal(event) { if (event.key === sessionSignalKey && event.newValue) recheckSession(); }
    async function probeSession() {
      if (destroyed || sessionPending || probingVisibility) return;
      const account = epoch; probingVisibility = true;
      try {
        const data = await api('/api/auth/session');
        if (destroyed || account !== epoch) return;
        if (typeof data?.configured !== 'boolean' || data.user !== null && !validUser(data.user)) return;
        const next = data.configured ? data.user : null;
        const availabilityChanged = configured !== data.configured || sessionFailed;
        configured = data.configured; sessionFailed = false;
        if ((user?.id || null) === (next?.id || null)) {
          if (availabilityChanged) { closeDialog(true); render(); }
          return;
        }
        closeDialog(true); await resetAccount(next);
      } catch (_error) { /* A failed probe does not replace a known session or its working draft. */ }
      finally { probingVisibility = false; }
    }
    function visibility() { if (document.visibilityState === 'visible') probeSession(); }
    function notify(text, kind = 'info') { if (!destroyed) onMessage(text, kind); }
    function planMetadata(plan) {
      return Object.fromEntries(['id', 'title', 'cityId', 'startDate', 'dayCount', 'revision', 'createdAt', 'updatedAt'].map(key => [key, plan[key]]));
    }
    function getAttachment() { return user && currentPlan ? { ownerId: user.id, plan: planMetadata(currentPlan) } : null; }
    function attachmentChanged() {
      try {
        if (onAttachmentChange(getAttachment()) === false) throw new Error('Attachment persistence failed');
        return true;
      } catch (_error) {
        notify('계획의 저장 연결을 이 기기에 기록하지 못했어요. 현재 노트는 그대로예요.', 'error');
        return false;
      }
    }
    async function verifyAttachment() {
      if (!user || !currentPlan || destroyed) return { ok: false, reason: 'invalid' };
      const account = epoch, link = attachment, original = planMetadata(currentPlan);
      attachmentState = 'checking'; renderSave();
      try {
        const data = await api(`/api/plans/${encodeURIComponent(original.id)}`);
        if (!sameAccount(account) || link !== attachment) return { ok: false, reason: 'invalid' };
        if (!validPlan(data?.plan) || data.plan.id !== original.id) throw { code: 'INVALID_RESPONSE' };
        // Keep the revision used by the local draft. Adopting a newer revision
        // here would silently overwrite changes saved from another device.
        attachmentState = data.plan.revision === original.revision ? 'ready' : 'conflict';
        renderSave();
        return { ok: attachmentState === 'ready', ...(attachmentState === 'ready' ? {} : { reason: 'conflict' }) };
      } catch (error) {
        if (!sameAccount(account) || link !== attachment) return { ok: false, reason: 'invalid' };
        if (error.code === 'SESSION_CHANGED') {
          await recheckSession();
          notify('로그인 계정이 바뀌어 저장 연결을 다시 확인했어요. 원래 계정의 노트는 그 계정으로 로그인해 확인해 주세요.', 'error');
          return { ok: false, reason: 'invalid' };
        }
        if (error.status === 404 || error.status === 403) {
          attachment++; currentPlan = null; attachmentState = 'none'; dirty = true;
          const persisted = attachmentChanged(); renderSave();
          notify(persisted ? '연결했던 계획을 계정에서 찾지 못했어요. 이 기기 노트는 유지했어요. 필요하면 새 계획으로 저장해 주세요.'
            : '연결했던 계획을 찾지 못했어요. 노트는 유지했지만 이 기기에 연결 해제를 기록하지 못했어요.', persisted ? 'info' : 'error');
          return { ok: false, reason: 'missing' };
        }
        attachmentState = 'unavailable'; renderSave();
        return { ok: false, reason: 'unavailable' };
      }
    }
    async function restoreAttachment(snapshot) {
      if (destroyed || !user || !snapshot || snapshot.ownerId !== user.id || !validPlan(snapshot.plan)) {
        return { ok: false, reason: snapshot?.ownerId && snapshot.ownerId !== user?.id ? 'not-owned' : 'invalid' };
      }
      attachment++; currentPlan = planMetadata(snapshot.plan); dirty = true;
      return verifyAttachment();
    }
    function sameAccount(value) { return !destroyed && value === epoch && Boolean(user); }
    async function resetAccount(next, { initial = false, known = true, socialReturn = false } = {}) {
      const previousUser = user ? { ...user } : null;
      epoch++; operation++; attachment++; listVersion++; abortRequests();
      const transition = epoch;
      user = next ? { id: next.id, username: next.username } : null;
      currentPlan = null; attachmentState = 'none'; plans = []; planSort = 'updated'; dirty = true; savePending = false; listPending = false; listError = ''; sessionPending = true;
      render();
      try { await onUserChange(known ? user : undefined, { initial, previousUser, socialReturn }); }
      catch (_error) { if (!destroyed && transition === epoch) notify('이 기기 노트를 준비하지 못했어요. 새로고침 후 다시 확인해 주세요.', 'error'); }
      if (destroyed || transition !== epoch) return false;
      sessionPending = false; render();
      if (user) refreshPlans();
      return true;
    }
    function closeDialog(force = false) {
      if (dialogBusy && !force) return;
      dialogVersion++; dialogBusy = false; dialogControls = []; backdrop.hidden = true; dialog.replaceChildren();
      if (returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus({ preventScroll: true });
      else nav.querySelector('button')?.focus({ preventScroll: true });
      returnFocus = null;
    }
    function openDialog(title, copy = '') {
      if (destroyed) return null;
      if (backdrop.hidden) returnFocus = document.activeElement;
      dialogVersion++; dialogBusy = false; dialogControls = []; dialog.replaceChildren(); backdrop.hidden = false;
      const header = node('div', 'account-dialog-heading'), heading = node('h2', 'account-dialog-title', title); heading.id = `${id}-title`;
      const close = button('×', () => closeDialog(), 'account-dialog-close'); close.setAttribute('aria-label', '창 닫기');
      header.append(heading, close); dialog.append(header); dialogControls.push(close);
      if (copy) dialog.append(node('p', 'account-dialog-copy', copy));
      const message = node('p', 'account-dialog-message'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
      const version = dialogVersion;
      return { version, message,
        error(text) { if (version === dialogVersion) { message.textContent = text; message.className = 'account-dialog-message is-error'; } },
        busy(value) { if (version === dialogVersion) { dialogBusy = value; dialogControls.forEach(control => { control.disabled = value; }); dialog.setAttribute('aria-busy', String(value)); } },
        current() { return !destroyed && version === dialogVersion; },
        input(form, caption, className, type = 'text') {
          const label = node(type === 'password' ? 'div' : 'label', 'account-dialog-field'), input = node('input', className); input.type = type;
          if (type === 'password') {
            input.id = `${id}-${className}`;
            const captionLabel = node('label', '', caption); captionLabel.setAttribute('for', input.id);
            const control = node('div', 'account-password-control');
            const toggle = button('보기', () => {
              const showing = input.type === 'password'; input.type = showing ? 'text' : 'password';
              toggle.textContent = showing ? '숨기기' : '보기';
              toggle.setAttribute('aria-label', `${caption} ${showing ? '숨기기' : '보기'}`);
              toggle.setAttribute('aria-pressed', String(showing));
            }, 'account-password-toggle');
            toggle.setAttribute('aria-label', `${caption} 보기`); toggle.setAttribute('aria-pressed', 'false'); toggle.setAttribute('aria-controls', input.id);
            control.append(input, toggle); label.append(captionLabel, control); dialogControls.push(toggle);
          } else label.append(node('span', '', caption), input);
          form.append(label); dialogControls.push(input); return input;
        },
        action(host, text, callback, className = '') { const result = button(text, callback, className); host.append(result); dialogControls.push(result); return result; }
      };
    }
    function renderNav() {
      nav.replaceChildren();
      if (sessionPending) { const pending = button('계정 확인 중…', () => {}); pending.disabled = true; nav.append(pending); return; }
      if (user) { nav.append(node('span', 'account-user', user.username), button('로그아웃', logout)); return; }
      nav.append(button(sessionFailed ? '계정 다시 확인' : configured === false ? '계정 저장 준비 중' : '로그인 · 회원가입', () => sessionFailed ? initialize() : authDialog('login')));
    }
    function renderSave() {
      saveActions.replaceChildren();
      const save = button(currentPlan ? attachmentState === 'unavailable' ? '저장 연결 다시 확인' : '변경사항 저장' : configured === false ? '계정 저장 준비 중' : '계획표 저장', () => saveDialog(false), 'is-primary');
      save.disabled = sessionPending || savePending || attachmentState === 'checking'; saveActions.append(save);
      if (currentPlan) { const copy = button('새 계획으로 저장', () => saveDialog(true)); copy.disabled = savePending; saveActions.append(copy); }
      const status = node('p', 'account-save-status', currentPlan ? attachmentState === 'checking' ? '원래 저장한 계획과 연결을 확인하고 있어요.'
        : attachmentState === 'unavailable' ? '저장 연결을 확인하지 못했어요. 다시 확인하면 기존 계획에 이어 저장할 수 있어요.'
          : attachmentState === 'conflict' ? '다른 기기에서 계획이 바뀌었어요. 저장하기 전에 최신 내용을 확인해 주세요.'
            : dirty ? '계정에 저장하지 않은 수정이 있어요.' : '계정에 저장했어요.' : '이 기기 자동저장은 그대로 유지돼요.');
      saveActions.append(status);
    }
    function renderLibrary() {
      library.replaceChildren();
      if(noticeRoot){
        noticeRoot.replaceChildren();
        noticeRoot.hidden=Boolean(user);
        libraryRoot.hidden=!user;
        if(!user){
          const notice=node('aside','account-notice');
          notice.setAttribute('aria-label','계획 저장 안내');
          notice.append(node('span','account-notice-label','안내'));
          const copy=node('p','account-notice-copy',sessionPending?'계정을 확인하고 있어요.':configured===false?'계정 저장을 준비 중이에요. 이 기기에서는 계속 편집할 수 있어요.':sessionFailed?'계정에 연결하지 못했어요. 잠시 후 다시 확인해 주세요.':'로그인하면 다른 기기에서도 내 계획을 불러올 수 있어요.');
          copy.setAttribute('role','status');
          notice.append(copy);
          if(!sessionPending)notice.append(button(sessionFailed||configured===false?'다시 확인':'로그인',()=>sessionFailed||configured===false?initialize():authDialog('login'),'account-notice-link'));
          noticeRoot.append(notice);
          return;
        }
      }
      const header = node('div', 'account-library-heading'); header.append(node('h2', '', '저장한 계획'));
      if (user) { const refresh = button('새로고침', refreshPlans); refresh.disabled = listPending; header.append(refresh); }
      library.append(header);
      const message = node('p', `account-library-message${listError ? ' is-error' : ''}`);
      message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
      message.textContent = sessionPending ? '계정을 확인하고 있어요.' : configured === false ? '계정 저장을 준비 중이에요. 이 기기에서는 계속 편집할 수 있어요.'
        : sessionFailed ? '계정에 연결하지 못했어요. 위에서 다시 확인해 주세요.' : !user ? '로그인하면 다른 기기에서도 저장한 계획을 불러올 수 있어요.'
          : listPending ? '저장한 계획을 불러오고 있어요.' : listError || (!plans.length ? '아직 계정에 저장한 계획이 없어요.' : '');
      library.append(message);
      if (!user) return;
      const sortLabel = node('label', 'account-sort', '계획 정렬');
      const sort = node('select', 'account-sort-select'); sort.setAttribute('aria-label', '저장한 계획 정렬');
      for (const [value, label] of [['updated', '최근 수정순'], ['start', '여행 시작일 빠른순']]) {
        const option = node('option', '', label); option.value = value; sort.append(option);
      }
      sort.value = planSort;
      sort.addEventListener('change', () => {
        planSort = sort.value === 'start' ? 'start' : 'updated'; renderLibrary();
        library.querySelector('.account-sort-select')?.focus({ preventScroll: true });
      });
      sortLabel.append(sort); library.append(sortLabel);
      const list = node('ul', 'account-plan-list'); list.setAttribute('aria-label', '계정에 저장한 여행 계획');
      const ordered = [...plans].sort((a, b) => (planSort === 'start' ? a.startDate.localeCompare(b.startDate) : 0)
        || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
      for (const plan of ordered) {
        const card = node('li', 'account-plan-card'), copy = node('div', 'account-plan-copy'), actions = node('div', 'account-plan-actions');
        const cityName = window.TRAVEL_DATA?.cities?.[plan.cityId]?.name || '국내 여행';
        copy.append(node('strong', 'account-plan-title', plan.title), node('span', 'account-plan-meta', `${cityName} · ${plan.startDate}부터 ${plan.dayCount}일 · 수정 ${new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(plan.updatedAt))}`));
        actions.append(button('불러오기', () => confirmLoad(plan)), button('삭제', () => confirmDelete(plan), 'is-danger'));
        card.append(copy, actions); list.append(card);
      }
      library.append(list);
    }
    function render() { renderNav(); renderSave(); renderLibrary(); }
    async function initialize() {
      if (destroyed) return;
      const version = ++epoch; sessionPending = true; sessionFailed = false; render();
      try {
        const data = await api('/api/auth/session');
        if (destroyed || version !== epoch) return;
        if (typeof data?.configured !== 'boolean' || data.user !== null && !validUser(data.user)) throw { code: 'INVALID_RESPONSE' };
        configured = data.configured;
        const initial = !initialReported; initialReported = true;
        const next = configured ? data.user : null;
        await resetAccount(next, { initial, socialReturn: initial && consumeSocialPending(next) });
      } catch (_error) {
        if (destroyed || version !== epoch) return;
        sessionFailed = true;
        const initial = !initialReported; initialReported = true;
        // A failed guest setup check is not an identity change. Keep its working
        // note and edit history; known account drafts still use the reset below.
        if (!initial && !user) { sessionPending = false; render(); return; }
        if (initial) consumeSocialPending(null);
        await resetAccount(null, { initial, known: false });
      }
    }
    async function refreshPlans() {
      if (!user || destroyed) return;
      const account = epoch, version = ++listVersion; listPending = true; listError = ''; renderLibrary();
      try {
        const data = await api('/api/plans');
        if (!sameAccount(account) || version !== listVersion) return;
        if (!Array.isArray(data?.plans) || data.plans.length > 500 || data.plans.some(plan => !validPlan(plan))) throw { code: 'INVALID_RESPONSE' };
        plans = data.plans.map(plan => ({ ...plan }));
      } catch (error) {
        if (!sameAccount(account) || version !== listVersion) return;
        if (error.code === 'SESSION_CHANGED') {
          await recheckSession(); notify('로그인 계정이 바뀌어 저장한 계획 목록을 다시 확인했어요.', 'info'); return;
        }
        listError = errorText(error, '저장한 계획을 불러오지 못했어요. 다시 시도해 주세요.');
        if (error.status === 401) { closeDialog(true); await resetAccount(null); notify('로그인이 만료됐어요. 다시 로그인해 주세요.', 'error'); return; }
      } finally { if (sameAccount(account) && version === listVersion) { listPending = false; renderLibrary(); } }
    }
    function socialReturnTo() {
      const hash = window.location?.hash;
      return typeof hash === 'string' && /^#\/(?:start|note(?:\/day\/[1-7])?)$/.test(hash) ? `/${hash}` : '/#/start';
    }
    function consumeSocialPending(next) {
      try {
        const result = new URLSearchParams(window.location?.search || '').get('social');
        if (result !== 'success' && result !== 'failed') return false;
        let pending = null;
        try { pending = JSON.parse(window.sessionStorage.getItem(socialPendingKey) || 'null'); }
        finally { window.sessionStorage.removeItem(socialPendingKey); }
        return result === 'success' && Boolean(next) && pending?.returnTo === socialReturnTo()
          && Number.isSafeInteger(pending.at) && pending.at <= Date.now() && Date.now() - pending.at <= 10 * 60 * 1000;
      } catch (_error) { return false; }
    }
    async function socialOptions(view, host) {
      try {
        const data = await api('/api/auth/providers');
        if (!view.current() || data?.configured !== true || !Array.isArray(data.providers) || data.providers.length > 3) return;
        const labels = { google: 'Google', kakao: '카카오', naver: '네이버' }, seen = new Set();
        for (const provider of data.providers) {
          if (!provider || !Object.hasOwn(labels, provider.id) || seen.has(provider.id) || provider.startUrl !== `/api/auth/oauth/${provider.id}/start`) return;
          seen.add(provider.id);
        }
        for (const provider of data.providers) {
          view.action(host, `${labels[provider.id]}로 계속하기`, () => {
            if (!view.current() || dialogBusy) return;
            const returnTo = socialReturnTo(), destination = `${provider.startUrl}?returnTo=${encodeURIComponent(returnTo)}`;
            try { window.sessionStorage.setItem(socialPendingKey, JSON.stringify({ returnTo, at: Date.now() })); }
            catch (_error) { view.error('작성 중인 노트를 안전하게 이어갈 수 있도록 브라우저 저장을 허용한 뒤 다시 시도해 주세요.'); return; }
            try { window.location.assign(destination); }
            catch (_error) {
              try { window.sessionStorage.removeItem(socialPendingKey); } catch (_ignored) {}
              view.error('로그인 화면을 열지 못했어요. 잠시 후 다시 시도해 주세요.');
            }
          }, `account-social-button account-social-${provider.id}`);
        }
        host.hidden = data.providers.length === 0;
      } catch (_error) { /* Optional social sign-in never blocks the password form. */ }
    }
    function consumeSocialResult() {
      try {
        if (!window.location?.search || !window.history?.replaceState) return;
        const query = new URLSearchParams(window.location.search), result = query.get('social');
        if (result !== 'success' && result !== 'failed') return;
        query.delete('social');
        const remaining = query.toString();
        if (result === 'success' && user) announceSession();
        window.history.replaceState(window.history.state, '', `${window.location.pathname || '/'}${remaining ? `?${remaining}` : ''}${window.location.hash || ''}`);
        notify(result === 'success' && user ? '로그인했어요.' : '소셜 로그인을 완료하지 못했어요. 다시 시도하거나 아이디로 로그인해 주세요.', result === 'success' && user ? 'success' : 'error');
      } catch (_error) { /* A blocked history update must not interrupt account initialization. */ }
    }
    function authDialog(mode = 'login', afterLogin = null) {
      const view = openDialog(mode === 'signup' ? '회원가입' : '로그인', '내 계정으로 여행 계획을 저장하고 다른 기기에서 불러와요.'); if (!view) return;
      if (configured === false) {
        view.error('계정 저장을 준비 중이에요. 지금은 이 기기에서 계속 편집해 주세요.');
        const actions = node('div', 'account-dialog-actions');
        view.action(actions, '다시 확인', async () => {
          if (!view.current() || dialogBusy) return;
          view.busy(true);
          await initialize();
          if (!view.current()) return;
          if (user) { closeDialog(true); return; }
          if (sessionFailed) { view.error('계정에 연결하지 못했어요. 잠시 후 다시 확인해 주세요.'); view.busy(false); return; }
          authDialog(mode, afterLogin);
        });
        dialog.append(view.message, actions);
        return;
      }
      const tabs = node('div', 'account-dialog-tabs');
      for (const [key, label] of [['login', '로그인'], ['signup', '회원가입']]) {
        const tab = view.action(tabs, label, () => { if (!dialogBusy) authDialog(key, afterLogin); }); tab.setAttribute('aria-pressed', String(mode === key));
      }
      const form = node('form', 'account-dialog-form'); form.noValidate = true;
      const name = view.input(form, '아이디', 'account-username'); name.autocomplete = 'username'; name.maxLength = 24; name.spellcheck = false; name.autocapitalize = 'none';
      const password = view.input(form, '비밀번호', 'account-password', 'password'); password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password'; password.maxLength = 128;
      const confirmation = mode === 'signup' ? view.input(form, '비밀번호 확인', 'account-password-confirm', 'password') : null;
      if (confirmation) { confirmation.autocomplete = 'new-password'; confirmation.maxLength = 128; }
      if (mode === 'signup') form.append(node('p', 'account-dialog-copy', '아이디는 영문·숫자·밑줄 3~24자, 비밀번호는 10자 이상으로 정해 주세요.'));
      const actions = node('div', 'account-dialog-actions'), submit = view.action(actions, mode === 'signup' ? '가입하고 시작하기' : '로그인', () => {}, 'is-primary'); submit.type = 'submit'; form.append(actions);
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (!view.current() || dialogBusy) return;
        const username = name.value.trim().toLowerCase(), secret = password.value;
        if (!usernameValid(username)) { view.error('아이디는 영문·숫자·밑줄 3~24자로 입력해 주세요.'); name.focus(); return; }
        if (secret.length < 10 || secret.length > 128) { view.error('비밀번호는 10~128자로 입력해 주세요.'); password.focus(); return; }
        if (confirmation && secret !== confirmation.value) { view.error('비밀번호 확인이 일치하지 않아요.'); confirmation.focus(); return; }
        const account = epoch; view.busy(true);
        try {
          const data = await api(`/api/auth/${mode}`, 'POST', { username, password: secret });
          if (!view.current() || account !== epoch) return;
          if (!validUser(data?.user)) throw { code: 'INVALID_RESPONSE' };
          password.value = ''; if (confirmation) confirmation.value = '';
          if (!await resetAccount(data.user)) return;
          announceSession();
          closeDialog(true); notify(mode === 'signup' ? '회원가입했어요.' : '로그인했어요.', 'success');
          if (afterLogin) afterLogin();
        } catch (error) {
          if (!view.current() || account !== epoch) return;
          view.error(error.status === 409 ? '이미 사용 중인 아이디예요. 다른 아이디를 입력해 주세요.'
            : error.status === 401 ? '아이디나 비밀번호를 확인해 주세요.' : errorText(error, '계정에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'));
        } finally { view.busy(false); }
      });
      const social = node('div', 'account-social-options'); social.hidden = true; social.setAttribute('aria-label', '소셜 계정으로 로그인');
      dialog.append(social, tabs, form, view.message); socialOptions(view, social); name.focus({ preventScroll: true });
    }
    async function logout() {
      if (!user || destroyed) return;
      const account = epoch;
      try { await api('/api/auth/logout', 'POST', {}); if (!sameAccount(account)) return; closeDialog(true); await resetAccount(null); announceSession(); notify('로그아웃했어요. 다음 로그인에서 내 노트를 다시 불러올 수 있어요.'); }
      catch (error) { if (sameAccount(account)) notify(errorText(error, '로그아웃하지 못했어요. 다시 시도해 주세요.'), 'error'); }
    }
    async function saveDialog(asNew) {
      if (destroyed || savePending) return;
      if (!user) { authDialog('login', () => saveDialog(asNew)); return; }
      if (!asNew && currentPlan) {
        if (attachmentState === 'checking') return;
        if (attachmentState === 'unavailable') {
          const checked = await verifyAttachment();
          if (destroyed || !user) return;
          if (!checked.ok && checked.reason === 'unavailable') { notify('저장 연결을 확인하지 못했어요. 현재 노트는 유지했어요. 잠시 후 다시 확인해 주세요.', 'error'); return; }
          if (!checked.ok && checked.reason !== 'conflict') return;
        }
        if (attachmentState === 'conflict') { conflictDialog(currentPlan); return; }
      }
      let suggested;
      try { copyDocument(getDocument()); suggested = !asNew && currentPlan ? currentPlan.title : getDefaultTitle(); }
      catch (error) { notify(errorText(error, '저장할 여행 노트를 확인해 주세요.'), 'error'); return; }
      const updating = !asNew && currentPlan;
      const view = openDialog(updating ? '계획표 변경사항 저장' : '계획표 저장', '이름을 정해 계정에 저장해요. 이 기기의 자동저장도 유지돼요.');
      const form = node('form', 'account-dialog-form'); form.noValidate = true;
      const title = view.input(form, '계획표 이름', 'account-plan-name'); title.maxLength = 80; title.value = line(suggested, 80) ? suggested : '나의 여행 계획';
      const actions = node('div', 'account-dialog-actions');
      view.action(actions, '취소', () => closeDialog()); const submit = view.action(actions, updating ? '변경사항 저장' : '계정에 저장', () => {}, 'is-primary'); submit.type = 'submit'; form.append(actions);
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (!view.current() || dialogBusy || !user) return;
        if (!line(title.value, 80)) { view.error('계획표 이름을 1~80자로 입력해 주세요.'); title.focus(); return; }
        let snapshot;
        try { snapshot = copyDocument(getDocument()); } catch (error) { view.error(errorText(error, '여행 노트를 확인해 주세요.')); return; }
        const account = epoch, edited = draftVersion, link = attachment, previous = updating ? { ...currentPlan } : null;
        savePending = true; renderSave(); view.busy(true);
        try {
          const data = await api(previous ? `/api/plans/${encodeURIComponent(previous.id)}` : '/api/plans', previous ? 'PUT' : 'POST',
            { title: title.value.trim(), document: snapshot, ...(previous ? { revision: previous.revision } : {}) });
          if (!sameAccount(account)) return;
          if (!validPlan(data?.plan)) throw { code: 'INVALID_RESPONSE' };
          let persisted = true;
          if (link === attachment) { currentPlan = planMetadata(data.plan); attachmentState = 'ready'; dirty = draftVersion !== edited; persisted = attachmentChanged(); }
          closeDialog(true); renderSave(); refreshPlans();
          notify(!persisted ? '계정에는 저장했어요. 현재 화면의 저장 연결은 유지되지만 이 기기에 기록하지 못했어요. 새로고침 후에는 계정의 계획을 다시 불러와 주세요.'
            : link !== attachment ? '이전 작업을 계정에 저장했어요. 현재 노트는 그대로예요.' : dirty ? '저장했어요. 이후 수정한 내용은 한 번 더 저장해 주세요.' : '계정에 계획표를 저장했어요.', persisted ? 'success' : 'error');
        } catch (error) {
          if (!sameAccount(account) || !view.current()) return;
          if (error.code === 'SESSION_CHANGED') {
            closeDialog(true); await recheckSession();
            notify('로그인 계정이 바뀌어 저장하지 않았어요. 원래 계정으로 다시 로그인해 작성하던 이 기기 초안을 확인해 주세요.', 'error'); return;
          }
          if (error.status === 401) { closeDialog(true); await resetAccount(null); notify(errorText(error), 'error'); return; }
          if (error.status === 409 && previous) { attachmentState = 'conflict'; renderSave(); conflictDialog(previous); return; }
          view.error(errorText(error, '계획표를 저장하지 못했어요. 현재 노트는 그대로예요.'));
        } finally { if (sameAccount(account)) { savePending = false; renderSave(); } view.busy(false); }
      });
      dialog.append(form, view.message); title.focus({ preventScroll: true });
    }
    function conflictDialog(plan) {
      const view = openDialog('다른 기기에서 바뀐 계획이에요', '지금 작성한 내용을 새 계획으로 저장하거나, 계정의 최신 계획을 다시 불러올 수 있어요.');
      const actions = node('div', 'account-dialog-actions');
      view.action(actions, '돌아가기', () => closeDialog());
      view.action(actions, '최신 계획 불러오기', () => confirmLoad(plan));
      view.action(actions, '새 계획으로 저장', () => saveDialog(true), 'is-primary'); dialog.append(actions, view.message);
      actions.querySelector('button')?.focus({preventScroll:true});
    }
    function confirmLoad(plan) {
      if (!user || destroyed) return;
      const view = openDialog('계획표를 불러올까요?', `‘${plan.title}’을 불러오면 현재 작업 중인 노트와 이 기기 자동저장본이 바뀌어요.`);
      const actions = node('div', 'account-dialog-actions'); view.action(actions, '취소', () => closeDialog());
      view.action(actions, '불러오기', async () => {
        if (!view.current() || dialogBusy) return;
        const account = epoch, task = ++operation, edited = draftVersion; view.busy(true);
        const isCurrent = () => sameAccount(account) && task === operation && edited === draftVersion;
        try {
          const data = await api(`/api/plans/${encodeURIComponent(plan.id)}`);
          if (!sameAccount(account) || task !== operation || !view.current()) return;
          if (!isCurrent()) { view.error('불러오는 동안 노트가 바뀌었어요. 현재 내용을 확인한 뒤 다시 선택해 주세요.'); return; }
          if (!validPlan(data?.plan)) throw { code: 'INVALID_RESPONSE' };
          const snapshot = copyDocument(data.plan.document);
          const restored = await loadDocument(snapshot, { isCurrent });
          if (!sameAccount(account) || task !== operation || !view.current()) return;
          if (restored !== true && restored?.ok !== true) { view.error('계획표를 불러오지 못했어요. 현재 노트는 그대로 유지했어요.'); return; }
          attachment++; currentPlan = planMetadata(data.plan); attachmentState = 'ready'; dirty = false;
          const persisted = attachmentChanged();
          const warning = restored?.warning || (!persisted ? '계정의 계획을 열었어요. 현재 화면의 저장 연결은 유지되지만 이 기기에 기록하지 못했어요. 새로고침 후에는 계정의 계획을 다시 불러와 주세요.' : '');
          closeDialog(true); renderSave(); notify(warning || '계정에 저장한 계획표를 불러왔어요.', warning ? 'error' : 'success');
        } catch (error) {
          if (!sameAccount(account) || !view.current()) return;
          if (error.code === 'SESSION_CHANGED') {
            closeDialog(true); await recheckSession();
            notify('로그인 계정이 바뀌어 계획을 불러오지 않았어요. 계정을 다시 확인한 뒤 선택해 주세요.', 'error'); return;
          }
          if (error.status === 401) { closeDialog(true); await resetAccount(null); notify(errorText(error), 'error'); return; }
          view.error(errorText(error, '계획표를 불러오지 못했어요. 현재 노트는 그대로예요.'));
        }
        finally { view.busy(false); }
      }, 'is-primary'); dialog.append(actions, view.message);
      actions.querySelector('button')?.focus({preventScroll:true});
    }
    function confirmDelete(plan) {
      if (!user || destroyed) return;
      const view = openDialog('저장한 계획표를 삭제할까요?', `계정의 ‘${plan.title}’을 삭제해요. 지금 편집 중인 이 기기 노트는 유지돼요.`);
      const actions = node('div', 'account-dialog-actions'); view.action(actions, '취소', () => closeDialog());
      view.action(actions, '삭제', async () => {
        if (!view.current() || dialogBusy) return;
        const account = epoch; view.busy(true);
        try {
          const data = await api(`/api/plans/${encodeURIComponent(plan.id)}`, 'DELETE', { revision: plan.revision });
          if (!sameAccount(account) || !view.current()) return;
          if (data?.ok !== true) throw { code: 'INVALID_RESPONSE' };
          let persisted = true;
          if (currentPlan?.id === plan.id) { attachment++; currentPlan = null; attachmentState = 'none'; dirty = true; persisted = attachmentChanged(); renderSave(); }
          closeDialog(true); refreshPlans(); notify(persisted ? '계정에서 계획표를 삭제했어요. 이 기기 노트는 유지했어요.'
            : '계정에서 계획표를 삭제했어요. 노트는 유지했지만 이 기기에 연결 해제를 기록하지 못했어요.', persisted ? 'success' : 'error');
        } catch (error) {
          if (!sameAccount(account) || !view.current()) return;
          if (error.status === 401) { closeDialog(true); await resetAccount(null); notify(errorText(error), 'error'); return; }
          if (error.code === 'SESSION_CHANGED') {
            closeDialog(true); await recheckSession();
            notify('로그인 계정이 바뀌어 삭제하지 않았어요. 계정을 다시 확인한 뒤 선택해 주세요.', 'error'); return;
          }
          view.error(error.status === 409 ? '다른 기기에서 계획이 바뀌었어요. 목록을 새로고침한 뒤 다시 선택해 주세요.' : errorText(error, '계획표를 삭제하지 못했어요. 다시 시도해 주세요.'));
        }
        finally { view.busy(false); }
      }, 'is-danger'); dialog.append(actions, view.message);
      actions.querySelector('button')?.focus({preventScroll:true});
    }
    function keydown(event) {
      if (backdrop.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); closeDialog(); return; }
      if (event.key !== 'Tab') return;
      const controls = dialogControls.filter(control => !control.disabled), first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    function outside(event) { if (event.target === backdrop) closeDialog(); }
    document.addEventListener('keydown', keydown); document.addEventListener('visibilitychange', visibility); backdrop.addEventListener('pointerdown', outside);
    channel?.addEventListener('message', sessionSignal); window.addEventListener('storage', storageSignal);
    render(); const ready = initialize().then(consumeSocialResult);
    return {
      ready,
      changed() { if (!destroyed) { draftVersion++; dirty = true; renderSave(); } },
      detach() { if (!destroyed) { attachment++; operation++; currentPlan = null; attachmentState = 'none'; dirty = true; attachmentChanged(); renderSave(); } },
      getAttachment,
      restoreAttachment,
      setCurrentPlan(plan) { if (!destroyed && user && validPlan(plan)) { attachment++; currentPlan = planMetadata(plan); attachmentState = 'ready'; dirty = false; attachmentChanged(); renderSave(); } },
      destroy() {
        if (destroyed) return;
        destroyed = true; epoch++; operation++; abortRequests(); dialogVersion++;
        document.removeEventListener('keydown', keydown); document.removeEventListener('visibilitychange', visibility);
        window.removeEventListener('storage', storageSignal); channel?.removeEventListener('message', sessionSignal); channel?.close();
        backdrop.removeEventListener('pointerdown', outside); backdrop.remove();
        accountRoot.replaceChildren(); libraryRoot.replaceChildren(); saveRoot.replaceChildren(); user = null; plans = []; currentPlan = null;
        if(noticeRoot){noticeRoot.replaceChildren();noticeRoot.hidden=true;}
      }
    };
  }
  window.TravelAccount = { mount };
})();

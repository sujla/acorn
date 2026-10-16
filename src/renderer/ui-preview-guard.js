// Injected before project scripts, only in Acorn's temporary UI preview server.
(() => {
  const config = window.__ACORN_UI_PREVIEW__;
  if (!config) return;
  const state = window.__ACORN_UI_STATE__ = { errors: 0, unavailable: false };
  const visualProfile = {
    owner: 'none', name: 'Preview User', ageRange: 'Adult · 4–7', energy: 'Balanced', dogs: 'Needs time', people: 'Friendly',
    activities: ['Quiet walks'], talents: [], training: 'Practiced at home', proud: [], customTalent: '', customProud: '',
    days: '3–4', duration: '30–60 min', times: ['Evening or night'], photos: [], meetingAreas: [],
    area: { id: 'orchard', source: 'manual', confirmedAt: '2026-01-01T00:00:00.000Z' },
  };
  const visualAccount = () => {
    if (location.pathname === '/' || location.pathname === '/phone') return null;
    const onboarding = location.pathname.match(/^\/onboarding\/([^/]+)/)?.[1];
    return { id: 'acorn-visual-preview', status: location.pathname === '/restricted' ? 'suspended' : 'active', step: onboarding || 'complete', profile: visualProfile };
  };
  // Expo source is transformed to pass state-bearing hook results through this
  // function. Normal previews receive the original value unchanged.
  globalThis.__ACORN_VISUAL_HOOK__ = (_hook, value, keys = []) => {
    if (!config.visual || !value || typeof value !== 'object') return value;
    const account = visualAccount();
    const identity = { id: account?.id || 'acorn-visual-preview', name: visualProfile.name };
    const samples = {
      account, user: identity, session: { authenticated: true, user: identity },
      profile: visualProfile, ready: true, loading: false, isLoading: false, authenticated: true, isAuthenticated: true,
      consent: { action: 'continue', at: '2026-01-01T00:00:00.000Z', termsVersion: 'preview', privacyVersion: 'preview' }, restoreError: '',
    };
    return { ...value, ...Object.fromEntries(keys.filter(key => Object.hasOwn(samples, key)).map(key => [key, samples[key]])) };
  };
  const send = (type, extra = {}) => parent.postMessage({ channel: 'acorn-ui-preview', type, ...extra }, '*');
  const reportedErrors = new Set();
  const reportError = value => {
    state.errors++;
    const message = String(value?.message || value || 'Unexpected preview error.').trim().slice(0, 1000);
    if (!message || reportedErrors.has(message)) return;
    reportedErrors.add(message);
    send('runtime-error', { message });
  };
  window.addEventListener('error', event => { if (event.error) reportError(event.error); });
  window.addEventListener('unhandledrejection', event => reportError(event.reason));
  const blocked = () => send('blocked');
  const deny = () => { blocked(); throw new DOMException('Unavailable in UI preview', 'NotAllowedError'); };
  // A project's back link may cancel its href and call history.back(). In a
  // sandboxed iframe, joint history can require traversing the sibling preview,
  // which Chromium refuses. Preserve the link's own destination as a fallback;
  // do not grant the preview permission to navigate its parent or sibling.
  let backLink = null;
  let backLinkTimer;
  const nativeBack = history.back.bind(history);
  history.back = function () {
    const href = backLink;
    if (!href || !window.navigation || parent === window) return nativeBack();
    const from = location.href;
    let fallbackStarted = false;
    const fallback = error => {
      if (fallbackStarted) return;
      if (['SecurityError', 'InvalidStateError'].includes(error.name) && location.href === from) {
        fallbackStarted = true;
        location.assign(href);
      }
    };
    const traversal = window.navigation.back();
    traversal.committed.catch(fallback);
    traversal.finished.catch(fallback);
  };
  const dataRequests = new Map();
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== 'acorn-data-response') return;
    const pending = dataRequests.get(event.data.id);
    if (!pending) return;
    dataRequests.delete(event.data.id);
    clearTimeout(pending.timer);
    const result = event.data.result;
    if (result?.error) pending.reject(new DOMException(result.error, 'NotAllowedError'));
    else pending.resolve(new Response(result.body, { status: result.status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
  });
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const method = (options.method || input?.method || 'GET').toUpperCase();
    const response = config.responses?.[`${method} ${url.pathname}${url.search}`];
    if (url.origin === location.origin && response) {
      const status = response.status || 200;
      return new Response([204, 205, 304].includes(status) ? null : JSON.stringify(response.body ?? null), { status, headers: { 'Content-Type': 'application/json', ...response.headers } });
    }
    if (config.dataBridge && url.origin !== location.origin && method === 'GET') {
      if (dataRequests.size >= 128) throw new Error('Too many pending data requests.');
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => { dataRequests.delete(id); reject(new Error('Preview data request timed out.')); }, 25000);
        dataRequests.set(id, { resolve, reject, timer });
        send('data-request', { id, url: url.href, method });
      });
    }
    send('needs-fixture', { method, path: url.pathname });
    throw new DOMException('Sample data needed for ' + method + ' ' + url.pathname, 'NotAllowedError');
  };
  XMLHttpRequest.prototype.send = deny;
  navigator.sendBeacon = () => { blocked(); return false; };
  // CSP blocks WebSocket/EventSource connections. Keep their native constructors
  // so development clients can handle connection failure without a synchronous throw.
  window.open = value => {
    try {
      const url = new URL(value, location.href);
      if (url.origin === location.origin && ['http:', 'https:'].includes(url.protocol)) { location.assign(url.href); return window; }
    } catch { /* Invalid destinations are blocked. */ }
    blocked(); return null;
  };
  const submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (this.method === 'dialog') return submit.call(this);
    return deny();
  };
  if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('Service workers are disabled in UI preview'));
  // Keep click/input/keyboard handlers and native validation. Stop only a form's
  // default network submission, after client-side submit handlers have run.
  window.addEventListener('submit', event => {
    if ((event.submitter?.formMethod || event.target.method) === 'dialog') return;
    if (!event.defaultPrevented) { event.preventDefault(); blocked(); }
  });
  window.addEventListener('click', event => {
    backLink = null;
    clearTimeout(backLinkTimer);
    if (config.adapter === 'acorn' && event.target.closest?.('#add-project, #empty-connect, #connect-local, #project-directory, #project-github')) {
      event.preventDefault(); event.stopImmediatePropagation(); blocked(); return;
    }
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin && ['http:', 'https:'].includes(url.protocol) && !link.hasAttribute('download')) {
      // External links cannot safely navigate a sandboxed preview. Preserve
      // target="_blank" semantics by asking Acorn to open a trusted click in
      // the system browser. Synthetic mirrored clicks must not launch it too.
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.isTrusted && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) send('external-link', { url: url.href });
      else blocked();
    } else if (!['http:', 'https:'].includes(url.protocol) || link.hasAttribute('download')) {
      event.preventDefault(); event.stopImmediatePropagation(); blocked();
    } else if (link.target && link.target !== '_self') {
      // Internal links stay inside this preview, including target="_blank" links.
      event.preventDefault(); location.assign(url.href);
    } else if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && url.href !== location.href) {
      backLink = url.href;
      backLinkTimer = setTimeout(() => { backLink = null; }, 0);
    }
  }, true);
  function applyAcornScreen() {
    const get = id => document.getElementById(id);
    const screen = config.screen;
    if (screen === 'workspace' || screen === 'settings-dialog') {
      get('app-shell')?.classList.remove('projects-loading');
      if (get('project-loading')) get('project-loading').hidden = true;
      if (get('connection-empty')) get('connection-empty').hidden = false;
      if (get('account-login')) get('account-login').textContent = 'UI preview';
      if (get('account-provider')) get('account-provider').textContent = 'No account connected';
    }
    if (screen === 'settings-dialog' && get(screen) && !get(screen).open) get(screen).showModal();
    document.documentElement.classList.remove('account-loading');
    if (!get(screen) && screen !== 'workspace') { state.unavailable = true; send('unavailable'); }
  }
  window.addEventListener('load', () => {
    if (config.adapter === 'acorn') applyAcornScreen();
    send('ready');
  }, { once: true });
})();

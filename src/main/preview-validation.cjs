const { randomUUID } = require('node:crypto');

// A source route is only a candidate. Check the actual guarded page before it is
// offered in the picker (HTTP errors, redirects, blank or failed renders excluded).
async function validateCatalog(BrowserWindow, previewUrl, catalog) {
  const candidates = catalog.pages.filter(page => page.available);
  const accepted = new Set();
  let next = 0;
  async function worker() {
    const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: `acorn-check-${randomUUID()}` } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.on('will-frame-navigate', event => {
      try { if (new URL(event.url).origin !== new URL(previewUrl).origin) event.preventDefault(); }
      catch { event.preventDefault(); }
    });
    try {
      while (next < candidates.length) {
        const page = candidates[next++];
        const url = new URL(page.previewPath || page.path, previewUrl);
        url.searchParams.set('__acorn_page', page.id);
        let timer;
        try {
          await window.loadURL('about:blank');
          await window.webContents.session.clearStorageData();
          const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
          const html = await response.text();
          if (!response.ok || !response.headers.get('content-type')?.includes('text/html') || !html.includes('__ACORN_UI_PREVIEW__')) continue;
          await Promise.race([
            window.loadURL(url.href),
            new Promise((_, reject) => { timer = setTimeout(() => { window.webContents.stop(); reject(new Error('Preview timed out')); }, 8000); }),
          ]);
          clearTimeout(timer);
          // Poll for client-rendered content; don't accept a blank SPA shell.
          for (let attempt = 0; attempt < 8; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 150));
            const state = await window.webContents.executeJavaScript(`(() => {
              const state = window.__ACORN_UI_STATE__;
              const visible = element => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
              const elements = [...document.body.querySelectorAll('h1,h2,h3,p,button,a,input,canvas,img,svg,[role="main"]')].filter(visible);
              const text = document.body.innerText.trim();
              return { ok: !!state && !state.unavailable && !state.errors, path: location.pathname, hash: location.hash,
                content: elements.length > 0 || text.length > 0,
                password: !![...document.querySelectorAll('input[type="password"]')].find(visible),
                busy: !![...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].find(visible)
              };
            })()`);
            if (!state.ok || state.path !== url.pathname || (url.hash && state.hash !== url.hash)) break;
            // A protected page which renders a login form in place is not that page.
            const loginPage = /login|log-in|signin|sign-in|signup|sign-up|register|password|auth/i.test(`${page.path} ${page.label} ${page.screen || ''}`);
            if (state.password && !loginPage) break;
            if (state.content && !state.busy && attempt >= 2) { accepted.add(page.id); break; }
          }
        } catch { /* Unavailable pages are not exposed as disabled choices. */ }
        finally { clearTimeout(timer); }
      }
    } finally { window.destroy(); }
  }
  await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, () => worker()));
  return { ...catalog, pages: candidates.filter(page => accepted.has(page.id)) };
}
module.exports = { validateCatalog };

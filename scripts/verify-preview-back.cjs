// Run with Electron. Uses an isolated profile and local fixture pages only.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { inject } = require('../src/main/ui-preview-server.cjs');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'acorn-back-test-')));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await pause(25); }
  throw new Error(message);
}
let guarded = false;
const server = http.createServer((request, response) => {
  const html = `<!doctype html><a id="next" href="/detail">Detail</a><a id="back" href="/">Back</a>
    <a id="external" href="https://example.com/">External</a><button id="modal">Modal back</button>
    <script>
    document.getElementById('back').onclick = event => { event.preventDefault(); history.back(); };
    document.getElementById('modal').onclick = () => history.back();
    </script>`;
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(guarded ? inject(html, {}) : html);
});
(async () => {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  const frame = side => window.webContents.mainFrame.frames.find(item => item.name === side);
  const run = (side, code) => frame(side).executeJavaScript(code);
  const click = (side, id) => run(side, `document.getElementById(${JSON.stringify(id)}).click(); void 0`);
  async function ready(side, pathname) {
    await until(() => run(side, `location.pathname === ${JSON.stringify(pathname)} && document.readyState === 'complete'`).catch(() => false), `${side} must reach ${pathname}`);
  }
  async function setup() {
    await window.loadURL('data:text/html,' + encodeURIComponent(['base', 'target'].map(side => `<iframe name="${side}" sandbox="allow-scripts allow-same-origin" src="${origin}/"></iframe>`).join('')));
    await ready('base', '/'); await ready('target', '/');
    await click('base', 'next'); await ready('base', '/detail');
    await click('target', 'next'); await ready('target', '/detail');
  }
  try {
    await setup();
    await click('base', 'back');
    await pause(150);
    assert.equal(await run('base', 'location.pathname'), '/detail', 'Reproduce native back blocked by sibling history');
    guarded = true;
    for (const side of ['base', 'target']) {
      await setup();
      await click(side, 'back');
      await ready(side, '/');
    }
    // A page opened directly still uses its link when no previous entry exists.
    await window.loadURL('data:text/html,' + encodeURIComponent(`<iframe name="base" sandbox="allow-scripts allow-same-origin" src="${origin}/detail"></iframe>`));
    await ready('base', '/detail');
    await click('base', 'back'); await ready('base', '/');
    // Ordinary same-document history remains native, including state/popstate.
    await run('base', `history.pushState({ modal: true }, '', '#modal'); window.popped = false; addEventListener('popstate', () => window.popped = true); void 0`);
    await click('base', 'modal');
    await until(() => run('base', 'window.popped && !location.hash'), 'Modal back must dispatch popstate');
    await click('base', 'external'); await pause(100);
    assert.equal(await run('base', 'location.origin'), origin, 'External links must remain blocked');
    console.log('PASS: Reproduced sandbox failure; both back links, direct-entry fallback, modal history and external-link blocking verified.');
  } finally {
    window.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().then(() => app.exit(0), error => { console.error(error); app.exit(1); });

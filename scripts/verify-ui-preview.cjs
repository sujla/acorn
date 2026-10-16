// Run with: node_modules/.bin/electron scripts/verify-ui-preview.cjs
// Uses temporary profiles and fixture data, never the user's connected projects.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const snapshotFs = require('../src/main/snapshot-files.cjs');
const { validateCatalog } = require('../src/main/preview-validation.cjs');
const { discoverPages } = require('../src/main/preview-pages.cjs');
const { startUiPreview, attachUiNavigationGuard } = require('../src/main/ui-preview-server.cjs');
const root = path.resolve(__dirname, '..');
const temporary = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'acorn-ui-qa-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.on('window-all-closed', () => {});
let server, proxy, window;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(code) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await window.webContents.executeJavaScript(code)) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${code}`);
}
app.whenReady().then(async () => {
  try {
    const guestRoot = path.join(temporary, 'historical-acorn');
    await fs.mkdir(guestRoot);
    const { execFileSync } = require('node:child_process');
    execFileSync('tar', ['-x', '-C', guestRoot], { input: execFileSync('git', ['-C', root, 'archive', 'HEAD'], { maxBuffer: 32 * 1024 * 1024 }) });
    // Exercise the real Electron dependency copy, including default_app.asar.
    await snapshotFs.cp(path.join(root, 'node_modules'), path.join(guestRoot, 'node_modules'), { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
    const asarFile = 'node_modules/electron/dist/Electron.app/Contents/Resources/default_app.asar';
    assert.deepEqual(await snapshotFs.readFile(path.join(guestRoot, asarFile)), await snapshotFs.readFile(path.join(root, asarFile)));
    let catalog = await discoverPages(guestRoot);
    catalog.pages.push(...[
      ['ui-test.html', 'UI interactions'], ['next.html', 'Next page'], ['missing.html', 'Missing'], ['protected.html', 'Protected'], ['blank.html', 'Blank'], ['crash.html', 'Crash']
    ].map(([file, label]) => ({ id: 'web:' + file, path: '/' + file, label, group: ['Web'], available: true })));
    catalog.pages.push({ id: 'dynamic', path: '/orders/[id]', label: '[id]', group: ['Unavailable'], available: false });
    assert.ok(catalog.pages.some(page => page.id === 'acorn:workspace'));
    server = http.createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://local').pathname;
      if (pathname === '/protected.html') { res.writeHead(302, { location: '/login.html' }).end(); return; }
      if (pathname === '/blank.html') { res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body></body></html>'); return; }
      if (pathname === '/crash.html') { res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Crash</h1><script>throw new Error("fixture failure")</script>'); return; }
      if (pathname === '/next.html') { res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Next page</h1><a href="/ui-test.html">Back</a>'); return; }
      if (pathname === '/ui-test.html') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head></head><body>
          <h1>UI interactions</h1><button id="js-next" onclick="window.open('/next.html','_blank')">Open next</button><button id="open-modal" onclick="document.getElementById('dialog').showModal()">Open modal</button><dialog id="dialog"><form method="dialog"><button id="close-modal">Close</button></form></dialog><a id="next" href="/next.html">Next</a><a id="anchor" href="#section">Section</a>
          <button id="toggle" onclick="document.getElementById('panel').hidden=!document.getElementById('panel').hidden">Toggle</button><div id="panel" hidden>Panel open</div>
          <form id="local-form"><input id="name" required><button id="submit">Continue</button></form><output id="result"></output>
          <button id="save" onclick="fetch('/api/save',{method:'POST'}).catch(()=>document.getElementById('result').textContent='blocked')">Save</button>
          <h2 id="section">Section</h2><script>document.getElementById('local-form').addEventListener('submit',event=>{event.preventDefault();document.getElementById('result').textContent='validated'});</script>
          </body></html>`); return;
      }
      const file = path.join(guestRoot, new URL(req.url, 'http://local').pathname === '/' ? 'index.html' : new URL(req.url, 'http://local').pathname);
      try { const body = await fs.readFile(file); res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream' }).end(body); }
      catch { res.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    proxy = await startUiPreview(`http://127.0.0.1:${server.address().port}/`, catalog);
    catalog = await validateCatalog(BrowserWindow, proxy.url, catalog);
    assert.deepEqual(catalog.pages.filter(page => page.id.startsWith('web:')).map(page => page.label), ['UI interactions', 'Next page']);
    assert.equal(catalog.pages.some(page => page.id === 'dynamic'), false);
    catalog.pages.push({ id: 'docs:guide', path: '/docs/guide', label: 'Guide', group: ['docs'], docs: true, available: true });
    const repo = { name: 'acorn', path: root, defaultBranch: 'main', currentBranch: 'main', branches: [{ name: 'main', sha: 'abcdef1' }], commits: [{ sha: 'abcdef1234567', shortSha: 'abcdef1', subject: 'UI preview fixture', author: 'Acorn', date: '2026-09-19' }, { sha: 'fedcba7654321', shortSha: 'fedcba7', subject: 'Older UI fixture', author: 'Acorn', date: '2026-09-18' }], runtimes: [{ id: 'web', available: true }], defaultRuntime: 'web' };
    const basePreview = { url: proxy.url, catalog, uiOnly: true };
    const targetPreview = { url: proxy.url, catalog: { ...catalog, pages: catalog.pages.filter(page => page.id !== 'web:ui-test.html') }, uiOnly: true };
    const preload = path.join(temporary, 'preload.cjs');
    await fs.writeFile(preload, `const {contextBridge}=require('electron');
      contextBridge.exposeInMainWorld('acornGit', {
        listRepositories: async()=>${JSON.stringify([repo])},
        getDiff: async()=>({diff:{files:[],totals:{added:0,removed:0},hints:{base:[],target:[]}}}),
        startPreview: async request=>({previews:{base:request.base==='main'?${JSON.stringify(basePreview)}:${JSON.stringify(targetPreview)}}}),
        listPreviewServers: async()=>({servers:[]})
      });`);
    window = new BrowserWindow({ width: 1440, height: 980, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
    attachUiNavigationGuard(window.webContents, () => [{ server: proxy, catalog }]);
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await waitFor("document.querySelectorAll('.page-picker-trigger:not(:disabled)').length === 2 && !!document.getElementById('base-preview-frame').src");
    await pause(700);
    assert.equal(await window.webContents.executeJavaScript("(() => { const loader=document.getElementById('base-preview-loading'); const viewport=document.getElementById('base-preview-viewport'); loader.hidden=false; const dot=loader.firstElementChild.getBoundingClientRect(); const section=viewport.getBoundingClientRect(); const centered=Math.abs((dot.left+dot.width/2)-(section.left+section.width/2))<1 && Math.abs((dot.top+dot.height/2)-(section.top+section.height/2))<1; loader.hidden=true; return centered; })()"), true);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('page-sync').getAttribute('aria-pressed')"), 'true');
    assert.equal(await window.webContents.executeJavaScript("[...document.querySelectorAll('.page-picker-trigger')].every(button=>button.textContent.includes('Workspace'))"), true);
    const initialPageLabel = await window.webContents.executeJavaScript("document.querySelector('.page-picker-trigger').textContent");
    await window.webContents.executeJavaScript("document.querySelector('.page-picker-trigger').click()");
    await pause(100);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('base-url-pages').matches(':popover-open')"), true);
    assert.equal(await window.webContents.executeJavaScript("(() => { const menu=document.getElementById('base-url-pages').getBoundingClientRect(); const trigger=document.querySelector('.page-picker-trigger').getBoundingClientRect(); return menu.bottom <= trigger.top; })()"), true);
    assert.equal(await window.webContents.executeJavaScript("(() => { const menu=document.getElementById('base-url-pages').getBoundingClientRect(); const trigger=document.querySelector('.page-picker-trigger').getBoundingClientRect(); return Math.abs(menu.width-trigger.width) < 1; })()"), true);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('#base-url-pages .page-picker-icon path')?.getAttribute('d') === document.querySelector('.project-folder path')?.getAttribute('d')"), true);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('#base-url-pages .page-picker-row.is-selected .page-picker-check') !== null"), true);
    assert.equal(await window.webContents.executeJavaScript("(() => { const probe=document.createElement('i'); probe.style.color='var(--page-row-hover)'; document.body.append(probe); const expected=getComputedStyle(probe).color; probe.remove(); return getComputedStyle(document.querySelector('#base-url-pages .page-picker-row.is-selected')).backgroundColor === expected; })()"), true);
    assert.match(await window.webContents.executeJavaScript("getComputedStyle(document.querySelector('.ref-picker-trigger'),'::after').content"), /▾/);
    assert.equal(await window.webContents.executeJavaScript("getComputedStyle(document.querySelector('.ref-picker-trigger'),'::after').fontSize"), '15px');
    assert.equal(await window.webContents.executeJavaScript("getComputedStyle(document.querySelector('.page-picker-trigger'),'::after').fontSize"), '15px');
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('base-url-pages').textContent.includes('Guide')"), false);
    await window.webContents.executeJavaScript("document.querySelector('.page-picker-trigger').click()");
    await pause(100);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('base-url-pages').matches(':popover-open')"), false);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.page-picker-trigger').textContent"), initialPageLabel);
    await window.webContents.executeJavaScript("document.getElementById('base-expand').click()");
    await pause(100);
    assert.equal(await window.webContents.executeJavaScript("(() => { const loader=document.getElementById('base-preview-loading'); const viewport=document.getElementById('base-preview-viewport'); loader.hidden=false; const dot=loader.firstElementChild.getBoundingClientRect(); const section=viewport.getBoundingClientRect(); const centered=Math.abs((dot.left+dot.width/2)-(section.left+section.width/2))<1 && Math.abs((dot.top+dot.height/2)-(section.top+section.height/2))<1; loader.hidden=true; return centered; })()"), true);
    await window.webContents.executeJavaScript("document.querySelector('#base-address-form .page-picker-trigger').click()");
    await pause(100);
    assert.equal(await window.webContents.executeJavaScript("(() => { const menu=document.getElementById('base-url-pages').getBoundingClientRect(); const trigger=document.querySelector('#base-address-form .page-picker-trigger').getBoundingClientRect(); return Math.abs(menu.width-trigger.width) < 1; })()"), true);
    assert.equal(await window.webContents.executeJavaScript("(() => { const menu=document.getElementById('base-url-pages').getBoundingClientRect(); const trigger=document.querySelector('#base-address-form .page-picker-trigger').getBoundingClientRect(); return menu.top >= trigger.bottom; })()"), true);
    await window.webContents.executeJavaScript("document.querySelector('#base-address-form .page-picker-trigger').click();document.getElementById('expanded-close').click()");
    await pause(100);
    const frames = () => window.webContents.mainFrame.frames.filter(frame => frame.name === 'base-preview');
    assert.equal(frames().length, 1);
    assert.equal(await frames()[0].executeJavaScript("document.getElementById('connection-empty').hidden"), false);
    assert.equal(await frames()[0].executeJavaScript("typeof window.acornGit"), 'undefined');
    assert.equal(await frames()[0].executeJavaScript("fetch('/api/save',{method:'POST'}).then(()=>false,()=>true)"), true);
    await frames()[0].executeJavaScript("window.__clicked=false;document.getElementById('add-project').addEventListener('click',()=>window.__clicked=true);document.getElementById('add-project').click()");
    assert.equal(await frames()[0].executeJavaScript('window.__clicked'), false);
    const currentUrl = frames()[0].url;
    await frames()[0].executeJavaScript("location.href = 'https://example.com/forbidden'; undefined");
    await pause(100);
    assert.equal(frames()[0].url, currentUrl);
    await window.webContents.executeJavaScript("document.querySelector('.page-picker-trigger').click()");
    await pause(100);
    await window.webContents.executeJavaScript("[...document.querySelectorAll('#base-url-pages .page-picker-row')].find(row=>row.textContent.includes('Web')).click()");
    assert.equal(await window.webContents.executeJavaScript("[...document.querySelectorAll('#base-url-pages .page-picker-row')].some(row=>/Missing|Protected|Blank|Crash|Unavailable/.test(row.textContent))"), false);
    await window.webContents.executeJavaScript("[...document.querySelectorAll('#base-url-pages .page-picker-row')].find(row=>row.textContent.includes('UI interactions')).click()");
    await pause(400);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('page-sync').getAttribute('aria-pressed')"), 'false');
    assert.match(await window.webContents.executeJavaScript("document.querySelector('#target-address-form .page-picker-trigger').textContent"), /Workspace/);
    await frames()[0].executeJavaScript("document.getElementById('open-modal').click()");
    assert.equal(await frames()[0].executeJavaScript("document.getElementById('dialog').open"), true);
    await frames()[0].executeJavaScript("document.getElementById('close-modal').click()");
    assert.equal(await frames()[0].executeJavaScript("document.getElementById('dialog').open"), false);
    await frames()[0].executeJavaScript("document.getElementById('toggle').click()");
    assert.equal(await frames()[0].executeJavaScript("document.getElementById('panel').hidden"), false);
    await frames()[0].executeJavaScript("document.getElementById('submit').click()");
    assert.equal(await frames()[0].executeJavaScript("document.getElementById('name').validity.valueMissing"), true);
    await frames()[0].executeJavaScript("document.getElementById('name').value='Example';document.getElementById('submit').click()");
    assert.equal(await frames()[0].executeJavaScript("document.getElementById('result').textContent"), 'validated');
    await frames()[0].executeJavaScript("document.getElementById('save').click()");
    await pause(100);
    assert.equal(await frames()[0].executeJavaScript("document.getElementById('result').textContent"), 'blocked');
    await frames()[0].executeJavaScript("document.getElementById('anchor').click()");
    assert.equal(await frames()[0].executeJavaScript('location.hash'), '#section');
    await frames()[0].executeJavaScript("document.getElementById('next').click()");
    await pause(400);
    assert.equal(await frames()[0].executeJavaScript('location.pathname'), '/next.html');
    await frames()[0].executeJavaScript('history.back()');
    await pause(400);
    assert.equal(await frames()[0].executeJavaScript('location.pathname'), '/ui-test.html');
    await frames()[0].executeJavaScript("document.getElementById('js-next').click()");
    await pause(400);
    assert.equal(await frames()[0].executeJavaScript('location.pathname'), '/next.html');
    await window.webContents.executeJavaScript("document.querySelector('#base-address-form .page-picker-trigger').click()");
    await pause(100);
    await window.webContents.executeJavaScript("[...document.querySelectorAll('#base-url-pages .page-picker-row')].find(row=>row.textContent.includes('Web')).click()");
    await window.webContents.executeJavaScript("[...document.querySelectorAll('#base-url-pages .page-picker-row')].find(row=>row.textContent.includes('Next page')).click()");
    await pause(300);
    assert.match(await window.webContents.executeJavaScript("document.querySelector('#target-address-form .page-picker-trigger').textContent"), /Select project/);
    await window.webContents.executeJavaScript("document.getElementById('page-sync').click()");
    await pause(300);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('page-sync').getAttribute('aria-pressed')"), 'true');
    assert.match(await window.webContents.executeJavaScript("document.querySelector('#target-address-form .page-picker-trigger').textContent"), /Next page/);
    console.log(JSON.stringify({ passed: true, checks: ['picker opens above and toggles without changing the page', 'sidebar folder icon reused', 'docs and unavailable pages excluded', 'page selection defaults to synced', 'page selection can be independent', 'missing counterpart unlocks sync and preserves the other page', 'shared page can be resynced', 'workspace without login', 'no native bridge', 'ASAR dependencies copied byte-for-byte', 'internal links and history restored', 'tabs and client validation enabled', 'API calls and native actions blocked'], screenshots: temporary }));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    window?.destroy(); await proxy?.close();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await snapshotFs.rm(path.join(temporary, 'historical-acorn'), { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});

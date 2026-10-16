const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const assert = require('node:assert/strict');
const { startUiPreview } = require('../src/main/ui-preview-server.cjs');
const root = path.resolve(process.argv[2]);
let sourceServer, proxy, window;
app.setPath('userData', require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'acorn-expo-render-')));
app.whenReady().then(async () => {
  try {
    const source = await fs.readFile(path.join(__dirname, '../src/main/desktop-main.cjs'), 'utf8');
    const context = vm.createContext({ fs, path, http, URL });
    vm.runInContext(source.slice(source.indexOf('function contentType('), source.indexOf('async function stopPreviewServer(') > source.indexOf('function contentType(') ? source.indexOf('async function stopPreviewServer(') : source.indexOf('async function startPreviewServer(')), context);
    sourceServer = await context.startStaticPreviewServer(root);
    proxy = await startUiPreview(sourceServer.url, { pages: [{ id: '/', path: '/' }], responses: {} });
    window = new BrowserWindow({ show: false, width: 900, height: 1000, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    window.webContents.session.setPermissionRequestHandler((_w,_p,cb) => cb(false));
    window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    const errors = [];
    window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    await window.loadURL(proxy.url);
    await new Promise(r => setTimeout(r, 6000));
    console.log(JSON.stringify({ errors, text: await window.webContents.executeJavaScript('document.body.innerText.slice(0, 2000)') }));
    await fs.writeFile('/tmp/acorn-expo-render.png', (await window.webContents.capturePage()).toPNG());
    assert.equal(await window.webContents.executeJavaScript('document.getElementById("root")?.children.length > 0'), true);
    assert.deepEqual(errors.filter(error => /^Uncaught/.test(error)), []);
    assert.equal(await window.webContents.executeJavaScript("fetch('https://example.com').then(()=>false,()=>true)"), true);
    const settings = await window.webContents.executeJavaScript(`(() => { const label = [...document.querySelectorAll('*')].find(el => !el.children.length && el.textContent === 'Settings'); if (!label) return false; label.click(); return true; })()`);
    if (settings) {
      await new Promise(r => setTimeout(r, 1000));
      assert.match(await window.webContents.executeJavaScript('location.pathname'), /settings/);
      console.log('Settings navigation passed');
      await fs.writeFile('/tmp/acorn-expo-settings.png', (await window.webContents.capturePage()).toPNG());
    }
    console.log('Expo artifact renders with network isolation');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { window?.destroy(); await proxy?.close(); sourceServer?.server.close(); app.exit(process.exitCode || 0); }
});

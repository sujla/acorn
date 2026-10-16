// Run with node_modules/.bin/electron scripts/verify-ui-engine.cjs.
// Tests the compiled result in Chromium, not just the generated bundle text.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { compileInWorker } = require('../src/main/preview-build-queue.cjs');
const { startUiPreview } = require('../src/main/ui-preview-server.cjs');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  let root, upstream, guarded, window, failure;
  try {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-render-test-'));
    const repo = path.join(root, 'repo');
    await fs.mkdir(path.join(repo, '.acorn'), { recursive: true });
    const inputs = {
      'package.json': JSON.stringify({ dependencies: { react: 'test', 'react-dom': 'test' } }),
      'index.html': '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>',
      'main.tsx': 'import {createRoot} from "react-dom/client"; import {useState} from "react"; import "./style.css"; function App(){const [n,setN]=useState(0);return <button onClick={()=>setN(n+1)}>Count {n}</button>} createRoot(document.getElementById("root")!).render(<App/>);',
      'style.css': 'button { color: rgb(128, 0, 128); }',
      '.acorn/preview.json': JSON.stringify({ responses: { 'GET /api/example': { status: 200, body: { label: 'Fixture' } } } }),
    };
    for (const [name, contents] of Object.entries(inputs)) await fs.writeFile(path.join(repo, name), contents);
    for (const name of ['react', 'react-dom', 'scheduler']) await fs.cp(path.join(__dirname, '../node_modules', name), path.join(repo, 'node_modules', name), { recursive: true });
    const options = { root: repo, repositoryPath: repo, cacheRoot: path.join(root, 'cache') };
    const artifact = await compileInWorker(options);
    assert.equal((await compileInWorker(options)).cached, true);
    upstream = http.createServer(async (request, response) => {
      try {
        const name = new URL(request.url, 'http://local').pathname;
        const dependencyPrefix = `/_acorn_deps/${artifact.dependencyKey}/`;
        const file = name.startsWith(dependencyPrefix)
          ? path.join(artifact.dependencyRoot, name.slice(dependencyPrefix.length))
          : path.join(artifact.root, name === '/' ? 'index.html' : name);
        response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
        response.end(await fs.readFile(file));
      } catch { response.writeHead(404).end(); }
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    guarded = await startUiPreview(`http://127.0.0.1:${upstream.address().port}/`, { pages: [], responses: artifact.responses });
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    await window.loadURL(guarded.url);
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await window.webContents.executeJavaScript('!!document.querySelector("button")')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("button").textContent'), 'Count 0');
    assert.equal(await window.webContents.executeJavaScript('getComputedStyle(document.querySelector("button")).color'), 'rgb(128, 0, 128)');
    await window.webContents.executeJavaScript('document.querySelector("button").click()');
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("button").textContent'), 'Count 1');
    assert.deepEqual(await window.webContents.executeJavaScript('fetch("/api/example").then(r=>r.json())'), { label: 'Fixture' });
    assert.equal(await window.webContents.executeJavaScript('fetch("/api/missing").then(()=>false,()=>true)'), true);
    assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined');
    await window.loadFile(path.join(__dirname, '../src/renderer/index.html'));
    assert.equal(await window.webContents.executeJavaScript('document.getElementById("account-menu-login").textContent'), 'User Name');
    assert.equal(await window.webContents.executeJavaScript('document.getElementById("project-loading").hidden'), true);
    assert.equal(await window.webContents.executeJavaScript('document.getElementById("projects-label").textContent'), 'Repositories');
    window.destroy();
    const preload = path.join(root, 'local-preload.cjs');
    await fs.writeFile(preload, `const { contextBridge } = require('electron'); let selections = 0;
      contextBridge.exposeInMainWorld('acornGit', {
        listRepositories: async () => [],
        listPreviewServers: async () => ({ servers: [] }),
        chooseLocalRepository: async () => { selections++; return { canceled: true }; },
        selectionCount: () => selections
      });
      contextBridge.exposeInMainWorld('acornLocalProfile', {
        status: async () => ({ profile: { name: 'Local Person', provider: 'local' } })
      });`);
    window = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
    await window.loadFile(path.join(__dirname, '../src/renderer/index.html'));
    assert.equal(await window.webContents.executeJavaScript('document.getElementById("account-menu-login").textContent'), 'Local Person');
    assert.equal(await window.webContents.executeJavaScript('document.getElementById("account-login").textContent'), 'Local Person');
    assert.equal(await window.webContents.executeJavaScript('document.getElementById("account-plan").textContent'), 'Free');
    await window.webContents.executeJavaScript('document.getElementById("empty-connect").click()');
    assert.equal(await window.webContents.executeJavaScript('window.acornGit.selectionCount()'), 1);
    assert.equal(await window.webContents.executeJavaScript('document.getElementById("connection-modal").hidden'), true);
    assert.equal(await window.webContents.executeJavaScript('document.getElementById("connection-error").textContent'), '');
    console.log('PASS: worker compile, warm cache, React render, CSS, click, fixture, unknown request denied, Node absent, local-only app shell.');
    process.exitCode = 0;
  } catch (error) { failure = error; console.error(error); console.error('Preserved test files:', root); }
  finally {
    window?.destroy();
    if (guarded) await guarded.close();
    if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
    if (root && !failure) await fs.rm(root, { recursive: true, force: true });
    app.exit(failure ? 1 : 0);
  }
});

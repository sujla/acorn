// Electron regression for project switching without rebuilding or reloading frames.
const { app, BrowserWindow, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  let window, server, temporary;
  try {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-project-restore-'));
    server = http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html><body style="height:3000px"><input id="value"><h1>Preview</h1></body></html>'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const repos = ['one', 'two', 'three', 'four'].map(name => ({ name, path: '/fixture/' + name,
      currentBranch: 'main', defaultBranch: 'main', branches: [{ name: 'main', sha: 'abcdef1' }],
      commits: [{ sha: 'abcdef1234567', shortSha: 'abcdef1', subject: 'Latest' }, { sha: 'fedcba7654321', shortSha: 'fedcba7', subject: 'Earlier' }],
      runtimes: [{ id: 'web', available: true }], defaultRuntime: 'web' }));
    const preload = path.join(temporary, 'preload.cjs');
    await fs.writeFile(preload, `const {contextBridge,ipcRenderer}=require('electron');
      let starts=Number(sessionStorage.getItem('fixture.starts') || 0); const servers = new Map(JSON.parse(sessionStorage.getItem('fixture.servers') || '[]'));
      let delay = 0;
      contextBridge.exposeInMainWorld('acornGit', {
        onRefresh: callback => { ipcRenderer.on('app:refresh', (_event, request) => callback(request)); },
        listRepositories: async()=>${JSON.stringify(repos)},
        getDiff: async()=>({diff:{files:[],totals:{added:0,deleted:0},hints:{base:[],target:[]}}}),
        startPreview: async request=>{
          starts++; sessionStorage.setItem('fixture.starts', starts);
          const wait = delay; delay = 0; if (wait) await new Promise(resolve => setTimeout(resolve, wait));
          const url=${JSON.stringify(origin)}+request.path+'/'+request.base+'/';
          const server={repositoryPath:request.path,sha:request.base,url,runtime:'web'};
          servers.set(url,server); sessionStorage.setItem('fixture.servers', JSON.stringify([...servers]));
          const preview={url,upstreamUrl:url,catalog:{pages:[{id:'home',label:'Home',path:request.path+'/'+request.base+'/',available:true},{id:'details',label:'Details',path:request.path+'/'+request.base+'/details',available:true}],warnings:[]}};
          return {previews:{base:preview,target:preview}};
        },
        listPreviewServers: async()=>({servers:[...servers.values()]}),
        stopPreviewServer: async request=>{servers.delete(request.url);return {success:true}},
        delayNext: ms=>{delay=ms},
        count:()=>starts
      });`);
    window = new BrowserWindow({ show: false, width: 1440, height: 980, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    require('../src/main/refresh-menu.cjs').installRefreshMenu(Menu, () => window);
    const mainSource = await fs.readFile(path.join(__dirname, '../src/main/desktop-main.cjs'), 'utf8');
    require('node:vm').runInNewContext(mainSource.slice(mainSource.indexOf("  mainWindow.webContents.on('before-input-event'"), mainSource.indexOf('  mainWindow.loadFile')), { mainWindow: window });
    window.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
    const evaluate = code => window.webContents.executeJavaScript(code);
    const waitFor = async code => { for (let i=0;i<100;i++) { if(await evaluate(code)) return; await pause(50); } throw new Error('Timed out: '+code+' '+JSON.stringify(await evaluate('({previewState, selectedPages, toast: document.body.innerText.slice(-1500)})'))); };
    const select = async name => { await evaluate(`document.querySelector('.comparison-row[data-repository-path="/fixture/${name}"] .comparison-item').click()`); await waitFor('previewState.base === "ready" && previewState.target === "ready"'); };
    await window.loadFile(path.join(__dirname, '../src/renderer/index.html'));
    await waitFor('previewState.base === "ready" && previewState.target === "ready"');
    await evaluate("baseRef.value='fedcba7654321';baseRef.dispatchEvent(new Event('change'));setPageSync(false)");
    await waitFor('previewState.base === "ready"');
    // Wait for the first navigation to commit before selecting another page.
    for (let i=0;i<100;i++) {
      const currentSrc = await evaluate("document.getElementById('base-preview-frame').src");
      const currentFrame = window.webContents.mainFrame.frames.find(frame => frame.name === 'base-preview' && frame.url === currentSrc);
      if (currentFrame && await currentFrame.executeJavaScript('document.readyState === "complete"')) break;
      await pause(50);
    }
    await evaluate("choosePage('base', previewUrls.base.catalog.pages[1])");
    const url = await evaluate('previewUrls.base.currentUrl');
    let frame;
    for(let i=0;i<100;i++) { frame=window.webContents.mainFrame.frames.find(frame=>frame.url===url); if(frame && await frame.executeJavaScript('!!document.getElementById("value")')) break; await pause(50); }
    assert.ok(frame, JSON.stringify({ expected: url, frames: window.webContents.mainFrame.frames.map(frame=>({name:frame.name,url:frame.url})), src: await evaluate("document.getElementById('base-preview-frame').src") }));
    await frame.executeJavaScript("window.retainedToken='retained';document.getElementById('value').value='Unsubmitted input';window.scrollTo(0,500)");
    await evaluate("window.retainedFrame=document.getElementById('base-preview-frame')");
    await select('two');
    const before = await evaluate('window.acornGit.count()');
    await select('one');
    assert.equal(await evaluate('window.acornGit.count()'), before, 'Restore must not request compilation');
    assert.equal(await evaluate("document.getElementById('base-preview-frame') === window.retainedFrame"), true);
    assert.equal(await evaluate('baseRef.value'), 'fedcba7654321');
    assert.equal(await evaluate('selectedPages.base.id'), 'details');
    assert.equal(await evaluate('pageSelectionSynced'), false);
    assert.equal(await frame.executeJavaScript('window.retainedToken'), 'retained');
    assert.equal(await frame.executeJavaScript('document.getElementById("value").value'), 'Unsubmitted input');
    assert.equal(await frame.executeJavaScript('window.scrollY'), 500);
    await select('one');
    assert.equal(await evaluate('window.acornGit.count()'), before, 'Reselecting active project is a no-op');
    await evaluate("document.getElementById('base-refresh').click()");
    await waitFor('previewState.base === "ready"');
    assert.equal(await evaluate('window.acornGit.count()'), before+1, 'Explicit refresh still validates');
    await select('two');
    await evaluate('refreshRuntimeServers().then(()=>clearRuntimeServers())');
    const stopped = await evaluate('window.acornGit.count()');
    await select('one');
    assert.equal(await evaluate('window.acornGit.count()'), stopped+2, 'Stopped cached previews must restart');
    for (const name of ['two','three','four']) await select(name);
    assert.equal(await evaluate('document.querySelectorAll("iframe.preview-frame").length'), 6, 'Live documents are bounded to three projects');
    const evictedCount = await evaluate('window.acornGit.count()');
    await select('one');
    assert.equal(await evaluate('window.acornGit.count()'), evictedCount, 'Evicted documents reuse existing servers without rebuilding');
    assert.equal(await evaluate('baseRef.value'), 'fedcba7654321');
    assert.equal(await evaluate('document.querySelectorAll("#base-preview-frame").length'), 1);
    assert.equal(await evaluate('document.querySelectorAll("#target-preview-frame").length'), 1);
    // A renderer reload reconnects without another preparation request.
    await select('three');
    await evaluate('addComparison(activeRepository)');
    await waitFor('previewState.base === "ready" && previewState.target === "ready"');
    const restoredComparison = await evaluate('activeComparison.id');
    await evaluate("setPageSync(false);choosePage('base',previewUrls.base.catalog.pages[1]);setPreviewZoom('base',140)");
    const reloadCount = await evaluate('window.acornGit.count()');
    await window.webContents.reload();
    await waitFor('activeRepository?.name === "three" && previewState.base === "ready" && previewState.target === "ready"');
    assert.equal(await evaluate('window.acornGit.count()'), reloadCount);
    assert.equal(await evaluate('activeComparison.id'), restoredComparison);
    assert.equal(await evaluate('selectedPages.base.id'), 'details');
    assert.equal(await evaluate('previewZoom.base'), 140);
    await evaluate("window.sidebarBeforeRefresh=get('project-list');window.comparisonBeforeRefresh=document.querySelector('.comparison-item.active');collapsedRepositories.add('/fixture/two')");
    Menu.getApplicationMenu().getMenuItemById('refresh-preview').click();
    await waitFor('previewState.base === "ready" && previewState.target === "ready"');
    assert.equal(await evaluate('window.acornGit.count()'), reloadCount + 2);
    assert.equal(await evaluate('selectedPages.base.id'), 'details');
    assert.equal(await evaluate('previewZoom.base'), 140);
    assert.equal(await evaluate("get('refresh-all').dataset.tooltip"), '⌘R');
    assert.equal(await evaluate("window.sidebarBeforeRefresh === get('project-list') && window.comparisonBeforeRefresh === document.querySelector('.comparison-item.active') && collapsedRepositories.has('/fixture/two')"), true, 'Menu refresh must preserve the sidebar and its state');
    const keyboardCount = await evaluate('window.acornGit.count()');
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'R',modifiers:['meta']});
    window.webContents.sendInputEvent({type:'keyUp',keyCode:'R',modifiers:['meta']});
    await waitFor(`window.acornGit.count() === ${keyboardCount + 2} && previewState.base === "ready" && previewState.target === "ready"`);
    assert.equal(await evaluate("window.sidebarBeforeRefresh === get('project-list') && window.comparisonBeforeRefresh === document.querySelector('.comparison-item.active') && collapsedRepositories.has('/fixture/two')"), true, 'Keyboard refresh must preserve the sidebar and its state');
    // An unrelated ready server is not blocked by a previous request.
    await evaluate("for (const [key, session] of projectPreviewSessions) { if (key.includes('/fixture/two') || key.includes('/fixture/four')) { session.previews = {}; session.states = {base:'stopped',target:'stopped'}; } } window.acornGit.delayNext(1500);activateRepository('/fixture/two')");
    const switchStarted = Date.now();
    await select('four');
    const switchMs = Date.now() - switchStarted;
    assert.ok(switchMs < 1000, 'Switching must not await unrelated preparation');
    console.log('Independent switch: '+switchMs+'ms while previous request delays 1500ms');
    console.log('PASS: no rebuild/reload on return, saved refs/page/input/scroll, same-project no-op, explicit refresh, stopped-server invalidation, bounded retained frames, renderer reload reconnection, refresh preserves view, independent switching.');
  } catch(error) { console.error(error); process.exitCode=1; }
  finally { window?.destroy(); if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));} if(temporary) await fs.rm(temporary,{recursive:true,force:true});app.exit(process.exitCode||0); }
});

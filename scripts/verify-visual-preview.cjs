// Read-only probe of an Expo project with PuppyAmanda-style guarded routes.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const repository = path.resolve(process.argv[2]);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'acorn-visual-probe-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'repositories.json'), '[]');
require('../src/main/desktop-main.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const deadline = setTimeout(() => { console.error('Visual preview probe timed out'); app.exit(1); }, 180000);
  const window = BrowserWindow.getAllWindows()[0];
  window.hide();
  const run = code => window.webContents.executeJavaScript(code);
  const waitFor = async code => {
    for (let i = 0; i < 1200; i++) { if (await run(code)) return; await pause(100); }
    throw new Error('Timed out: ' + code);
  };
  try {
    while (window.webContents.isLoading()) await pause(50);
    fs.writeFileSync(path.join(profile, 'repositories.json'), JSON.stringify([repository]));
    await run(`(async () => {
      repositories = await bridge.listRepositories(); activeRepository = repositories[0];
      activeComparison = { id: 'visual-probe' }; pageSelectionSynced = false;
      baseRef.innerHTML = '<option value="__working_tree__">Working folder</option>';
      schedulePreview(['base']);
    })()`);
    await waitFor("['ready','failed'].includes(previewState.base)");
    assert.equal(await run('previewState.base'), 'ready', await run("get('base-url').title"));
    const frame = () => window.webContents.mainFrame.frames.find(f => f.name === 'base-preview');
    await waitFor("previewUrls.base.currentUrl != null");
    await pause(1000);
    for (const route of ['/onboarding/name', '/onboarding/owner', '/discover', '/phone']) {
      await run(`choosePage('base', previewUrls.base.catalog.pages.find(p => p.path === ${JSON.stringify(route)}))`);
      await waitFor(`previewState.base === 'ready' && previewUrls.base.visual === true && new URL(previewUrls.base.currentUrl).pathname === ${JSON.stringify(route)}`);
      await pause(700);
      assert.equal(await frame().executeJavaScript('location.pathname'), route);
      assert.ok((await frame().executeJavaScript('document.body.innerText')).trim());
      assert.equal(await frame().executeJavaScript('window.__ACORN_UI_STATE__.errors'), 0);
      console.log('Guarded screen rendered with visual fallback:', route);
    }
    await run("choosePage('base', previewUrls.base.catalog.pages.find(p => p.path === '/support'))");
    await waitFor("previewState.base === 'ready' && previewUrls.base.visual === false && new URL(previewUrls.base.currentUrl).pathname === '/support'");
    console.log('Ordinary support page returned to normal preview.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    clearTimeout(deadline);
    await run("bridge.releaseComparison({path: activeRepository.path, comparisonId: activeComparison.id})").catch(() => {});
    app.exit(process.exitCode || 0);
  }
});

// Electron integration probe for a connected Expo project; no checkout writes.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const repository = path.resolve(process.argv[2]);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acorn-mobile-probe-'));
app.setPath('userData', scratch);
fs.writeFileSync(path.join(scratch, 'repositories.json'), '[]');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// This probe deliberately tests manual permission before its optional network step.
const dataModule = require('../src/main/preview-data.cjs');
const createData = dataModule.createPreviewData;
dataModule.createPreviewData = () => createData({ automatic: false });
require('../src/main/desktop-main.cjs');
app.whenReady().then(async () => {
  const deadline = setTimeout(() => app.exit(1), 180000);
  const window = BrowserWindow.getAllWindows()[0];
  window.hide();
  const run = code => window.webContents.executeJavaScript(code);
  const waitFor = async code => { for (let i = 0; i < 1800; i++) { if (await run(code)) return; await pause(100); } throw new Error('Timed out: ' + code); };
  try {
    while (window.webContents.isLoading()) await pause(50);
    fs.writeFileSync(path.join(scratch, 'repositories.json'), JSON.stringify([repository]));
    await run(`(async () => { repositories = await bridge.listRepositories(); repositories[0].defaultBranch = repositories[0].currentBranch; repositories[0].commits = []; activateRepository(${JSON.stringify(repository)}); })()`);
    await waitFor("previewState.base === 'ready' && previewState.target === 'ready'");
    assert.equal(await run('activeRepository.platforms.mobile'), true);
    assert.equal(await run("get('base-preview-frame').style.width"), '390px');
    assert.equal(await run("get('base-preview-frame').style.height"), '844px');
    await waitFor(`bridge.previewDataStatus({path:${JSON.stringify(repository)}}).then(s => s.sources.length > 0)`);
    const before = await run(`bridge.previewDataStatus({path:${JSON.stringify(repository)}})`);
    console.log(JSON.stringify({ stage: 'before consent', sources: before.sources, viewport: await run('previewGeometry.base') }));
    // Opt in only when explicitly running this probe with --public-data.
    if (process.argv.includes('--public-data')) {
      const origins = before.sources.map(s => s.origin).filter(origin => ['https://raw.githubusercontent.com', 'https://api-open.data.gov.sg'].includes(origin));
      await run(`bridge.allowPreviewData({path:${JSON.stringify(repository)},origins:${JSON.stringify(origins)}})`);
      await run("for (const side of ['base', 'target']) get(side + '-preview-frame').src = previewUrls[side].url");
      await pause(25000);
      const status = await run(`bridge.previewDataStatus({path:${JSON.stringify(repository)}})`);
      console.log(JSON.stringify({ stage: 'after consent', data: status }));
      assert.ok(status.cached > 0, 'Allowed public responses must reach the preview');
    }
    const frame = window.webContents.mainFrame.frames.find(f => f.name === 'base-preview');
    console.log(JSON.stringify({ screen: await frame.executeJavaScript("document.getElementById('root').innerText.slice(0,2500)"), state: await frame.executeJavaScript('window.__ACORN_UI_STATE__') }));
    assert.equal(await frame.executeJavaScript('document.getElementById("root").children.length > 0'), true);
    assert.equal(await frame.executeJavaScript('window.__ACORN_UI_STATE__.errors'), 0);
    if (process.argv.includes('--map')) {
      assert.equal(await frame.executeJavaScript(`!!document.querySelector('[data-acorn-map="schematic"]')`), true);
      const count = await frame.executeJavaScript(`document.querySelectorAll('[data-acorn-marker]').length`);
      assert.ok(count > 0, 'Expected real project markers in schematic map');
      console.log(JSON.stringify({ mapMarkers: count }));
    }
    console.log('Mobile viewport and Expo rendering passed');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { clearTimeout(deadline); app.exit(process.exitCode || 0); }
});

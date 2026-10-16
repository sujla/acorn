// Isolated desktop verification: fixture repository and disposable Acorn profile.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const git = require('isomorphic-git');
const temporary = syncFs.mkdtempSync(path.join(os.tmpdir(), 'acorn-folder-ui-'));
const profile = path.join(temporary, 'profile'); syncFs.mkdirSync(profile);
app.setPath('userData', profile); app.setPath('sessionData', path.join(temporary, 'session'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let window;
  const deadline = setTimeout(() => { console.error('Preview folder UI test timed out'); app.exit(1); }, 90000);
  try {
    const repository = path.join(temporary, 'repository'); await fs.mkdir(repository);
    await git.init({ fs: syncFs, dir: repository, defaultBranch: 'main' });
    for (const [file, body] of Object.entries({ 'index.html': '<h1>Preview</h1><img src="assets/icon.svg">', 'src/readme.txt': 'source', 'assets/icon.svg': '<svg/>', 'qa/report.txt': 'unknown folder', 'android/app/build/binary.txt': 'generated', 'ios/Pods/binary.txt': 'native', 'dist/index.html': '<h1>Export</h1>' })) {
      await fs.mkdir(path.dirname(path.join(repository, file)), { recursive: true }); await fs.writeFile(path.join(repository, file), body);
      await git.add({ fs: syncFs, dir: repository, filepath: file });
    }
    await git.commit({ fs: syncFs, dir: repository, author: { name: 'Fixture', email: 'fixture@example.test' }, message: 'fixture' });
    await fs.writeFile(path.join(profile, 'repositories.json'), '[]');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repository] });
    require('../src/main/desktop-main.cjs'); await app.whenReady(); window = BrowserWindow.getAllWindows()[0]; window.hide();
    const run = code => window.webContents.executeJavaScript(code);
    console.log('Window created');
    window.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
    const wait = async code => { console.log('Waiting:', code); for (let i = 0; i < 200; i++) { if (await run(code).catch(() => false)) return; await pause(50); } throw new Error('Timed out: ' + code); };
    await wait('typeof window.PreviewFilePicker !== "undefined" && !document.getElementById("project-loading").hasAttribute("aria-busy") || typeof window.PreviewFilePicker !== "undefined" && document.getElementById("project-loading").getAttribute("aria-busy") === "false"');
    // Simulate macOS waiting for consent during the first directory read.
    const readDirectory = fs.readdir;
    let allowAccess, accessStarted;
    const accessAllowed = new Promise(resolve => { allowAccess = resolve; });
    const accessRequested = new Promise(resolve => { accessStarted = resolve; });
    fs.readdir = (...args) => {
      if (args[0] !== repository) return readDirectory(...args);
      fs.readdir = readDirectory;
      accessStarted();
      return accessAllowed.then(() => readDirectory(...args));
    };
    await run('window.folderProgress = []; window.acornGit.onPreviewFilesProgress(value => window.folderProgress.push(value.value)); document.getElementById("empty-connect").click();');
    await accessRequested;
    assert.equal(await run('document.getElementById("preview-files-dialog").open'), false);
    assert.deepEqual(await run('window.folderProgress'), []);
    assert.equal(await run('document.getElementById("empty-connect").disabled'), true);
    allowAccess();
    await wait('document.getElementById("preview-files-dialog").open && !document.getElementById("preview-files-save").disabled');
    assert.deepEqual(await run('[document.getElementById("preview-settings-tabs").hidden, document.getElementById("preview-external-data-panel").hidden]'), [true, true]);
    assert.deepEqual(await run('window.folderProgress'), [0, 1, 2, 3, 4, 5]);
    assert.equal(await run('document.querySelector(\'[data-folder="android/app/build"]\').checked'), false);
    assert.equal(await run('document.querySelector(\'[data-folder="qa"]\').checked'), false);
    assert.equal(await run('document.querySelector(\'[data-folder="assets"]\').checked'), true);
    assert.deepEqual(await run('window.acornGit.listRepositories()'), []);
    await run('document.getElementById("preview-files-cancel").click()');
    await wait('!document.getElementById("preview-files-dialog").open');
    assert.equal(await run('document.getElementById("connection-modal").hidden'), true);
    assert.deepEqual(await run('window.acornGit.listRepositories()'), []);
    await run('document.getElementById("add-project").click(); document.getElementById("connect-local").click()');
    await wait('document.getElementById("preview-files-dialog").open && !document.getElementById("preview-files-save").disabled');
    await run('document.querySelector(\'[data-folder="qa"]\').click(); document.getElementById("preview-files-reset").click()');
    assert.equal(await run('document.querySelector(\'[data-folder="qa"]\').checked'), false);
    window.showInactive(); await pause(200);
    const screenshot = '/tmp/acorn-preview-folders.png';
    await fs.writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
    await run('document.getElementById("preview-files-save").click()');
    await wait('!document.getElementById("preview-files-dialog").open && !document.getElementById("project-preview-settings").disabled');
    const request = JSON.stringify({ path: repository, base: '__working_tree__', target: '__working_tree__' });
    let result = await run(`window.acornGit.startPreview(${request})`); assert.equal(result.error, undefined, result.error);
    const root = result.previews.base.root;
    for (const folder of ['qa', 'android/app/build', 'ios/Pods', 'dist']) await assert.rejects(fs.access(path.join(root, folder)), { code: 'ENOENT' });
    await run(`(() => {
      const frame = document.getElementById('base-preview-frame');
      const requestData = (id, url) => window.dispatchEvent(new MessageEvent('message', {
        data: { channel: 'acorn-ui-preview', type: 'data-request', id, url, method: 'GET' },
        origin: new URL(frame.src).origin, source: frame.contentWindow,
      }));
      requestData('verify-external-data-1', 'https://127.0.0.1/data.json');
      requestData('verify-external-data-2', 'https://example.com/data.json');
    })()`);
    await wait('document.getElementById("preview-files-dialog").open && document.getElementById("preview-external-data-tab").getAttribute("aria-selected") === "true" && document.querySelectorAll(".preview-external-data-row").length === 3');
    assert.equal(await run('document.querySelector(\'[data-folder="qa"]\').checked'), false);
    const bounds = await run('(() => {const a=document.getElementById("project-preview-settings").getBoundingClientRect(); const b=document.getElementById("project-directory").getBoundingClientRect(); return [a.width,a.height,b.height];})()');
    assert.deepEqual(bounds, [26, 26, 26]);
    await pause(100);
    const tabState = await run(`(() => {
      const dialog = document.getElementById('preview-files-dialog');
      const projectHeight = dialog.getBoundingClientRect().height;
      const projectFooterBottom = dialog.querySelector('footer').getBoundingClientRect().bottom;
      document.getElementById('preview-external-data-tab').click();
      const external = document.getElementById('preview-external-data-panel');
      const project = document.getElementById('preview-project-files-panel');
      const rows = [...document.querySelectorAll('.preview-external-data-row')];
      const row = document.querySelector('[data-origin="https://127.0.0.1"]').closest('.preview-external-data-row');
      const state = [project.hidden, external.hidden, external.textContent.includes('external data'), rows.length, rows[0].children[1].textContent, [...row.children].map(item => item.tagName), row.children[1].textContent, row.children[2].textContent, row.querySelector('input').checked, getComputedStyle(row.querySelector('input')).appearance, dialog.getBoundingClientRect().height === projectHeight, dialog.querySelector('footer').getBoundingClientRect().bottom === projectFooterBottom, dialog.style.minHeight !== ''];
      row.querySelector('input').click();
      return state;
    })()`);
    assert.deepEqual(tabState, [true, false, true, 3, 'All', ['INPUT', 'STRONG', 'SMALL'], '127.0.0.1', 'https://127.0.0.1', false, 'none', true, true, true]);
    await run(`(() => {
      const frame = document.getElementById('base-preview-frame');
      window.dispatchEvent(new MessageEvent('message', {
        data: { channel: 'acorn-ui-preview', type: 'data-request', id: 'verify-external-data-3', url: 'https://later.example/data.json', method: 'GET' },
        origin: new URL(frame.src).origin, source: frame.contentWindow,
      }));
    })()`);
    await wait('document.querySelector("[data-origin=\\"https://later.example\\"]")');
    assert.deepEqual(await run(`(() => {
      const first = document.querySelector('[data-origin="https://127.0.0.1"]');
      const latest = document.querySelector('[data-origin="https://later.example"]');
      const all = document.querySelector('.preview-external-data-all input');
      const state = [first.checked, latest.checked, latest.closest('.preview-external-data-row').classList.contains('is-new'), all.indeterminate];
      all.click();
      document.getElementById('preview-project-files-tab').click();
      return state;
    })()`), [true, false, true, true]);
    window.setSize(700, 600); await pause(100);
    const analysisLayout = await run(`(() => {
      const dialog = document.getElementById('preview-files-dialog');
      const details = document.getElementById('preview-files-warning');
      const list = document.getElementById('preview-files-warning-list');
      const folderList = document.getElementById('preview-files-list');
      const content = details.querySelector('.preview-files-warning-content');
      const folderListHeight = folderList.getBoundingClientRect().height;
      list.replaceChildren(...Array.from({ length: 30 }, (_, index) => {
        const item = document.createElement('li'); item.textContent = 'Unresolved reference ' + index; return item;
      }));
      details.hidden = false; details.open = true;
      const dialogBounds = dialog.getBoundingClientRect();
      const footerBounds = dialog.querySelector('footer').getBoundingClientRect();
      return new Promise(resolve => requestAnimationFrame(() => resolve({
        dialogOverflow: getComputedStyle(dialog).overflow,
        detailsOverflow: getComputedStyle(details).overflow,
        contentOverflowY: getComputedStyle(content).overflowY,
        contentHasOverflow: content.scrollHeight > content.clientHeight,
        folderListKeptHeight: folderList.getBoundingClientRect().height === folderListHeight,
        footerInsideDialog: footerBounds.bottom <= dialogBounds.bottom,
        dialogHasOverflow: dialog.scrollHeight > dialog.clientHeight,
      })));
    })()`);
    assert.deepEqual(analysisLayout, {
      dialogOverflow: 'clip',
      detailsOverflow: 'hidden',
      contentOverflowY: 'auto',
      contentHasOverflow: true,
      folderListKeptHeight: true,
      footerInsideDialog: true,
      dialogHasOverflow: false,
    });
    await run('document.querySelector(\'[data-folder="dist"]\').click(); document.getElementById("preview-files-save").click();');
    await wait('!document.getElementById("preview-files-dialog").open');
    assert.deepEqual((await run(`window.acornGit.previewDataStatus(${JSON.stringify({ path: repository })})`)).sources.map(source => source.allowed), [true, true, true]);
    result = await run(`window.acornGit.startPreview(${request})`); assert.equal(result.error, undefined, result.error);
    assert.match(await fs.readFile(path.join(result.previews.base.root, 'dist/index.html'), 'utf8'), /Export/);
    const historical = await run(`window.acornGit.startPreview(${JSON.stringify({ path: repository, base: 'main', target: 'main' })})`);
    assert.equal(historical.error, undefined, historical.error);
    assert.match(await fs.readFile(path.join(historical.previews.base.root, 'dist/index.html'), 'utf8'), /Export/);
    const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    await run('void window.acornGit.reloadApp()');
    await reloaded;
    await wait('typeof window.PreviewFilePicker !== "undefined" && !document.getElementById("project-preview-settings").disabled');
    await run('document.getElementById("project-preview-settings").click()');
    await wait('document.getElementById("preview-files-dialog").open && !document.getElementById("preview-files-save").disabled');
    assert.equal(await run('document.querySelector(\'[data-folder="dist"]\').checked'), true);
    assert.equal(await run('document.querySelector(\'[data-folder="qa"]\').checked'), false);
    console.log(JSON.stringify({ success: true, screenshot, checks: 'access before scan, connect, progress, cancel, defaults, persistence, connect tabs hidden, automatic external data prompt, external data all selection, analysis details scroll containment, working tree exclusion, historical inclusion, reload' }));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { clearTimeout(deadline); if (window && !window.isDestroyed()) window.destroy(); await fs.rm(temporary, { recursive: true, force: true }); app.exit(process.exitCode || 0); }
})();

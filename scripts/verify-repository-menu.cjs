const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const git = require('isomorphic-git');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acorn-repository-menu-'));
const profile = path.join(scratch, 'profile');
fs.mkdirSync(profile);
app.setPath('userData', profile);
app.setPath('sessionData', path.join(scratch, 'session'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const repo = path.join(scratch, 'repository');
  fs.mkdirSync(repo);
  await git.init({ fs, dir: repo, defaultBranch: 'main' });
  for (const label of ['Before', 'After']) {
    fs.writeFileSync(path.join(repo, 'index.html'), `<h1>${label}</h1>`);
    await git.add({ fs, dir: repo, filepath: 'index.html' });
    await git.commit({ fs, dir: repo, author: { name: 'Test', email: 'test@example.test' }, message: label });
  }
  fs.writeFileSync(path.join(profile, 'repositories.json'), JSON.stringify([repo]));
  require('../src/main/desktop-main.cjs');
  await app.whenReady();
  const window = BrowserWindow.getAllWindows()[0];
  window.hide();
  const run = code => window.webContents.executeJavaScript(code);
  const deadline = setTimeout(() => { console.error('Comparison verification timed out'); app.exit(1); }, 90000);
  const waitFor = async code => {
    for (let i = 0; i < 300; i++) {
      if (!window.webContents.isLoading() && await run(code)) return;
      await pause(100);
    }
    console.error(await run(`JSON.stringify({state: previewState, comparison: activeComparison, text: document.body.innerText})`));
    throw new Error(`Timed out: ${code}`);
  };
  await waitFor(`activeComparison || get('preview-files-dialog').open`);
  if (await run(`get('preview-files-dialog').open`)) {
    await waitFor(`!get('preview-files-save').disabled`);
    await run(`get('preview-files-save').click()`);
  }
  await waitFor(`activeComparison && Object.values(previewState).every(state => state === 'ready')`);
  assert.equal(await run(`document.querySelector('.repository-more').nextElementSibling.className`), 'new-comparison');
  await run(`document.querySelector('.repository-more').click()`);
  assert.equal(await run(`get('comparison-menu').matches(':popover-open')`), true);
  assert.equal(await run(`get('comparison-rename').hidden`), true);
  assert.equal(await run(`get('comparison-delete').textContent`), 'Remove Repository');
  assert.equal(await run(`document.activeElement.id`), 'comparison-delete');
  await run(`get('comparison-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  assert.equal(await run(`document.activeElement.className`), 'repository-more');
  await run(`document.querySelector('.comparison-more').click()`);
  assert.equal(await run(`get('comparison-rename').hidden`), false);
  assert.equal(await run(`get('comparison-delete').textContent`), 'Delete');
  await run(`document.querySelector('.repository-more').click(); get('comparison-delete').click()`);
  assert.equal(await run(`get('repository-delete-dialog').open`), true);
  assert.equal(await run(`document.activeElement.id`), 'repository-delete-cancel');
  assert.equal(await run(`repositories.length`), 1);
  await run(`get('repository-delete-cancel').click()`);
  await pause(100);
  assert.equal(await run(`repositories.length`), 1);
  assert.equal(await run(`document.activeElement.className`), 'repository-more');
  await run(`document.querySelector('.comparison-more').click(); get('comparison-delete').click(); previewRefresh`);
  assert.equal(await run(`get('repository-delete-dialog').open`), false);
  assert.equal(await run(`document.querySelectorAll('.comparison-item').length`), 0);
  await run(`get('empty-comparison').click()`);
  await waitFor(`activeComparison && Object.values(previewState).every(state => state === 'ready')`);
  await run(`document.querySelector('.repository-more').click(); get('comparison-delete').click()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(`!get('repository-delete-dialog').open`);
  assert.equal(await run(`repositories.length`), 1);
  await run(`document.querySelector('.repository-more').click(); get('comparison-delete').click(); get('repository-delete-confirm').click()`);
  await waitFor(`repositories.length === 0 && !get('connection-empty').hidden`);
  await run(`previewRefresh`);
  assert.equal(await run(`document.querySelectorAll('.repository-row').length`), 0);
  assert.equal(await run(`window.acornGit.listPreviewServers().then(result => result.servers.length)`), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'repositories.json'), 'utf8')), []);
  assert.equal(fs.existsSync(path.join(repo, '.git')), true);
  assert.equal(fs.readFileSync(path.join(repo, 'index.html'), 'utf8'), '<h1>After</h1>');
  window.reload();
  await pause(300);
  await waitFor(`!get('project-loading').hidden === false && !get('connection-empty').hidden`);
  assert.equal(await run(`repositories.length`), 0);
  console.log('Passed: repository menu placement, labels, confirmation cancel/Escape, immediate comparison deletion, confirmed persisted removal, preview cleanup, local files preserved, reload.');
  clearTimeout(deadline);
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });

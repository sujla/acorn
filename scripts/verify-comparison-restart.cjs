// Run with Node: each phase launches and fully quits a separate Electron process.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function verifyRestart() {
  const { spawn } = require('node:child_process');
  const git = require('isomorphic-git');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acorn-comparison-restart-'));
  try {
    const repo = path.join(scratch, 'repository');
    const profile = path.join(scratch, 'profile');
    fs.mkdirSync(repo);
    fs.mkdirSync(profile);
    await git.init({ fs, dir: repo, defaultBranch: 'main' });
    for (const label of ['Before', 'After']) {
      fs.writeFileSync(path.join(repo, 'index.html'), `<h1>${label}</h1>`);
      await git.add({ fs, dir: repo, filepath: 'index.html' });
      await git.commit({ fs, dir: repo, author: { name: 'Test', email: 'test@example.test' }, message: label });
    }
    fs.writeFileSync(path.join(profile, 'repositories.json'), JSON.stringify([repo]));
    for (const phase of ['create', 'restore', 'empty']) {
      await new Promise((resolve, reject) => {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(require('electron'), [__filename, scratch, phase], { env, stdio: 'inherit' });
        const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 60000);
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.on('exit', (code, signal) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(new Error(`${phase} failed: ${signal || code}`));
        });
      });
    }
    console.log('Passed: full app restarts preserve comparison IDs, order, names, refs, and explicit deletion.');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function runPhase() {
  const { app, BrowserWindow } = require('electron');
  const [scratch, phase] = process.argv.slice(2);
  app.setPath('userData', path.join(scratch, 'profile'));
  app.setPath('sessionData', path.join(scratch, 'session'));
  require('../src/main/desktop-main.cjs');
  await app.whenReady();
  const window = BrowserWindow.getAllWindows()[0];
  window.hide();
  const run = code => window.webContents.executeJavaScript(code);
  const waitFor = async code => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (!window.webContents.isLoading() && await run(code)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${code}`);
  };
  await waitFor('repositories.length === 1 && get("project-loading").hidden');
  if (phase === 'empty') {
    await waitFor('!get("comparison-empty").hidden');
    assert.equal(await run('document.querySelectorAll(".comparison-item").length'), 0);
    assert.equal(await run('JSON.stringify(comparisonsFor(repositories[0]))'), '[]');
  } else {
    await waitFor('activeComparison && Object.values(previewState).every(state => state === "ready")');
    if (phase === 'create') {
      await run('document.querySelector(".new-comparison").click()');
      await waitFor('Object.values(previewState).every(state => state === "ready")');
      await run(`document.querySelector('.comparison-item.active').parentElement.querySelector('.comparison-more').click();
        get('comparison-rename').click(); get('comparison-name').value = 'Release review';
        get('comparison-rename-form').requestSubmit();
        baseRef.value = '__working_tree__'; baseRef.dispatchEvent(new Event('change'));`);
      await waitFor('Object.values(previewState).every(state => state === "ready")');
      fs.writeFileSync(path.join(scratch, 'expected.json'), await run('JSON.stringify(comparisonsFor(activeRepository))'));
      // Comparison persistence must not depend on Chromium storage or shutdown flushing.
      await window.webContents.session.clearStorageData({ storages: ['localstorage'] });
      app.exit(0);
      return;
    } else {
      assert.equal(await run('document.querySelectorAll(".comparison-item").length'), 2);
      assert.equal(await run('JSON.stringify(comparisonsFor(activeRepository))'), fs.readFileSync(path.join(scratch, 'expected.json'), 'utf8'));
      assert.equal(await run('document.querySelectorAll(".comparison-item")[1].textContent'), 'Release review');
      await run('deleteComparison(activeRepository, comparisonsFor(activeRepository)[1])');
      await run('deleteComparison(activeRepository, activeComparison)');
      await waitFor('!get("comparison-empty").hidden');
    }
  }
  // Use the production shutdown path; do not manually flush storage for the test.
  app.quit();
}

(process.versions.electron ? runPhase() : verifyRestart()).catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});

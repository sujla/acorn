// Run with Electron; optional absolute repository path exercises a real project read-only.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const git = require('isomorphic-git');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acorn-desktop-preview-'));
const profile = path.join(scratch, 'profile');
fs.mkdirSync(profile);
app.setPath('userData', profile);
app.setPath('sessionData', path.join(scratch, 'session'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const expo = process.argv[2] === '--expo';
  const repository = (expo ? null : process.argv[2]) || path.join(scratch, 'repository');
  if (!process.argv[2] || expo) {
    await fsp.mkdir(repository);
    await git.init({ fs, dir: repository, defaultBranch: 'main' });
    for (const label of ['Before', 'After']) {
      await fsp.writeFile(path.join(repository, 'index.html'), `<h1>${label}</h1><script type="module" src="/main.ts"></script>`);
      await fsp.writeFile(path.join(repository, 'main.ts'), 'document.body.dataset.ready = "yes";');
      for (const filepath of ['index.html', 'main.ts']) await git.add({ fs, dir: repository, filepath });
      if (expo) {
        await fsp.rm(path.join(repository, 'index.html'));
        await fsp.rm(path.join(repository, 'main.ts'));
        await git.remove({ fs, dir: repository, filepath: 'index.html' });
        await git.remove({ fs, dir: repository, filepath: 'main.ts' });
        await fsp.mkdir(path.join(repository, 'dist/_expo'), { recursive: true });
        const entries = {
          'package.json': JSON.stringify({ dependencies: { expo: '*' }, scripts: { dev: 'exit 99' } }),
          'dist/index.html': `<h1>${label}</h1><script src="/_expo/app.js"></script>`,
          'dist/about.html': `<h1>${label} route</h1>`,
          'dist/_expo/app.js': 'document.body.dataset.ready = "yes";',
        };
        for (const [filepath, body] of Object.entries(entries)) {
          await fsp.writeFile(path.join(repository, filepath), body);
          await git.add({ fs, dir: repository, filepath });
        }
      }
      await git.commit({ fs, dir: repository, author: { name: 'Acorn Test', email: 'test@example.test' }, message: label });
    }
  }
  // Leave the UI empty so this test controls the timing of concurrent starts.
  fs.writeFileSync(path.join(profile, 'repositories.json'), '[]');
  require('../src/main/desktop-main.cjs');
  await app.whenReady();
  const window = BrowserWindow.getAllWindows()[0];
  window.hide();
  const browserErrors = [];
  window.webContents.on('console-message', event => { if (event.level === 'error') browserErrors.push(event.message); });
  for (let i = 0; i < 100 && window.webContents.isLoading(); i++) await pause(50);
  fs.writeFileSync(path.join(profile, 'repositories.json'), JSON.stringify([repository]));
  const invoke = code => window.webContents.executeJavaScript(code);
  const deadline = setTimeout(() => { console.error('Desktop preview test timed out:', scratch); app.exit(1); }, 180000);
  try {
    const repos = await invoke('window.acornGit.listRepositories()');
    assert.equal(repos.length, 1);
    const ref = repos[0].currentBranch;
    const request = JSON.stringify({ path: repository, base: ref, target: ref, runtime: 'web' });
    const started = Date.now();
    const results = await invoke(`Promise.all([window.acornGit.startPreview(${request}), window.acornGit.startPreview(${request})])`);
    for (const result of results) assert.equal(result.error, undefined, result.error);
    assert.equal(results[0].previews.base.url, results[1].previews.base.url, 'Concurrent starts must share one server');
    const list = await invoke('window.acornGit.listPreviewServers()');
    assert.equal(list.servers.length, 1);
    const preview = results[0].previews.base;
    for (const directory of preview.outputDirectories || []) {
      await assert.rejects(fsp.access(path.join(preview.root, directory)), { code: 'ENOENT' });
      assert.ok(preview.catalog.pages.every(page => !page.path.startsWith('/' + directory + '/')));
    }
    await invoke(`document.getElementById('base-preview-frame').src=${JSON.stringify(preview.url)}`);
    let frame;
    for (let i = 0; i < 200; i++) {
      frame = window.webContents.mainFrame.frames.find(frame => frame.name === 'base-preview' && frame.url.startsWith(preview.url));
      if (frame && await frame.executeJavaScript('document.readyState === "complete" && document.body.innerText.trim().length > 0').catch(() => false)) break;
      await pause(50);
    }
    assert.ok(frame, 'Preview frame must load');
    if (process.env.ACORN_VERIFY_EXPO) {
      await pause(3000);
      console.log(JSON.stringify({ browserErrors, body: await frame.executeJavaScript('document.body.innerText.slice(0, 1800)') }));
      assert.equal(await frame.executeJavaScript('document.getElementById("root")?.children.length > 0'), true, 'Expo must mount a real screen');
      assert.deepEqual(browserErrors.filter(message => message.startsWith('Uncaught')), [], 'No uncaught render errors');
    }
    assert.equal(await frame.executeJavaScript('typeof require'), 'undefined');
    assert.ok(await frame.executeJavaScript('document.body.innerText.trim().length > 0'));
    assert.equal(await frame.executeJavaScript("fetch('https://example.com/').then(()=>false,()=>true)"), true);
    if (expo) {
      assert.equal(await frame.executeJavaScript('document.body.dataset.ready'), 'yes');
      assert.match(await (await fetch(preview.url + 'about')).text(), /After route/);
      const commits = await git.log({ fs, dir: repository });
      const compared = await invoke(`window.acornGit.startPreview(${JSON.stringify({ path: repository, base: commits[1].oid, target: commits[0].oid })})`);
      assert.equal(compared.error, undefined, compared.error);
      assert.match(await (await fetch(compared.previews.base.url)).text(), /Before/);
      assert.match(await (await fetch(compared.previews.target.url)).text(), /After/);
      const servers = await invoke('window.acornGit.listPreviewServers()');
      for (const server of servers.servers.filter(server => server.url !== list.servers[0].url)) {
        await invoke(`window.acornGit.stopPreviewServer(${JSON.stringify(server)})`);
      }
    }
    await invoke(`window.acornGit.stopPreviewServer(${JSON.stringify(list.servers[0])})`);
    assert.equal((await invoke('window.acornGit.listPreviewServers()')).servers.length, 0);
    const restarted = await invoke(`window.acornGit.startPreview(${request})`);
    assert.equal(restarted.error, undefined, restarted.error);
    assert.notEqual(restarted.previews.base.url, preview.url);
    assert.equal((await invoke('window.acornGit.listPreviewServers()')).servers.length, 1);
    console.log(JSON.stringify({ passed: true, elapsedMs: Date.now() - started, checks: ['real desktop IPC', 'concurrent start', 'rendered frame', 'no Node in preview', 'external fetch denied', 'stop and restart'] }));
  } catch (error) { process.exitCode = 1; console.error(error); }
  finally { clearTimeout(deadline); app.quit(); }
})().catch(error => { console.error(error); app.exit(1); });

// Real Electron verification with an isolated application and profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-startup-'));
  const children = [];
  const waitFor = async name => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (await fs.stat(path.join(root, name)).catch(() => null)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${name}`);
  };
  const launch = () => {
    const child = spawn(require('electron'), [root], { stdio: 'inherit' });
    children.push(child);
    return child;
  };
  try {
    await fs.copyFile(path.join(__dirname, '../desktop-lifecycle.cjs'), path.join(root, 'desktop-lifecycle.cjs'));
    await fs.writeFile(path.join(root, 'desktop.cjs'), `
      const { app, BrowserWindow, dialog } = require('electron');
      app.setPath('userData', require('node:path').join(__dirname, 'profile'));
      require('./desktop-lifecycle.cjs').startApplication({ app, BrowserWindow, dialog, load: file => require(file) });
    `);
    await fs.mkdir(path.join(root, 'profile'));
    const manifest = main => JSON.stringify({ name: 'acorn-startup-check', main: 'desktop.cjs', acorn: { main, renderer: 'index.html' } });
    await fs.writeFile(path.join(root, 'package.json'), manifest('main.cjs'));
    await fs.writeFile(path.join(root, 'index.html'), '<h1>Startup check</h1>');
    await fs.writeFile(path.join(root, 'main.cjs'), `
      const { app, BrowserWindow } = require('electron');
      const fs = require('node:fs');
      const path = require('node:path');
      fs.appendFileSync(path.join(__dirname, 'loads'), 'loaded\\n');
      app.on('second-instance', () => fs.writeFileSync(path.join(__dirname, 'second'), 'ok'));
      app.whenReady().then(async () => {
        const window = new BrowserWindow({ show: false });
        await window.loadFile(app.acornRendererPath);
        fs.writeFileSync(path.join(__dirname, 'ready'), 'ok');
      });
    `);
    launch();
    await waitFor('ready');
    const duplicate = launch();
    const duplicateExit = new Promise(resolve => duplicate.once('exit', resolve));
    await waitFor('second');
    assert.equal(await duplicateExit, 0);
    assert.equal(await fs.readFile(path.join(root, 'loads'), 'utf8'), 'loaded\n');
    await fs.writeFile(path.join(root, 'relocated.cjs'), `
      const { app } = require('electron');
      require('node:fs').writeFileSync(require('node:path').join(__dirname, 'restarted'), 'ok');
      app.whenReady().then(() => app.quit());
    `);
    await fs.writeFile(path.join(root, 'package.json'), manifest('relocated.cjs'));
    await waitFor('restarted');
    console.log(JSON.stringify({ passed: true, checks: ['single process', 'second launch notification', 'layout change relaunch'] }));
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

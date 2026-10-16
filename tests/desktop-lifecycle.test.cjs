const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { readLayout, startApplication } = require('../desktop-lifecycle.cjs');

function fixture(t, locked = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acorn-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writeLayout = (main = 'main.cjs', renderer = 'index.html') => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ acorn: { main, renderer } }));
  };
  fs.writeFileSync(path.join(root, 'main.cjs'), '');
  fs.writeFileSync(path.join(root, 'index.html'), '');
  writeLayout();
  const calls = [];
  const app = Object.assign(new EventEmitter(), {
    getAppPath: () => root, requestSingleInstanceLock: () => locked,
    quit: () => calls.push('quit'), relaunch: () => calls.push('relaunch'),
    whenReady: () => Promise.resolve(),
  });
  let tick;
  const windows = [];
  const options = {
    app, BrowserWindow: { getAllWindows: () => windows },
    dialog: { showErrorBox: () => calls.push('error') },
    load: file => calls.push(file),
    schedule: callback => { tick = callback; return {}; },
    unschedule: () => calls.push('clear'),
  };
  return { root, calls, app, windows, options, writeLayout, tick: () => tick() };
}

test('a duplicate exits without loading application code or starting a watcher', t => {
  const f = fixture(t, false);
  startApplication(f.options);
  assert.deepEqual(f.calls, ['quit']);
  assert.equal(f.app.listenerCount('second-instance'), 0);
});

test('a second launch restores and focuses the existing window, or recreates a closed window', async t => {
  const f = fixture(t);
  startApplication(f.options);
  f.windows.push({ isDestroyed: () => false, isMinimized: () => true,
    restore: () => f.calls.push('restore'), show: () => f.calls.push('show'), focus: () => f.calls.push('focus') });
  f.app.emit('second-instance');
  assert.deepEqual(f.calls.slice(1), ['restore', 'show', 'focus']);
  f.windows.length = 0;
  f.app.on('activate', () => f.calls.push('activate'));
  f.app.emit('second-instance');
  await Promise.resolve();
  assert.equal(f.calls.at(-1), 'activate');
});

test('a folder reorganization waits for complete files, then relaunches exactly once', t => {
  const f = fixture(t);
  startApplication(f.options);
  f.tick();
  assert.equal(f.calls.length, 1);
  f.writeLayout('moved/main.cjs', 'moved/index.html');
  f.tick();
  assert.equal(f.calls.length, 1);
  fs.mkdirSync(path.join(f.root, 'moved'));
  fs.renameSync(path.join(f.root, 'main.cjs'), path.join(f.root, 'moved/main.cjs'));
  f.tick();
  assert.equal(f.calls.length, 1);
  fs.renameSync(path.join(f.root, 'index.html'), path.join(f.root, 'moved/index.html'));
  f.tick();
  f.tick();
  assert.deepEqual(f.calls.slice(1), ['relaunch', 'quit']);
  f.app.emit('before-quit');
  assert.equal(f.calls.at(-1), 'clear');
});

test('broken startup paths display an error; paths outside the app are rejected', t => {
  const f = fixture(t);
  f.writeLayout('missing.cjs');
  startApplication(f.options);
  assert.deepEqual(f.calls, ['error', 'quit']);
  f.writeLayout('../outside.cjs');
  assert.throws(() => readLayout(f.root), /inside the application/);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/main/desktop-main.cjs'), 'utf8');

test('full reload drains pending requests, stops servers, then reloads and rejects new starts', async () => {
  const handlers = new Map(), order = [];
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const contents = { mainFrame: {}, reload: () => order.push('reload') };
  const context = vm.createContext({
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    mainWindow: { webContents: contents }, reloadStarted: false,
    previewRequests: new Set([pending]), cancelBuilds: () => order.push('cancel'),
    stopPreviewServers: async () => order.push('stop'),
  });
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('app:reload'"), source.indexOf('async function handlePreviewStart')), context);
  const reload = handlers.get('app:reload');
  assert.match((await reload({ sender: {} })).error, /Unauthorized/);
  assert.deepEqual(order, []);
  const result = reload({ sender: contents, senderFrame: contents.mainFrame });
  assert.deepEqual(order, ['cancel']);
  assert.match(handlers.get('preview:start')({}, {}).error, /reloading/);
  finish();
  assert.equal((await result).success, true);
  assert.deepEqual(order, ['cancel', 'stop', 'reload']);
  assert.equal(context.reloadStarted, false);
});

test('keyboard refresh intercepts native reload and forwards preview/full intent', () => {
  let handler;
  const messages = [];
  const context = vm.createContext({ mainWindow: { webContents: {
    on: (_name, callback) => { handler = callback; },
    send: (channel, request) => messages.push({ channel, full: request.full }),
  } } });
  vm.runInContext(source.slice(source.indexOf("  mainWindow.webContents.on('before-input-event'"), source.indexOf('  mainWindow.loadFile')), context);
  let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  handler(event, { key: 'r', meta: true, type: 'keyDown', shift: false });
  handler(event, { key: 'R', meta: true, type: 'keyDown', shift: true });
  handler(event, { key: 'r', control: true, type: 'keyDown', shift: false });
  handler(event, { key: 'r', meta: true, type: 'keyUp' });
  handler(event, { key: 'r', meta: true, type: 'keyDown', isAutoRepeat: true });
  assert.equal(prevented, 5);
  assert.deepEqual(messages.map(item => item.full), [false, true, false]);
  handler(event, { key: 'r', type: 'keyDown' });
  assert.equal(prevented, 5);
});

test('menu accelerators dispatch comparison refresh instead of native renderer reload', () => {
  const { installRefreshMenu } = require('../src/main/refresh-menu.cjs');
  let menu;
  const messages = [];
  installRefreshMenu({ buildFromTemplate: template => template, setApplicationMenu: value => { menu = value; } },
    () => ({ isDestroyed: () => false, webContents: { send: (channel, payload) => messages.push([channel, payload.full]) } }));
  const view = menu.find(item => item.label === 'View').submenu;
  assert.ok(view.every(item => !['reload', 'forceReload'].includes(item.role)));
  const preview = view.find(item => item.id === 'refresh-preview');
  assert.equal(preview.accelerator, 'CommandOrControl+R');
  preview.click();
  view.find(item => item.id === 'reload-acorn').click();
  assert.deepEqual(messages, [['app:refresh', false], ['app:refresh', true]]);
});

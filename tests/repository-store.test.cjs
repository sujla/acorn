const { test } = require('node:test');
const assert = require('node:assert/strict');
const { repositoryRecords, saveRecord, reorderRecords } = require('../src/main/repository-store.cjs');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const mainSource = fs.readFileSync(require.resolve('../src/main/desktop-main.cjs'), 'utf8');

test('packaged startup isolates repository and browser state from development', () => {
  const start = mainSource.indexOf('if (app.isPackaged)');
  const block = mainSource.slice(start, mainSource.indexOf('\n\n', start));
  for (const isPackaged of [false, true]) {
    const paths = { appData: '/profile', userData: '/profile/acorn', sessionData: '/profile/acorn' };
    const created = new Set();
    vm.runInNewContext(block, { path, require: () => ({ mkdirSync: dir => created.add(dir) }),
      app: { isPackaged, getPath: key => paths[key], setPath: (key, value) => { assert.ok(created.has(value)); paths[key] = value; } } });
    assert.equal(paths.userData, isPackaged ? '/profile/Acorn Desktop' : '/profile/acorn');
    assert.equal(paths.sessionData, paths.userData);
  }
});

test('folder selection waits for approval and cancellation never reads the repository', async () => {
  const start = mainSource.indexOf('async function chooseLocalRepository(');
  const source = mainSource.slice(start, mainSource.indexOf('\nasync function repositoryDiff', start));
  let resolveDialog;
  let reads = 0;
  const folderReads = [];
  let options;
  const context = vm.createContext({
    app: { getPath: () => '/Desktop' }, path, mainWindow: {},
    dialog: { showOpenDialog: (_, value) => { options = value; return new Promise(resolve => { resolveDialog = resolve; }); } },
    runGit: async selected => { reads++; return selected; },
    fs: { readdir: async selected => { folderReads.push(selected); return []; } },
  });
  vm.runInContext(source, context);
  const canceled = context.chooseLocalRepository({ save: false, inspect: false, defaultPath: '/dropped' });
  assert.equal(options.defaultPath, '/dropped');
  assert.equal(reads, 0);
  assert.deepEqual(folderReads, []);
  resolveDialog({ canceled: true, filePaths: [] });
  assert.equal(await canceled, null);
  assert.equal(reads, 0);
  assert.deepEqual(folderReads, []);
  const approved = context.chooseLocalRepository({ save: false, inspect: false });
  assert.equal(reads, 0);
  resolveDialog({ canceled: false, filePaths: ['/selected'] });
  assert.equal((await approved).path, '/selected');
  assert.equal(reads, 1);
  assert.deepEqual(folderReads, ['/selected']);
});

test('Choose from Device opens the picker directly while new repo uses the drop modal', async () => {
  const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
  const start = source.indexOf("get('add-project').addEventListener('click'");
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; } });
    return elements.get(id);
  };
  let opens = 0;
  let choices = 0;
  let dropped;
  let connectionOptions;
  const context = vm.createContext({ get,
    showConnectionModal: () => { opens++; },
    bridge: {
      chooseLocalRepository: async () => { choices++; return {}; },
      chooseDroppedRepository: async file => { dropped = file; return {}; },
    },
    addConnection: async (_, options) => { connectionOptions = options; },
  });
  vm.runInContext(source.slice(start, source.indexOf("get('project-preview-settings').addEventListener", start)), context);
  await get('empty-connect').handlers.click();
  assert.equal(opens, 0);
  assert.equal(choices, 1);
  assert.equal(connectionOptions.reopenModalOnCancel, false);
  assert.equal(connectionOptions.showErrorsInModal, false);
  assert.equal(get('empty-connect').disabled, false);
  get('add-project').handlers.click();
  assert.equal(opens, 1);
  assert.equal(choices, 1);
  await get('connect-local').handlers.click();
  assert.equal(choices, 2);
  const file = { name: 'repository' };
  get('connect-local').handlers.drop({ preventDefault() {}, dataTransfer: { files: [file] } });
  assert.equal(dropped, file);
  assert.equal(get('connect-local').disabled, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('connect-local').disabled, false);
});

test('legacy repository paths migrate to records and malformed entries are ignored', () => {
  assert.deepEqual(repositoryRecords(['/one', { path: '/two', bookmark: 'secure' }, null, { nope: true }]), [
    { path: '/one' },
    { path: '/two' },
  ]);
});

test('saving and reordering repositories keeps unique local paths', () => {
  const records = repositoryRecords([{ path: '/one', bookmark: 'first' }, { path: '/two', bookmark: 'second' }]);
  assert.deepEqual(saveRecord(records, '/one'), [
    { path: '/one' },
    { path: '/two' },
  ]);
  assert.deepEqual(reorderRecords(records, ['/two', '/two']), [
    { path: '/two' },
    { path: '/one' },
  ]);
});

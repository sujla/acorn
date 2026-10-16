const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const appSource = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
const mainSource = fs.readFileSync(require.resolve('../src/main/desktop-main.cjs'), 'utf8');

test('repository removal sends every comparison id and clears retained client state', async () => {
  const repository = { path: '/removed', name: 'Removed' };
  const comparisons = [{ id: 'one' }, { id: 'two' }];
  const removedKeys = [];
  const removedFrames = [];
  let payload;
  const context = vm.createContext({
    closeComparisonMenu() {},
    comparisonsFor: () => comparisons,
    bridge: {
      removeRepository: async value => { payload = value; return { success: true }; },
    },
    notify: error => { throw new Error('Unexpected notification: ' + error); },
    repositories: [repository, { path: '/kept' }],
    collapsedRepositories: new Set(['/removed']),
    activeRepository: { path: '/kept' },
    activeComparison: null,
    activateRepository() {},
    showEmptyComparisons() {},
    get() { throw new Error('Unexpected DOM access'); },
    runtimeMode: {},
    projectPreviewSessions: new Map([
      [JSON.stringify(['/removed', 'one']), { frames: { base: { remove: () => removedFrames.push('base') } } }],
      [JSON.stringify(['/removed', 'orphan']), { frames: { target: { remove: () => removedFrames.push('orphan') } } }],
      [JSON.stringify(['/kept', 'three']), { frames: { base: { remove: () => removedFrames.push('kept') } } }],
    ]),
    localStorage: { removeItem: key => removedKeys.push(key) },
    repositoryViewOptionsStorageKey: repo => `repository:${repo.path}`,
    comparisonViewOptionsStorageKey: (repo, comparison) => `comparison:${repo.path}:${comparison.id}`,
    repositoryComparisons: new Map([['/removed', comparisons]]),
    renderProjectList() {},
    runtimeListSignature: 'old',
    refreshRuntimeServers() {},
  });
  const start = appSource.indexOf('async function deleteRepository(');
  vm.runInContext(appSource.slice(start, appSource.indexOf('\nfunction deleteComparison(', start)), context);
  await context.deleteRepository(repository);
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), { path: '/removed', comparisonIds: ['one', 'two'] });
  assert.deepEqual(removedFrames.sort(), ['base', 'orphan']);
  assert.equal(context.projectPreviewSessions.size, 1);
  assert.equal(context.repositoryComparisons.has('/removed'), false);
  assert.deepEqual(removedKeys.sort(), [
    'acorn.comparisons:/removed',
    'acorn.view-options:/removed',
    'comparison:/removed:one',
    'comparison:/removed:two',
    'repository:/removed',
  ].sort());
});

test('a newly reconnected repository clears stale client comparisons before activation', () => {
  const addStart = appSource.indexOf('async function addConnection(');
  const block = appSource.slice(addStart, appSource.indexOf('\nasync function loadMoreCommits(', addStart));
  assert.match(block, /freshConnection = !repositories\.some/);
  assert.match(block, /if \(freshConnection\) clearRepositoryClientState/);
});

test('main-process removal owns all repository preview cleanup', () => {
  const start = mainSource.indexOf("ipcMain.handle('repositories:remove'");
  const block = mainSource.slice(start, mainSource.indexOf("ipcMain.handle('repositories:reorder'", start));
  for (const expected of [
    'previewLifecycle.release',
    'previewLifecycle.stopResource',
    'previewSnapshots.delete',
    'previewData.remove',
    'previewFileSettingsPath',
    'store.remove',
    'previewLifecycle.forget',
    'removedRepositories.add',
  ]) assert.match(block, new RegExp(expected.replace('.', '\\.')));
});

test('successful fresh connection removes stale native comparisons before saving the repository', () => {
  const start = mainSource.indexOf("for (const action of ['scan', 'save', 'cancel'])");
  const block = mainSource.slice(start, mainSource.indexOf("ipcMain.handle('local-profile:status'", start));
  assert.match(block, /wasConnected/);
  assert.match(block, /comparisonStore\(app\.getPath\('userData'\)\)\.remove\(repositoryPath\)/);
  assert.match(block, /removedRepositories\.delete\(repositoryPath\)/);
});

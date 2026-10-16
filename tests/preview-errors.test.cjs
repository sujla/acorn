const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/desktop-main.cjs'), 'utf8');
const context = vm.createContext({ process: { platform: 'darwin', arch: 'arm64' } });
vm.runInContext(source.slice(source.indexOf('function isMissingPreviewCompilerError('), source.indexOf('function cleanLocalRepositoryError(')), context);
const localRepositoryContext = vm.createContext({ cleanGitError: error => error.message });
vm.runInContext(source.slice(source.indexOf('function cleanLocalRepositoryError('), source.indexOf('async function chooseLocalRepository(')), localRepositoryContext);
test('preview explains missing or mismatched compiler binaries instead of the esbuild footnote', () => {
  for (const message of ['You installed esbuild for another platform than the one you are currently using.\nDetails\ncan sometimes be 10x slower', 'The package "@esbuild/darwin-arm64" could not be found']) {
    const result = context.cleanPreviewError(new Error(message));
    assert.match(result, /darwin\/arm64/);
    assert.match(result, /Install it to continue/);
    assert.match(result, /project is unchanged/);
    assert.doesNotMatch(result, /Repair/);
    assert.doesNotMatch(result, /10x/);
  }
});
test('preview retains the cause at the start of a long diagnostic', () => {
  const result = context.cleanPreviewError(new Error('Missing entry main.tsx\n' + 'detail\n'.repeat(20)));
  assert.match(result, /^Missing entry main.tsx/);
  assert.equal(result.split('\n').length, 8);
});

test('preview failures stay visible in the preview area; dependency failures retain their diagnostics', async () => {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      const paragraph = { textContent: '' };
      elements.set(id, { hidden: false, classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) }, querySelector: () => paragraph, setAttribute() {}, removeAttribute() {} });
    }
    return elements.get(id);
  };
  const notifications = [];
  let result = { error: 'No previewable screen was found in this revision.', code: 'NO_PREVIEW_SCREEN' };
  const ui = vm.createContext({
    bridge: { startPreview: async () => result, installPreviewCompiler: async () => ({ compiler: { version: '0.28.2' } }) }, activeRepository: { path: '/repo' }, activeComparison: { id: 'comparison' },
    previewUrls: {}, previewRevision: { target: 0 }, previewState: {}, selectedPages: {}, visualPreviewMode: { target: false }, selectedRuntime: 'automatic',
    baseRef: { value: 'base' }, targetRef: { value: 'target' }, previewCleanup: Promise.resolve(), previewRefresh: Promise.resolve(),
    get, pagePickers: new Map([['target', { loading() {}, failed() {} }]]),
    updateRoute() {}, updateRefreshAllState() {}, refreshRuntimeServers() {},
    notify: (...args) => notifications.push(args),
  });
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  vm.runInContext(app.slice(app.indexOf('const previewUnavailableMessage'), app.indexOf('function restoreExpandedPanelControls(')), ui);
  ui.schedulePreview(['target']);
  await ui.previewRefresh;
  assert.equal(ui.previewState.target, 'empty');
  assert.equal(get('target-preview-loading').hidden, false);
  assert.equal(get('target-preview-loading').classList.contains('preview-empty'), true);
  assert.equal(get('target-preview-loading').querySelector('p').textContent, 'Unable to load the preview.\nTry another branch or commit from the history.');
  assert.equal(notifications.length, 0);
  result = { error: 'This Acorn build does not include the preview compiler for darwin/arm64.', code: 'PREVIEW_COMPILER_MISSING' };
  ui.schedulePreview(['target']);
  await ui.previewRefresh;
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][1].action.label, 'Install preview compiler');
  notifications.length = 0;
  result = { error: 'This revision has no dependency lockfile.', code: 'MISSING_DEPENDENCY_LOCKFILE' };
  ui.schedulePreview(['target']);
  await ui.previewRefresh;
  assert.equal(ui.previewState.target, 'failed');
  assert.equal(get('target-preview-loading').hidden, false);
  assert.equal(get('target-preview-loading').classList.contains('preview-empty'), true);
  assert.equal(get('target-preview-loading').querySelector('p').textContent, 'Unable to load the preview.\nTry another branch or commit from the history.');
  assert.match(notifications[0][0], /lockfile/);
});

test('preview runtime failures are forwarded from the guard and shown as errors', () => {
  const guard = fs.readFileSync(path.join(__dirname, '../src/renderer/ui-preview-guard.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(guard, /send\('runtime-error', \{ message \}\)/);
  assert.match(guard, /unhandledrejection.*reportError\(event\.reason\)/);
  assert.match(app, /event\.data\.type === 'runtime-error'/);
  assert.match(app, /preview error.*dismissible: true, tone: 'error'/);
});

test('sandboxed back navigation handles both Navigation API promises', () => {
  const guard = fs.readFileSync(path.join(__dirname, '../src/renderer/ui-preview-guard.js'), 'utf8');
  assert.match(guard, /traversal\.committed\.catch\(fallback\)/);
  assert.match(guard, /traversal\.finished\.catch\(fallback\)/);
});

test('trusted external preview links are handed to the desktop browser', () => {
  const guard = fs.readFileSync(path.join(__dirname, '../src/renderer/ui-preview-guard.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.cjs'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(guard, /event\.isTrusted.*send\('external-link', \{ url: url\.href \}\)/);
  assert.match(preload, /openExternalPreviewLink:.*preview:open-external/);
  assert.match(app, /event\.data\.type === 'external-link'.*openExternalPreviewLink/s);
});

test('missing compiler failures expose the install IPC and a stable error code', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.cjs'), 'utf8');
  assert.match(preload, /installPreviewCompiler:.*preview:compiler:install/);
  assert.match(source, /isMissingPreviewCompilerError\(error\) \? 'PREVIEW_COMPILER_MISSING'/);
});

test('normalizes missing Git roots without exposing the selected path', () => {
  for (const message of [
    'Could not find git root for /Users/example/project.',
    'fatal: not a git repository (or any of the parent directories): .git',
  ]) {
    assert.equal(localRepositoryContext.cleanLocalRepositoryError(new Error(message)), 'Could not find a git root for this project');
  }
  assert.equal(localRepositoryContext.cleanLocalRepositoryError(new Error('Permission denied')), 'Permission denied');
});

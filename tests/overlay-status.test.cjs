const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
function fixture(hints, scope = 'both') {
  const selection = { value: scope };
  const messages = [];
  const timers = new Map();
  let nextTimer = 0;
  const element = () => {
    const classes = new Set();
    return {
      hidden: true,
      dataset: {},
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
        contains: name => classes.has(name),
      },
      setAttribute() {},
    };
  };
  const elements = { 'diff-overlay': { checked: true }, 'diff-scope': { hidden: true, querySelector: () => selection }, 'diff-progress': element(), 'diff-progress-message': element() };
  const context = vm.createContext({
    overlayDiff: { hints, files: [{}] }, overlayCounts: {}, overlayRequests: {}, overlayMatchedFiles: {}, overlayRequestSequence: 0, diffRequestVersion: 1, diffLoadError: null, diffProgressHideTimeout: null, toastDuration: 3000,
    get: id => elements[id], document: { documentElement: { dataset: { theme: 'light' } }, body: element() }, getComputedStyle: () => ({ getPropertyValue: () => '#6810e8' }), sendPreviewSync: (side, message) => messages.push({ side, ...message }),
    window: {
      clearTimeout: id => timers.delete(id),
      setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    },
    setToastAlertVisible: (alert, visible) => { alert.dataset.toastVisible = String(visible); },
  });
  vm.runInContext(source.slice(source.indexOf('function updateDiffProgress('), source.indexOf("get('diff-overlay').addEventListener")), context);
  return { context, elements, selection, messages, timers };
}
test('progress stays visible until both previews respond, including zero matches', () => {
  const { context, elements, timers } = fixture({ base: [{}], target: [{}] });
  context.configureDiffOverlay();
  assert.equal(elements['diff-progress'].hidden, false);
  assert.equal(elements['diff-progress-message'].textContent, 'Loading diff...');
  context.overlayCounts.base = 1;
  context.updateDiffProgress();
  assert.equal(elements['diff-progress'].hidden, false);
  context.overlayCounts.target = 0;
  context.updateDiffProgress();
  assert.equal(elements['diff-progress'].hidden, false);
  assert.equal(elements['diff-progress'].classList.contains('is-complete'), true);
  assert.equal(elements['diff-progress'].classList.contains('is-loading'), false);
  assert.equal(elements['diff-progress-message'].textContent, 'Loaded');
  context.updateDiffProgress();
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.equal(elements['diff-progress'].hidden, true);
  assert.equal(elements['diff-progress'].dataset.toastVisible, 'false');
});
test('no hints and turning off highlights leave no progress notification', () => {
  const { context, elements } = fixture({ base: [], target: [] });
  context.configureDiffOverlay();
  assert.equal(elements['diff-progress'].hidden, true);
  context.overlayDiff = null;
  context.configureDiffOverlay();
  assert.equal(elements['diff-progress'].hidden, false);
  assert.equal(elements['diff-progress-message'].textContent, 'Loading diff...');
  elements['diff-overlay'].checked = false;
  context.configureDiffOverlay();
  assert.equal(elements['diff-progress'].hidden, true);
});
test('failed comparison clears progress so the error can be shown separately', () => {
  const { context, elements } = fixture({ base: [{}] });
  context.diffLoadError = 'Unable to load changes.';
  context.updateDiffProgress();
  assert.equal(elements['diff-progress'].hidden, true);
});

test('scope switches overlays between sides and waits only for the selected preview', () => {
  const { context, elements, selection, messages } = fixture({ base: [{}], target: [{}] }, 'base');
  context.configureDiffOverlay();
  assert.equal(elements['diff-scope'].hidden, false);
  assert.deepEqual(messages.map(({ side, enabled }) => [side, enabled]), [['base', true], ['target', false]]);
  context.overlayCounts.base = 1;
  context.updateDiffProgress();
  assert.equal(elements['diff-progress'].hidden, false);
  assert.equal(elements['diff-progress'].classList.contains('is-complete'), true);

  selection.value = 'target';
  messages.length = 0;
  context.configureDiffOverlay();
  assert.deepEqual(messages.map(({ side, enabled }) => [side, enabled]), [['base', false], ['target', true]]);
  assert.equal(elements['diff-progress'].hidden, false);
  context.overlayCounts.target = 0;
  context.updateDiffProgress();
  assert.equal(elements['diff-progress'].hidden, false);
  assert.equal(elements['diff-progress'].classList.contains('is-complete'), true);

  elements['diff-overlay'].checked = false;
  messages.length = 0;
  context.configureDiffOverlay();
  assert.equal(elements['diff-scope'].hidden, true);
  assert.ok(messages.every(message => !message.enabled));
});

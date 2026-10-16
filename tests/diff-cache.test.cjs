const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/renderer/app.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function createDiffCache('), source.indexOf('async function loadDiff(')), context);
const request = { path: '/a', base: 'main', target: '__working_tree__', file: null };
const result = (patch = 'first') => ({ diff: { patch } });

test('project and comparison round trips reuse results; files and refs stay separate', async () => {
  const cache = context.createDiffCache();
  let calls = 0;
  const fetch = async () => { calls++; return result(); };
  const first = await cache.load(request, fetch);
  await cache.load({ ...request, path: '/b' }, fetch);
  assert.equal(await cache.load(request, fetch), first);
  await cache.load({ ...request, target: 'other' }, fetch);
  await cache.load({ ...request, file: 'app.js' }, fetch);
  assert.equal(await cache.load(request, fetch), first);
  assert.equal(calls, 4);
  assert.equal(context.createDiffCache().peek(request), null);
});

test('refresh invalidates all files and comparisons only for its repository', async () => {
  const cache = context.createDiffCache();
  const file = { ...request, file: 'app.js' };
  const other = { ...request, path: '/b' };
  for (const item of [request, file, other]) await cache.load(item, async () => result());
  cache.invalidate('/a');
  assert.equal(cache.peek(request), null);
  assert.equal(cache.peek(file), null);
  assert.ok(cache.peek(other));
  assert.equal((await cache.load(request, async () => result('updated'))).diff.patch, 'updated');
});

test('duplicate in-flight requests share work and old responses cannot replace refreshed data', async () => {
  const cache = context.createDiffCache();
  let finish;
  let calls = 0;
  const fetch = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const pending = cache.load(request, fetch);
  const duplicate = cache.load(request, fetch);
  await Promise.resolve();
  assert.equal(calls, 1);
  cache.invalidate('/a');
  const fresh = await cache.load(request, async () => result('new'));
  finish(result('old'));
  await Promise.all([pending, duplicate]);
  assert.equal(cache.peek(request), fresh);
});

test('errors are retried instead of cached', async () => {
  const cache = context.createDiffCache();
  await cache.load(request, async () => ({ error: 'failed' }));
  assert.equal(cache.peek(request), null);
  await assert.rejects(cache.load(request, async () => { throw new Error('offline'); }), /offline/);
  assert.equal(cache.peek(request), null);
  assert.ok((await cache.load(request, async () => result())).diff);
});

test('LRU entry and estimated size limits discard old or oversized data', async () => {
  const cache = context.createDiffCache({ maxEntries: 2, maxBytes: 200 });
  const second = { ...request, path: '/b' };
  const third = { ...request, path: '/c' };
  await cache.load(request, async () => result());
  await cache.load(second, async () => result());
  cache.peek(request);
  await cache.load(third, async () => result());
  assert.equal(cache.peek(second), null);
  assert.ok(cache.peek(request));
  assert.ok(cache.peek(third));
  const oversized = await cache.load(second, async () => result('x'.repeat(200)));
  assert.equal(oversized.diff.patch.length, 200);
  assert.equal(cache.peek(second), null);
});

test('restoring the selected file reuses the default response without duplicating it', async () => {
  const cache = context.createDiffCache();
  const first = await cache.load(request, async () => ({ diff: { selectedFile: 'app.js', patch: 'cached' } }));
  const restored = await cache.load({ ...request, file: 'app.js' }, async () => { throw new Error('must not fetch'); });
  assert.equal(restored, first);
  cache.invalidate(request.path);
  assert.equal(cache.peek({ ...request, file: 'app.js' }), null);
});

test('loadDiff restores project cache and forces fresh data on refresh', async () => {
  const elements = new Map();
  const element = () => ({
    classList: { toggle() {}, add() {}, remove() {} }, dataset: {},
    setAttribute() {}, replaceChildren() {}, append() {}, addEventListener() {},
  });
  let calls = 0;
  let loading = 0;
  const ui = vm.createContext({
    activeRepository: { path: '/a' }, baseRef: { value: 'main' }, targetRef: { value: 'topic' },
    selectedFile: null, diffRequestVersion: 0, overlayDiff: null, diffLoadError: null,
    diffCache: context.createDiffCache(),
    bridge: { getDiff: async () => {
      calls++;
      return { diff: { files: [], totals: { added: 0, deleted: 0 }, selectedFile: null, patch: `patch-${calls}` } };
    } },
    configureDiffOverlay() {}, updateDiffProgress() {}, refreshFilePreviewActions() {},
    setDiffLoading(value) { if (value) loading++; }, renderPatch: value => value,
    get(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    document: { createElement: element },
  });
  vm.runInContext(source.slice(source.indexOf('async function loadDiff('), source.indexOf('function renderProjectMetadata(')), ui);
  await ui.loadDiff();
  ui.activeRepository = { path: '/b' };
  await ui.loadDiff();
  ui.activeRepository = { path: '/a' };
  await ui.loadDiff();
  assert.equal(calls, 2);
  assert.equal(loading, 2);
  assert.equal(elements.get('diff-view').innerHTML, 'patch-1');
  await ui.loadDiff({ refresh: true });
  assert.equal(calls, 3);
  assert.equal(elements.get('diff-view').innerHTML, 'patch-3');
  await ui.loadDiff();
  assert.equal(calls, 3);
});

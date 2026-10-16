const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/renderer/app.js'), 'utf8');
const context = vm.createContext({ URL });
vm.runInContext(source.slice(source.indexOf('function previewRouteUrl('), source.indexOf('function displayPreviewAddress(')), context);

test('address paths resolve from the displayed origin, even with a nested app base', () => {
  const base = 'http://127.0.0.1:5180/sample-app/';
  assert.equal(context.previewRouteUrl('/about?tab=work#details', base), 'http://127.0.0.1:5180/about?tab=work#details');
  assert.equal(context.previewRouteUrl('/', base), 'http://127.0.0.1:5180/');
  assert.equal(context.previewRouteUrl('/sample-app/work', base), 'http://127.0.0.1:5180/sample-app/work');
  assert.equal(context.previewRouteUrl('work', base), 'http://127.0.0.1:5180/sample-app/work');
});

test('pasted page URLs retain the selected preview server and reject unsafe routes', () => {
  const base = 'http://127.0.0.1:5181/';
  assert.equal(context.previewRouteUrl('https://example.com/work?q=1#top', base), 'http://127.0.0.1:5181/work?q=1#top');
  assert.throws(() => context.previewRouteUrl('//example.com/work', base));
  assert.throws(() => context.previewRouteUrl('javascript:alert(1)', base));
});

test('address fields are internal state and page selection drives navigation', () => {
  assert.ok(source.includes('createPagePicker(get(`${id}-url`)'));
  assert.ok(!source.includes("event.target.dataset.editing = 'true'"));
});

function navigationHarness() {
  const pages = [
    { id: 'home', path: '/', available: true },
    { id: 'detail', path: '/detail', available: true },
  ];
  const writes = [];
  const fallbacks = [];
  const notifications = [];
  const elements = new Map();
  elements.set('page-sync', { classList: { toggle() {} }, setAttribute() {}, title: '' });
  for (const side of ['base', 'target']) {
    elements.set(`${side}-url`, {});
    elements.set(`${side}-preview-frame`, {
      set src(url) { writes.push({ side, url, replace: false }); },
      contentWindow: { location: { replace(url) { writes.push({ side, url, replace: true }); } } },
    });
  }
  let navigated;
  const sandbox = vm.createContext({
    URL, get: id => elements.get(id),
    previewUrls: Object.fromEntries(['base', 'target'].map((side, index) => [side, {
      url: `http://127.0.0.1:${5180 + index}/`,
      currentUrl: `http://127.0.0.1:${5180 + index}/?__acorn_page=home`,
      catalog: { pages },
    }])),
    selectedPages: { base: pages[0], target: pages[0] },
    previewState: { base: 'ready', target: 'ready' },
    pendingPageLandings: { base: null, target: null }, visualPreviewMode: { base: false, target: false },
    pendingMirroredNavigations: { base: null, target: null },
    pageSelectionSynced: true, pagePickers: new Map(),
    window: { setTimeout() { return 1; }, clearTimeout() {} }, notify: (...args) => notifications.push(args), schedulePreview: (...args) => fallbacks.push(args),
    bridge: { onPreviewNavigation: callback => { navigated = callback; } },
  });
  vm.runInContext(source.slice(source.indexOf('function previewRouteUrl('), source.indexOf('function normalizedSourcePath(')), sandbox);
  vm.runInContext(source.slice(source.indexOf('bridge?.onPreviewNavigation?.('), source.indexOf('function resizeDevicePreviews(')), sandbox);
  return { sandbox, writes, navigated, pages, fallbacks, notifications };
}

test('mirrored navigation must not reload the originating app and erase its router state', () => {
  const { navigated, writes, sandbox } = navigationHarness();
  navigated({ side: 'base', url: 'http://127.0.0.1:5180/detail' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].side, 'target');
  assert.equal(writes[0].replace, true, 'Mirroring must not add an extra joint-history entry');
  navigated(writes[0]);
  assert.equal(writes.length, 1, 'The target notification must not reload the base document');
  assert.equal(sandbox.previewUrls.base.currentUrl, 'http://127.0.0.1:5180/detail');
  navigated({ side: 'base', url: 'http://127.0.0.1:5180/?__acorn_page=home' });
  assert.equal(writes.length, 2);
  navigated(writes[1]);
  assert.equal(writes.length, 2, 'Back navigation must not bounce between previews');
});

test('matching mouse navigation does not force a full document reload', () => {
  const { navigated, writes } = navigationHarness();
  navigated({ side: 'base', url: 'http://127.0.0.1:5180/detail' });
  navigated({ side: 'target', url: 'http://127.0.0.1:5181/detail' });
  assert.equal(writes.length, 1);
});

test('a mirrored click unlocks page sync when revisions produce different outcomes', () => {
  const { sandbox, navigated, writes, notifications } = navigationHarness();
  sandbox.markPendingMirroredNavigation('target', 'base');
  assert.equal(sandbox.pageSelectionSynced, false, 'Page sync must pause before a pointerup-triggered route change');
  navigated({ side: 'target', url: 'http://127.0.0.1:5181/detail' });
  navigated({ side: 'target', url: 'http://127.0.0.1:5181/detail' });
  sandbox.settlePendingMirroredNavigation(sandbox.pendingMirroredNavigations.target);
  assert.equal(writes.length, 0, 'The navigating preview must not force the modal preview to follow');
  assert.equal(sandbox.selectedPages.base.id, 'home');
  assert.equal(sandbox.selectedPages.target.id, 'detail');
  assert.equal(sandbox.pageSelectionSynced, false);
  assert.equal(notifications.length, 1, 'Duplicate navigation events must remain part of the same mirrored click');
  assert.match(notifications[0][0], /different results/);
});

test('a mirrored click keeps page sync when both revisions reach the same page', () => {
  const { sandbox, navigated, writes, notifications, pages } = navigationHarness();
  sandbox.selectedPages.base = pages[1];
  sandbox.markPendingMirroredNavigation('target', 'base');
  navigated({ side: 'target', url: 'http://127.0.0.1:5181/detail' });
  sandbox.settlePendingMirroredNavigation(sandbox.pendingMirroredNavigations.target);
  assert.equal(writes.length, 0);
  assert.equal(sandbox.pageSelectionSynced, true);
  assert.equal(notifications.length, 0);
});

test('the originating side may navigate while the mirrored side stays on a modal', () => {
  const { sandbox, navigated, writes, notifications } = navigationHarness();
  sandbox.markPendingMirroredNavigation('target', 'base');
  navigated({ side: 'target', url: 'http://127.0.0.1:5181/?__acorn_page=home&modal=detail' });
  navigated({ side: 'base', url: 'http://127.0.0.1:5180/detail' });
  sandbox.settlePendingMirroredNavigation(sandbox.pendingMirroredNavigations.base);
  assert.equal(writes.length, 0);
  assert.equal(sandbox.selectedPages.base.id, 'detail');
  assert.equal(sandbox.selectedPages.target.id, 'home');
  assert.equal(sandbox.pageSelectionSynced, false);
  assert.equal(notifications.length, 1);
});

test('explicit page selection still navigates both previews', () => {
  const { sandbox, writes, pages } = navigationHarness();
  sandbox.choosePage('base', pages[1]);
  assert.deepEqual(writes.map(write => write.side), ['base', 'target']);
});

test('a guarded page redirect retries only that side as an isolated visual preview', () => {
  const { sandbox, navigated, pages, fallbacks } = navigationHarness();
  pages[1].visualFallback = true;
  sandbox.choosePage('base', pages[1]);
  navigated({ side: 'base', url: 'http://127.0.0.1:5180/' });
  assert.equal(sandbox.selectedPages.base.id, 'detail');
  assert.equal(sandbox.visualPreviewMode.base, true);
  assert.deepEqual(JSON.parse(JSON.stringify(fallbacks)), [[['base'], { reuse: true, visual: true }]]);
});

test('ordinary application routes never enable sample data after a route mismatch', () => {
  const { sandbox, navigated, pages, fallbacks } = navigationHarness();
  sandbox.choosePage('base', pages[1]);
  navigated({ side: 'base', url: 'http://127.0.0.1:5180/' });
  assert.equal(sandbox.pendingPageLandings.base, null);
  assert.equal(sandbox.visualPreviewMode.base, false);
  assert.equal(fallbacks.length, 0);
});

test('an initial URL event does not suppress a subsequent asynchronous guard redirect', () => {
  const { sandbox, navigated, pages, fallbacks } = navigationHarness();
  pages[1].visualFallback = true;
  sandbox.choosePage('base', pages[1]);
  navigated({ side: 'base', url: 'http://127.0.0.1:5180/detail' });
  assert.ok(sandbox.pendingPageLandings.base);
  navigated({ side: 'base', url: 'http://127.0.0.1:5180/' });
  assert.equal(sandbox.visualPreviewMode.base, true);
  assert.deepEqual(JSON.parse(JSON.stringify(fallbacks)), [[['base'], { reuse: true, visual: true }]]);
});

test('selecting an ordinary page leaves a previously enabled visual preview', () => {
  const { sandbox, pages, fallbacks } = navigationHarness();
  sandbox.previewUrls.base.visual = true;
  sandbox.visualPreviewMode.base = true;
  sandbox.choosePage('base', pages[0]);
  assert.equal(sandbox.visualPreviewMode.base, false);
  assert.deepEqual(JSON.parse(JSON.stringify(fallbacks)), [[['base'], { reuse: true, visual: false }]]);
});

test('following an ordinary link also leaves synthetic state behind', () => {
  const { sandbox, navigated, fallbacks } = navigationHarness();
  sandbox.previewUrls.base.visual = true;
  sandbox.visualPreviewMode.base = true;
  navigated({ side: 'base', url: 'http://127.0.0.1:5180/detail' });
  assert.equal(sandbox.visualPreviewMode.base, false);
  assert.deepEqual(JSON.parse(JSON.stringify(fallbacks)), [[['base'], { reuse: true, visual: false }]]);
});

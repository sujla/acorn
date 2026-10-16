const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { discoverPages, normalizeManifest } = require('../src/main/preview-pages.cjs');
const { buildPageTree } = require('../src/renderer/page-picker.js');
const { allowedRequest, inject, startUiPreview } = require('../src/main/ui-preview-server.cjs');
const http = require('node:http');

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-pages-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), contents); }
  return root;
}
test('revision-specific file routes exclude layouts and API handlers, keeping dynamic routes unavailable', async t => {
  const root = await fixture(t, { 'package.json': '{"dependencies":{"expo-router":"1"}}', 'app/(tabs)/index.tsx': '', 'app/(tabs)/settings.tsx': '', 'app/orders/[id].tsx': '', 'app/_layout.tsx': '', 'app/orders+api.ts': '' });
  const { pages } = await discoverPages(root);
  assert.deepEqual(pages.map(page => page.path), ['/', '/orders/[id]', '/settings']);
  assert.equal(pages.find(page => page.path.includes('[id]')).available, false);
  await fs.unlink(path.join(root, 'app/(tabs)/settings.tsx'));
  assert.equal((await discoverPages(root)).pages.some(page => page.path === '/settings'), false);
});
test('Next app root and nested routes are discovered without private or parallel slots', async t => {
  const root = await fixture(t, { 'package.json': '{"dependencies":{"next":"1"}}', 'app/page.tsx': '', 'app/(app)/settings/page.tsx': '', 'app/@modal/page.tsx': '', 'app/_private/page.tsx': '', 'app/api/me/route.ts': '' });
  assert.deepEqual((await discoverPages(root)).pages.map(page => page.path), ['/', '/settings']);
});
test('Expo dynamic routes expand from local const enums and concrete internal links', async t => {
  const root = await fixture(t, {
    'package.json': '{"dependencies":{"expo-router":"1"}}',
    'src/app/onboarding/[step].tsx': 'export default function Screen(){}',
    'src/app/legal/[document].tsx': 'export default function Legal(){}',
    'src/app/index.tsx': `export const steps = ['owner', 'name'] as const; const links = <><Link href="/legal/terms"/><button onClick={() => router.push('/legal/privacy')}/><img src="/logo.png"/></>`
  });
  const pages = (await discoverPages(root)).pages;
  assert.ok(pages.find(page => page.path === '/onboarding/owner')?.available);
  assert.ok(pages.find(page => page.path === '/onboarding/name')?.available);
  assert.ok(pages.find(page => page.path === '/legal/terms')?.available);
  assert.ok(pages.find(page => page.path === '/legal/privacy')?.available);
  assert.equal(pages.some(page => page.path === '/logo.png'), false);
});
test('explicit IA keeps hierarchy and concrete preview paths; invalid manifests fail visibly', async t => {
  const manifest = { pages: [{ id: 'order', label: 'Order complete', group: ['Shop', 'Orders'], path: '/orders/example', previewPath: '/preview/order-complete' }] };
  const pages = normalizeManifest(manifest);
  const tree = buildPageTree(pages);
  assert.equal(tree.children[0].children[0].children[0].page.id, 'order');
  assert.equal(pages[0].previewPath, '/preview/order-complete');
  for (const bad of ['//example.com', '/\\example.com', 'https://example.com', '/orders/[id]']) assert.throws(() => normalizeManifest({ pages: [{ path: bad }] }));
  const root = await fixture(t, { '.acorn/pages.json': '{invalid', 'index.html': '<h1>Home</h1>' });
  const catalog = await discoverPages(root);
  assert.equal(catalog.pages.length, 0);
  assert.equal(catalog.warnings.length, 1);
});
test('Acorn adapter exposes current workspace screens', async t => {
  const root = await fixture(t, { 'package.json': '{"name":"acorn"}', 'index.html': '<div id="app-shell"></div><dialog id="settings-dialog"></dialog>' });
  assert.deepEqual((await discoverPages(root)).pages.map(page => page.id), ['acorn:workspace', 'acorn:settings-dialog']);
});
test('manifest fallback declarations are boolean and static pages do not opt in', async t => {
  const pages = normalizeManifest({ pages: [{ path: '/' }, { path: '/protected', visualFallback: true }, { path: '/about', visualFallback: false }] });
  assert.deepEqual(pages.map(page => page.visualFallback), [false, true, false]);
  assert.throws(() => normalizeManifest({ pages: [{ path: '/', visualFallback: 'true' }] }), /Invalid visualFallback/);
  const root = await fixture(t, { 'index.html': '<h1>Portfolio</h1>' });
  assert.ok((await discoverPages(root)).pages.every(page => page.visualFallback !== true));
});
test('Expo state guards automatically support fallback, including expanded onboarding routes', async t => {
  const guarded = `import { Redirect as GuardRedirect } from 'expo-router';
    export default function Screen() { const { account, ready } = useOnboarding();
      if (!ready) return null; if (!account) return <GuardRedirect href="/"/>; return <h1>Profile</h1>; }`;
  const root = await fixture(t, {
    'package.json': '{"dependencies":{"expo-router":"1"}}',
    'src/app/index.tsx': 'export default function Home(){return <h1>Home</h1>}',
    'src/app/onboarding/[step].tsx': guarded,
    'src/state.ts': `export const steps = ['name', 'owner'] as const;`,
    'src/app/about.tsx': `import { Redirect } from 'expo-router'; export default function About(){return <Redirect href="/"/>}`,
    'src/app/loading.tsx': `import { Redirect } from 'expo-router'; export default function Loading(){const {ready} = useFonts(); return <Redirect href="/"/>}`,
  });
  const pages = (await discoverPages(root)).pages;
  for (const route of ['/onboarding/name', '/onboarding/owner']) assert.equal(pages.find(p => p.path === route).visualFallback, true);
  for (const route of ['/', '/about', '/loading']) assert.equal(pages.find(p => p.path === route).visualFallback, false);
});
test('working-folder preview copies local edits without copying or mutating dependencies', async t => {
  const vm = require('node:vm');
  const root = await fixture(t, { 'index.html': '<h1>Local edits</h1>', 'node_modules/demo/index.js': 'original dependency', '.git/config': 'original git state', 'untracked.html': 'untracked screen', 'vite.config.js': 'export default {build:{outDir:"docs"}}', 'docs/index.html': 'built output', 'dist/index.html': 'default build output' });
  const source = await fs.readFile(path.join(__dirname, '../src/main/desktop-main.cjs'), 'utf8');
  const snapshots = new Map();
  const context = vm.createContext({ fs, snapshotFs: require('../src/main/snapshot-files.cjs'), path, os, previewSnapshots: snapshots, discoverPages, ...require('../src/main/preview-file-settings.cjs'), ...require('../src/main/generated-output.cjs'), ...require('../src/main/expo-preview-output.cjs'), runGit: async () => 'abc123' });
  vm.runInContext(source.slice(source.indexOf('async function previewRoot('), source.indexOf('function contentType(')), context);
  const preview = await context.previewRoot(root, '__working_tree__');
  t.after(() => fs.rm(preview.root, { recursive: true, force: true }));
  assert.notEqual(preview.root, root);
  assert.equal(await fs.readFile(path.join(preview.root, 'index.html'), 'utf8'), '<h1>Local edits</h1>');
  assert.equal(await fs.readFile(path.join(preview.root, 'untracked.html'), 'utf8'), 'untracked screen');
  await assert.rejects(fs.access(path.join(preview.root, '.git')));
  await assert.rejects(fs.access(path.join(preview.root, 'docs')));
  await assert.rejects(fs.access(path.join(preview.root, 'dist')));
  assert.equal(await fs.readFile(path.join(root, 'docs/index.html'), 'utf8'), 'built output');
  await fs.writeFile(path.join(preview.root, 'index.html'), 'changed preview');
  await assert.rejects(fs.access(path.join(preview.root, 'node_modules')));
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), '<h1>Local edits</h1>');
  assert.equal(await fs.readFile(path.join(root, 'node_modules/demo/index.js'), 'utf8'), 'original dependency');
});
test('working-folder Expo exports are copied fresh without dependencies or symlinks', async t => {
  const vm = require('node:vm');
  const root = await fixture(t, { 'package.json': '{"dependencies":{"expo":"*"}}', 'dist/index.html': '<h1>Local Expo</h1>', 'node_modules/expo/index.js': 'do not execute' });
  await fs.symlink(path.join(root, 'package.json'), path.join(root, 'dist/leak.json'));
  const source = await fs.readFile(path.join(__dirname, '../src/main/desktop-main.cjs'), 'utf8');
  const context = vm.createContext({ fs, snapshotFs: require('../src/main/snapshot-files.cjs'), path, os, previewSnapshots: new Map(), discoverPages, ...require('../src/main/preview-file-settings.cjs'), ...require('../src/main/generated-output.cjs'), ...require('../src/main/expo-preview-output.cjs'), runGit: async () => 'abc123' });
  vm.runInContext(source.slice(source.indexOf('async function previewRoot('), source.indexOf('function contentType(')), context);
  const first = await context.previewRoot(root, '__working_tree__');
  t.after(() => fs.rm(first.root, { recursive: true, force: true }));
  assert.equal(await fs.readFile(path.join(first.exportedRoot, 'index.html'), 'utf8'), '<h1>Local Expo</h1>');
  await assert.rejects(fs.access(path.join(first.exportedRoot, 'leak.json')));
  await assert.rejects(fs.access(path.join(first.root, 'node_modules')));
  await fs.writeFile(path.join(root, 'dist/index.html'), '<h1>Refreshed</h1>');
  const next = await context.previewRoot(root, '__working_tree__');
  t.after(() => fs.rm(next.root, { recursive: true, force: true }));
  assert.equal(await fs.readFile(path.join(next.exportedRoot, 'index.html'), 'utf8'), '<h1>Refreshed</h1>');
  assert.notEqual(first.exportedRoot, next.exportedRoot);
});
test('UI proxy allows local page navigation while refusing API requests, mutations and workers', () => {
  const pages = [{ path: '/' }];
  assert.equal(allowedRequest('POST', 'document', '/', pages), false);
  assert.equal(allowedRequest('GET', 'empty', '/data.json', pages), false);
  assert.equal(allowedRequest('GET', 'script', '/api/delete', pages), false);
  assert.equal(allowedRequest('GET', 'document', '/about.html', pages), true);
  assert.equal(allowedRequest('GET', 'serviceworker', '/sw.js', pages), false);
  assert.equal(allowedRequest('GET', 'script', '/assets/app.js', pages), true);
  assert.equal(allowedRequest('GET', 'document', '/', pages), true);
  const html = inject('<html><head><script>project()</script></head></html>', { screen: '</script>' });
  assert.ok(html.indexOf('window.fetch =') < html.indexOf('project()'));
  assert.ok(!html.includes('"screen":"</script>"'));
});
test('unavailable and docs pages and their empty folders never appear in the page tree', () => {
  const tree = buildPageTree([
    { id: 'home', label: 'Home', group: [], available: true },
    { id: 'dynamic', label: '[id]', group: ['Orders'], available: false },
    { id: 'failed', label: 'Failed', group: ['Unavailable'], available: false },
    { id: 'docs', label: 'Guide', group: ['docs'], available: true, docs: true },
  ]);
  assert.deepEqual(tree.children.map(item => item.label), ['Home']);
});
test('source docs routes remain available unless configured as build output', async t => {
  const discoveredRoot = await fixture(t, { 'index.html': '<h1>Home</h1>', 'docs/guide.html': '<h1>Guide</h1>' });
  const discovered = await discoverPages(discoveredRoot);
  const docsPage = discovered.pages.find(page => page.path === '/docs/guide.html');
  assert.equal(docsPage.docs, false);
  assert.equal(docsPage.available, true);

  const explicit = normalizeManifest({ pages: [{ path: '/docs/guide', label: 'Guide' }] });
  assert.equal(explicit[0].docs, false);
  assert.equal(explicit[0].available, true);
});
test('proxy serves guarded HTML, blocks writes before upstream, and does not follow auth redirects', async t => {
  const calls = [];
  const upstream = http.createServer((req, res) => {
    calls.push(req.url);
    if (req.url === '/protected') { res.writeHead(302, { location: 'https://example.com/login' }).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'session=secret' }); res.end('<html><head></head><body>Hello</body></html>');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const proxy = await startUiPreview(`http://127.0.0.1:${upstream.address().port}/`, { pages: [{ id: 'home', path: '/' }, { id: 'protected', path: '/protected' }] });
  t.after(() => proxy.close());
  const response = await fetch(proxy.url + '?__acorn_page=home');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.match(await response.text(), /__ACORN_UI_PREVIEW__/);
  assert.equal((await fetch(proxy.url, { method: 'POST' })).status, 403);
  assert.deepEqual(calls, ['/']);
  assert.equal((await fetch(proxy.url + 'protected')).status, 409);
  assert.deepEqual(calls, ['/', '/protected']);
});

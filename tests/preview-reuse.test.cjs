const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { compilePreview } = require('../src/main/preview-compiler.cjs');
const { startUiPreview } = require('../src/main/ui-preview-server.cjs');

test('working preview keeps both URLs, refreshes edits and routes, and survives failed refresh', async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-reuse-'));
  const repository = path.join(scratch, 'repository');
  await fs.mkdir(repository);
  await fs.writeFile(path.join(repository, 'index.html'), '<h1>Before</h1>');
  const previewServers = new Map(), previewSnapshots = new Map(), uiPreviews = new Map();
  let fail = false;
  let builds = 0;
  const progress = [];
  const context = vm.createContext({
    fs, path, os, http, URL, snapshotFs: require('../src/main/snapshot-files.cjs'),
    previewServers, previewSnapshots, uiPreviews, shutdownStarted: false, reloadStarted: false,
    mainWindow: { isDestroyed: () => false, webContents: { send: (_channel, event) => progress.push(event) } },
    app: { getPath: () => scratch }, runGit: async () => 'abc123',
    ...require('../src/main/preview-file-settings.cjs'), ...require('../src/main/generated-output.cjs'), ...require('../src/main/expo-preview-output.cjs'),
    ...require('../src/main/preview-pages.cjs'), startUiPreview,
    compileInWorker: async (options, callbacks) => { builds++; if (fail) throw new Error('build failed'); return compilePreview({ ...options, ...callbacks }); },
  });
  const source = await fs.readFile(path.join(__dirname, '../src/main/desktop-main.cjs'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function previewRoot('), source.indexOf('async function stopPreviewServers(')), context);
  const uiStart = source.indexOf('async function withUiPreview(');
  vm.runInContext(source.slice(uiStart, source.indexOf('\n}\n', uiStart) + 3), context);
  t.after(async () => {
    for (const item of uiPreviews.values()) await item.server.close();
    for (const server of previewServers.values()) await context.stopPreviewServer(server);
    await fs.rm(scratch, { recursive: true, force: true });
  });
  const start = () => context.startPreviewServer(repository, '__working_tree__').then(context.withUiPreview);
  const [first, concurrent] = await Promise.all([start(), start()]);
  assert.equal(first.url, concurrent.url);
  assert.ok(progress.some(event => event.message === 'Copying working folder files…'));
  assert.ok(progress.some(event => event.message === 'Finding preview pages…'));
  assert.ok(progress.some(event => event.message === 'Saving preview files…'));
  assert.ok(progress.every(event => event.path === repository && event.ref === '__working_tree__'));
  assert.equal(previewServers.size, 1);
  assert.equal(previewSnapshots.size, 1);
  assert.match(await (await fetch(first.url)).text(), /Before/);
  const unchanged = await start();
  assert.equal(unchanged.url, first.url);
  assert.equal(unchanged.cacheKey, first.cacheKey);
  assert.equal(unchanged.cached, true);
  await fs.writeFile(path.join(repository, 'index.html'), '<h1>After</h1>');
  await fs.writeFile(path.join(repository, 'new.html'), '<h1>New route</h1>');
  const beforeReuse = builds;
  const reused = await context.startPreviewServer(repository, '__working_tree__', { reuse: true }).then(context.withUiPreview);
  assert.equal(builds, beforeReuse, 'Switching to a running working folder must not compile');
  assert.equal(reused.url, first.url);
  assert.match(await (await fetch(reused.url)).text(), /Before/);
  const changed = await start();
  assert.equal(changed.url, first.url);
  assert.equal(changed.upstreamUrl, first.upstreamUrl);
  assert.notEqual(changed.cacheKey, first.cacheKey);
  assert.match(await (await fetch(first.url)).text(), /After/);
  assert.match(await (await fetch(first.url + 'new.html')).text(), /New route/);
  assert.ok(changed.catalog.pages.some(page => page.path.includes('new')));
  assert.equal(previewServers.size, 1);
  assert.equal(uiPreviews.size, 1);
  assert.equal(previewSnapshots.size, 1);
  fail = true;
  await assert.rejects(start(), /build failed/);
  assert.match(await (await fetch(first.url)).text(), /After/);
  assert.equal(previewSnapshots.size, 1);
  fail = false;
  assert.equal((await start()).url, first.url);
});

test('visual viewers are scoped independently and never expose the data bridge', async t => {
  const upstream = http.createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Preview</h1>'));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const uiPreviews = new Map();
  const registered = [];
  const context = vm.createContext({
    URL, uiPreviews, startUiPreview,
    previewNetworkPolicy: { register: (url, scope) => registered.push({ url, scope }) },
  });
  const source = await fs.readFile(path.join(__dirname, '../src/main/desktop-main.cjs'), 'utf8');
  const uiStart = source.indexOf('async function withUiPreview(');
  vm.runInContext(source.slice(uiStart, source.indexOf('\n}\n', uiStart) + 3), context);
  const preview = { url: `http://127.0.0.1:${upstream.address().port}/`, catalog: { source: 'discovered', pages: [{ id: '/', path: '/', available: true }], warnings: [] } };
  const [first, second] = await Promise.all([
    context.withUiPreview(preview, { visual: true, scope: 'comparison-a:base' }),
    context.withUiPreview(preview, { visual: true, scope: 'comparison-b:target' }),
  ]);
  t.after(() => Promise.all([...uiPreviews.values()].map(item => item.server.close())));
  assert.notEqual(first.url, second.url);
  assert.equal(first.visual, true);
  assert.equal(first.catalog.dataBridge, false);
  assert.deepEqual(registered.map(item => item.scope).sort(), ['comparison-a:base', 'comparison-b:target']);
});

test('preview requests report repository checks and viewer connection at their actual boundaries', async () => {
  const progress = [];
  let resolveRepository, resolveBuild, resolveViewer;
  const repositoryReady = new Promise(resolve => { resolveRepository = resolve; });
  const buildReady = new Promise(resolve => { resolveBuild = resolve; });
  const viewerReady = new Promise(resolve => { resolveViewer = resolve; });
  const sender = { mainFrame: {}, isDestroyed: () => false, send: (channel, event) => progress.push({ channel, ...event }) };
  let builds = 0, viewers = 0;
  const context = vm.createContext({
    mainWindow: { webContents: sender },
    removingRepositories: new Set(),
    previewLifecycle: require('../src/main/preview-lifecycle.cjs').createPreviewLifecycle({ stop: async () => [] }),
    runGit: async () => 'abc123',
    readRepositoryPaths: () => repositoryReady,
    readPreviewFileSettings: async () => ({ overrides: {} }),
    startPreviewServer: () => { builds++; return buildReady; },
    withUiPreview: () => { viewers++; return viewerReady; },
    cleanPreviewError: error => error.message,
  });
  const source = await fs.readFile(path.join(__dirname, '../src/main/desktop-main.cjs'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function handlePreviewStart('), source.indexOf('app.whenReady()')), context);
  const request = context.handlePreviewStart({ sender, senderFrame: sender.mainFrame }, { path: '/repo', base: 'main', target: 'main' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(progress.at(-1).message, 'Checking repository connection…');
  assert.equal(builds, 0);
  resolveRepository(['/repo']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(builds, 1);
  assert.equal(viewers, 0);
  resolveBuild({ url: 'http://localhost/' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(progress.at(-1).message, 'Connecting preview to the viewer…');
  assert.equal(viewers, 1);
  resolveViewer({ url: 'http://localhost/viewer/' });
  const result = await request;
  assert.equal(result.previews.base, result.previews.target);
  assert.ok(progress.every(event => event.channel === 'preview:progress' && event.path === '/repo' && event.ref === 'main'));
});

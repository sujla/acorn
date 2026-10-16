const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPreviewLifecycle } = require('../src/main/preview-lifecycle.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('shared running server stays until its last comparison closes; duplicate release is harmless', async () => {
  const stopped = [];
  const lifecycle = createPreviewLifecycle({ stop: async key => { stopped.push(key); return [key]; } });
  await lifecycle.request('a', owner => owner.use('shared', async () => 'ready'));
  await lifecycle.request('b', owner => owner.use('shared', async () => 'ready'));
  assert.deepEqual(await lifecycle.release('a'), []);
  assert.deepEqual(stopped, []);
  assert.deepEqual(await lifecycle.release('b'), ['shared']);
  await lifecycle.release('b');
  assert.deepEqual(stopped, ['shared']);
});

test('closing one comparison preserves shared pending work; last close aborts it', async () => {
  let signal;
  const stopped = [];
  const lifecycle = createPreviewLifecycle({ stop: async key => { stopped.push(key); } });
  const build = deferred();
  const run = owner => owner.use('shared', async s => { signal = s; return build.promise; });
  const first = assert.rejects(lifecycle.request('a', run), /cancelled/);
  const second = assert.rejects(lifecycle.request('b', run), /cancelled/);
  await tick();
  const closeA = lifecycle.release('a');
  assert.equal(signal.aborted, false);
  const closeB = lifecycle.release('b');
  assert.equal(signal.aborted, true);
  build.resolve('late completion');
  await Promise.all([first, second, closeA, closeB]);
  assert.deepEqual(stopped, ['shared']);
});

test('close fences requests resolving refs and late IPC requests, without affecting other owners', async () => {
  const gate = deferred();
  let starts = 0;
  const lifecycle = createPreviewLifecycle({ stop: async () => {} });
  const pending = assert.rejects(lifecycle.request('closed', async owner => {
    await gate.promise;
    return owner.use('server', async () => { starts++; });
  }), /cancelled/);
  await tick();
  const closing = lifecycle.release('closed');
  gate.resolve();
  await Promise.all([pending, closing]);
  await assert.rejects(lifecycle.request('closed', () => { starts++; }), /cancelled/);
  assert.equal(starts, 0);
  await lifecycle.request('other', owner => owner.use('server', async () => { starts++; }));
  assert.equal(starts, 1);
});

test('a fully removed repository can forget a closed owner and reconnect with the same comparison id', async () => {
  const stopped = [];
  const lifecycle = createPreviewLifecycle({ stop: async key => { stopped.push(key); } });
  await lifecycle.request('repository-comparison', owner => owner.use('old-server', async () => 'old'));
  await lifecycle.release('repository-comparison');
  await assert.rejects(lifecycle.request('repository-comparison', () => 'blocked'), /cancelled/);
  await lifecycle.forget('repository-comparison');
  assert.equal(await lifecycle.request('repository-comparison', owner => owner.use('new-server', async () => 'new')), 'new');
  assert.deepEqual(stopped, ['old-server']);
});

test('a new owner arriving during stop waits before restarting the same resource', async () => {
  const gate = deferred();
  const order = [];
  const lifecycle = createPreviewLifecycle({ stop: async () => { order.push('stopping'); await gate.promise; order.push('stopped'); } });
  await lifecycle.request('a', owner => owner.use('key', async () => {}));
  const closing = lifecycle.release('a');
  const opening = lifecycle.request('b', owner => owner.use('key', async () => order.push('restarted')));
  await tick();
  assert.deepEqual(order, ['stopping']);
  gate.resolve();
  await Promise.all([closing, opening]);
  assert.deepEqual(order, ['stopping', 'stopped', 'restarted']);
});

test('ownership retains historical resources across renderer reload without resolving deleted branches', async () => {
  const stopped = [];
  const lifecycle = createPreviewLifecycle({ stop: async key => { stopped.push(key); } });
  await lifecycle.request('comparison-id', owner => owner.use('old-branch-sha', async () => {}));
  await lifecycle.request('comparison-id', owner => owner.use('new-branch-sha', async () => {}));
  await lifecycle.release('comparison-id');
  assert.deepEqual(stopped.sort(), ['new-branch-sha', 'old-branch-sha']);
});

// Exercise the production HTTP servers and stop handler, including open sockets.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const { startUiPreview } = require('../src/main/ui-preview-server.cjs');
async function portOpen(url) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(new URL(url).port) });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Port probe timed out')); });
  });
}
async function serverFixture(t, compileInWorker) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-lifecycle-'));
  const repository = path.join(scratch, 'repo');
  await fs.mkdir(repository);
  await fs.writeFile(path.join(repository, 'index.html'), '<h1>Preview</h1>');
  const previewServers = new Map(), previewSnapshots = new Map(), uiPreviews = new Map();
  const c = vm.createContext({
    fs, path, os, http, URL, snapshotFs: require('../src/main/snapshot-files.cjs'),
    previewServers, previewSnapshots, uiPreviews, shutdownStarted: false, reloadStarted: false,
    mainWindow: null, app: { getPath: () => scratch }, runGit: async () => 'abc123',
    ...require('../src/main/preview-file-settings.cjs'), ...require('../src/main/generated-output.cjs'),
    ...require('../src/main/expo-preview-output.cjs'), ...require('../src/main/preview-pages.cjs'), startUiPreview,
    compileInWorker: compileInWorker || (async options => ({ root: options.root, warnings: [] })),
  });
  const source = await fs.readFile(path.join(__dirname, '../src/main/desktop-main.cjs'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function previewRoot('), source.indexOf('async function stopPreviewServers(')), c);
  const uiStart = source.indexOf('async function withUiPreview(');
  vm.runInContext(source.slice(uiStart, source.indexOf('\n}\n', uiStart) + 3), c);
  const lifecycle = createPreviewLifecycle({ stop: key => c.stopPreviewResource(key) });
  const key = `${repository}\0working-tree\0working-tree\0{}`;
  const start = (owner, reuse = true) => lifecycle.request(owner, token => token.use(key, async signal => {
    const preview = await c.startPreviewServer(repository, '__working_tree__', { signal, reuse });
    signal.throwIfAborted();
    const result = await c.withUiPreview(preview);
    signal.throwIfAborted();
    return result;
  }));
  t.after(async () => {
    await lifecycle.stopAll();
    await fs.rm(scratch, { recursive: true, force: true });
  });
  return { lifecycle, start, previewServers, uiPreviews };
}

test('last close shuts both real ports and open sockets; shared close keeps HTTP usable', async t => {
  const f = await serverFixture(t);
  const a = await f.start('a');
  const b = await f.start('b');
  assert.equal(a.url, b.url);
  const urls = [a.url, a.upstreamUrl];
  const sockets = await Promise.all(urls.map(url => new Promise((resolve, reject) => {
    const socket = net.connect(Number(new URL(url).port), '127.0.0.1', () => resolve(socket));
    socket.once('error', reject);
  })));
  t.after(() => sockets.forEach(socket => socket.destroy()));
  const disconnected = sockets.map(socket => new Promise(resolve => socket.once('close', resolve)));
  await f.lifecycle.release('a');
  for (const url of urls) assert.equal(await portOpen(url), true);
  assert.match(await (await fetch(b.url)).text(), /Preview/);
  const began = performance.now();
  await f.lifecycle.release('b');
  await Promise.all(disconnected);
  for (const url of urls) assert.equal(await portOpen(url), false);
  assert.equal(f.previewServers.size, 0);
  assert.equal(f.uiPreviews.size, 0);
  t.diagnostic(`Final release and TCP probes: ${(performance.now() - began).toFixed(1)} ms`);
});

test('closing during refresh aborts compilation, closes existing ports, and cannot recreate them', async t => {
  let refreshing = false;
  const entered = deferred();
  const f = await serverFixture(t, async (options, { signal }) => {
    if (refreshing) {
      entered.resolve();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return { root: options.root, warnings: [] };
  });
  const preview = await f.start('a');
  refreshing = true;
  const pending = assert.rejects(f.start('a', false), /cancelled/);
  await entered.promise;
  await f.lifecycle.release('a');
  await pending;
  for (const url of [preview.url, preview.upstreamUrl]) assert.equal(await portOpen(url), false);
  assert.equal(f.previewServers.size, 0);
  assert.equal(f.uiPreviews.size, 0);
});

test('closing during first build leaves no listening server, even if compilation returns late', async t => {
  const entered = deferred(), finish = deferred();
  const f = await serverFixture(t, async options => {
    entered.resolve();
    await finish.promise;
    return { root: options.root, warnings: [] };
  });
  const pending = assert.rejects(f.start('a'), /cancelled/);
  await entered.promise;
  const closing = f.lifecycle.release('a');
  finish.resolve();
  await Promise.all([pending, closing]);
  assert.equal(f.previewServers.size, 0);
  assert.equal(f.uiPreviews.size, 0);
});

test('last close terminates a real compiler worker before reporting completion', async t => {
  const { Worker } = require('node:worker_threads');
  const { createBuildQueue } = require('../src/main/preview-build-queue.cjs');
  const entered = deferred();
  let exited = false;
  class HoldingWorker extends Worker {
    constructor() {
      super("require('node:worker_threads').parentPort.postMessage({progress:'Test compiler running'}); setInterval(() => {}, 1000)", { eval: true });
      this.once('message', () => entered.resolve());
      this.once('exit', () => { exited = true; });
    }
  }
  const queue = createBuildQueue({ WorkerClass: HoldingWorker });
  t.after(() => queue.cancelBuilds());
  const f = await serverFixture(t, queue.compileInWorker);
  const pending = assert.rejects(f.start('a'), /cancelled/);
  await entered.promise;
  await f.lifecycle.release('a');
  await pending;
  assert.equal(exited, true);
  assert.equal(f.previewServers.size, 0);
  assert.equal(f.uiPreviews.size, 0);
});

test('closing one shared build returns promptly and the remaining comparison receives its preview', async () => {
  const gate = deferred();
  let aborted;
  const lifecycle = createPreviewLifecycle({ stop: async () => {} });
  const start = owner => owner.use('shared', async signal => { aborted = () => signal.aborted; return gate.promise; });
  const deleted = assert.rejects(lifecycle.request('deleted', start), /cancelled/);
  const retained = lifecycle.request('retained', start);
  await tick();
  await lifecycle.release('deleted');
  assert.equal(aborted(), false);
  gate.resolve('preview');
  assert.equal(await retained, 'preview');
  await deleted;
  await lifecycle.release('retained');
});

test('duplicate close awaits disposal and failed disposal can be retried', async () => {
  const gate = deferred();
  let attempts = 0;
  const lifecycle = createPreviewLifecycle({ stop: async () => { await gate.promise; if (++attempts === 1) throw new Error('close failed'); } });
  await lifecycle.request('a', owner => owner.use('key', async () => {}));
  const first = lifecycle.release('a');
  assert.equal(lifecycle.release('a'), first);
  const failed = assert.rejects(first, /close failed/);
  gate.resolve();
  await failed;
  await lifecycle.release('a');
  assert.equal(attempts, 2);
});

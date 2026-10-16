const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBuildQueue } = require('../src/main/preview-build-queue.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(timeoutMs = 1000) {
  const workers = [];
  class Worker extends EventEmitter {
    constructor(_file, { workerData }) { super(); this.options = workerData; workers.push(this); }
    terminate() { this.terminated = true; return Promise.resolve(0); }
  }
  return { ...createBuildQueue({ WorkerClass: Worker, timeoutMs }), workers };
}
const options = root => ({ root, repositoryPath: '/repo', cacheRoot: '/cache' });
test('preserves preview availability codes across the worker boundary', async () => {
  const queue = fixture();
  const result = queue.compileInWorker(options('empty'));
  queue.workers[0].emit('message', { error: 'No previewable screen was found.', code: 'NO_PREVIEW_SCREEN' });
  await assert.rejects(result, { code: 'NO_PREVIEW_SCREEN' });
});
test('joins duplicate builds and promotes requested work ahead of background work', async () => {
  const queue = fixture();
  const first = queue.compileInWorker(options('first'));
  const background = queue.compileInWorker(options('background'), { priority: 'background' });
  const selected = queue.compileInWorker(options('selected'), { priority: 'background' });
  assert.equal(queue.compileInWorker(options('selected')), selected);
  assert.equal(queue.workers.length, 1);
  queue.workers[0].emit('message', { artifact: 'first' });
  assert.equal(await first, 'first');
  await tick();
  assert.equal(queue.workers[1].options.root, 'selected');
  queue.workers[1].emit('message', { artifact: 'selected' });
  await selected; await tick();
  queue.workers[2].emit('message', { artifact: 'background' });
  await background;
});
test('unexpected successful worker exit rejects and releases the next build', async () => {
  const queue = fixture();
  const first = queue.compileInWorker(options('first'));
  const failed = assert.rejects(first, /stopped before returning/);
  const next = queue.compileInWorker(options('next'));
  queue.workers[0].emit('exit', 0);
  await failed; await tick();
  queue.workers[1].emit('message', { artifact: 'ok' });
  assert.equal(await next, 'ok');
});
test('shutdown cancels active and pending workers without leaving unresolved callers', async () => {
  const queue = fixture();
  const first = assert.rejects(queue.compileInWorker(options('first')), /cancelled/);
  const next = assert.rejects(queue.compileInWorker(options('next')), /cancelled/);
  queue.cancelBuilds();
  await Promise.all([first, next]);
  assert.equal(queue.workers.length, 1);
  assert.equal(queue.workers[0].terminated, true);
});
test('timeout terminates the worker and permits a retry', async () => {
  const queue = fixture(10);
  await assert.rejects(queue.compileInWorker(options('first')), /timed out/);
  const retry = queue.compileInWorker(options('first'));
  queue.workers[1].emit('message', { artifact: 'retry' });
  assert.equal(await retry, 'retry');
});

test('progress messages do not finish a worker and reach duplicate callers', async () => {
  const queue = fixture();
  const firstProgress = [], secondProgress = [];
  const first = queue.compileInWorker(options('progress'), { onProgress: value => firstProgress.push(value) });
  queue.workers[0].emit('message', { progress: 'Preparing libraries…' });
  const duplicate = queue.compileInWorker(options('progress'), { onProgress: value => secondProgress.push(value) });
  queue.workers[0].emit('message', { installerPid: null });
  assert.equal(queue.workers[0].terminated, undefined);
  assert.deepEqual(firstProgress, ['Starting preview build…', 'Preparing libraries…']);
  assert.deepEqual(secondProgress, ['Preparing libraries…']);
  queue.workers[0].emit('message', { artifact: 'ready' });
  assert.equal(await first, 'ready');
  assert.equal(await duplicate, 'ready');
});

test('queued callers see waiting until their build actually starts', async () => {
  const queue = fixture();
  const first = queue.compileInWorker(options('first'));
  const statuses = [];
  const next = queue.compileInWorker(options('next'), { onProgress: message => statuses.push(message) });
  assert.deepEqual(statuses, ['Waiting for another preview build…']);
  queue.workers[0].emit('message', { artifact: 'first' });
  await first;
  assert.deepEqual(statuses, ['Waiting for another preview build…', 'Starting preview build…']);
  queue.workers[1].emit('message', { artifact: 'next' });
  await next;
});

test('resource abort cancels only its queued job, leaving the active worker alive', async () => {
  const queue = fixture();
  const running = queue.compileInWorker(options('running'));
  const controller = new AbortController();
  const cancelled = assert.rejects(queue.compileInWorker(options('cancelled'), { signal: controller.signal }), /cancelled/);
  controller.abort();
  await cancelled;
  assert.equal(queue.workers[0].terminated, undefined);
  queue.workers[0].emit('message', { artifact: 'ok' });
  assert.equal(await running, 'ok');
  assert.equal(queue.workers.length, 1);
});

test('resource abort terminates its active worker and advances unrelated queued work', async () => {
  const queue = fixture();
  const controller = new AbortController();
  const cancelled = assert.rejects(queue.compileInWorker(options('cancelled'), { signal: controller.signal }), /cancelled/);
  const next = queue.compileInWorker(options('next'));
  controller.abort();
  await cancelled;
  assert.equal(queue.workers[0].terminated, true);
  assert.equal(queue.workers[1].options.root, 'next');
  queue.workers[1].emit('message', { artifact: 'ok' });
  assert.equal(await next, 'ok');
});

const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { stopRuntimeProcess } = require('./runtime-process.cjs');

function createBuildQueue({ WorkerClass = Worker, timeoutMs = 180000 } = {}) {
  const jobs = [];
  const pending = new Map();
  let active = null;
  function report(job, message) {
    job.progress = message;
    for (const callback of job.listeners) callback(message);
  }
  function pump() {
    if (active || !jobs.length) return;
    const job = active = jobs.shift();
    report(job, 'Starting preview build…');
    let worker, timer, installerPid, settled = false;
    const finish = (error, artifact) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(job.key);
      // Wait for worker exit before another compiler can modify the cache.
      Promise.resolve().then(async () => {
        await worker?.terminate();
        if (installerPid) await stopRuntimeProcess({ pid: installerPid, kill: signal => process.kill(installerPid, signal) });
      }).catch(cleanupError => { error = cleanupError; }).finally(() => {
        active = null;
        error ? job.reject(error) : job.resolve(artifact);
        pump();
      });
    };
    job.cancel = () => finish(new Error('Preview compilation cancelled.'));
    try {
      worker = new WorkerClass(path.join(__dirname, 'preview-compiler-worker.cjs'), { workerData: job.options });
      timer = setTimeout(() => finish(new Error('Preview preparation timed out. Try again or select a smaller revision.')), timeoutMs);
      worker.on('message', result => {
        if ('installerPid' in result) { installerPid = result.installerPid; return; }
        if (settled) return;
        if (result.progress) { report(job, result.progress); return; }
        finish(result.error ? Object.assign(new Error(result.error), { code: result.code }) : null, result.artifact);
      });
      worker.once('error', error => finish(error));
      worker.once('exit', code => finish(new Error(`UI compiler stopped before returning a result (${code}).`)));
    } catch (error) { finish(error); }
  }
  function compileInWorker(options, { priority = 'foreground', onProgress, signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const key = JSON.stringify([options.root, options.repositoryPath, options.cacheRoot]);
    const existing = pending.get(key);
    if (existing) {
      if (onProgress) { existing.listeners.add(onProgress); if (existing.progress) onProgress(existing.progress); }
      if (priority === 'foreground' && existing !== active) {
        jobs.splice(jobs.indexOf(existing), 1);
        existing.priority = priority;
        jobs.unshift(existing);
      }
      return existing.promise;
    }
    const job = { options, priority, key, listeners: new Set(onProgress ? [onProgress] : []) };
    job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
    pending.set(key, job);
    if (signal) {
      const abort = () => {
        if (job === active) job.cancel();
        else {
          const index = jobs.indexOf(job);
          if (index < 0) return;
          jobs.splice(index, 1);
          pending.delete(key);
          job.reject(new Error('Preview compilation cancelled.'));
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      job.promise.finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
    }
    const firstBackground = jobs.findIndex(item => item.priority === 'background');
    if (priority === 'background' || firstBackground < 0) jobs.push(job);
    else jobs.splice(firstBackground, 0, job);
    if (active) report(job, 'Waiting for another preview build…');
    pump();
    return job.promise;
  }
  function cancelBuilds() {
    for (const job of jobs.splice(0)) { pending.delete(job.key); job.reject(new Error('Preview compilation cancelled.')); }
    active?.cancel();
  }
  return { compileInWorker, cancelBuilds };
}
module.exports = { ...createBuildQueue(), createBuildQueue };

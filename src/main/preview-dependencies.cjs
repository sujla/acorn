const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { stopRuntimeProcess } = require('./runtime-process.cjs');
const { yarnPlan, installYarn } = require('./preview-yarn.cjs');
const locks = ['npm-shrinkwrap.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm.lock', 'bun.lock', 'bun.lockb'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const pending = new Map();
function dependencySignature(pkg) {
  return JSON.stringify(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions', 'workspaces', 'packageManager'].map(key => [key, pkg[key] || null]));
}

async function installNpm({ directory, cacheRoot, onProcess = () => {} }) {
  // Do not evaluate repository npm configuration or lifecycle scripts. Use the
  // user's installed npm, including the usual macOS GUI-app search locations.
  const env = { ...process.env, PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter), CI: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['ci', '--global=false', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', '--include=dev', '--include=optional', '--include=peer', '--cache', path.join(cacheRoot, 'npm-cache'), '--fetch-retries=1', '--fetch-timeout=30000'];
  await new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: directory, env, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
    let timedOut = false;
    // Never surface npm output verbatim: registry URLs may contain credentials.
    child.stderr.resume();
    onProcess(child.pid || null);
    const timer = setTimeout(() => { timedOut = true; stopRuntimeProcess(child).catch(() => {}); }, 120000);
    child.once('error', error => { clearTimeout(timer); onProcess(null); reject(new Error(error.code === 'ENOENT' ? 'Preparing this revision requires Node.js and npm on this computer. Install them, then refresh the preview.' : 'Could not start dependency installation. Refresh the preview to retry.')); });
    child.once('close', code => {
      clearTimeout(timer); onProcess(null);
      if (code === 0 && !timedOut) resolve();
      else reject(new Error(timedOut ? 'Dependency installation timed out. Check your connection and refresh the preview to retry.' : `Dependency installation failed (npm exit ${code}). Check network access, package registry credentials, and the revision’s lockfile, then refresh the preview to retry.`));
    });
  });
}

async function prepareDependencies({ root, repositoryPath, cacheRoot, onProgress = () => {}, onProcess, install }) {
  onProgress('Checking libraries for this revision…');
  const manifest = await read(path.join(root, 'package.json'));
  const liveManifest = await read(path.join(repositoryPath, 'package.json'));
  const pkg = manifest ? JSON.parse(manifest) : {};
  const livePkg = liveManifest ? JSON.parse(liveManifest) : {};
  const inputs = { [path.join(repositoryPath, 'package.json')]: liveManifest ? hash(liveManifest) : null };
  const historical = {};
  let different = dependencySignature(pkg) !== dependencySignature(livePkg);
  for (const name of [...locks, '.yarnrc.yml']) {
    const old = await read(path.join(root, name));
    const current = await read(path.join(repositoryPath, name));
    inputs[path.join(repositoryPath, name)] = current ? hash(current) : null;
    if (old) historical[name] = old;
    if (Boolean(old) !== Boolean(current) || (old && !old.equals(current))) different = true;
  }
  if (!different) {
    onProgress('Building preview with local libraries…');
    return { root: repositoryPath, inputs, isolated: false, key: 'live' };
  }
  let manager;
  if (!locks.some(name => historical[name])) {
    throw Object.assign(new Error('This revision has no dependency lockfile. Acorn cannot reproduce its library versions. Choose a revision with a lockfile.'), { code: 'MISSING_DEPENDENCY_LOCKFILE' });
  }
  if (pkg.packageManager?.startsWith('yarn@') || (!pkg.packageManager && historical['yarn.lock'] && !historical['package-lock.json'] && !historical['npm-shrinkwrap.json'])) {
    manager = yarnPlan(pkg, historical['yarn.lock'], historical['.yarnrc.yml']);
  } else {
    const lockName = historical['npm-shrinkwrap.json'] ? 'npm-shrinkwrap.json' : 'package-lock.json';
    if (!historical[lockName] || (pkg.packageManager && !pkg.packageManager.startsWith('npm@'))) throw Object.assign(new Error('This revision uses a package manager that historical previews do not support yet. Supported formats: npm and Yarn 4. Try another revision.'), { code: 'UNSUPPORTED_PACKAGE_MANAGER' });
    let lock;
    try { lock = JSON.parse(historical[lockName]); } catch { throw new Error('Cannot prepare historical dependencies: the npm lockfile is invalid.'); }
    if (!lock.lockfileVersion) throw new Error('Cannot prepare historical dependencies: the npm lockfile has no lockfileVersion.');
    // Local/workspace packages require snapshot-aware copying. Do not accidentally
    // resolve them relative to the cache or run Git prepare hooks.
    if (pkg.workspaces || /"(?:file:|link:|workspace:|git\+|git:|github:|gitlab:|bitbucket:)/.test(JSON.stringify([pkg, lock])) || Object.values(lock.packages || {}).some(entry => entry.link || (entry.resolved && !/^https?:\/\//.test(entry.resolved)))) throw new Error('Historical dependency installation does not yet support workspace, local-file or Git packages.');
    manager = { name: 'npm', lockName, key: 'npm-ci-ignore-scripts-v1' };
  }
  const { lockName } = manager;
  const installer = install || (manager.name === 'yarn' ? installYarn : installNpm);
  const key = hash([manager.key, repositoryPath, process.platform, process.arch, process.versions.modules, manifest, historical[lockName], historical['.yarnrc.yml']].join('\0'));
  const parent = path.join(cacheRoot, 'installed-dependencies');
  await fs.mkdir(parent, { recursive: true });
  const destination = path.join(await fs.realpath(parent), key);
  const marker = path.join(destination, '.acorn-ready.json');
  const valid = async () => {
    const ready = await read(marker);
    return ready?.toString() === key && Boolean(await fs.stat(path.join(destination, 'node_modules')).catch(() => null));
  };
  if (!(await valid())) {
    let task = pending.get(destination);
    if (!task) {
      task = (async () => {
        onProgress('Installing libraries for this revision…');
        const work = await fs.mkdtemp(path.join(parent, '.installing-'));
        try {
          await fs.writeFile(path.join(work, 'package.json'), manifest);
          await fs.writeFile(path.join(work, lockName), historical[lockName]);
          await installer({ directory: work, cacheRoot, onProcess, manager });
          if (!(await fs.readFile(path.join(work, lockName))).equals(historical[lockName])) throw new Error('Dependency installation changed the revision’s lockfile; the preview was not cached.');
          await fs.mkdir(path.join(work, 'node_modules'), { recursive: true });
          await fs.writeFile(path.join(work, '.acorn-ready.json'), key);
          await fs.rm(destination, { recursive: true, force: true });
          await fs.rename(work, destination);
        } catch (error) { await fs.rm(work, { recursive: true, force: true }); throw error; }
      })();
      pending.set(destination, task);
      task.finally(() => pending.delete(destination)).catch(() => {});
    }
    else onProgress('Waiting for library installation…');
    await task;
  } else onProgress('Reusing installed libraries for this revision…');
  await fs.utimes(marker, new Date(), new Date());
  inputs[marker] = hash(key);
  onProgress('Building preview…');
  return { root: destination, inputs, isolated: true, key };
}
module.exports = { prepareDependencies, installNpm };

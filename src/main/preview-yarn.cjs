const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const YAML = require('yaml');
const { stopRuntimeProcess } = require('./runtime-process.cjs');

function yarnPlan(pkg, lockBytes, configBytes) {
  const match = /^yarn@(4\.\d+\.\d+)(?:\+sha(?:224|512)\.[a-f0-9]+)?$/.exec(pkg.packageManager || '');
  if (!match) throw new Error('This revision needs different dependencies. Historical Yarn previews currently require an exact Yarn 4 version in package.json (packageManager: yarn@4.x.y).');
  if (!lockBytes) throw new Error('This revision needs different dependencies, but its yarn.lock is missing.');
  let lock, config;
  try {
    lock = YAML.parse(lockBytes.toString(), { maxAliasCount: 0 });
    config = configBytes ? YAML.parse(configBytes.toString(), { maxAliasCount: 0 }) : {};
  } catch { throw new Error('Cannot prepare historical dependencies: invalid Yarn lockfile or configuration.'); }
  if (!lock?.__metadata?.version) throw new Error('Historical Yarn previews require a modern Yarn lockfile.');
  // Only this known configuration is supported; never load repository plugins,
  // yarnPath, custom registries, package extensions, or injected environment files.
  if (!config || typeof config !== 'object' || Object.keys(config).some(key => key !== 'nodeLinker') || config.nodeLinker !== 'node-modules') {
    throw new Error('Historical Yarn previews currently support only nodeLinker: node-modules in .yarnrc.yml; custom Yarn settings and plugins are not supported.');
  }
  if (pkg.workspaces) throw new Error('Historical dependency installation does not yet support workspace, local-file or Git packages.');
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'resolutions']) {
    for (const spec of Object.values(pkg[group] || {})) {
      if (typeof spec !== 'string' || /(?:file:|link:|portal:|workspace:|patch:|git[+:]|https?:|github:|gitlab:|bitbucket:)/i.test(spec) || (!spec.startsWith('npm:') && spec.includes('/'))) {
        throw new Error('Historical Yarn previews do not yet support local, Git, URL, workspace dependencies or custom patches.');
      }
    }
  }
  if (!lock[`${pkg.name}@workspace:.`]) throw new Error('The Yarn lockfile does not contain this project’s root package.');
  for (const [key, entry] of Object.entries(lock)) {
    if (key === '__metadata') continue;
    const resolution = entry?.resolution;
    const root = resolution === `${pkg.name}@workspace:.` && key === resolution;
    const registry = typeof resolution === 'string' && /^(?:@[^/\s]+\/)?[^@\s]+@npm:/.test(resolution);
    const builtin = typeof resolution === 'string' && /^(?:@[^/\s]+\/)?[^@\s]+@patch:[^#]+@npm%3[Aa][^#]+#optional!builtin<compat\/[^>]+>(?:::.*)?$/.test(resolution);
    if (!root && !registry && !builtin) throw new Error('Historical Yarn previews do not yet support local, Git, URL, workspace dependencies or custom patches.');
  }
  return { name: 'yarn', version: match[1], lockName: 'yarn.lock', key: `yarn-${match[1]}-immutable-node-modules-skip-build-v1` };
}

async function installYarn({ directory, cacheRoot, manager, onProcess = () => {} }) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('YARN_') || key === 'NODE_OPTIONS' || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  Object.assign(env, {
    PATH: [process.env.PATH, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter),
    CI: '1', COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_AUTO_PIN: '0',
    YARN_RC_FILENAME: '.acorn-yarnrc.yml', YARN_IGNORE_PATH: '1',
    YARN_ENABLE_SCRIPTS: 'false', YARN_ENABLE_TELEMETRY: 'false',
    YARN_ENABLE_GLOBAL_CACHE: 'false', YARN_CACHE_FOLDER: path.join(cacheRoot, 'yarn-cache', manager.version),
    YARN_NODE_LINKER: 'node-modules', YARN_ENABLE_IMMUTABLE_INSTALLS: 'true',
  });
  await fs.writeFile(path.join(directory, '.acorn-yarnrc.yml'), 'nodeLinker: node-modules\nenableScripts: false\ninjectEnvironmentFiles: []\n');
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'yarn.cmd' : 'yarn', args, { cwd: directory, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    child.stdout.on('data', chunk => { if (output.length < 1024) output += chunk.toString().slice(0, 1024); });
    child.stderr.resume(); // Registry credentials must never reach the UI.
    onProcess(child.pid || null);
    const timer = setTimeout(() => { timedOut = true; stopRuntimeProcess(child).catch(() => {}); }, 120000);
    child.once('error', () => { clearTimeout(timer); onProcess(null); reject(new Error(`Preparing this revision requires Yarn ${manager.version} and Node.js on this computer.`)); });
    child.once('close', code => {
      clearTimeout(timer); onProcess(null);
      if (code === 0 && !timedOut) resolve(output.trim());
      else reject(new Error(timedOut ? 'Yarn dependency installation timed out. Refresh the preview to retry.' : `Could not prepare dependencies with Yarn ${manager.version}. Ensure this version is installed, the lockfile matches package.json, and the package registry is accessible.`));
    });
  });
  if (await run(['--version']) !== manager.version) throw new Error(`This revision requires Yarn ${manager.version}; the available Yarn version does not match.`);
  await run(['install', '--immutable', '--mode=skip-build']);
}

module.exports = { yarnPlan, installYarn };

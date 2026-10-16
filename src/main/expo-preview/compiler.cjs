const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { files, hash, validateInputs } = require('../preview-compiler.cjs');
const { localPreviewOutputDirectories } = require('../generated-output.cjs');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const bundledModules = path.resolve(__dirname, '../../../node_modules');
const { prepareDependencies } = require('../preview-dependencies.cjs');
const { resolveExpoRuntime, runtimeModule } = require('./runtime.cjs');
const { loadPathAliases, resolvePathAlias } = require('./path-aliases.cjs');
const version = 'expo-web-5';
async function json(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function packageName(specifier) {
  if (!specifier || specifier.startsWith('.') || path.isAbsolute(specifier)) return null;
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

function installedPackageRoot(nodeModulesRoot, file) {
  const relative = path.relative(nodeModulesRoot, file);
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  let last = -1;
  for (let index = 0; index < parts.length; index++) if (parts[index] === 'node_modules') last = index;
  const start = last + 1;
  const length = parts[start]?.startsWith('@') ? 2 : 1;
  if (!parts[start] || parts.length < start + length) return null;
  return path.join(nodeModulesRoot, ...parts.slice(0, start + length));
}

function installedPackages(nodeModulesRoot) {
  const packages = [];
  const visited = new Set();
  const visit = modules => {
    let real;
    try { real = syncFs.realpathSync(modules); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of syncFs.readdirSync(real, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name.startsWith('@')) {
        visitScope(path.join(real, entry.name));
        continue;
      }
      visitPackage(path.join(real, entry.name));
    }
  };
  const visitScope = scope => {
    let entries;
    try { entries = syncFs.readdirSync(scope, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) if (!entry.name.startsWith('.')) visitPackage(path.join(scope, entry.name));
  };
  const visitPackage = directory => {
    let manifest;
    try { manifest = JSON.parse(syncFs.readFileSync(path.join(directory, 'package.json'), 'utf8')); } catch { return; }
    if (manifest.name) packages.push({ directory, manifest });
    visit(path.join(directory, 'node_modules'));
  };
  visit(nodeModulesRoot);
  return packages;
}

function resolvedPackageRoot(from, name, nodeModulesRoot) {
  let directory = from;
  while (inside(nodeModulesRoot, directory)) {
    const candidate = path.join(directory, 'node_modules', ...name.split('/'));
    try { return syncFs.realpathSync(candidate); } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const topLevel = path.join(nodeModulesRoot, ...name.split('/'));
  try { return syncFs.realpathSync(topLevel); } catch { return null; }
}

function nestedDependencyOwner(packages, nodeModulesRoot, originModulePath, request) {
  const requestedName = packageName(request);
  const originRoot = installedPackageRoot(nodeModulesRoot, originModulePath);
  if (!requestedName || !originRoot) return null;
  let originManifest;
  try { originManifest = JSON.parse(syncFs.readFileSync(path.join(originRoot, 'package.json'), 'utf8')); } catch { return null; }
  const originName = originManifest.name;
  if (!originName) return null;
  const realOrigin = syncFs.realpathSync(originRoot);
  for (const { directory, manifest } of packages) {
    const declarations = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
    if (!declarations[originName] || !declarations[requestedName]) continue;
    if (resolvedPackageRoot(directory, originName, nodeModulesRoot) !== realOrigin) continue;
    const requestedRoot = resolvedPackageRoot(directory, requestedName, nodeModulesRoot);
    if (requestedRoot && requestedRoot !== resolvedPackageRoot(nodeModulesRoot, requestedName, nodeModulesRoot)) return directory;
  }
  return null;
}

async function compileExpoPreview({ root, repositoryPath, cacheRoot, onProgress, onProcess, installDependencies }) {
  root = await fs.realpath(root);
  repositoryPath = await fs.realpath(repositoryPath);
  if (root === repositoryPath) throw new Error('Expo compilation requires an isolated source snapshot.');
  const pkg = await json(path.join(root, 'package.json'), {});
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  const sourceFiles = await files(root, root, await localPreviewOutputDirectories(root));
  require('../preview-availability.cjs').assertExpoScreen(root, sourceFiles, pkg);
  const prepared = await prepareDependencies({ root, repositoryPath, cacheRoot, onProgress, onProcess, install: installDependencies });
  const dependencyRoot = path.join(prepared.root, 'node_modules');
  const expoPackage = await json(path.join(dependencyRoot, 'expo/package.json'), null);
  if (!expoPackage) throw new Error('Expo preview needs the project’s installed dependencies. This project has no local Expo package yet.');
  const runtime = resolveExpoRuntime(expoPackage.version);
  const Metro = require(runtime.metro);
  const { getDefaultConfig } = require(runtime.metroConfig);
  const inputs = { ...prepared.inputs };
  const digest = crypto.createHash('sha256').update(version).update(runtime.id).update(repositoryPath);
  for (const file of sourceFiles) digest.update(path.relative(root, file)).update(await fs.readFile(file));
  // App upgrades invalidate artifacts when the trusted transformer/runtime changes.
  for (const file of ['compiler.cjs', 'transformer.cjs', 'visual-hook-plugin.cjs', 'css.cjs', 'runtime.cjs', 'path-aliases.cjs', 'asset-registry.js', 'native-map.js', 'map-geometry.cjs', 'map-compatibility.cjs', 'feature-boundary.js', 'feature-boundary-plugin.cjs', 'native-features.js', 'feature-adapters.cjs', 'native-ads.js', 'native-share.js', 'file-system.js']) digest.update(await fs.readFile(path.join(__dirname, file)));
  digest.update(await fs.readFile(path.join(__dirname, '../../../package.json')));
  const cacheKey = digest.digest('hex');
  const destination = path.join(cacheRoot, cacheKey);
  const previous = await json(path.join(destination, 'artifact.json'), null);
  if (previous && await validateInputs(previous.inputs)) return { root: destination, cacheKey, cached: true, warnings: previous.warnings, responses: {} };
  await fs.mkdir(cacheRoot, { recursive: true });
  const work = await fs.realpath(await fs.mkdtemp(path.join(cacheRoot, '.expo-')));
  const artifactRoot = path.join(work, 'output');
  await fs.mkdir(artifactRoot);
  const previousManifest = process.env.APP_MANIFEST;
  const substitutions = new Set();
  const mapRules = require('./map-compatibility.cjs');
  const mappedFiles = [];
  for (const file of sourceFiles.filter(file => file.endsWith('GoogleTransitMap.tsx'))) {
    if (mapRules.mapCompatibility(file, await fs.readFile(file, 'utf8')).applied) mappedFiles.push(path.relative(root, file));
  }
  const warnings = [`Automatic Expo web preview selected Acorn’s Expo SDK ${runtime.sdk} runtime. Native-only modules and project build plugins may not work on web.`];
  if (mappedFiles.length) warnings.push('Schematic map compatibility bypasses the Google SDK configuration guard in: ' + mappedFiles.join(', '));
  try {
    const app = await json(path.join(root, 'app.json'), {});
    const pathAliases = await loadPathAliases(root);
    // Prevent Expo's preset from evaluating app.config.js/ts. This is worker-local.
    const publicConfig = { ...(app.expo || {}) };
    for (const key of ['plugins', 'hooks', '_internal', 'ios', 'android']) delete publicConfig[key];
    process.env.APP_MANIFEST = JSON.stringify({ ...publicConfig, web: { ...(publicConfig.web || {}), output: 'single' } });
    const routerRoot = sourceFiles.some(file => file.startsWith(path.join(root, 'src/app') + path.sep)) ? 'src/app' : 'app';
    let entry;
    if (declared['expo-router']) entry = "import 'expo-router/entry';";
    else {
      const main = pkg.main && !/(?:^|\/)expo\/AppEntry/.test(pkg.main) ? pkg.main : './App';
      entry = /^(?:\.\/)?App(?:\.[jt]sx?)?$/.test(main)
        ? `import { registerRootComponent } from 'expo'; import App from ${JSON.stringify(path.resolve(root, main))}; registerRootComponent(App);`
        : `import ${JSON.stringify(main.startsWith('.') || sourceFiles.includes(path.resolve(root, main)) ? path.resolve(root, main) : main)};`;
    }
    const entryFile = path.join(work, 'entry.js');
    await fs.writeFile(entryFile, entry);
    const contextFile = path.join(work, 'routes.js');
    await fs.writeFile(contextFile, `exports.ctx = require.context(${JSON.stringify(path.relative(work, path.join(root, routerRoot)))}, true, /^(?!.*(?:\\+api|\\+html|\\+native-intent|\\.native|\\.ios|\\.android)\\.[jt]sx?$).*\\.[jt]sx?$/, 'sync');`);
    const snapshotModules = path.join(root, 'node_modules');
    const existingModules = await fs.lstat(snapshotModules).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existingModules?.isSymbolicLink() && await fs.readlink(snapshotModules) !== dependencyRoot) await fs.unlink(snapshotModules);
    await fs.symlink(dependencyRoot, path.join(root, 'node_modules')).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (await fs.realpath(path.join(root, 'node_modules')) !== await fs.realpath(dependencyRoot)) throw new Error('Snapshot dependencies do not match the connected project.');
    const config = await getDefaultConfig(root);
    config.projectRoot = root;
    config.watchFolders = [root, dependencyRoot, bundledModules, await fs.realpath(work), __dirname];
    config.maxWorkers = 1;
    config.useGlobalHotkey = false;
    config.reporter = { update() {} };
    config.cacheStores = [];
    config.fileMapCacheDirectory = work;
    config.resolver.useWatchman = false;
    config.resolver.resolverMainFields = ['browser', 'main'];
    // Prefer source modules over data files when an extensionless import has a
    // same-basename pair such as theme.ts and theme.json. The TypeScript module
    // commonly wraps and exports values from the JSON file.
    config.resolver.sourceExts = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'svg', 'css'];
    config.resolver.assetExts = config.resolver.assetExts.filter(ext => !['svg', 'css'].includes(ext));
    config.resolver.nodeModulesPaths = [dependencyRoot, bundledModules];
    config.resolver.unstable_enablePackageExports = true;
    config.resolver.unstable_conditionNames = ['require'];
    const allowed = [root, dependencyRoot, bundledModules, work, __dirname];
    const record = file => {
      const real = syncFs.realpathSync(file);
      if (!allowed.some(base => inside(base, real))) throw new Error('Expo import is outside the connected project: ' + file);
      if (real.endsWith('.node')) throw new Error('Native binary modules cannot run in web preview.');
      if (inside(dependencyRoot, real) || inside(bundledModules, real)) {
        if (!inputs[real]) inputs[real] = hash(syncFs.readFileSync(real));
        let directory = path.dirname(real);
        while (inside(dependencyRoot, directory) || inside(bundledModules, directory)) {
          const manifest = path.join(directory, 'package.json');
          if (!inputs[manifest] && syncFs.existsSync(manifest)) inputs[manifest] = hash(syncFs.readFileSync(manifest));
          directory = path.dirname(directory);
        }
      }
      return real;
    };
    const featureAdapters = require('./feature-adapters.cjs');
    const featureFiles = new Map();
    let dependencyPackages;
    for (const name of Object.keys(featureAdapters.adapters)) {
      const file = path.join(work, name.replace(/[^a-z0-9]/gi, '_') + '.js');
      await fs.writeFile(file, featureAdapters.sourceFor(name));
      featureFiles.set(name, file);
    }
    config.resolver.resolveRequest = (context, name, platform) => {
      if (name === 'node:async_hooks' && /[\\/]expo-font[\\/]build[\\/]serverContext\.web\.js$/.test(context.originModulePath)) return { type: 'empty' };
      const nativeFallbacks = { 'expo-file-system': 'file-system.js', 'react-native-maps': 'native-map.js', 'react-native-google-mobile-ads': 'native-ads.js', 'expo-share-intent': 'native-share.js' };
      if (featureFiles.has(name)) {
        substitutions.add(name);
        return { type: 'sourceFile', filePath: featureFiles.get(name) };
      }
      if (nativeFallbacks[name]) {
        substitutions.add(name);
        return { type: 'sourceFile', filePath: path.join(__dirname, nativeFallbacks[name]) };
      }
      if (name === 'expo-router/_ctx') return { type: 'sourceFile', filePath: contextFile };
      if (name === 'react-native') name = 'react-native-web';
      if (/^react-native\//.test(name)) throw new Error('A package requires native React Native internals without a web implementation: ' + name + ' (from ' + context.originModulePath + ')');
      const alias = resolvePathAlias(pathAliases, name, root);
      if (alias) {
        const result = context.resolveRequest({ ...context, preferNativePlatform: false }, alias, platform);
        if (result.type === 'sourceFile') record(result.filePath);
        if (result.type === 'assetFiles') result.filePaths.forEach(record);
        return result;
      }
      // One SDK-matched React/DOM pair avoids duplicate React and fills missing web dependencies.
      if (/^(react|react-dom|react-native-web)(\/|$)/.test(name)) {
        const result = require.resolve(runtimeModule(runtime, name), { paths: [path.dirname(bundledModules)] });
        return { type: 'sourceFile', filePath: record(result) };
      }
      let result;
      try {
        result = context.resolveRequest({ ...context, preferNativePlatform: false }, name, platform);
      } catch (error) {
        // npm may hoist one dependency while leaving its sibling nested under
        // their common owner (for example expo-font beside expo/node_modules/expo-asset).
        // Follow only a declared dependency edge whose owner resolves to the
        // exact package that issued the import; never search arbitrary modules.
        dependencyPackages ||= installedPackages(dependencyRoot);
        const owner = nestedDependencyOwner(dependencyPackages, dependencyRoot, context.originModulePath, name);
        if (!owner) throw error;
        result = context.resolveRequest({ ...context, originModulePath: path.join(owner, 'package.json'), preferNativePlatform: false }, name, platform);
      }
      if (result.type === 'sourceFile') record(result.filePath);
      if (result.type === 'assetFiles') result.filePaths.forEach(record);
      return result;
    };
    config.transformer.babelTransformerPath = require.resolve('./transformer.cjs');
    config.transformer.enableBabelRCLookup = false;
    config.transformer.unstable_allowRequireContext = true;
    config.transformer.assetRegistryPath = require.resolve('./asset-registry.js');
    config.transformer.assetPlugins = [];
    config.transformer.getTransformOptions = async () => ({ transform: { experimentalImportSupport: false, inlineRequires: false } });
    const cssInputs = path.join(work, 'css-inputs');
    await fs.mkdir(cssInputs);
    const result = await Metro.runBuild(config, { entry: entryFile, platform: 'web', dev: false, minify: false, assets: true, sourceMap: false, customTransformOptions: { routerRoot, preserveEnvVars: 'true', acornExpoSdk: String(runtime.sdk), acornCssRoots: JSON.stringify(allowed), acornCssInputs: cssInputs } });
    for (const file of await fs.readdir(cssInputs)) Object.assign(inputs, await json(path.join(cssInputs, file), {}));
    for (const asset of result.assets || []) {
      const relative = `_acorn_assets/${asset.hash}-${asset.name}.${asset.type}`;
      const target = path.resolve(artifactRoot, relative);
      if (!inside(artifactRoot, target)) throw new Error('Invalid exported asset path.');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(asset.files[0], target);
    }
    for (const file of sourceFiles.filter(file => inside(path.join(root, 'public'), file))) {
      const target = path.join(artifactRoot, path.relative(path.join(root, 'public'), file));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(file, target);
    }
    await fs.writeFile(path.join(artifactRoot, 'app.js'), result.code);
    await fs.writeFile(path.join(artifactRoot, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column}#root{flex:1;min-height:0;display:flex;flex-direction:column}</style></head><body><div id="root"></div><script>globalThis.global=globalThis;globalThis.process={env:{NODE_ENV:"production"}};</script><script src="/app.js"></script></body></html>');
    if (substitutions.has('expo-file-system')) warnings.push('File storage is simulated separately in each preview. Text and selected images stay in memory and are cleared on reload; device files are inaccessible.');
    if (substitutions.size) {
      const messages = [];
      if (substitutions.has('react-native-maps')) messages.push('Maps use a coordinate schematic, not Google Maps.');
      if (substitutions.has('expo-file-system')) messages.push('Preview files are temporary and cleared on reload.');
      if ([...substitutions].some(name => !['expo-file-system', 'react-native-maps'].includes(name))) messages.push('Unsupported native features show local notices.');
      const notice = 'Web preview · ' + messages.join(' ');
      warnings.push(notice + ' (' + [...substitutions].join(', ') + ')');
      const htmlPath = path.join(artifactRoot, 'index.html');
      const html = await fs.readFile(htmlPath, 'utf8');
      await fs.writeFile(htmlPath, html.replace('<div id="root">', '<aside role="note" style="font:11px system-ui;padding:6px 10px;background:#fff4d6;color:#624913">' + notice + '</aside><div id="root">'));
    }
    await fs.writeFile(path.join(artifactRoot, 'artifact.json'), JSON.stringify({ inputs, warnings }));
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(artifactRoot, destination);
    await fs.rm(work, { recursive: true, force: true });
    return { root: destination, cacheKey, cached: false, warnings, responses: {} };
  } catch (error) {
    await fs.rm(work, { recursive: true, force: true });
    throw new Error(require('./css.cjs').conciseExpoError(error, root));
  } finally {
    if (previousManifest === undefined) delete process.env.APP_MANIFEST;
    else process.env.APP_MANIFEST = previousManifest;
  }
}
module.exports = { compileExpoPreview };

const { normalizeSettings, scanPreviewFolders, resolveExclusions } = require('./preview-file-settings.cjs');
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, Menu } = require('electron');
const fs = require('fs/promises');
const { installRefreshMenu } = require('./refresh-menu.cjs');
const snapshotFs = require('./snapshot-files.cjs');
const path = require('path');
const os = require('os');
const http = require('http');

// Packaged installs must never inherit development repositories or browser state.
// Do not migrate the shared legacy profile: its folders were selected in dev.
if (app.isPackaged) {
  const profile = path.join(app.getPath('appData'), 'Acorn Desktop');
  require('node:fs').mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
}

const { githubRepository } = require('../renderer/repository-links.js');
const { createPreviewData } = require('./preview-data.cjs');
const previewData = createPreviewData();
const { detectProjectPlatforms } = require('./project-platforms.cjs');
const { expoPreviewExclusions, findExpoStaticPreview } = require('./expo-preview-output.cjs');
const { configuredOutputDirectories, localPreviewOutputDirectories, isPreviewOutput } = require('./generated-output.cjs');
const { getCommitPage, getCommitSummaries } = require('./commit-history.cjs');
const { inspectRepositoryRefs } = require('./repository-refs.cjs');
const { attachPreviewSync } = require('./preview-sync.cjs');
const { discoverPages } = require('./preview-pages.cjs');
const { startUiPreview, attachUiNavigationGuard } = require('./ui-preview-server.cjs');
const uiPreviews = new Map();
const { extractOverlayHints, comparisonRefs, diffPathspecs, isMediaFile } = require('./diff-overlay.cjs');
const { stopRuntimeProcess } = require('./runtime-process.cjs');
const { createLocalProfile, normalizeLocalProfileName, readLocalProfile } = require('./local-profile.cjs');
const { repositoryRecords, saveRecord, reorderRecords } = require('./repository-store.cjs');
const { comparisonStore } = require('./comparison-store.cjs');
const { createPreviewLifecycle } = require('./preview-lifecycle.cjs');
const previewLifecycle = createPreviewLifecycle({ stop: stopPreviewResource });
const visualPreviewLifecycle = createPreviewLifecycle({ stop: stopVisualPreviewResource });
const { createPreviewNetworkPolicy } = require('./preview-network-policy.cjs');
const { compileInWorker, cancelBuilds } = require('./preview-build-queue.cjs');
const { installPreviewCompiler, verifiedCompiler } = require('./preview-compiler-install.cjs');

let mainWindow;
let previewNetworkPolicy;
let shutdownStarted = false;
let reloadStarted = false;
let managedPreviewCompilerPath;
const previewRequests = new Set();
const previewServers = new Map();
const previewSnapshots = new Map();
const removingRepositories = new Set();
const removedRepositories = new Set();

// Acorn defaults to dark; the renderer synchronizes a saved Light or System choice after loading.
nativeTheme.themeSource = 'dark';

function updateNativeWindowTheme(preference) {
  if (!['dark', 'light', 'system'].includes(preference)) return;
  nativeTheme.themeSource = preference;
  mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0b0b0b' : '#fcfcfc');
}

ipcMain.on('theme:set', (event, preference) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return;
  updateNativeWindowTheme(preference);
});

nativeTheme.on('updated', () => {
  if (nativeTheme.themeSource === 'system') {
    mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0b0b0b' : '#fcfcfc');
  }
});

const { runGit, exportRevision } = require('./local-git.cjs');

function repositoryName(remoteUrl, repositoryPath) {
  const remoteName = remoteUrl && remoteUrl.replace(/\/$/, '').split('/').pop().replace(/\.git$/, '');
  return remoteName || path.basename(repositoryPath);
}

async function detectRuntimes(root) {
  return { runtimes: [{ id: 'web', label: 'UI Preview', available: true }], defaultRuntime: 'web' };
}

async function inspectRepository(repositoryPath) {
  const root = await runGit(repositoryPath, ['rev-parse', '--show-toplevel']);
  const [remoteUrl, refs] = await Promise.all([
    runGit(root, ['remote', 'get-url', 'origin']).catch(() => ''),
    inspectRepositoryRefs(runGit, root),
  ]);
  const runtimeInfo = await detectRuntimes(root);
  const platforms = await detectProjectPlatforms(root);
  return {
    path: root,
    id: root,
    name: repositoryName(remoteUrl, root),
    remoteUrl,
    ...refs,
    ...runtimeInfo,
    platforms,
  };
}

async function activeSpaceId() {
  return (await readLocalProfile(app))?.spaceId || null;
}

async function repositoryStorePath(spaceId) {
  const resolvedSpaceId = spaceId === undefined ? await activeSpaceId() : spaceId;
  return resolvedSpaceId
    ? path.join(app.getPath('userData'), 'spaces', resolvedSpaceId, 'repositories.json')
    : path.join(app.getPath('userData'), 'repositories.json');
}

async function readRepositoryRecords(spaceId) {
  try {
    const content = await fs.readFile(await repositoryStorePath(spaceId), 'utf8');
    const saved = JSON.parse(content);
    return repositoryRecords(saved);
  } catch {
    return [];
  }
}

async function readRepositoryPaths(spaceId) {
  return (await readRepositoryRecords(spaceId)).map(record => record.path);
}

async function writeRepositoryRecords(records, spaceId) {
  const file = await repositoryStorePath(spaceId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(records, null, 2), 'utf8');
}

async function saveRepositoryPath(repositoryPath, spaceId) {
  const saved = await readRepositoryRecords(spaceId);
  await writeRepositoryRecords(saveRecord(saved, repositoryPath), spaceId);
}

async function saveRepositoryOrder(repositoryPaths) {
  const saved = await readRepositoryRecords();
  await writeRepositoryRecords(reorderRecords(saved, repositoryPaths));
}

async function listRepositories() {
  const saved = await readRepositoryRecords();
  const repositories = [];
  const validRecords = [];
  for (const record of saved) {
    try {
      const repository = await inspectRepository(record.path);
      repository.previewFilesConfigured = await fs.access(await previewFileSettingsPath(record.path)).then(() => true, () => false);
      repositories.push(repository);
      validRecords.push(record);
    } catch {
      // The project was removed or is no longer a Git repository.
    }
  }
  return repositories;
}

function cleanGitError(error) {
  const message = String(error.stderr || error.message || 'The Git operation failed.').trim();
  return message.split('\n').slice(-3).join('\n');
}

function isMissingPreviewCompilerError(error) {
  const message = String(error?.message || error?.stderr || 'Preview compilation failed.').trim();
  return /installed esbuild for another platform|The package "@esbuild\/[^" ]+" could not be found/.test(message);
}

function cleanPreviewError(error) {
  const message = String(error?.message || error?.stderr || 'Preview compilation failed.').trim();
  if (isMissingPreviewCompilerError(error)) {
    return `This Acorn installation is missing the preview compiler for ${process.platform}/${process.arch}. Install it to continue. Your project is unchanged.`;
  }
  // Compiler messages put the cause first; Git's last-line summary loses it.
  return message.split('\n').filter(line => line.trim()).slice(0, 8).join('\n').slice(0, 1800);
}

function cleanLocalRepositoryError(error) {
  if (['EACCES', 'EPERM'].includes(error.code)) return 'Folder access was denied. Allow access in System Settings > Privacy & Security > Files and Folders, then choose the folder again.';
  const message = cleanGitError(error);
  return /not a git repository|could not find git root/i.test(message)
    ? 'Could not find a git root for this project'
    : message;
}

async function chooseLocalRepository({ save = true, inspect = true, defaultPath = app.getPath('desktop'), title = 'Choose a Git or SourceTree project folder', buttonLabel = 'Connect' } = {}) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    defaultPath,
    buttonLabel,
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const selectedPath = result.filePaths[0];
  // Directory enumeration happens only after the native chooser grants access.
  await fs.readdir(selectedPath, { withFileTypes: true });
  const repository = inspect
    ? await inspectRepository(selectedPath)
    : { path: await runGit(selectedPath, ['rev-parse', '--show-toplevel']), name: path.basename(selectedPath) };
  if (repository.path !== selectedPath) await fs.readdir(repository.path, { withFileTypes: true });
  if (save) await saveRepositoryPath(repository.path);
  return repository;
}

async function repositoryDiff(repositoryPath, base, target, selectedFile) {
  const [baseSha, targetSha] = await Promise.all([base, target].map((ref) => ref === '__working_tree__' ? ref : runGit(repositoryPath, ['rev-parse', `${ref}^{commit}`])));
  const { refs, baseWorking, targetWorking } = comparisonRefs(baseSha, targetSha);
  const outputDirectories = await configuredOutputDirectories(runGit, repositoryPath, [baseSha, targetSha]);
  const [statOutput, namesOutput] = await Promise.all([
    runGit(repositoryPath, ['diff', '--numstat', ...refs]),
    runGit(repositoryPath, ['diff', '--name-status', ...refs]),
  ]);
  const stats = new Map(statOutput.split('\n').filter(Boolean).map((line) => {
    const [added, deleted, file] = line.split('\t');
    return [file, { added, deleted }];
  }));
  const files = namesOutput.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    const file = rest.at(-1);
    const stat = stats.get(file) || { added: '0', deleted: '0' };
    return { status, file, ...stat };
  });
  const totals = files.reduce((sum, file) => ({ added: sum.added + Number(file.added || 0), deleted: sum.deleted + Number(file.deleted || 0) }), { added: 0, deleted: 0 });
  const file = selectedFile && files.some((item) => item.file === selectedFile) ? selectedFile : files[0]?.file;
  const detailType = file && isMediaFile(file) ? 'media' : 'text';
  const patch = file && detailType === 'text' ? await runGit(repositoryPath, ['diff', '--unified=3', ...refs, '--', file]) : '';
  const fullPatch = await runGit(repositoryPath, ['diff', '--unified=12', ...refs, '--', ...diffPathspecs(outputDirectories)]);
  return { files, totals, selectedFile: file || null, detailType, patch, hints: extractOverlayHints(fullPatch, outputDirectories), baseWorking, targetWorking, source: baseWorking || targetWorking ? 'working-tree' : 'branches' };
}

function archiveRevision(repositoryPath, ref, destination, previewFileSettings = {}, signal) {
  return exportRevision(repositoryPath, ref, destination, { excludeBuildOutputs: true, preserveExpoExport: true, previewFileSettings, signal });
}

async function previewRoot(repositoryPath, ref, onProgress = () => {}, previewFileSettings = {}, signal) {
  signal?.throwIfAborted();
  const workingTree = ref === '__working_tree__';
  const sha = await runGit(repositoryPath, ['rev-parse', `${workingTree ? 'HEAD' : ref}^{commit}`]);
  // Working-folder previews also run from a copy, never the connected directory.
  const key = `${repositoryPath}\0${sha}\0${workingTree ? Date.now() + '-' + Math.random() : 'commit'}\0${JSON.stringify(previewFileSettings)}`;
  const existing = previewSnapshots.get(key);
  if (existing) { onProgress('Reusing revision files…'); return existing; }
  const ready = (async () => {
    const temporaryRoot = typeof app !== 'undefined' && app.getPath ? app.getPath('temp') : os.tmpdir();
    const snapshotPath = await fs.mkdtemp(path.join(temporaryRoot, 'acorn-preview-'));
    try {
      signal?.throwIfAborted();
      onProgress(workingTree ? 'Copying working folder files…' : 'Extracting revision files…');
      let outputDirectories;
      if (workingTree) {
        outputDirectories = await localPreviewOutputDirectories(repositoryPath);
        const pkg = await fs.readFile(path.join(repositoryPath, 'package.json'), 'utf8').then(JSON.parse).catch(error => {
          if (error.code === 'ENOENT') return {}; throw error;
        });
        outputDirectories = resolveExclusions(expoPreviewExclusions(outputDirectories, pkg), previewFileSettings);
        await snapshotFs.cp(repositoryPath, snapshotPath, { recursive: true, filter: async source => {
          signal?.throwIfAborted();
          const relative = path.relative(repositoryPath, source);
          if (isPreviewOutput(relative, outputDirectories)) return false;
          if (relative.split(path.sep).some(part => ['.git', 'node_modules', '.next', '.cache', '.expo', '.acorn-runtime'].includes(part) || part === '.env' || part.startsWith('.env.'))) return false;
          return !(await snapshotFs.lstat(source)).isSymbolicLink();
        } });
      } else ({ outputDirectories } = await archiveRevision(repositoryPath, sha, snapshotPath, previewFileSettings, signal));
      signal?.throwIfAborted();
      onProgress('Finding preview pages…');
      const exportedRoot = await findExpoStaticPreview(snapshotPath);
      const catalog = await discoverPages(snapshotPath, { outputDirectories });
      const snapshot = { root: snapshotPath, exportedRoot, sha, workingTree, snapshotPath, catalog, outputDirectories };
      return snapshot;
    } catch (error) {
      await snapshotFs.rm(snapshotPath, { recursive: true, force: true });
      throw error;
    }
  })();
  previewSnapshots.set(key, ready);
  try { return await ready; }
  catch (error) { if (previewSnapshots.get(key) === ready) previewSnapshots.delete(key); throw error; }
}

function contentType(filePath) {
  return { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function startStaticPreviewServer(root, dependencyRoot, dependencyKey) {
  root = await fs.realpath(root);
  if (dependencyRoot) dependencyRoot = await fs.realpath(dependencyRoot);
  let serving = { root, dependencyRoot, dependencyKey };
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      const { root, dependencyRoot, dependencyKey } = serving;
      let pathname;
      try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
      catch { response.writeHead(400).end(); return; }
      const dependencyPrefix = dependencyKey ? `/_acorn_deps/${dependencyKey}/` : null;
      const servedRoot = dependencyPrefix && pathname.startsWith(dependencyPrefix) ? dependencyRoot : root;
      const relativePath = (dependencyPrefix && servedRoot === dependencyRoot ? pathname.slice(dependencyPrefix.length) : pathname.replace(/^\/+/, '')) || 'index.html';
      let filePath = path.resolve(servedRoot, relativePath);
      if (!filePath.startsWith(`${servedRoot}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      try {
        const stat = await fs.stat(filePath).catch(error => {
          if (error.code === 'ENOENT' && !path.extname(filePath)) return null;
          throw error;
        });
        if (!stat) filePath += '.html';
        else if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
        filePath = await fs.realpath(filePath);
        if (!filePath.startsWith(`${servedRoot}${path.sep}`)) { response.writeHead(403).end(); return; }
        if (['artifact.json', 'dependency.json'].includes(path.basename(filePath)) || relativePath.split('/').some(part => part.startsWith('.'))) { response.writeHead(403).end(); return; }
        const contents = await fs.readFile(filePath);
        response.writeHead(200, { 'Content-Type': contentType(filePath) }).end(contents);
      } catch {
        if (servedRoot === dependencyRoot || path.extname(pathname)) { response.writeHead(404).end(); return; }
        try {
          const contents = await fs.readFile(path.join(root, 'index.html'));
          response.writeHead(200, { 'Content-Type': 'text/html' }).end(contents);
        } catch {
          response.writeHead(404).end();
        }
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/`, update: async (next) => {
        const root = await fs.realpath(next.root);
        const dependencyRoot = next.dependencyRoot ? await fs.realpath(next.dependencyRoot) : undefined;
        serving = { root, dependencyRoot, dependencyKey: next.dependencyKey };
      } });
    });
  });
}

async function stopPreviewServer(server) {
  if (server.child) await stopRuntimeProcess(server.child);
  if (server.staticServer?.listening) {
    await new Promise((resolve, reject) => {
      server.staticServer.close((error) => error ? reject(error) : resolve());
      server.staticServer.closeAllConnections();
    });
  }
}

async function startPreviewServer(repositoryPath, ref, { reuse = false, previewFileSettings = {}, signal, revision: resolvedRevision } = {}) {
  signal?.throwIfAborted();
  if (shutdownStarted) throw new Error('Acorn is shutting down.');
  const sendProgress = message => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('preview:progress', { path: repositoryPath, ref, message });
  };
  sendProgress('Checking selected revision…');
  const workingTree = ref === '__working_tree__';
  const revision = resolvedRevision || (workingTree ? 'working-tree' : await runGit(repositoryPath, ['rev-parse', `${ref}^{commit}`]));
  signal?.throwIfAborted();
  const key = `${repositoryPath}\0${revision}\0${workingTree ? 'working-tree' : 'commit'}\0${JSON.stringify(previewFileSettings)}`;
  const existing = previewServers.get(key);
  if (existing?.ready) {
    existing.progressListeners.add(sendProgress);
    if (existing.progressMessage) sendProgress(existing.progressMessage);
    try { return await existing.ready; } finally { existing.progressListeners.delete(sendProgress); }
  }
  if ((!workingTree || reuse) && existing?.staticServer?.listening) {
    sendProgress('Reusing running preview…');
    return { ...existing.preview, url: existing.url };
  }
  const server = existing || { repositoryPath };
  server.progressListeners = new Set([sendProgress]);
  const onProgress = message => {
    server.progressMessage = message;
    for (const listener of server.progressListeners) listener(message);
  };
  const releaseSnapshot = async (preview) => {
    if (!preview?.workingTree) return;
    for (const [snapshotKey, ready] of previewSnapshots) {
      if ((await ready.catch(() => null))?.snapshotPath === preview.snapshotPath) previewSnapshots.delete(snapshotKey);
    }
    await snapshotFs.rm(preview.snapshotPath, { recursive: true, force: true });
  };
  let preview;
  server.ready = (async () => {
    preview = await previewRoot(repositoryPath, workingTree ? ref : revision, onProgress, previewFileSettings, signal);
    signal?.throwIfAborted();
    if (reloadStarted) throw new Error('Acorn is reloading.');
    let artifact;
    let previewCatalog = preview.catalog;
    try {
      artifact = await compileInWorker({ root: preview.root, outputDirectories: preview.outputDirectories, repositoryPath, cacheRoot: path.join(app.getPath('userData'), 'preview-cache'), esbuildBinaryPath: typeof managedPreviewCompilerPath === 'string' ? managedPreviewCompilerPath : undefined }, {
        onProgress, signal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (!preview.exportedRoot) throw error;
      onProgress('Opening saved web export…');
      previewCatalog = await discoverPages(preview.exportedRoot, { outputDirectories: [] });
      artifact = { root: preview.exportedRoot, cached: false, warnings: ['Automatic preview could not be built. Showing the saved Expo web export, which may differ from the source. ' + error.message] };
    }
    signal?.throwIfAborted();
    if (shutdownStarted) throw new Error('Acorn is shutting down.');
    const catalog = { ...previewCatalog, warnings: [...previewCatalog.warnings] };
    catalog.responses = artifact.responses;
    catalog.warnings.push(...artifact.warnings);
    onProgress('Starting preview server…');
    const staticPreview = { ...preview, root: artifact.root, catalog, cached: artifact.cached, cacheKey: artifact.cacheKey, dependencyCached: artifact.dependencyCached, dependencyKey: artifact.dependencyKey, uiOnly: true };
    if (server.staticServer?.listening) {
      await server.update(artifact);
      const previous = server.preview;
      server.preview = staticPreview;
      await releaseSnapshot(previous).catch(() => {});
      return { ...staticPreview, url: server.url };
    }
    const { server: staticServer, url, update } = await startStaticPreviewServer(artifact.root, artifact.dependencyRoot, artifact.dependencyKey);
    Object.assign(server, { staticServer, url, update, preview: staticPreview });
    staticServer.once('close', () => {
      if (previewServers.get(key) === server) previewServers.delete(key);
    });
    return { ...staticPreview, url };
  })();
  previewServers.set(key, server);
  try { return await server.ready; }
  catch (error) {
    if (preview !== server.preview) await releaseSnapshot(preview).catch(() => {});
    if (!server.staticServer?.listening && previewServers.get(key) === server) previewServers.delete(key);
    throw error;
  }
  finally { delete server.ready; server.progressListeners.clear(); }
}

async function stopPreviewResource(key) {
  const server = previewServers.get(key);
  if (!server) return [];
  await server.ready?.catch(() => {});
  const ui = uiPreviews.get(server.url);
  if (ui) {
    await ui.ready.catch(() => {});
    await ui.server?.close();
    uiPreviews.delete(server.url);
  }
  await stopPreviewServer(server);
  if (previewServers.get(key) === server) previewServers.delete(key);
  return server.url ? [{ repositoryPath: server.repositoryPath, url: server.url, runtime: 'web' }] : [];
}

async function stopVisualPreviewResource(key) {
  const item = uiPreviews.get(key);
  if (!item) return [];
  await item.ready?.catch(() => {});
  await item.server?.close();
  if (item.visual && typeof previewNetworkPolicy !== 'undefined') await previewNetworkPolicy?.release(item.server?.url, item.scope);
  uiPreviews.delete(key);
  return [];
}

async function stopPreviewServers() {
  const visualRetiring = visualPreviewLifecycle.stopAll();
  const retiring = previewLifecycle.stopAll();
  cancelBuilds();
  await Promise.all([visualRetiring, retiring]);
  await Promise.allSettled([...previewServers.values()].map(server => server.ready));
  await Promise.allSettled([...uiPreviews.values()].map(item => item.ready));
  await Promise.all([...uiPreviews.values()].map(item => item.server?.close()));
  uiPreviews.clear();
  await Promise.all([...previewServers.values()].map(stopPreviewServer));
  previewServers.clear();
  const removals = [...previewSnapshots.values()].map(async (ready) => {
    const snapshot = await ready.catch(() => null);
    if (snapshot) await snapshotFs.rm(snapshot.snapshotPath, { recursive: true, force: true });
  });
  previewSnapshots.clear();
  await Promise.all(removals);
}

for (const action of ['read', 'write']) {
  ipcMain.on(`comparisons:${action}`, (event, payload) => {
    try {
      if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Unauthorized request.');
      if (removedRepositories.has(payload?.path)) throw new Error('Repository is no longer connected.');
      const store = comparisonStore(app.getPath('userData'));
      const comparisons = store[action](payload?.path, payload?.comparisons);
      event.returnValue = { success: true, comparisons };
    } catch (error) { event.returnValue = { error: error.message }; }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 980,
    minWidth: 1040,
    minHeight: 720,
    title: 'Acorn',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0b0b' : '#fcfcfc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Comparisons and preferences in localStorage must survive a full app restart.
      partition: 'persist:acorn-workspace',
    },
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  previewNetworkPolicy = createPreviewNetworkPolicy(mainWindow.webContents.session);
  mainWindow.webContents.session.on('will-download', event => event.preventDefault());
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  attachUiNavigationGuard(mainWindow.webContents, () => [...uiPreviews.values()].filter(item => item.server));
  attachPreviewSync(mainWindow.webContents);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!(input.meta || input.control) || input.alt || input.key.toLowerCase() !== 'r') return;
    event.preventDefault();
    if (input.type === 'keyDown' && !input.isAutoRepeat) {
      mainWindow.webContents.send('app:refresh', { full: input.shift });
    }
  });
  mainWindow.loadFile(app.acornRendererPath || path.join(__dirname, '../renderer/index.html'));
}

ipcMain.handle('preview:open-external', async (event, payload) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { error: 'Unauthorized request.' };
  try {
    if (typeof payload?.url !== 'string' || payload.url.length > 2048) throw new Error('Invalid external link.');
    const url = new URL(payload.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported external link.');
    await shell.openExternal(url.href);
    return { success: true };
  } catch (error) { return { error: error.message }; }
});

ipcMain.handle('repositories:open-location', async (event, payload) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { error: 'Unauthorized request.' };
  try {
    if (!(await readRepositoryPaths()).includes(payload?.path)) return { error: 'Project is not connected.' };
    if (payload.destination === 'directory') {
      const error = await shell.openPath(payload.path);
      return error ? { error } : { success: true };
    }
    if (payload.destination === 'github') {
      const remote = await runGit(payload.path, ['remote', 'get-url', 'origin']);
      const repository = githubRepository(remote);
      if (!repository) return { error: 'No GitHub remote connected.' };
      await shell.openExternal(repository.url);
      return { success: true };
    }
    return { error: 'Unknown project location.' };
  } catch (error) { return { error: cleanGitError(error) }; }
});

ipcMain.handle('repositories:list', () => listRepositories());
ipcMain.handle('repositories:refresh-refs', async (event, payload) => {
  try {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Unauthorized request.');
    if (!(await readRepositoryPaths()).includes(payload?.path)) throw new Error('Repository is not connected.');
    return await inspectRepositoryRefs(runGit, payload.path);
  } catch (error) { return { error: cleanGitError(error) }; }
});
ipcMain.handle('repositories:remove', async (event, payload) => {
  try {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Unauthorized request.');
    const repositoryPath = typeof payload === 'string' ? payload : payload?.path;
    const requestedIds = typeof payload === 'string' ? [] : payload?.comparisonIds;
    if (typeof repositoryPath !== 'string' || !repositoryPath) throw new Error('Repository path is required.');
    if (requestedIds !== undefined && (!Array.isArray(requestedIds) || requestedIds.length > 1000
      || requestedIds.some(id => typeof id !== 'string' || !id))) throw new Error('Invalid repository comparisons.');
    if (removingRepositories.has(repositoryPath)) throw new Error('Repository removal is already in progress.');
    removingRepositories.add(repositoryPath);
    let removed = false;
    removedRepositories.add(repositoryPath);
    try {
      const spaceId = await activeSpaceId();
      const records = await readRepositoryRecords(spaceId);
      const store = comparisonStore(app.getPath('userData'));
      let stored = [];
      try { stored = store.read(repositoryPath) || []; } catch { /* Corrupt state must not prevent removal. */ }
      const ownerIds = [...new Set([...(requestedIds || []), ...stored.map(item => item.id)])]
        .map(comparisonId => JSON.stringify([repositoryPath, comparisonId]));
      await Promise.all(ownerIds.flatMap(id => [previewLifecycle.release(id), visualPreviewLifecycle.release(id)]));
      await Promise.all([...previewServers]
        .filter(([, server]) => server.repositoryPath === repositoryPath)
        .map(([key]) => previewLifecycle.stopResource(key)));
      const snapshots = [...previewSnapshots].filter(([key]) => key.startsWith(repositoryPath + '\0'));
      for (const [key] of snapshots) previewSnapshots.delete(key);
      await Promise.all(snapshots.map(async ([, ready]) => {
        const snapshot = await ready.catch(() => null);
        if (snapshot) await snapshotFs.rm(snapshot.snapshotPath, { recursive: true, force: true });
      }));
      pendingPreviewConnections.delete(repositoryPath);
      previewData.remove(repositoryPath);
      await fs.rm(await previewFileSettingsPath(repositoryPath), { force: true });
      store.remove(repositoryPath);
      await writeRepositoryRecords(records.filter(record => record.path !== repositoryPath), spaceId);
      await Promise.all(ownerIds.flatMap(id => [previewLifecycle.forget(id), visualPreviewLifecycle.forget(id)]));
      removed = true;
      return { success: true };
    } finally {
      removingRepositories.delete(repositoryPath);
      if (!removed) removedRepositories.delete(repositoryPath);
    }
  } catch (error) {
    return { error: cleanGitError(error) };
  }
});
ipcMain.handle('repositories:reorder', async (_, repositoryPaths) => {
  try {
    await saveRepositoryOrder(repositoryPaths);
    return { success: true };
  } catch (error) {
    return { error: cleanGitError(error) };
  }
});
const pendingPreviewConnections = new Map();
ipcMain.handle('repositories:choose-local', async (event, payload) => {
  try {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Unauthorized request.');
    const droppedPath = payload?.path;
    if (droppedPath !== undefined && (typeof droppedPath !== 'string' || !path.isAbsolute(droppedPath))) throw new Error('Choose a local folder.');
    // A drop only suggests the dialog location. Read Git files after the user
    // approves the native folder chooser.
    const repository = await chooseLocalRepository({ save: false, inspect: false, ...(droppedPath ? { defaultPath: droppedPath } : {}) });
    if (repository) pendingPreviewConnections.set(repository.path, repository);
    return { repository };
  }
  catch (error) { return { error: cleanLocalRepositoryError(error) }; }
});
async function previewFileSettingsPath(repositoryPath) {
  const key = require('node:crypto').createHash('sha256').update(repositoryPath).digest('hex');
  return path.join(path.dirname(await repositoryStorePath()), 'preview-files', key + '.json');
}
async function readPreviewFileSettings(repositoryPath) {
  try { return normalizeSettings(JSON.parse(await fs.readFile(await previewFileSettingsPath(repositoryPath), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { overrides: {} }; throw error; }
}
for (const action of ['scan', 'save', 'cancel']) {
  ipcMain.handle(`preview:files:${action}`, async (event, payload) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { error: 'Unauthorized request.' };
    try {
      const repositoryPath = payload?.path;
      if (!pendingPreviewConnections.has(repositoryPath) && !(await readRepositoryPaths()).includes(repositoryPath)) throw new Error('Repository is not connected.');
      if (action === 'cancel') { pendingPreviewConnections.delete(repositoryPath); return { success: true }; }
      if (action === 'scan') {
        const connecting = pendingPreviewConnections.has(repositoryPath);
        const report = progress => {
          if (!event.sender.isDestroyed()) event.sender.send('preview:files:progress', { ...progress, max: connecting ? 5 : 4, path: repositoryPath, requestId: payload.requestId });
        };
        let repository;
        if (connecting) {
          report({ value: 0, message: 'Checking Git history and project information…' });
          repository = await inspectRepository(repositoryPath);
          if (!pendingPreviewConnections.has(repositoryPath)) return { error: 'Connection cancelled.' };
          pendingPreviewConnections.set(repositoryPath, repository);
        }
        const scan = await scanPreviewFolders(repositoryPath, await readPreviewFileSettings(repositoryPath), progress => report({ ...progress, value: progress.value + (connecting ? 1 : 0) }));
        return { ...scan, repository };
      }
      const settings = normalizeSettings(payload.settings);
      // Validate parent/child consistency against the current recommendations.
      const scan = await scanPreviewFolders(repositoryPath, settings);
      resolveExclusions(scan.automatic, settings);
      const file = await previewFileSettingsPath(repositoryPath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = file + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(settings));
      await fs.rename(temporary, file);
      const repository = pendingPreviewConnections.get(repositoryPath);
      if (repository) {
        const wasConnected = (await readRepositoryPaths()).includes(repositoryPath);
        if (!wasConnected) {
          comparisonStore(app.getPath('userData')).remove(repositoryPath);
          previewData.remove(repositoryPath);
        }
        await saveRepositoryPath(repositoryPath);
        pendingPreviewConnections.delete(repositoryPath);
        removedRepositories.delete(repositoryPath);
      }
      return { success: true, repository };
    } catch (error) { return { error: cleanPreviewError(error) }; }
  });
}
ipcMain.handle('local-profile:status', async (event) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { error: 'Unauthorized request.' };
  try { return { profile: await readLocalProfile(app) }; }
  catch { return { error: 'Could not load the local profile.' }; }
});
ipcMain.handle('local-profile:choose-repository', async (event) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { error: 'Unauthorized request.' };
  try {
    const repository = await chooseLocalRepository({ save: false, title: 'Select a local project', buttonLabel: 'Select' });
    return repository ? { repository } : { cancelled: true };
  } catch (error) { return { error: cleanLocalRepositoryError(error) }; }
});
ipcMain.handle('local-profile:continue', async (event, payload) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { error: 'Unauthorized request.' };
  try {
    const name = normalizeLocalProfileName(payload?.name);
    if (typeof payload?.repositoryPath !== 'string' || !payload.repositoryPath) throw new Error('Select a project to continue.');
    const repository = await inspectRepository(payload.repositoryPath);
    const profile = await createLocalProfile(app, name);
    await saveRepositoryPath(repository.path, profile.spaceId);
    return { profile, repository };
  } catch (error) { return { error: cleanLocalRepositoryError(error) }; }
});
ipcMain.handle('repositories:commits', async (_, payload) => {
  try { return await getCommitPage(runGit, payload.path, { anchor: payload.anchor, offset: payload.offset }); }
  catch (error) { return { error: cleanGitError(error) }; }
});
ipcMain.handle('repositories:commit-summaries', async (event, payload) => {
  try {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Unauthorized request.');
    if (!(await readRepositoryPaths()).includes(payload?.path)) throw new Error('Repository is not connected.');
    return { commits: await getCommitSummaries(runGit, payload.path, payload.refs) };
  } catch (error) { return { error: cleanGitError(error) }; }
});
ipcMain.handle('repositories:diff', async (_, payload) => {
  try { return { diff: await repositoryDiff(payload.path, payload.base, payload.target, payload.file) }; }
  catch (error) { return { error: cleanGitError(error) }; }
});
ipcMain.handle('repositories:resolve-refs', async (event, payload) => {
  try {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Unauthorized request.');
    if (!(await readRepositoryPaths()).includes(payload?.path)) throw new Error('Repository is not connected.');
    if (!Array.isArray(payload.refs) || payload.refs.some(ref => typeof ref !== 'string' || !ref)) throw new Error('Invalid comparison refs.');
    const refs = Object.fromEntries(await Promise.all([...new Set(payload.refs)].map(async ref => [ref,
      ref === '__working_tree__' ? ref : await runGit(payload.path, ['rev-parse', `${ref}^{commit}`]),
    ])));
    return { refs };
  } catch (error) { return { error: cleanGitError(error) }; }
});
ipcMain.handle('preview:list', () => {
  const webServers = [...previewServers.values()]
    .filter((server) => server.url && (server.staticServer?.listening || (server.child && server.child.exitCode === null && server.child.signalCode === null && !server.child.killed)))
    .map((server) => ({ repositoryPath: server.repositoryPath, sha: server.preview.sha, workingTree: server.preview.workingTree, url: server.url, runtime: 'web' }));
  const servers = webServers
    .map((server) => ({ ...server, projectName: path.basename(server.repositoryPath) }))
    .sort((a, b) => a.repositoryPath.localeCompare(b.repositoryPath) || a.url.localeCompare(b.url));
  return { servers };
});
ipcMain.handle('preview:release-comparison', async (event, payload) => {
  try {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Unauthorized request.');
    if (typeof payload?.path !== 'string' || typeof payload.comparisonId !== 'string' || !payload.comparisonId) throw new Error('Invalid comparison.');
    const ownerId = JSON.stringify([payload.path, payload.comparisonId]);
    const [stopped] = await Promise.all([previewLifecycle.release(ownerId), visualPreviewLifecycle.release(ownerId)]);
    return { success: true, stopped };
  } catch (error) { return { error: cleanPreviewError(error) }; }
});
ipcMain.handle('preview:stop', async (_, payload) => {
  try {
    if (!payload || typeof payload.url !== 'string' || typeof payload.repositoryPath !== 'string') throw new Error('Invalid server selection.');
    if (payload.runtime === 'web') {
      const entry = [...previewServers].find(([, server]) => server.repositoryPath === payload.repositoryPath && server.url === payload.url);
      if (entry) {
        await previewLifecycle.stopResource(entry[0]);
      }
    } else throw new Error('Unknown preview runtime.');
    const matches = [...uiPreviews].filter(([, item]) => item.upstreamUrl === payload.url || item.server?.url === payload.url);
    await Promise.all(matches.map(([key]) => stopVisualPreviewResource(key)));
    return { success: true };
  } catch (error) { return { error: cleanGitError(error) }; }
});
async function withUiPreview(preview, { visual = false, scope = 'shared' } = {}) {
  const uiKey = visual ? `${preview.url}\0visual\0${scope}` : preview.url;
  let item = uiPreviews.get(uiKey);
  const baseUrl = new URL(preview.url);
  const catalog = { ...preview.catalog, visual, dataBridge: !visual, pages: preview.catalog.pages.map(page => {
    if (preview.catalog.source === 'manifest' || baseUrl.pathname === '/' || page.previewPath) return page;
    return { ...page, previewPath: new URL(page.path.replace(/^\//, ''), baseUrl).pathname };
  }) };
  if (!item) {
    item = { server: null, catalog, ready: null, upstreamUrl: preview.url, visual, scope };
    uiPreviews.set(uiKey, item);
    const pending = item;
    item.ready = startUiPreview(preview.url, catalog).then(server => {
      pending.server = server;
      if (visual && typeof previewNetworkPolicy !== 'undefined') previewNetworkPolicy?.register(server.url, scope);
    }).catch(error => {
      if (uiPreviews.get(uiKey) === pending) uiPreviews.delete(uiKey);
      throw error;
    });
    // Discovery is not a render guarantee. Do not delay the first frame by
    // loading every candidate in separate hidden browser windows.
    item.catalog = { ...catalog, validation: 'on-demand' };
  }
  await item.ready;
  item.catalog = { ...catalog, validation: 'on-demand' };
  item.server.updateCatalog(item.catalog);
  return { ...preview, upstreamUrl: preview.url, url: item.server.url, catalog: item.catalog, uiOnly: true, visual };
}

for (const action of ['status', 'allow', 'refresh', 'get']) {
  ipcMain.handle(`preview:data:${action}`, async (event, payload) => {
    try {
      if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Unauthorized request.');
      if (!(await readRepositoryPaths()).includes(payload?.path)) throw new Error('Repository is not connected.');
      if (action === 'get') return await previewData.get(payload.path, payload.url, payload.method);
      if (action === 'allow') return previewData.allow(payload.path, payload.origins, payload.automatic);
      return previewData[action](payload.path);
    } catch (error) { return { error: error.message }; }
  });
}

ipcMain.handle('app:reload', async event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { error: 'Unauthorized request.' };
  if (reloadStarted) return;
  reloadStarted = true;
  try {
    cancelBuilds();
    await Promise.allSettled([...previewRequests]);
    await stopPreviewServers();
    mainWindow.webContents.reload();
    return { success: true };
  } catch (error) { return { error: error.message }; }
  finally { reloadStarted = false; }
});

ipcMain.handle('preview:start', (event, payload) => {
  if (reloadStarted) return { error: 'Acorn is reloading.' };
  const request = handlePreviewStart(event, payload);
  previewRequests.add(request);
  request.finally(() => previewRequests.delete(request));
  return request;
});

let previewCompilerInstallation;
ipcMain.handle('preview:compiler:install', async event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { error: 'Unauthorized request.' };
  try {
    previewCompilerInstallation ||= installPreviewCompiler(app.getPath('userData')).finally(() => { previewCompilerInstallation = null; });
    const compiler = await previewCompilerInstallation;
    managedPreviewCompilerPath = compiler.path;
    return { compiler: { version: compiler.version, platform: compiler.platform, arch: compiler.arch, cached: compiler.cached } };
  } catch (error) {
    return { error: String(error?.message || 'The preview compiler could not be installed.') };
  }
});

async function handlePreviewStart(event, payload) {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { error: 'Unauthorized request.' };
  const report = (ref, message) => {
    if (!event.sender.isDestroyed()) event.sender.send('preview:progress', { path: payload?.path, ref, message });
  };
  try {
    const ownerId = JSON.stringify([payload?.path, payload?.comparisonId || '__manual__']);
    if (payload?.visual !== undefined && typeof payload.visual !== 'boolean') throw new Error('Invalid visual preview mode.');
    if (payload?.side !== undefined && !['base', 'target'].includes(payload.side)) throw new Error('Invalid preview side.');
    return await previewLifecycle.request(ownerId, async owner => {
      for (const ref of new Set([payload?.base, payload?.target])) report(ref, 'Checking repository connection…');
      if (removingRepositories.has(payload?.path)) throw new Error('Repository is being removed.');
      if (!(await readRepositoryPaths()).includes(payload?.path)) throw new Error('Repository is not connected.');
      owner.check();
      const previewFileSettings = await readPreviewFileSettings(payload.path);
      const prepare = async ref => {
        const workingTree = ref === '__working_tree__';
        const revision = workingTree ? 'working-tree' : await runGit(payload.path, ['rev-parse', `${ref}^{commit}`]);
        owner.check();
        const key = `${payload.path}\0${revision}\0${workingTree ? 'working-tree' : 'commit'}\0${JSON.stringify(previewFileSettings)}`;
        return owner.use(key, async signal => {
          const preview = await startPreviewServer(payload.path, ref, { reuse: payload.reuse === true, previewFileSettings, signal, revision });
          signal.throwIfAborted();
          report(ref, 'Connecting preview to the viewer…');
          const visual = payload.visual === true;
          const scope = JSON.stringify([payload.path, payload.comparisonId || '__manual__', payload.side || 'base', revision]);
          const result = visual
            ? await visualPreviewLifecycle.request(ownerId, visualOwner => visualOwner.use(`${preview.url}\0visual\0${scope}`, () => withUiPreview(preview, { visual: true, scope })))
            : await withUiPreview(preview);
          signal.throwIfAborted();
          return result;
        });
      };
      if (payload.base === payload.target) {
        const preview = await prepare(payload.base);
        return { previews: { base: preview, target: preview } };
      }
      const results = await Promise.allSettled([prepare(payload.base), prepare(payload.target)]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      return { previews: { base: results[0].value, target: results[1].value } };
    });
  } catch (error) {
    if (!/cancelled/i.test(error.message)) { mainWindow?.show(); mainWindow?.focus(); }
    return { error: cleanPreviewError(error), code: error.code || (isMissingPreviewCompilerError(error) ? 'PREVIEW_COMPILER_MISSING' : undefined) };
  }
}
app.whenReady().then(async () => {
  managedPreviewCompilerPath = await verifiedCompiler(app.getPath('userData')).catch(() => null);
  installRefreshMenu(Menu, () => mainWindow);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  event.preventDefault();
  stopPreviewServers().finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

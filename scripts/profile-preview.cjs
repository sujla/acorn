// Development-only profiler: read-only repository; all snapshots/cache go to a temp folder.
// node_modules/.bin/electron scripts/profile-preview.cjs /absolute/repository
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const { runGit, exportRevision } = require('../src/main/local-git.cjs');
const { discoverPages } = require('../src/main/preview-pages.cjs');
const esbuild = require('esbuild');
let stages, last;
const mark = name => { const now = performance.now(); stages[name] = +(now - last).toFixed(1); last = now; };
const compilerFile = path.resolve(__dirname, '../src/main/preview-compiler.cjs');
const measure = async (name, work) => { const start = performance.now(); const result = await work(); console.log(JSON.stringify({ stage: name, ms: +(performance.now() - start).toFixed(1) })); return result; };
app.whenReady().then(async () => {
  let temporary;
  try {
    const repositoryPath = process.argv[2];
    if (!repositoryPath) throw new Error('An absolute repository path is required.');
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-profile-'));
    const source = (await fs.readFile(compilerFile, 'utf8'))
      .replace("const esbuild = require('esbuild');", "const esbuild = require('esbuild'); const mark = global.__acornProfileMark;")
      .replace('  const recipe = await json(', "  mark('scan-and-hash');\n  const recipe = await json(")
      .replace('  const inputs = {};', "  mark('cache-lookup');\n  const inputs = {};")
      .replace('    for (const file of sourceFiles) {', "    mark('dependency-validation');\n    for (const file of sourceFiles) {")
      .replace('    let htmlFiles =', "    mark('copy-files');\n    let htmlFiles =")
      .replace('    const dependencySpecifiers =', "    mark('entry-discovery');\n    const dependencySpecifiers =")
      .replace('    let dependency = null;', "    mark('compile-source-pages');\n    let dependency = null;")
      .replace('    for (const { htmlFile, html } of compiledHtml)', "    mark('bundle-dependencies');\n    for (const { htmlFile, html } of compiledHtml)")
      .replaceAll('return { root: destination,', "mark('finalize-or-cache-hit'); return { root: destination,");
    global.__acornProfileMark = mark;
    const compiledModule = new Module(compilerFile, module);
    compiledModule.filename = compilerFile;
    compiledModule.paths = module.paths;
    compiledModule._compile(source, compilerFile);
    const compiler = compiledModule.exports;
    const sha = await measure('resolve-HEAD', () => runGit(repositoryPath, ['rev-parse', 'HEAD']));
    const snapshot = path.join(temporary, 'snapshot'); await fs.mkdir(snapshot);
    await measure('export-HEAD', () => exportRevision(repositoryPath, sha, snapshot, { excludeBuildOutputs: true }));
    const sourceFiles = await compiler.files(snapshot);
    const groups = {};
    for (const file of sourceFiles) {
      const group = path.relative(snapshot, file).split(path.sep)[0];
      groups[group] ||= { files: 0, bytes: 0 };
      groups[group].files++; groups[group].bytes += (await fs.stat(file)).size;
    }
    console.log(JSON.stringify({ inventory: groups, sha, arch: process.arch, electron: process.versions.electron }));
    await measure('page-discovery', () => discoverPages(snapshot));
    const options = { root: snapshot, repositoryPath, cacheRoot: path.join(temporary, 'cache') };
    for (const mode of ['cold', 'warm-1', 'warm-2']) {
      stages = {}; last = performance.now();
      const artifact = await measure('compile-' + mode, () => compiler.compilePreview(options));
      console.log(JSON.stringify({ mode, stages, cached: artifact.cached, dependencyCached: artifact.dependencyCached }));
    }
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { esbuild.stop(); if (temporary) await fs.rm(temporary, { recursive: true, force: true }); app.exit(process.exitCode || 0); }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const { scanPreviewFolders, normalizeSettings, resolveExclusions } = require('../src/main/preview-file-settings.cjs');
const { exportRevision } = require('../src/main/local-git.cjs');
const { compilePreview } = require('../src/main/preview-compiler.cjs');

test('folder picker unchecks a parent only when all displayed descendants are unchecked', async () => {
  const source = await fs.readFile(new URL('../src/renderer/preview-file-picker.js', `file://${__filename}`), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('  const effective ='), source.indexOf('  function render()')), context);
  vm.runInContext(`
    const partial = {
      folders: [{ path: 'android' }, { path: 'android/app/build' }, { path: 'android/.gradle' }],
      automatic: [],
      overrides: { 'android/app/build': false },
    };
    uncheckAllEmptyAncestors(partial);
    const empty = {
      folders: [{ path: 'android' }, { path: 'android/app/build' }, { path: 'android/.gradle' }],
      automatic: [],
      overrides: { 'android/app/build': false, 'android/.gradle': false },
    };
    uncheckAllEmptyAncestors(empty);
    globalThis.result = {
      partialParent: effective('android', partial),
      emptyParent: effective('android', empty),
    };
  `, context);
  assert.deepEqual({ ...context.result }, { partialParent: true, emptyParent: false });
});

test('folder picker preserves unchecked siblings when one child is selected', async () => {
  const source = await fs.readFile(new URL('../src/renderer/preview-file-picker.js', `file://${__filename}`), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('  const effective ='), source.indexOf('  function render()')), context);
  vm.runInContext(`
    const state = {
      folders: [{ path: 'android' }, { path: 'android/app/build' }, { path: 'android/.gradle' }],
      automatic: [],
      overrides: { android: false, 'android/app/build': true },
    };
    checkAncestorsPreservingUncheckedDescendants('android/app/build', state);
    globalThis.result = {
      parent: effective('android', state),
      selectedChild: effective('android/app/build', state),
      sibling: effective('android/.gradle', state),
    };
  `, context);
  assert.deepEqual({ ...context.result }, { parent: true, selectedChild: true, sibling: false });
});

test('folder picker counts leaf folders instead of parent rows', async () => {
  const source = await fs.readFile(new URL('../src/renderer/preview-file-picker.js', `file://${__filename}`), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('  const effective ='), source.indexOf('  function render()')), context);
  vm.runInContext(`
    const state = {
      folders: [{ path: 'android' }, { path: 'android/app/build' }, { path: 'android/.gradle' }, { path: 'src' }],
      automatic: [],
      overrides: { android: true, 'android/app/build': true, 'android/.gradle': false, src: true },
    };
    const folders = countableFolders(state);
    globalThis.result = {
      paths: folders.map(folder => folder.path),
      selected: folders.filter(folder => effective(folder.path, state)).length,
      total: folders.length,
    };
  `, context);
  assert.deepEqual([...context.result.paths], ['android/app/build', 'android/.gradle', 'src']);
  assert.deepEqual({ selected: context.result.selected, total: context.result.total }, { selected: 2, total: 3 });
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-preview-folders-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  const write = async (name, content = 'fixture') => { const file = path.join(repo, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  return { root, repo, write };
}
test('scan excludes folders without a known entry and selects newly detected entries', async t => {
  const { repo, write } = await fixture(t);
  for (const folder of ['src', 'assets', 'qa', 'android/app/build', 'ios/Pods', 'docs', 'node_modules', '.git']) await write(folder + '/file');
  await write('vite.config.js', 'export default {build:{outDir:"docs"}}');
  const progress = [];
  const scan = await scanPreviewFolders(repo, {}, value => progress.push(value.value));
  const selected = Object.fromEntries(scan.folders.map(item => [item.path, item.included]));
  assert.deepEqual(progress, [0, 1, 2, 3, 4]);
  assert.equal(selected['android/app/build'], false); assert.equal(selected['ios/Pods'], false); assert.equal(selected.docs, false);
  assert.equal(selected.src, false); assert.equal(selected.assets, false); assert.equal(selected.qa, false);
  assert.match(scan.warnings.join(' '), /No supported preview entry/);
  assert.equal(selected.node_modules, undefined); assert.equal(selected['.git'], undefined);
  await write('new-source/index.html');
  assert.equal((await scanPreviewFolders(repo)).folders.find(item => item.path === 'new-source').included, true);
});
test('settings reject unsafe paths and unreachable child selections', () => {
  for (const name of ['../secret', '/tmp', 'a/../b', 'node_modules', 'a/.env', 'a\\b']) assert.throws(() => normalizeSettings({ overrides: { [name]: false } }));
  assert.throws(() => resolveExclusions(['dist'], { overrides: { 'dist/assets': true } }), /parent/);
  assert.ok(!resolveExclusions(['dist'], { overrides: { dist: true } }).includes('dist'));
  assert.ok(resolveExclusions([], { overrides: { qa: false } }).includes('qa'));
});
test('scan does not follow directory symlinks and keeps saved missing folders editable', async t => {
  const { root, repo } = await fixture(t);
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(repo, 'android'));
  const scan = await scanPreviewFolders(repo, { overrides: { 'old-assets': false } });
  assert.ok(!scan.folders.some(item => item.path.startsWith('android')));
  assert.equal(scan.folders.find(item => item.path === 'old-assets').included, false);
});
test('historical recommendations use each revision and explicit inclusion reaches compiled output', async t => {
  const { root, repo, write } = await fixture(t);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const commit = () => { git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@test.test', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  git('init', '-q');
  await write('index.html', '<h1>Home</h1>'); await write('docs/index.html', '<h1>Docs</h1>'); await write('qa/report.html', '<h1>Report</h1>');
  await write('ios/Pods/binary', 'native'); await write('vite.config.js', 'export default {build:{outDir:"docs"}}');
  const old = commit(); await write('vite.config.js', 'export default {build:{outDir:"dist"}}'); const recent = commit();
  for (const [ref, includeDocs] of [[old, false], [recent, true]]) {
    const destination = path.join(root, ref); await fs.mkdir(destination);
    await exportRevision(repo, ref, destination, { excludeBuildOutputs: true, previewFileSettings: { overrides: { qa: false } } });
    assert.equal(await fs.access(path.join(destination, 'docs/index.html')).then(() => true, () => false), includeDocs);
    for (const excluded of ['qa', 'ios/Pods']) await assert.rejects(fs.access(path.join(destination, excluded)), { code: 'ENOENT' });
  }
  const destination = path.join(root, 'selected'); await fs.mkdir(destination);
  const { outputDirectories } = await exportRevision(repo, old, destination, { excludeBuildOutputs: true, previewFileSettings: { overrides: { docs: true, qa: false } } });
  const artifact = await compilePreview({ root: destination, repositoryPath: repo, outputDirectories, cacheRoot: path.join(root, 'cache') });
  assert.match(await fs.readFile(path.join(artifact.root, 'docs/index.html'), 'utf8'), /Docs/);
  assert.equal(git('status', '--porcelain'), '');
});

test('static preview follows HTML, inline JS, CSS, and computed media but excludes tooling', async t => {
  const { root, repo, write } = await fixture(t);
  await write('index.html', '<link href="styles.css"><script>const theme="dark";</script><script src="main.js"></script><img src=assets/logo.svg>');
  await write('styles.css', '@import "theme/colors.css"; body { background: url(assets/bg.svg) }');
  await write('theme/colors.css', '@font-face { src: url(../fonts/site.woff2) }');
  await write('fonts/site.woff2', 'font');
  await write('main.js', 'const name="intro"; const video = `media/${name}.mp4`;');
  for (const file of ['assets/logo.svg', 'assets/bg.svg', 'media/intro.mp4', 'demo/index.html', 'qa/report.html', 'scripts/build.js', 'tests/site.js']) await write(file, file.endsWith('.html') ? '<h1>Tool</h1>' : '');
  const scan = await scanPreviewFolders(repo);
  assert.deepEqual(scan.warnings, []);
  assert.deepEqual(scan.folders.filter(f => f.recommended).map(f => f.path), ['assets', 'fonts', 'media', 'theme']);
  assert.equal(scan.folders.find(f => f.path === 'qa').included, false);
  // Exercise the same effective selection that the UI persists, then compile it.
  const settings = { overrides: Object.fromEntries(scan.folders.map(f => [f.path, f.included])) };
  const excluded = resolveExclusions([], settings);
  const snapshot = path.join(root, 'snapshot');
  await fs.cp(repo, snapshot, { recursive: true, filter: file => !excluded.some(dir => path.relative(repo, file) === dir || path.relative(repo, file).startsWith(dir + '/')) });
  const artifact = await compilePreview({ root: snapshot, repositoryPath: repo, cacheRoot: path.join(root, 'cache'), outputDirectories: excluded });
  assert.match(await fs.readFile(path.join(artifact.root, 'index.html'), 'utf8'), /main.js/);
  await fs.access(path.join(artifact.root, 'media/intro.mp4'));
  await assert.rejects(fs.access(path.join(artifact.root, 'demo')), { code: 'ENOENT' });
});

test('module graph follows reexports, alias paths, CSS assets and lazy imports', async t => {
  const { repo, write } = await fixture(t);
  await write('index.html', '<script type="module" src="/src/main.ts"></script>');
  await write('tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@shared/*":["shared/*"]}}}');
  await write('src/main.ts', 'import { value } from "@shared/value"; import("../lazy/screen"); import "../styles/main.css";');
  await write('shared/value.ts', 'export { value } from "../data/value";');
  await write('data/value.ts', 'export const value = 1;');
  await write('lazy/screen.ts', 'export default 1;');
  await write('styles/main.css', 'body { background: url("../images/bg.svg") }');
  await write('images/bg.svg', '<svg/>');
  await write('tests/main.ts', 'throw new Error("not a preview entry");');
  const scan = await scanPreviewFolders(repo);
  assert.deepEqual(scan.warnings, []);
  assert.deepEqual(scan.folders.filter(f => f.recommended).map(f => f.path), ['data', 'images', 'lazy', 'shared', 'src', 'styles']);
});

test('framework route roots and public assets include dependencies without root HTML', async t => {
  const { repo, write } = await fixture(t);
  await write('package.json', JSON.stringify({ dependencies: { next: '1' } }));
  await write('app/page.tsx', 'import "../components/card"; export default () => null;');
  await write('app/settings/page.tsx', 'import "../../models/settings";');
  await write('components/card.tsx', 'export default () => null;');
  await write('models/settings.ts', 'export const settings = {};');
  await write('public/logo.svg', '<svg/>');
  await write('qa/screenshot.png');
  const scan = await scanPreviewFolders(repo);
  assert.deepEqual(scan.warnings, []);
  assert.deepEqual(scan.folders.filter(f => f.recommended).map(f => f.path), ['app', 'components', 'models', 'public']);
});

test('glob and context references retain their directories and transitive imports', async t => {
  const { repo, write } = await fixture(t);
  await write('index.html', '<script type="module" src="main.js"></script>');
  await write('main.js', 'import.meta.glob("./screens/*.js"); require.context("./messages", true);');
  await write('screens/home.js', 'import "../shared/util.js";');
  await write('messages/en.json', '{}');
  await write('shared/util.js', 'export const a=1;');
  await write('tests/not-used.js', '');
  const scan = await scanPreviewFolders(repo);
  assert.deepEqual(scan.warnings, []);
  assert.deepEqual(scan.folders.filter(f => f.recommended).map(f => f.path), ['messages', 'screens', 'shared']);
});

test('uncertain imports keep confirmed dependencies only; manual selections still win', async t => {
  const { repo, write } = await fixture(t);
  await write('index.html', '<script type="module" src="src/main.js"></script>');
  await write('src/main.js', 'import(window.modulePath);');
  await write('screens/home.js', 'export default 1;');
  await write('qa/report.html', '<h1>Report</h1>');
  await write('release/local/Acorn.app/Contents/Resources/default_app.asar', 'binary');
  const scan = await scanPreviewFolders(repo, { overrides: { qa: false } });
  assert.match(scan.warnings.join(' '), /Computed module/);
  const screen = scan.folders.find(f => f.path === 'screens');
  assert.equal(screen.included, false);
  assert.equal(screen.recommended, false);
  assert.match(screen.reason, /incomplete/);
  assert.equal(scan.folders.find(f => f.path === 'qa').included, false);
  assert.equal(scan.folders.find(f => f.path === 'src').included, true);
  assert.equal(scan.folders.find(f => f.path === 'release').included, false);
  assert.ok(scan.automatic.includes('release'));
  const manual = await scanPreviewFolders(repo, { overrides: { screens: true, src: false } });
  assert.equal(manual.folders.find(f => f.path === 'screens').included, true);
  assert.equal(manual.folders.find(f => f.path === 'src').included, false);
  // Persist the effective UI selection and verify it excludes packaged apps.
  const saved = { overrides: Object.fromEntries(scan.folders.map(f => [f.path, f.included])) };
  assert.ok(resolveExclusions([], saved).includes('release'));
});

test('linked source and scan limits never silently produce a complete analysis', async t => {
  const { root, repo, write } = await fixture(t);
  await write('index.html', '<script type="module" src="src/main.js"></script>');
  await write('src/main.js', 'import "../linked/outside.js";');
  await fs.mkdir(path.join(root, 'outside'));
  await fs.writeFile(path.join(root, 'outside/outside.js'), 'throw Error("never evaluated");');
  await fs.symlink(path.join(root, 'outside'), path.join(repo, 'linked'));
  const scan = await scanPreviewFolders(repo);
  assert.ok(!scan.folders.some(f => f.path === 'linked'));
  assert.match(scan.warnings.join(' '), /Unresolved local import/);
  const { analyzePreviewReferences } = require('../src/main/preview-references.cjs');
  const limited = await analyzePreviewReferences(repo, { automatic: [], pkg: {}, maxFiles: 1 });
  assert.equal(limited.complete, false);
  assert.match(limited.warnings.join(' '), /too large/);
});

test('Expo router includes screens, layout dependencies, and config assets', async t => {
  const { repo, write } = await fixture(t);
  await write('package.json', JSON.stringify({ dependencies: { expo: '57', 'expo-router': '1', react: '1' } }));
  await write('app/_layout.tsx', 'import React from "react"; import "../providers/theme";');
  await write('app/index.tsx', 'export default () => null;');
  await write('providers/theme.ts', 'export const theme = {};');
  await write('app.json', '{"expo":{"icon":"./branding/icon.png"}}');
  await write('branding/icon.png', '');
  await write('assets/splash.png', '');
  await write('scripts/release.js', '');
  const scan = await scanPreviewFolders(repo);
  assert.deepEqual(scan.warnings, []);
  assert.deepEqual(scan.folders.filter(f => f.recommended).map(f => f.path), ['app', 'assets', 'branding', 'providers']);
});

test('preview recipe and additional manifest pages are graph roots', async t => {
  const { repo, write } = await fixture(t);
  await write('.acorn/preview.json', '{"entry":"client/preview.ts"}');
  await write('.acorn/pages.json', '{"pages":[{"path":"/help/"}]}');
  await write('client/preview.ts', 'export const preview = 1;');
  await write('help/index.html', '<img src="../images/help.png">');
  await write('images/help.png', '');
  await write('scripts/build.js', '');
  const scan = await scanPreviewFolders(repo);
  assert.deepEqual(scan.warnings, []);
  assert.deepEqual(scan.folders.filter(f => f.recommended).map(f => f.path), ['.acorn', 'client', 'help', 'images']);
});

test('a wholly computed template import is explicitly uncertain', async t => {
  const { repo, write } = await fixture(t);
  await write('index.html', '<script type="module">import(`${window.modulePath}`)</script>');
  await write('screens/home.js', '');
  const scan = await scanPreviewFolders(repo);
  assert.match(scan.warnings.join(' '), /Computed module/);
  assert.equal(scan.folders.find(f => f.path === 'screens').included, false);
});

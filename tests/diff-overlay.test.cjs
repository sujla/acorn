const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractOverlayHints, comparisonRefs, isMediaFile } = require('../src/main/diff-overlay.cjs');

test('common image, video, and audio files are treated as media', () => {
  for (const file of ['assets/photo.GIF', 'image.png', 'photo.jpg', 'clip.mp4', 'poster.avif', 'audio.mp3', 'movie.webm']) assert(isMediaFile(file));
  for (const file of ['icon.svg', 'data.json', 'video.ts', 'README.md']) assert(!isMediaFile(file));
});

test('hints distinguish added and removed text and ignore backend source', () => {
  const hints = extractOverlayHints('diff --git a/view.html b/view.html\n--- a/view.html\n+++ b/view.html\n@@ -1 +1 @@\n-<button id="old">Before</button>\n+<button id="new">After</button>');
  assert(hints.base.some((hint) => hint.value === 'Before'));
  assert(!hints.base.some((hint) => hint.value === 'After'));
  assert(hints.target.some((hint) => hint.value === 'After'));
  assert(!hints.target.some((hint) => hint.value === 'Before'));
  assert.deepEqual(extractOverlayHints('diff --git a/server.py b/server.py\n+++ b/server.py\n@@ -1 +1 @@\n+<button id="foo">Foo</button>'), { base: [], target: [] });
});

test('CSS context identifies the selector for a changed declaration', () => {
  const hints = extractOverlayHints('diff --git a/style.css b/style.css\n+++ b/style.css\n@@ -1,3 +1,3 @@\n .card {\n- color: red;\n+ color: blue;\n }');
  assert(hints.base.some((hint) => hint.kind === 'selector' && hint.value === '.card'));
  assert(hints.target.some((hint) => hint.kind === 'selector' && hint.value === '.card'));
});

test('real Git comparisons follow working-folder previews in both directions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acorn-diff-test-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init');
    fs.writeFileSync(path.join(root, 'view.html'), '<p>Old</p>\n');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'old');
    const old = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'view.html'), '<p>Committed</p>\n');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'new');
    const head = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'view.html'), '<p>Local</p>\n');
    const forward = git('diff', ...comparisonRefs(old, '__working_tree__').refs);
    assert(forward.includes('+<p>Local</p>'));
    assert(!forward.includes('+<p>Committed</p>'));
    assert(git('diff', ...comparisonRefs(old, head).refs).includes('+<p>Committed</p>'));
    assert(git('diff', ...comparisonRefs(head, '__working_tree__').refs).includes('+<p>Local</p>'));
    const reverse = git('diff', ...comparisonRefs('__working_tree__', old).refs);
    assert(reverse.includes('-<p>Local</p>'));
    assert(reverse.includes('+<p>Old</p>'));
    assert.equal(git('diff', ...comparisonRefs('__working_tree__', '__working_tree__').refs), '');
    assert.equal(git('diff', ...comparisonRefs(old, old).refs), '');
    assert.deepEqual(comparisonRefs('a', 'b').refs, ['a', 'b']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unchanged neighboring markup and CSS rules do not produce highlights', () => {
  const markup = extractOverlayHints('diff --git a/view.html b/view.html\n+++ b/view.html\n@@ -1,4 +1,4 @@\n <header id="unchanged">Header</header>\n-<button id="edited">Before</button>\n+<button id="edited">After</button>\n <footer class="footer">Footer</footer>');
  for (const side of ['base', 'target']) {
    assert(markup[side].some(hint => hint.value === 'edited'));
    assert(!markup[side].some(hint => ['unchanged', 'Header', 'footer', 'Footer'].includes(hint.value)));
  }
  const css = extractOverlayHints('diff --git a/style.css b/style.css\n+++ b/style.css\n@@ -1,7 +1,7 @@\n .header { color: black; }\n .card {\n- color: red;\n+ color: blue;\n }\n .footer { color: black; }');
  assert.deepEqual(css.base.map(hint => hint.value), ['.card']);
  assert.deepEqual(css.target.map(hint => hint.value), ['.card']);
});

test('generated source never produces overlay hints', () => {
  const { isGeneratedFile } = require('../src/main/diff-overlay.cjs');
  for (const file of ['dist/app.js', 'packages/web/build/page.html', '.next/static/app.js', 'public/app.min.js', 'styles.css.map', 'cache.tsbuildinfo']) {
    assert(isGeneratedFile(file));
    assert.deepEqual(extractOverlayHints(`diff --git a/${file} b/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+<button id="generated">Generated</button>`), { base: [], target: [] });
  }
  assert(!isGeneratedFile('src/components/Builder.tsx'));
});

test('Show Diff always includes build files while overlays exclude configured output directories', async () => {
  const vm = require('node:vm');
  const { diffPathspecs } = require('../src/main/diff-overlay.cjs');
  const { configuredOutputDirectories } = require('../src/main/generated-output.cjs');
  const source = fs.readFileSync(path.join(__dirname, '../src/main/desktop-main.cjs'), 'utf8');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acorn-generated-test-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    for (const dir of ['src', 'dist', 'packages/web/build', 'docs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const file of ['src/view.html', 'dist/index.html', 'packages/web/build/page.html', 'app.min.js', 'docs/index.html']) fs.writeFileSync(path.join(root, file), '<button id="old">Before</button>\n');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'vite.config.js'), 'export default { build: { outDir: "docs" } };');
    for (const file of ['src/view.html', 'dist/index.html', 'packages/web/build/page.html', 'app.min.js', 'docs/index.html']) fs.writeFileSync(path.join(root, file), '<button id="new">After</button>\n');
    const context = vm.createContext({ runGit: async (_path, args) => git(...args), extractOverlayHints, comparisonRefs, diffPathspecs, isMediaFile, configuredOutputDirectories });
    vm.runInContext(source.slice(source.indexOf('async function repositoryDiff('), source.indexOf('function archiveRevision(')), context);
    const result = await context.repositoryDiff(root, base, '__working_tree__', 'docs/index.html');
    assert.equal(result.files.length, 5);
    assert.equal(result.totals.added, 5);
    assert.equal(result.totals.deleted, 5);
    assert.equal(result.selectedFile, 'docs/index.html');
    assert(result.patch.includes('docs/index.html'));
    assert(result.files.some(file => file.file === 'dist/index.html'));
    assert(result.hints.target.length > 0);
    assert(result.hints.target.every(hint => hint.file === 'src/view.html'));
    assert(result.hints.base.every(hint => hint.file === 'src/view.html'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('media details skip the per-file patch and media is excluded from overlay patches', async () => {
  const vm = require('node:vm');
  const { diffPathspecs } = require('../src/main/diff-overlay.cjs');
  const { configuredOutputDirectories } = require('../src/main/generated-output.cjs');
  const source = fs.readFileSync(path.join(__dirname, '../src/main/desktop-main.cjs'), 'utf8');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acorn-media-diff-test-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'assets', 'intro.MP4'), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(root, 'view.html'), '<p>Before</p>\n');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'assets', 'intro.MP4'), Buffer.from([0, 3, 4]));
    fs.writeFileSync(path.join(root, 'view.html'), '<p>After</p>\n');
    const calls = [];
    const runGit = async (_path, args) => { calls.push(args); return git(...args); };
    const context = vm.createContext({ runGit, extractOverlayHints, comparisonRefs, diffPathspecs, isMediaFile, configuredOutputDirectories });
    vm.runInContext(source.slice(source.indexOf('async function repositoryDiff('), source.indexOf('function archiveRevision(')), context);
    const result = await context.repositoryDiff(root, base, '__working_tree__', 'assets/intro.MP4');
    assert.equal(result.detailType, 'media');
    assert.equal(result.patch, '');
    assert(!calls.some(args => args.includes('--unified=3')));
    assert(result.hints.target.some(hint => hint.file === 'view.html'));
    assert(result.hints.target.every(hint => hint.file !== 'assets/intro.MP4'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('literal build output detection ignores comments and unsafe paths', () => {
  const { parseOutputDirectories } = require('../src/main/generated-output.cjs');
  assert.deepEqual(parseOutputDirectories(`// outDir: 'src'
export default { build: { outDir: "./docs" } }; /* outDir: 'assets' */`), ['docs']);
  assert.deepEqual(parseOutputDirectories(`outDir: '../outside', outDir: '/', outDir: '.', outDir: outputVariable`), []);
  assert.deepEqual(parseOutputDirectories(`outDir: 'published/site'`), ['published/site']);
});

test('labels list only changed properties, even on a shared single line', () => {
  const hints = extractOverlayHints('diff --git a/style.css b/style.css\n+++ b/style.css\n@@ -1 +1 @@\n-.card { color: red; line-height: 1.2; padding: 4px; }\n+.card { color: red; line-height: 1.5; padding: 8px; }');
  for (const side of ['base', 'target']) {
    assert.deepEqual(hints[side].find(hint => hint.value === '.card').changes, ['line-height', 'padding']);
  }
});

test('added and removed properties label both existing rule counterparts', () => {
  const hints = extractOverlayHints('diff --git a/style.css b/style.css\n+++ b/style.css\n@@ -1,4 +1,4 @@\n .card {\n- margin: 4px;\n+ padding: 8px;\n   color: red;\n }');
  assert.deepEqual(hints.base[0].changes, ['margin', 'padding']);
  assert.deepEqual(hints.target[0].changes, ['margin', 'padding']);
});

test('property labels retain quoted values and separate neighboring rules', () => {
  const hints = extractOverlayHints('diff --git a/style.css b/style.css\n+++ b/style.css\n@@ -1,2 +1,2 @@\n-.a { content: "before;after"; color: red; }\n+.a { content: "after;before"; color: red; }\n-.b { line-height: 1; }\n+.b { line-height: 2; }');
  assert.deepEqual(hints.target.find(hint => hint.value === '.a').changes, ['content']);
  assert.deepEqual(hints.target.find(hint => hint.value === '.b').changes, ['line-height']);
});

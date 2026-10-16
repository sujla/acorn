const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { exportRevision, runGit } = require('../src/main/local-git.cjs');
const { discoverPages } = require('../src/main/preview-pages.cjs');
const { compilePreview } = require('../src/main/preview-compiler.cjs');
async function fixture(t, entries) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-output-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  for (const [file, body] of Object.entries(entries)) { await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true }); await fs.writeFile(path.join(repo, file), body); }
  return { root, repo };
}
test('preview export prunes revision-specific output trees but ordinary Git export and diff retain them', async t => {
  const { root, repo } = await fixture(t, {
    'index.html': '<h1>Source</h1>', 'vite.config.js': 'export default {build:{outDir:"docs"}}',
    'docs/index.html': '<h1>Built</h1>', 'docs-extra/index.html': '<h1>Source docs</h1>',
    'release/site/index.html': '<h1>Source release</h1>', 'dist/index.html': '<h1>Default build</h1>',
  });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const commit = message => { git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@test.test', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q'); const before = commit('docs output');
  await fs.writeFile(path.join(repo, 'vite.config.js'), 'export default {build:{outDir:"release/site"}}');
  await fs.writeFile(path.join(repo, 'docs/index.html'), '<h1>Now source documentation</h1>');
  const after = commit('release output');
  for (const [sha, excluded, retained] of [[before, 'docs', 'release/site'], [after, 'release/site', 'docs']]) {
    const destination = path.join(root, sha); await fs.mkdir(destination);
    const { outputDirectories } = await exportRevision(repo, sha, destination, { excludeBuildOutputs: true });
    await assert.rejects(fs.access(path.join(destination, excluded)), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(destination, 'dist')), { code: 'ENOENT' });
    assert.ok(await fs.readFile(path.join(destination, retained, 'index.html')));
    assert.ok(await fs.readFile(path.join(destination, 'docs-extra/index.html')));
    const catalog = await discoverPages(destination, { outputDirectories });
    assert.ok(catalog.pages.every(page => !page.path.startsWith('/' + excluded + '/')));
  }
  const full = path.join(root, 'full'); await fs.mkdir(full); await exportRevision(repo, before, full);
  assert.ok(await fs.readFile(path.join(full, 'docs/index.html')));
  assert.match(await runGit(repo, ['diff', '--name-status', before, after]), /docs\/index.html/);
  assert.equal(git('status', '--porcelain'), '');
});
test('compiler and page discovery skip output files before reading them, including manifest entries', async t => {
  const { root, repo } = await fixture(t, {
    'index.html': '<h1>Source</h1>', 'vite.config.js': 'throw new Error("must not execute"); export default {build:{outDir:"publish/site"}}',
    'publish/site/index.html': '<script src="/does-not-exist.js"></script>',
    'publish/site/routes.jsx': '<Route path="/phantom" />', 'publish/site/unreadable.bin': 'excluded',
    'out/index.html': '<h1>Built</h1>', 'web-build/index.html': '<h1>Built</h1>',
    'docs/index.html': '<h1>Real source docs</h1>',
  });
  await fs.chmod(path.join(repo, 'publish/site/unreadable.bin'), 0);
  const catalog = await discoverPages(repo);
  assert.deepEqual(catalog.pages.map(page => page.path), ['/', '/docs/']);
  const artifact = await compilePreview({ root: repo, repositoryPath: repo, cacheRoot: path.join(root, 'cache') });
  await assert.rejects(fs.access(path.join(artifact.root, 'publish')), { code: 'ENOENT' });
  assert.ok(await fs.readFile(path.join(artifact.root, 'docs/index.html')));
  await fs.mkdir(path.join(repo, '.acorn'));
  await fs.writeFile(path.join(repo, '.acorn/pages.json'), JSON.stringify({ pages: [
    { path: '/' }, { path: '/publish/site/' }, { path: '/alias', previewPath: '/publish/site/index.html' }, { path: '/out/' }, { path: '/docs/' },
  ] }));
  assert.deepEqual((await discoverPages(repo)).pages.map(page => page.path), ['/', '/docs/']);
});
test('output-only revisions do not silently fall back to deployment HTML', async t => {
  const { root, repo } = await fixture(t, { 'dist/index.html': '<h1>Built only</h1>' });
  assert.deepEqual((await discoverPages(repo)).pages, []);
  await assert.rejects(compilePreview({ root: repo, repositoryPath: repo, cacheRoot: path.join(root, 'cache') }), { code: 'NO_PREVIEW_SCREEN' });
});

test('excluded Git blobs are never loaded during preview extraction', async t => {
  const { root, repo } = await fixture(t, { 'index.html': '<h1>Source</h1>', 'dist/index.html': '<h1>Unique built payload</h1>' });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@test.test', 'commit', '-qm', 'fixture');
  const oid = git('rev-parse', 'HEAD:dist/index.html');
  const object = path.join(repo, '.git/objects', oid.slice(0, 2), oid.slice(2));
  const held = path.join(root, 'held-object');
  await fs.rename(object, held);
  try {
    const destination = path.join(root, 'preview'); await fs.mkdir(destination);
    await exportRevision(repo, 'HEAD', destination, { excludeBuildOutputs: true });
    assert.equal(await fs.readFile(path.join(destination, 'index.html'), 'utf8'), '<h1>Source</h1>');
    await assert.rejects(fs.access(path.join(destination, 'dist')), { code: 'ENOENT' });
  } finally { await fs.rename(held, object); }
});

test('Expo snapshots preserve only selected revision exports without changing ordinary output exclusion', async t => {
  const { root, repo } = await fixture(t, {
    'package.json': JSON.stringify({ dependencies: { expo: '*' } }),
    'dist/index.html': '<h1>Old export</h1>',
    'dist/_expo/static/web/app.js': 'window.exported = true;',
    'build/index.html': '<h1>Excluded</h1>',
  });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@test.test', 'commit', '-qm', 'Expo export');
  const before = git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(repo, 'package.json'), '{}');
  await fs.writeFile(path.join(repo, 'dist/index.html'), '<h1>New export</h1>');
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@test.test', 'commit', '-qm', 'Not Expo');
  const destination = path.join(root, 'expo'); await fs.mkdir(destination);
  await exportRevision(repo, before, destination, { excludeBuildOutputs: true, preserveExpoExport: true });
  assert.equal(await fs.readFile(path.join(destination, 'dist/index.html'), 'utf8'), '<h1>Old export</h1>');
  assert.match(await fs.readFile(path.join(destination, 'dist/_expo/static/web/app.js'), 'utf8'), /exported/);
  await assert.rejects(fs.access(path.join(destination, 'build')), { code: 'ENOENT' });
  const current = path.join(root, 'current'); await fs.mkdir(current);
  await exportRevision(repo, 'HEAD', current, { excludeBuildOutputs: true, preserveExpoExport: true });
  await assert.rejects(fs.access(path.join(current, 'dist')), { code: 'ENOENT' });
});

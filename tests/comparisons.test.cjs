const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');
const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
const styles = fs.readFileSync(require.resolve('../src/renderer/styles.css'), 'utf8');
function setup() {
  const saved = new Map();
  const context = vm.createContext({ crypto, repositoryComparisons: new Map(), collapsedRepositories: new Set(),
    displaySha: value => value.slice(0, 7), localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    activateRepository: () => {},
  });
  vm.runInContext(source.slice(source.indexOf('function comparisonsFor('), source.indexOf('function renderProjectList(')), context);
  return { context, saved };
}
const repo = { path: '/a', branches: [{ name: 'main', sha: '1234567' }], commits: [{ sha: '1234567890abcdef' }, { sha: 'abcdef1234567890' }], currentBranch: 'main', defaultBranch: 'main' };
test('native storage migrates legacy comparisons and survives losing browser storage', () => {
  const { context: c, saved } = setup();
  const legacy = [{ id: 'legacy', name: 'Review', base: 'main', target: '__working_tree__' }];
  saved.set('acorn.comparisons:/a', JSON.stringify(legacy));
  let disk = null;
  c.bridge = {
    readComparisons: () => ({ comparisons: disk }),
    saveComparisons: (_path, items) => { disk = JSON.parse(JSON.stringify(items)); return { success: true }; },
  };
  c.comparisonsFor(repo);
  assert.deepEqual(disk, legacy);
  c.addComparison(repo);
  const expected = JSON.stringify(disk);
  saved.clear();
  c.repositoryComparisons.clear();
  assert.equal(JSON.stringify(c.comparisonsFor(repo)), expected);
  disk = [];
  c.repositoryComparisons.clear();
  assert.equal(c.comparisonsFor(repo).length, 0);
});

test('native storage failures are reported and read failures do not overwrite saved data', () => {
  const { context: c } = setup();
  const notices = [];
  c.notify = (...args) => notices.push(args);
  c.bridge = { readComparisons: () => ({ error: 'Read failed' }), saveComparisons: () => { throw new Error('Must not write'); } };
  assert.throws(() => c.comparisonsFor(repo), /Read failed/);
  assert.equal(c.repositoryComparisons.size, 0);
  c.bridge = { readComparisons: () => ({ comparisons: null }), saveComparisons: () => ({ error: 'Disk full' }) };
  c.comparisonsFor(repo);
  assert.equal(notices[0][0], 'Disk full');
  assert.equal(c.persistComparisons(repo), false);
});

test('comparison files survive a new store instance and preserve previous data on invalid writes', () => {
  const { comparisonStore } = require('../src/main/comparison-store.cjs');
  const root = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'acorn-store-'));
  try {
    const store = comparisonStore(root);
    const items = [{ id: 'saved', name: 'Release', base: 'main', target: '__working_tree__' }];
    assert.equal(store.read('/a'), null);
    store.write('/a', items);
    store.write('/b', []);
    assert.throws(() => store.write('/a', [{ id: 'invalid' }]));
    assert.deepEqual(comparisonStore(root).read('/a'), items);
    assert.deepEqual(comparisonStore(root).read('/b'), []);
    store.write('/a', []);
    assert.deepEqual(comparisonStore(root).read('/a'), []);
    store.remove('/a');
    assert.equal(comparisonStore(root).read('/a'), null);
    store.remove('/a');
    const file = require('node:path').join(root, 'comparisons', fs.readdirSync(require('node:path').join(root, 'comparisons'))[0]);
    fs.writeFileSync(file, 'broken');
    assert.throws(() => comparisonStore(root).read(file.includes(require('node:crypto').createHash('sha256').update('/a').digest('hex')) ? '/a' : '/b'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('default uses the full commit id and comparisons persist independently per repository', () => {
  const { context: c } = setup();
  const first = c.comparisonsFor(repo)[0];
  assert.equal(first.target, repo.commits[0].sha);
  assert.equal(c.comparisonName(repo, first), 'Working Folder • Main');
  c.addComparison(repo);
  const second = c.comparisonsFor(repo)[1];
  assert.equal(c.comparisonName(repo, second), 'Main • abcdef1');
  assert.notEqual(c.comparisonSessionKey(repo, first), c.comparisonSessionKey(repo, second));
  second.base = second.target;
  c.persistComparisons(repo);
  c.repositoryComparisons.clear();
  assert.equal(c.comparisonsFor(repo)[1].base, second.target);
  assert.equal(c.comparisonsFor({ ...repo, path: '/b' }).length, 1);
});
test('one-commit repositories and malformed storage still allow comparisons', () => {
  const { context: c, saved } = setup();
  saved.set('acorn.comparisons:/a', '[null,{"id":"bad"}]');
  const single = { ...repo, commits: repo.commits.slice(0, 1) };
  c.addComparison(single);
  assert.equal(c.comparisonsFor(single).length, 2);
  assert.equal(c.comparisonsFor(single)[1].base, single.commits[0].sha);
});

test('an explicitly emptied folder stays empty after reload and custom names survive ref changes', () => {
  const { context: c, saved } = setup();
  saved.set('acorn.comparisons:/a', '[]');
  assert.equal(c.comparisonsFor(repo).length, 0);
  c.addComparison(repo);
  const comparison = c.comparisonsFor(repo)[0];
  comparison.name = 'Release review';
  comparison.base = '__working_tree__';
  c.persistComparisons(repo);
  c.repositoryComparisons.clear();
  assert.equal(c.comparisonName(repo, c.comparisonsFor(repo)[0]), 'Release review');
});

test('runtime servers show concise source details without redundant labels', () => {
  const { context: c } = setup();
  assert.equal(c.runtimeServerDetail(repo, { workingTree: true, sha: '1234567890abcdef' }), 'Working Folder');
  assert.equal(c.runtimeServerDetail(repo, { workingTree: false, sha: '1234567890abcdef' }), 'Main · 1234567');
  assert.equal(c.runtimeServerDetail(repo, { workingTree: false, sha: 'abcdef1234567890' }), 'abcdef1');
  const current = { base: { upstreamUrl: 'http://current' } };
  const sessions = new Map([['other', { previews: { target: { upstreamUrl: 'http://retained' } } }]]);
  assert.deepEqual([...c.runtimeUsedServerUrls(current, sessions)].sort(), ['http://current', 'http://retained']);
  assert.match(source, /detail\.textContent = runtimeServerDetail\(repository, server\)/);
  assert.match(source, /projectServers\.toSorted\(\(a, b\) => Number\(usedUrls\.has\(b\.url\)\) - Number\(usedUrls\.has\(a\.url\)\)\)/);
  assert.match(source, /row\.classList\.toggle\('is-unused', !usedUrls\.has\(server\.url\)\)/);
  assert.match(styles, /\.runtime-popover \.runtime-server\.is-unused span \{ color: var\(--muted\); \}/);
  assert.doesNotMatch(source, /detail\.textContent[^\n]*(?:React Native Web|Current working folder|Snapshot|Preview)/);
});

test('collapsed repository tooltip separates its label from clickable comparisons', () => {
  assert.match(source, /showIconTooltip\(button, repository\)/);
  assert.match(source, /iconTooltip\.replaceChildren\(name, \.\.\.comparisonButtons\)/);
  assert.match(source, /activateRepository\(repository\.path, comparison\.id\)/);
  assert.match(styles, /\.repository-tooltip-name[^}]*overflow: hidden[^}]*padding: 5px 10px[^}]*font-weight: 600[^}]*text-overflow: ellipsis[^}]*white-space: nowrap/);
  assert.match(styles, /\.repository-tooltip-comparison[^}]*padding: 5px 16px 5px 10px[^}]*border-radius: 6px[^}]*color: var\(--muted\)[^}]*font-weight: 400/);
  assert.match(styles, /\.repository-tooltip-comparison[^}]*overflow: hidden[^}]*text-overflow: ellipsis[^}]*white-space: nowrap/);
  assert.match(styles, /\.repository-tooltip-comparison \+ \.repository-tooltip-comparison[^}]*margin-top: 1px/);
  assert.match(styles, /\.icon-tooltip\.repository-tooltip[^}]*width: 240px[^}]*padding: 5px[^}]*border-radius: 10px[^}]*pointer-events: auto/);
  assert.match(styles, /\.repository-tooltip-comparison:hover[^}]*background: color-mix\(in srgb, var\(--hover\) 80%, transparent\)/);
  assert.match(styles, /\.repository-tooltip-comparison\[aria-current="page"\][^}]*color: var\(--text\)[^}]*background: color-mix\(in srgb, var\(--selected\) 80%, transparent\)/);
  assert.match(source, /repository\s*\? bounds\.top\s*:/);
  assert.match(source, /bounds\.right \+ 10/);
});

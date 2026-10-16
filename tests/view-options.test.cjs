const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
const helpers = source.slice(
  source.indexOf('function legacyProjectViewOptions('),
  source.indexOf('function comparisonName('),
);

function setup() {
  const saved = new Map();
  const elements = new Map([
    ['mouse-sync', { checked: true }],
    ['diff-overlay', { checked: false }],
    ['previewable-only', { checked: false }],
  ]);
  const calls = { filter: 0, mouse: 0, diff: 0 };
  const context = vm.createContext({
    activeRepository: null,
    activeComparison: null,
    get: id => elements.get(id),
    localStorage: {
      getItem: key => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
    },
    applyPreviewableOnlyFilter: () => { calls.filter++; },
    configureMouseSync: () => { calls.mouse++; },
    configureDiffOverlay: () => { calls.diff++; },
  });
  vm.runInContext(helpers, context);
  return { context, saved, elements, calls };
}

test('mouse sync and diff persist independently for each comparison', () => {
  const { context, elements } = setup();
  const first = { path: '/projects/first' };
  const comparisonA = { id: 'comparison-a' };
  const comparisonB = { id: 'comparison-b' };

  elements.get('mouse-sync').checked = false;
  elements.get('diff-overlay').checked = true;
  context.persistComparisonViewOptions(first, comparisonA);

  elements.get('mouse-sync').checked = true;
  elements.get('diff-overlay').checked = false;
  context.persistComparisonViewOptions(first, comparisonB);

  assert.deepEqual(JSON.parse(JSON.stringify(context.readComparisonViewOptions(first, comparisonA))), {
    mouseSync: false, diffOverlay: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.readComparisonViewOptions(first, comparisonB))), {
    mouseSync: true, diffOverlay: false,
  });
});

test('previewable only persists independently for each repository', () => {
  const { context, elements } = setup();
  const first = { path: '/projects/first' };
  const second = { path: '/projects/second' };

  elements.get('previewable-only').checked = true;
  context.persistRepositoryViewOptions(first);
  elements.get('previewable-only').checked = false;
  context.persistRepositoryViewOptions(second);

  assert.deepEqual(JSON.parse(JSON.stringify(context.readRepositoryViewOptions(first))), { previewableOnly: true });
  assert.deepEqual(JSON.parse(JSON.stringify(context.readRepositoryViewOptions(second))), { previewableOnly: false });
});

test('restoring a comparison and repository applies their saved controls and safe defaults', () => {
  const { context, saved, elements, calls } = setup();
  const repository = { path: '/projects/saved' };
  const comparison = { id: 'comparison-a' };
  saved.set('acorn.comparison-view-options:["/projects/saved","comparison-a"]', JSON.stringify({ mouseSync: false, diffOverlay: true }));
  saved.set('acorn.repository-view-options:/projects/saved', JSON.stringify({ previewableOnly: true }));

  context.restoreViewOptions(repository, comparison);
  assert.equal(elements.get('mouse-sync').checked, false);
  assert.equal(elements.get('diff-overlay').checked, true);
  assert.equal(elements.get('previewable-only').checked, true);
  assert.deepEqual(calls, { filter: 1, mouse: 1, diff: 1 });

  const newRepository = { path: '/projects/new' };
  saved.set('acorn.comparison-view-options:["/projects/new","comparison-new"]', '{broken');
  saved.set('acorn.repository-view-options:/projects/new', '{broken');
  context.restoreViewOptions(newRepository, { id: 'comparison-new' });
  assert.equal(elements.get('mouse-sync').checked, true);
  assert.equal(elements.get('diff-overlay').checked, false);
  assert.equal(elements.get('previewable-only').checked, false);
});

test('checkbox change handlers persist at their intended scope', () => {
  assert.match(source, /get\('mouse-sync'\)\.addEventListener\('change', \(\) => \{\s*persistComparisonViewOptions\(\);/);
  assert.match(source, /get\('diff-overlay'\)\.addEventListener\('change', \(\) => \{\s*persistComparisonViewOptions\(\);/);
  assert.match(source, /get\('previewable-only'\)\.addEventListener\('change', \(\) => \{\s*persistRepositoryViewOptions\(\);/);
});

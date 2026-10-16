const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
const markup = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');

test('changed files resolve to revision-specific preview pages and merge shared page ids', () => {
  const context = vm.createContext({
    overlayMatchedFiles: { base: new Set(['styles.css']), target: new Set() },
    selectedPages: { base: { id: 'home', path: '/', label: 'Home', source: 'src/App.tsx', available: true }, target: null },
    previewUrls: {
      base: { catalog: { pages: [
        { id: 'home', path: '/', label: 'Home', source: './src/App.tsx', available: true },
        { id: 'settings', path: '/settings', label: 'Settings', source: 'src/App.tsx', available: true },
      ] } },
      target: { catalog: { pages: [
        { id: 'home', path: '/', label: 'Home', source: 'src/App.tsx', available: true },
        { id: 'draft', path: '/draft', label: 'Draft', source: 'src/App.tsx', available: false },
      ] } },
    },
  });
  const start = appSource.indexOf('function normalizedSourcePath(');
  const end = appSource.indexOf('function previewSideForPage(', start);
  vm.runInContext(appSource.slice(start, end), context);
  const pages = context.previewPagesForFile('src/App.tsx');
  assert.deepEqual(JSON.parse(JSON.stringify(pages.map(page => [page.id, Object.keys(page.pages)]))), [
    ['home', ['base', 'target']],
    ['settings', ['base']],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.previewPagesForFile('styles.css').map(page => [page.id, Object.keys(page.pages)]))), [
    ['home', ['base']],
  ]);
});

test('diff drawer preserves totals while switching files and hides invalid totals', () => {
  assert.match(appSource, /loadDiff\(\{ preserveHeader: true \}\)/);
  assert.match(appSource, /Number\.isFinite\(diff\.totals\?\.added\).*Number\.isFinite\(diff\.totals\?\.deleted\)/s);
  assert.match(appSource, /if \(loading\) view\.innerHTML = '<span class="diff-loading-spinner"/);
  assert.match(appSource, /overlayMatchedFiles\[side\] = new Set/);
});

test('media files show an immediate unavailable message instead of a patch', () => {
  const context = vm.createContext({});
  const start = appSource.indexOf('function renderPatch(');
  const end = appSource.indexOf('function setDiffLoading(', start);
  vm.runInContext(appSource.slice(start, end), context);
  assert.match(context.renderPatch('', 'branches', 'media'), /Preview is not available for media files/);
});

test('diff header matches the main preview controls without a close button', () => {
  assert.match(styles, /--diff-width: 360px/);
  assert.match(appSource, /setDiffPanelWidth\(360\)/);
  assert.match(markup, /id="diff-resizer"[^>]*aria-valuenow="360"/);
  assert.match(styles, /\.changes-header \{[^}]*min-height: 44px;[^}]*flex: 0 0 44px;[^}]*padding: 4px 16px;/s);
  assert.doesNotMatch(markup, /id="toggle-diff"/);
  assert.match(styles, /\.file\.has-preview-action:hover \.file-preview-action[^}]*display: inline-flex;/s);
});

test('view controls use compact spacing', () => {
  assert.match(styles, /\.mouse-sync-control \{[^}]*gap: 6px;/s);
  assert.match(styles, /\.diff-control \{[^}]*gap: 8px;/s);
  assert.match(styles, /\.view-control \{[^}]*gap: 8px;/s);
  assert.match(styles, /\.expanded-preview-options \.diff-control \{ gap: 8px; \}/);
});

test('Shift+D toggles the diff outside editable controls', () => {
  assert.match(appSource, /get\('show-diff'\)\.dataset\.tooltip = '⇧D'/);
  assert.match(appSource, /get\('show-diff'\)\.setAttribute\('aria-keyshortcuts', 'Shift\+D'\)/);
  assert.match(appSource, /event\.code === 'KeyD' \|\| event\.key\.toLowerCase\(\) === 'd'/);
  assert.match(appSource, /event\.shiftKey[\s\S]*!isDKey/);
  assert.match(appSource, /event\.target\.closest\?\.\('input, textarea, select, \[contenteditable="true"\]'\)/);
  assert.match(appSource, /if \(!event\.repeat\) get\('show-diff'\)\.click\(\)/);
});

test('refresh and diff tooltips sit four pixels from their buttons', () => {
  assert.match(appSource, /const gap = \['refresh-all', 'show-diff'\]\.includes\(button\.id\) \? 4 : 6/);
  assert.match(appSource, /bounds\.bottom \+ gap/);
  assert.match(appSource, /bounds\.top - tooltip\.height - gap/);
});

test('preview actions preserve the drawer and keep counts for files without an action', () => {
  const viewStart = appSource.indexOf('function viewPageFromDiff(');
  const viewEnd = appSource.indexOf('function ensureFilePreviewMenu(', viewStart);
  const actionStart = appSource.indexOf('function refreshFilePreviewActions(');
  const actionEnd = appSource.indexOf('bridge?.onPreviewBlocked', actionStart);
  assert.doesNotMatch(appSource.slice(viewStart, viewEnd), /closeDiffPanel/);
  assert.match(appSource.slice(actionStart, actionEnd), /classList\.remove\('has-preview-action'\)/);
  assert.match(appSource.slice(actionStart, actionEnd), /classList\.add\('has-preview-action'\)/);
  assert.match(styles, /\.file\.has-preview-action:hover \.file-trailing em[^}]*display: none;/s);
  assert.match(styles, /--file-preview-action-background: #ffffff;/);
  assert.match(styles, /font: 500 11px\/1 ui-sans-serif/);
});

test('repository and comparison navigation preserve the open diff drawer', () => {
  const emptyStart = appSource.indexOf('function showEmptyComparisons(');
  const emptyEnd = appSource.indexOf('async function deleteRepository(', emptyStart);
  const activateStart = appSource.indexOf('function activateRepository(');
  const activateEnd = appSource.indexOf('async function addConnection(', activateStart);
  const eventStart = appSource.indexOf("get('show-diff').addEventListener('click'");
  const eventEnd = appSource.indexOf("get('diff-resizer').addEventListener('pointerdown'", eventStart);

  assert.doesNotMatch(appSource.slice(emptyStart, emptyEnd), /closeDiffPanel/);
  assert.doesNotMatch(appSource.slice(activateStart, activateEnd), /closeDiffPanel/);
  assert.match(appSource.slice(eventStart, eventEnd), /closeDiffPanel/);
});

test('previewable-only control filters rows using the same preview action state', () => {
  assert.match(appSource, /get\('previewable-only'\)\.addEventListener\('change', \(\) => \{\s*persistRepositoryViewOptions\(\);\s*applyPreviewableOnlyFilter\(\);/);
  assert.match(appSource, /row\.hidden = previewableOnly && !row\.classList\.contains\('has-preview-action'\)/);
  assert.match(appSource, /function refreshFilePreviewActions\(\)[\s\S]*applyPreviewableOnlyFilter\(\);/);
  assert.match(markup, /id="previewable-only"[^>]*aria-controls="file-list"[^>]*\/> Previewable Only<\/label>/);
  assert.match(styles, /\.file\[hidden\] \{ display: none; \}/);
});

test('long preview page names scroll through their hidden text on hover and focus', () => {
  assert.match(appSource, /file-preview-menu-scroll"><span class="file-preview-menu-scroll-text"><span class="file-preview-menu-label"/);
  assert.match(appSource, /<small class="file-preview-menu-path"/);
  assert.match(appSource, /text\.scrollWidth - line\.clientWidth/);
  assert.match(appSource, /line\.style\.setProperty\('--marquee-distance'/);
  assert.match(appSource, /line\.style\.setProperty\('--marquee-duration'/);
  assert.match(styles, /button:is\(:hover, :focus-visible\) \.file-preview-menu-scroll\.is-overflowing/);
  assert.match(styles, /@keyframes file-preview-menu-marquee/);
  assert.match(styles, /prefers-reduced-motion: reduce[^}]*\.file-preview-menu-scroll-text[^}]*animation: none !important/s);
  assert.match(styles, /\.file-preview-menu-scroll-text \{[^}]*display: grid;[^}]*width: max-content;[^}]*min-width: 100%;/s);
});

test('clicking the active preview menu trigger toggles the menu closed', () => {
  const menuStart = appSource.indexOf('function openFilePreviewMenu(');
  const menuEnd = appSource.indexOf('function applyPreviewableOnlyFilter(', menuStart);
  const menuSource = appSource.slice(menuStart, menuEnd);
  assert.match(menuSource, /filePreviewMenuToggleTrigger === button \|\| \(menu\.matches\(':popover-open'\) && filePreviewMenuTrigger === button\)/);
  assert.match(menuSource, /if \(menu\.matches\(':popover-open'\)\) menu\.hidePopover\(\);[\s\S]*button\.focus\(\);[\s\S]*return;/);
  assert.match(appSource, /filePreviewMenuTrigger\?\.setAttribute\('aria-expanded', 'false'\)/);
  assert.match(menuSource, /button\.setAttribute\('aria-expanded', 'true'\)/);
  assert.match(appSource, /action\.setAttribute\('aria-haspopup', 'menu'\)/);
  assert.match(appSource, /action\.addEventListener\('pointerdown',[\s\S]*filePreviewMenuToggleTrigger = filePreviewMenu\?\.matches\(':popover-open'\)/);
  assert.match(appSource, /action\.addEventListener\('pointercancel',[\s\S]*filePreviewMenuToggleTrigger = null/);
});

test('shared hover backgrounds are two steps softer than selected backgrounds', () => {
  assert.match(styles, /--hover: #f2f2f2; --selected: #e8e8e8;/);
  assert.match(styles, /--hover: #222222; --selected: #2c2c2c;/);
  assert.match(styles, /--page-row-hover: var\(--hover\);/);
});

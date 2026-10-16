const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/renderer/app.js'), 'utf8');

function fixture() {
  const makeClassList = () => {
    const values = new Set();
    return { values, toggle(name, force) { if (force) values.add(name); else values.delete(name); }, contains(name) { return values.has(name); } };
  };
  const makeHandle = (side, axis, edge, hint = false) => ({
    dataset: { side, axis, edge }, hint, handlers: {}, captured: null,
    addEventListener(name, handler) { this.handlers[name] = handler; },
    setPointerCapture(id) { this.captured = id; },
    hasPointerCapture(id) { return this.captured === id; },
    releasePointerCapture() { this.captured = null; },
  });
  const handles = ['base', 'target'].flatMap(side => [
    makeHandle(side, 'width', 'right'),
    makeHandle(side, 'height', 'bottom'),
    makeHandle(side, 'both', 'bottom-right'),
  ]);
  handles.push(
    makeHandle('base', 'width', 'right', true),
    makeHandle('target', 'width', 'right', true),
    makeHandle('base', 'height', 'bottom', true),
    makeHandle('target', 'height', 'bottom', true),
  );
  for (const side of ['base', 'target']) {
    handles.push(
      makeHandle(side, 'height', 'top'),
      makeHandle(side, 'width', 'left'),
      makeHandle(side, 'both', 'top-left'),
      makeHandle(side, 'both', 'top-right'),
      makeHandle(side, 'both', 'bottom-left'),
    );
  }
  const elements = { 'preview-grid': { dataset: {}, getBoundingClientRect: () => ({ top: 100 }) } };
  for (const side of ['base', 'target']) {
    elements[`${side}-preview-viewport`] = { classList: makeClassList(), style: { setProperty(name, value) { this[name] = value; } }, clientWidth: 600, getBoundingClientRect: () => ({ top: 180 }), closest: () => ({ children: [{ getBoundingClientRect: () => ({ height: 40 }) }, { getBoundingClientRect: () => ({ height: 40 }) }] }) };
    for (const suffix of ['zoom-label', 'zoom-out', 'zoom-in']) elements[`${side}-${suffix}`] = {};
    elements[`${side}-url`] = { value: '/nested/path' };
    elements[`${side}-device-frame`] = { style: {} };
    elements[`${side}-preview-frame`] = { style: {} };
  }
  const workspace = { clientHeight: 900, scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) };
  const classes = new Set();
  const context = vm.createContext({ activeRepository: null, get: id => elements[id], customPreviewSize: { value: null }, previewGeometry: {}, previewZoom: { base: 100, target: 100 }, previewFit: { base: null, target: null }, previewResizeDrag: null, expandedSide: null, document: { querySelector: () => workspace, querySelectorAll: () => handles, body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } } }, window: { innerHeight: 900, addEventListener() {}, getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0' }) } });
  vm.runInContext(source.slice(source.indexOf('function resizeDevicePreviews()'), source.indexOf('function setSidebarCollapsed(')), context);
  context.resizeDevicePreviews();
  const event = (x = 0, y = 0) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {} });
  return { context, elements, handles, classes, event, workspace };
}

const normalScale = 600 / 1440;
const near = (actual, expected) => assert.ok(Math.abs(parseFloat(actual) - expected) < 0.01, `${actual} differs from ${expected}`);

test('normal preview fills the section width and its section fills the app height', () => {
  const { context, elements, workspace } = fixture();
  for (const side of ['base', 'target']) {
    assert.equal(elements[`${side}-preview-frame`].style.width, '1440px');
    assert.equal(elements[`${side}-preview-frame`].style.height, '900px');
    near(elements[`${side}-device-frame`].style.width, 600);
    near(elements[`${side}-device-frame`].style.height, 375);
    assert.equal(context.previewGeometry[side].availableHeight, 718);
    near(elements[`${side}-preview-viewport`].style['--preview-rendered-height'], 375);
    assert.equal(elements[`${side}-preview-viewport`].classList.contains('has-inline-preview-space'), false);
    assert.equal(elements[`${side}-preview-viewport`].classList.contains('has-block-preview-space'), true);
  }
  workspace.clientHeight = 1100;
  context.resizeDevicePreviews();
  assert.equal(context.previewGeometry.base.availableHeight, 918);
  near(elements['base-device-frame'].style.height, 375);
  workspace.clientHeight = 300;
  context.resizeDevicePreviews();
  assert.equal(context.previewGeometry.base.availableHeight, 118);
  near(elements['base-device-frame'].style.height, 118);
});

test('preview uses available workspace height without reserving bottom space', () => {
  const { context, elements, workspace } = fixture();
  workspace.clientHeight = 400;
  context.resizeDevicePreviews();
  for (const side of ['base', 'target']) {
    assert.equal(context.previewGeometry[side].availableHeight, 218);
    near(elements[`${side}-device-frame`].style.height, 218);
  }
});

test('all four edges and corners resize outward in their visual direction', () => {
  const cases = [
    ['top', 0, -10, false, true],
    ['right', 10, 0, true, false],
    ['bottom', 0, 10, false, true],
    ['left', -10, 0, true, false],
    ['top-left', -10, -10, true, true],
    ['top-right', 10, -10, true, true],
    ['bottom-right', 10, 10, true, true],
    ['bottom-left', -10, 10, true, true],
  ];
  for (const [edge, x, y, changesWidth, changesHeight] of cases) {
    const { context, elements, handles, event } = fixture();
    context.customPreviewSize.value = { width: 1000, height: 600 };
    context.resizeDevicePreviews();
    const handle = handles.find(candidate => !candidate.hint && candidate.dataset.side === 'base' && candidate.dataset.edge === edge);
    assert.ok(handle, `missing ${edge} handle`);
    handle.handlers.pointerdown(event());
    handle.handlers.pointermove(event(x, y));
    handle.handlers.pointerup(event(x, y));
    assert.equal(parseFloat(elements['base-preview-frame'].style.width) > 1000, changesWidth, `${edge} width`);
    assert.equal(parseFloat(elements['base-preview-frame'].style.height) > 600, changesHeight, `${edge} height`);
  }
});

test('centered drag moves both edges symmetrically and synchronizes both previews', () => {
  const { context, elements, handles, classes, event } = fixture();
  handles[2].handlers.pointerdown(event());
  assert.ok(classes.has('resizing-preview'));
  handles[2].handlers.pointermove(event(-100, -50));
  for (const side of ['base', 'target']) {
    assert.equal(elements[`${side}-preview-frame`].style.width, `${Math.round(1440 - 200 / normalScale)}px`);
    assert.equal(elements[`${side}-preview-frame`].style.height, `${Math.round(900 - 100 / normalScale)}px`);
    assert.equal(context.previewGeometry[side].availableHeight, 718);
  }
  handles[2].handlers.pointercancel(event());
  assert.equal(context.previewResizeDrag, null);
  assert.equal(handles[2].captured, null);
  assert.equal(classes.has('resizing-preview'), false);
});

test('default preview has no inline hint and shrinking reveals it', () => {
  const { context, elements, handles, event } = fixture();
  assert.equal(elements['base-preview-viewport'].classList.contains('has-inline-preview-space'), false);
  handles[0].handlers.pointerdown(event());
  handles[0].handlers.pointermove(event(-40, 0));
  assert.ok(parseFloat(elements['base-device-frame'].style.width) < 600);
  assert.equal(elements['base-preview-viewport'].classList.contains('has-inline-preview-space'), true);
  assert.equal(context.previewGeometry.base.scale, normalScale);
  assert.equal(elements['base-preview-frame'].style.height, '900px');
  handles[0].handlers.pointermove(event(2000, 0));
  near(elements['base-device-frame'].style.width, 600);
  assert.equal(elements['base-preview-viewport'].classList.contains('has-inline-preview-space'), false);
});

test('right-side hint allows both previews to fill the entire section width', () => {
  const { elements, handles, event } = fixture();
  const edge = handles[0];
  edge.handlers.pointerdown(event());
  edge.handlers.pointermove(event(-40, 0));
  edge.handlers.pointerup(event());
  const hint = handles[6];
  hint.handlers.pointerdown(event());
  hint.handlers.pointermove(event(2000, 0));
  for (const side of ['base', 'target']) {
    near(elements[`${side}-device-frame`].style.width, 600);
    assert.equal(elements[`${side}-preview-viewport`].style['--preview-rendered-width'], '600px');
    assert.equal(elements[`${side}-preview-viewport`].classList.contains('has-inline-preview-space'), false);
    assert.equal(elements[`${side}-preview-viewport`].classList.contains('has-block-preview-space'), true);
  }
  hint.handlers.pointerup(event());
});

test('bottom hint fills the remaining section height and then hides', () => {
  const { elements, handles, event } = fixture();
  const hint = handles[8];
  hint.handlers.pointerdown(event());
  hint.handlers.pointermove(event(0, 2000));
  for (const side of ['base', 'target']) {
    near(elements[`${side}-device-frame`].style.height, 718);
    assert.equal(elements[`${side}-preview-viewport`].classList.contains('has-inline-preview-space'), false);
    assert.equal(elements[`${side}-preview-viewport`].classList.contains('has-block-preview-space'), false);
  }
  hint.handlers.pointerup(event());
});

test('expanded previews keep the normal logical frame and use a larger display scale', () => {
  const { context, elements, handles, event } = fixture();
  context.expandedSide = 'base';
  elements['base-preview-viewport'].clientWidth = 1200;
  context.resizeDevicePreviews();
  assert.equal(elements['base-preview-frame'].style.width, '1440px');
  assert.equal(elements['base-preview-frame'].style.height, '900px');
  near(elements['base-device-frame'].style.width, 1200);
  near(elements['base-device-frame'].style.height, 750);
  near(elements['base-preview-viewport'].style['--preview-top'], 34);
  handles[2].handlers.pointerdown(event());
  handles[2].handlers.pointermove(event(-100, -50));
  handles[2].handlers.pointerup(event());
  assert.equal(elements['base-preview-frame'].style.width, '1200px');
  assert.equal(elements['base-preview-frame'].style.height, '780px');
  context.expandedSide = 'target';
  elements['target-preview-viewport'].clientWidth = 1200;
  context.resizeDevicePreviews();
  assert.equal(elements['target-preview-frame'].style.width, '1200px');
  assert.equal(elements['base-preview-frame'].style.width, '1200px');
  handles[5].handlers.dblclick();
  assert.equal(elements['target-preview-frame'].style.width, '1440px');
  assert.equal(elements['base-preview-frame'].style.width, '1440px');
});

test('resized app frames stay synchronized when entering and leaving expanded mode', () => {
  const { context, elements, handles, event } = fixture();
  handles[2].handlers.pointerdown(event());
  handles[2].handlers.pointermove(event(-100, -50));
  handles[2].handlers.pointerup(event());
  const logicalWidth = elements['base-preview-frame'].style.width;
  const logicalHeight = elements['base-preview-frame'].style.height;

  context.expandedSide = 'base';
  elements['base-preview-viewport'].clientWidth = 1200;
  context.resizeDevicePreviews();
  assert.equal(elements['base-preview-frame'].style.width, logicalWidth);
  assert.equal(elements['base-preview-frame'].style.height, logicalHeight);

  context.expandedSide = null;
  context.resizeDevicePreviews();
  assert.equal(elements['base-preview-frame'].style.width, logicalWidth);
  assert.equal(elements['base-preview-frame'].style.height, logicalHeight);
});

test('Target drag updates Base and double-click restores the initial inset', () => {
  const { elements, handles, event } = fixture();
  handles[5].handlers.pointerdown(event());
  handles[5].handlers.pointermove(event(-50, -100));
  handles[5].handlers.pointerup(event());
  assert.equal(elements['base-preview-frame'].style.width, elements['target-preview-frame'].style.width);
  assert.equal(elements['base-preview-frame'].style.height, elements['target-preview-frame'].style.height);
  handles[5].handlers.dblclick();
  for (const side of ['base', 'target']) {
    assert.equal(elements[`${side}-preview-frame`].style.width, '1440px');
    assert.equal(elements[`${side}-preview-frame`].style.height, '900px');
    near(elements[`${side}-device-frame`].style.width, 600);
  }
});

test('corner drag fills the whole section in both dimensions without reserving hint space', () => {
  const { elements, handles, event } = fixture();
  handles[2].handlers.pointerdown(event());
  handles[2].handlers.pointermove(event(2000, 2000));
  handles[2].handlers.pointerup(event());
  for (const side of ['base', 'target']) {
    near(elements[`${side}-device-frame`].style.width, 600);
    near(elements[`${side}-device-frame`].style.height, 718);
    assert.equal(elements[`${side}-preview-viewport`].classList.contains('has-inline-preview-space'), false);
    assert.equal(elements[`${side}-preview-viewport`].classList.contains('has-block-preview-space'), false);
  }
});

test('expanded right-side hint stays on the visible edge and can shrink the preview', () => {
  const { context, elements, handles, event } = fixture();
  context.expandedSide = 'base';
  elements['base-preview-viewport'].clientWidth = 1200;
  context.resizeDevicePreviews();
  const hint = handles[6];
  hint.handlers.pointerdown(event());
  hint.handlers.pointermove(event(2000, 0));
  near(elements['base-device-frame'].style.width, 1200);
  assert.equal(parseFloat(elements['base-device-frame'].style.width), 1200);
  hint.handlers.pointerup(event());
  hint.handlers.pointerdown(event());
  hint.handlers.pointermove(event(-50, 0));
  hint.handlers.pointerup(event());
  near(elements['base-device-frame'].style.width, 1100);
});

test('expanded bottom hint fills all remaining height and then hides', () => {
  const { context, elements, handles, event } = fixture();
  context.expandedSide = 'base';
  elements['base-preview-viewport'].clientWidth = 1200;
  context.resizeDevicePreviews();
  const hint = handles[8];
  hint.handlers.pointerdown(event());
  hint.handlers.pointermove(event(0, 2000));
  near(elements['base-device-frame'].style.height, 818);
  assert.equal(elements['base-preview-viewport'].classList.contains('has-block-preview-space'), false);
  hint.handlers.pointerup(event());
});

test('zoom reflows content within a fixed frame and remains independent per side', () => {
  const { context, elements } = fixture();
  const width = elements['base-device-frame'].style.width;
  context.setPreviewZoom('base', 110);
  near(elements['base-preview-frame'].style.width, 1440 / 1.1);
  near(elements['base-preview-frame'].style.height, 900 / 1.1);
  assert.equal(elements['base-preview-frame'].style.transform, `scale(${normalScale * 1.1})`);
  assert.equal(elements['base-device-frame'].style.width, width);
  assert.equal(elements['target-preview-frame'].style.width, '1440px');
  assert.equal(elements['base-zoom-label'].textContent, '110%');
  context.expandedSide = 'base';
  context.resizeDevicePreviews();
  near(elements['base-preview-frame'].style.width, 1440 / 1.1);
  context.setPreviewZoom('base', 90);
  near(elements['base-preview-frame'].style.width, 1440 / 0.9);
  context.setPreviewZoom('base', 0);
  assert.equal(elements['base-zoom-label'].textContent, '30%');
  assert.equal(elements['base-zoom-out'].disabled, true);
  context.setPreviewZoom('base', 300);
  assert.equal(elements['base-zoom-label'].textContent, '200%');
  assert.equal(elements['base-zoom-in'].disabled, true);
  context.setPreviewZoom('base', 100);
  assert.equal(elements['base-preview-frame'].style.width, '1440px');
  assert.equal(elements['base-zoom-out'].disabled, false);
  assert.equal(elements['base-zoom-in'].disabled, false);
});

test('Explicit view reset restores the initial preview route, size, fit, and zoom', () => {
  const { context, elements } = fixture();
  context.customPreviewSize.value = { width: 300, height: 600 };
  context.previewFit.base = { width: 300, height: 600 };
  context.previewFit.target = { width: 400, height: 700 };
  context.setPreviewZoom('base', 140);
  context.setPreviewZoom('target', 80);

  context.resetPreviewView();

  assert.equal(context.customPreviewSize.value, null);
  for (const side of ['base', 'target']) {
    assert.equal(context.previewFit[side], null);
    assert.equal(context.previewZoom[side], 100);
    assert.equal(elements[`${side}-url`].value, '/');
    assert.equal(elements[`${side}-zoom-label`].textContent, '100%');
  }
});

test('Fit fills width proportionally without changing the current content viewport', () => {
  const { context, elements } = fixture();
  context.setPreviewZoom('base', 110);
  const width = elements['base-preview-frame'].style.width;
  context.fitPreview('base');
  near(elements['base-device-frame'].style.width, 600);
  near(elements['base-device-frame'].style.height, 375);
  assert.equal(elements['base-preview-frame'].style.width, width);
  near(elements['target-device-frame'].style.width, 600);
});

test('Fit stays active and recalculates its scale for normal and expanded sections', () => {
  const { context, elements } = fixture();
  context.customPreviewSize.value = { width: 300, height: 600 };
  context.fitPreview('base');
  near(elements['base-device-frame'].style.height, 718);
  near(elements['base-device-frame'].style.width, 359);
  assert.equal(elements['base-preview-frame'].style.width, '300px');
  context.expandedSide = 'base';
  context.resizeDevicePreviews();
  near(elements['base-device-frame'].style.height, 818);
  near(elements['base-device-frame'].style.width, 409);
});

test('Fit follows section resizing while preserving the content viewport', () => {
  const { context, elements } = fixture();
  context.fitPreview('base');
  elements['base-preview-viewport'].clientWidth = 1000;
  context.resizeDevicePreviews();
  near(elements['base-device-frame'].style.width, 1000);
  assert.equal(elements['base-preview-frame'].style.width, '1440px');
  elements['base-preview-viewport'].clientWidth = 400;
  context.resizeDevicePreviews();
  near(elements['base-device-frame'].style.width, 400);
  assert.equal(elements['base-preview-frame'].style.width, '1440px');
});

test('mobile projects start and reset at 390 by 844 while desktop keeps its default', () => {
  const { context, elements } = fixture();
  context.activeRepository = { platforms: { mobile: true, web: true } };
  context.resizeDevicePreviews();
  for (const side of ['base', 'target']) {
    assert.equal(elements[`${side}-preview-frame`].style.width, '390px');
    assert.equal(elements[`${side}-preview-frame`].style.height, '844px');
    assert.ok(parseFloat(elements[`${side}-device-frame`].style.height) <= 718);
  }
  context.customPreviewSize.value = { width: 320, height: 600 };
  context.resetPreviewView();
  context.resizeDevicePreviews();
  assert.equal(elements['base-preview-frame'].style.width, '390px');
  context.activeRepository = { platforms: { desktop: true, web: true } };
  context.resizeDevicePreviews();
  assert.equal(elements['base-preview-frame'].style.width, '1440px');
});

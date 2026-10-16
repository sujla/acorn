const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/preview-overlay.js'), 'utf8');

test('confirmed overlay labels omit the generic change suffix', () => {
  assert.match(source, /label\.textContent = rect\.changes\.join\(', '\)/);
  assert.doesNotMatch(source, /Estimated change/);
  assert.doesNotMatch(source, /join\(', '\).*` change`/);
});

test('CSS selectors identify their preview page even when the element is outside the viewport', () => {
  const messages = [];
  const listeners = {};
  const node = {
    tagName: 'DIV',
    getBoundingClientRect: () => ({ width: 120, height: 40, top: 900, right: 120, bottom: 940, left: 0 }),
  };
  const parent = { postMessage: message => messages.push(message) };
  const window = {
    addEventListener: (type, listener) => { listeners[type] = listener; },
  };
  const document = {
    addEventListener: () => {},
    querySelectorAll: selector => selector === '.detail-title-inner' ? [node] : [],
  };
  const context = vm.createContext({
    CSS: { escape: value => value, supports: () => true },
    cancelAnimationFrame: () => {},
    clearInterval: () => {},
    document,
    getComputedStyle: () => ({ visibility: 'visible' }),
    innerHeight: 800,
    innerWidth: 1200,
    parent,
    requestAnimationFrame: callback => callback(),
    setInterval: () => 1,
    window,
  });

  vm.runInContext(source, context);
  listeners.message({
    source: parent,
    data: {
      channel: 'acorn-preview-sync',
      type: 'diff-overlay',
      enabled: false,
      locate: true,
      version: 1,
      requestId: 1,
      hints: [{ kind: 'selector', value: '.detail-title-inner', file: 'detail-styles.css' }],
    },
  });

  const status = messages.find(message => message.type === 'overlay-status');
  assert.equal(status.count, 0);
  assert.deepEqual([...status.matchedFiles], ['detail-styles.css']);
});

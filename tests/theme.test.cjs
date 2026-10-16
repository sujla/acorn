const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const themeSource = fs.readFileSync(new URL('../src/renderer/theme.js', `file://${__filename}`), 'utf8');
const indexSource = fs.readFileSync(new URL('../src/renderer/index.html', `file://${__filename}`), 'utf8');

function loadTheme({ saved = null, systemDark = false } = {}) {
  const options = ['light', 'dark', 'system'].map(theme => ({
    dataset: { themeOption: theme },
    setAttribute(name, value) { this[name] = value; },
  }));
  const listeners = {};
  const stored = new Map(saved === null ? [] : [['acorn.theme', saved]]);
  const media = {
    matches: systemDark,
    addEventListener(type, listener) { listeners[`media:${type}`] = listener; },
  };
  const choices = {
    addEventListener(type, listener) { listeners[`choices:${type}`] = listener; },
    querySelectorAll() { return options; },
    hidePopover() {},
  };
  const document = {
    documentElement: { dataset: {} },
    querySelectorAll() { return options; },
    getElementById(id) { return id === 'appearance-menu' ? choices : null; },
    addEventListener(type, listener) { listeners[`document:${type}`] = listener; },
  };
  const window = {
    matchMedia() { return media; },
    addEventListener(type, listener) { listeners[`window:${type}`] = listener; },
  };
  const localStorage = {
    getItem(key) { return stored.get(key) ?? null; },
    setItem(key, value) { stored.set(key, value); },
  };

  vm.runInNewContext(themeSource, { document, localStorage, window });
  listeners['document:DOMContentLoaded']();
  return { document, listeners, media, options, stored };
}

test('System is the default and follows the current OS theme', () => {
  const state = loadTheme({ systemDark: true });
  assert.equal(state.document.documentElement.dataset.theme, 'dark');
  assert.equal(state.options.find(option => option['aria-checked'] === 'true').dataset.themeOption, 'system');

  state.media.matches = false;
  state.listeners['media:change']();
  assert.equal(state.document.documentElement.dataset.theme, 'light');
});

test('an explicit saved theme still overrides the system theme', () => {
  const state = loadTheme({ saved: 'light', systemDark: true });
  assert.equal(state.document.documentElement.dataset.theme, 'light');
  assert.equal(state.options.find(option => option['aria-checked'] === 'true').dataset.themeOption, 'light');
});

test('clearing or invalidating the stored theme restores System', () => {
  const state = loadTheme({ saved: 'dark', systemDark: false });
  state.listeners['window:storage']({ key: 'acorn.theme', newValue: null });
  assert.equal(state.document.documentElement.dataset.theme, 'light');
  assert.equal(state.options.find(option => option['aria-checked'] === 'true').dataset.themeOption, 'system');
});

test('the initial appearance menu selects System without forcing a resolved theme', () => {
  assert.match(indexSource, /data-theme-option="system" aria-checked="true"/);
  assert.doesNotMatch(indexSource, /<html[^>]+data-theme=/);
});

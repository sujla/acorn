// Run with: node_modules/.bin/electron scripts/verify-page-picker.cjs
// Uses an isolated profile and synthetic pages, never connected projects.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'acorn-page-picker-'));
app.setPath('userData', path.join(temporary, 'profile'));

app.whenReady().then(async () => {
  let window;
  try {
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await window.loadURL('about:blank');
    await window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '../src/renderer/page-picker.js'), 'utf8'));
    const results = await window.webContents.executeJavaScript(`(async () => {
      document.body.innerHTML = '<input id="base-url">';
      const selected = [];
      const picker = createPagePicker(document.querySelector('input'), page => selected.push(page.id));
      const pages = [
        { id: 'home', label: 'Home', group: [] },
        { id: 'map', label: 'map', group: [] },
        { id: 'build', label: 'Build page', group: ['android', 'build'] },
        { id: 'android', label: 'Android page', group: ['android'] },
        { id: 'settings', label: 'Settings', group: ['account'] },
      ].map(page => ({ ...page, path: '/' + page.id, available: true }));
      picker.setCatalog({ pages });
      const menu = document.querySelector('.page-picker-menu');
      const settle = () => new Promise(resolve => setTimeout(resolve, 30));
      const open = async () => { menu.showPopover(); await settle(); };
      const click = label => [...menu.querySelectorAll('.page-picker-row')].find(row => row.querySelector('.page-picker-name').textContent === label).click();
      const state = () => ({
        columns: [...menu.querySelectorAll('.page-picker-column')].map(column => column.getAttribute('aria-label')),
        folders: [...menu.querySelectorAll('[aria-expanded="true"]')].map(row => row.querySelector('.page-picker-name').textContent),
        current: menu.querySelector('[aria-current="page"] .page-picker-name')?.textContent,
      });
      await open();
      click('android'); click('build'); click('map');
      await settle(); await open();
      const root = state();
      click('android'); click('build'); click('Build page');
      await settle(); await open();
      const nested = state();
      click('Android page'); await settle(); await open();
      const ancestor = state();
      picker.select('settings');
      const external = state();
      click('android'); click('build');
      picker.close(); await settle(); await open();
      const reopened = state();
      picker.setCatalog({ pages: pages.map(page => page.id === 'settings' ? { ...page, group: ['profile'] } : page) });
      const refreshed = state();
      picker.select('home');
      const home = state();
      return { root, nested, ancestor, external, reopened, refreshed, home, selected };
    })()`);
    assert.deepEqual(results.root, { columns: ['Pages'], folders: [], current: 'map' });
    assert.deepEqual(results.nested, { columns: ['Pages', 'android', 'build'], folders: ['android', 'build'], current: 'Build page' });
    assert.deepEqual(results.ancestor, { columns: ['Pages', 'android'], folders: ['android'], current: 'Android page' });
    assert.deepEqual(results.external, { columns: ['Pages', 'account'], folders: ['account'], current: 'Settings' });
    assert.deepEqual(results.reopened, results.external);
    assert.deepEqual(results.refreshed, { columns: ['Pages', 'profile'], folders: ['profile'], current: 'Settings' });
    assert.deepEqual(results.home, { columns: ['Pages'], folders: [], current: 'Home' });
    assert.deepEqual(results.selected, ['map', 'build', 'android']);
    console.log('PASS: root, nested, ancestor, external navigation, reopen, and catalog refresh folder state');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    app.exit(process.exitCode || 0);
  }
});

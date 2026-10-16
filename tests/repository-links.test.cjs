const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { githubRepository } = require('../src/renderer/repository-links.js');

test('GitHub metadata accepts HTTPS and SSH remotes without exposing credentials', () => {
  for (const remote of ['https://github.com/example-owner/example-repo.git', 'git@github.com:example-owner/example-repo.git', 'ssh://git@github.com/example-owner/example-repo.git', 'https://user:secret@github.com/example-owner/example-repo.git']) {
    assert.deepEqual(githubRepository(remote), { name: 'example-owner/example-repo', url: 'https://github.com/example-owner/example-repo' });
  }
  for (const remote of ['', '/local/path', 'https://gitlab.com/example-owner/example-repo', 'https://github.com.evil.test/example-owner/example-repo', 'https://github.com/example-owner/example-repo/issues', 'file://github.com/example-owner/example-repo']) assert.equal(githubRepository(remote), null);
});

test('native open actions use connected directories and the verified GitHub origin', async () => {
  const calls = [];
  let handler;
  const frame = {};
  const webContents = { mainFrame: frame };
  const event = { sender: webContents, senderFrame: frame };
  const context = vm.createContext({
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    mainWindow: { webContents },
    readRepositoryPaths: async () => ['/work/example-repo'],
    runGit: async (path, args) => { calls.push(['git', path, ...args]); return 'git@github.com:example-owner/example-repo.git'; },
    shell: { openPath: async path => { calls.push(['finder', path]); return ''; }, openExternal: async url => calls.push(['browser', url]) },
    githubRepository, cleanGitError: error => error.message,
  });
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/main/desktop-main.cjs'), 'utf8');
  const start = source.indexOf("ipcMain.handle('repositories:open-location'");
  vm.runInContext(source.slice(start, source.indexOf("ipcMain.handle('repositories:list'", start)), context);
  assert.equal((await handler(event, { path: '/work/example-repo', destination: 'directory' })).success, true);
  assert.equal((await handler(event, { path: '/work/example-repo', destination: 'github' })).success, true);
  assert.deepEqual(calls, [['finder', '/work/example-repo'], ['git', '/work/example-repo', 'remote', 'get-url', 'origin'], ['browser', 'https://github.com/example-owner/example-repo']]);
  assert.ok((await handler(event, { path: '/unconnected', destination: 'directory' })).error);
  assert.ok((await handler({ sender: {}, senderFrame: {} }, { path: '/work/unconnected', destination: 'github' })).error);
  assert.equal(calls.length, 3);
});

test('external preview links only open validated web URLs from the main frame', async () => {
  const calls = [];
  let handler;
  const frame = {};
  const webContents = { mainFrame: frame };
  const event = { sender: webContents, senderFrame: frame };
  const context = vm.createContext({
    URL,
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    mainWindow: { webContents },
    shell: { openExternal: async url => calls.push(url) },
  });
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/main/desktop-main.cjs'), 'utf8');
  const start = source.indexOf("ipcMain.handle('preview:open-external'");
  vm.runInContext(source.slice(start, source.indexOf("ipcMain.handle('repositories:open-location'", start)), context);
  assert.equal((await handler(event, { url: 'https://example.com/article-studio' })).success, true);
  for (const url of ['javascript:alert(1)', 'file:///tmp/private', 'https://user:secret@example.com/']) assert.ok((await handler(event, { url })).error);
  assert.ok((await handler({ sender: {}, senderFrame: {} }, { url: 'https://example.com/' })).error);
  assert.deepEqual(calls, ['https://example.com/article-studio']);
});

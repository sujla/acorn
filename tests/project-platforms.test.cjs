const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { detectProjectPlatforms } = require('../src/main/project-platforms.cjs');
test('platform detection distinguishes mobile, desktop and cross-platform projects without executing configs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-platforms-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  await fs.writeFile(path.join(root, 'app.config.js'), 'throw new Error("must not execute")');
  for (const [deps, label] of [[{expo:'57'}, 'Mobile App'], [{electron:'43','react-dom':'19'}, 'Desktop App'], [{expo:'57','react-native-web':'1'}, 'Mobile App'], [{'react-dom':'19'}, 'Web'], [{}, 'Unknown']]) {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({dependencies:deps}));
    assert.equal((await detectProjectPlatforms(root)).label, label);
  }
});

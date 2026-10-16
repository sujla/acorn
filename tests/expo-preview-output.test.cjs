const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { expoPreviewExclusions, findExpoStaticPreview } = require('../src/main/expo-preview-output.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-expo-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('Expo export selection requires an Expo package and a browser index', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'dist/index.html'), '<h1>Export</h1>');
  assert.equal(await findExpoStaticPreview(root), null);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  assert.equal(await findExpoStaticPreview(root), path.join(root, 'dist'));
  assert.deepEqual(expoPreviewExclusions(['dist', 'build', 'web-build', '.next'], { dependencies: { expo: '*' } }), ['build', '.next']);
  assert.deepEqual(expoPreviewExclusions(['dist', 'build'], {}), ['dist', 'build']);
  await fs.rm(path.join(root, 'dist/index.html'));
  await fs.mkdir(path.join(root, 'dist/client'));
  await fs.writeFile(path.join(root, 'dist/client/index.html'), '<h1>Server client</h1>');
  assert.equal(await findExpoStaticPreview(root), null, 'Missing export proceeds to automatic compilation');
});

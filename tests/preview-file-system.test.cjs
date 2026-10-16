const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');
function runtime() {
  const code = esbuild.transformSync(fs.readFileSync(require.resolve('../src/main/expo-preview/file-system.js'), 'utf8'), { format: 'cjs' }).code;
  const context = { module: { exports: {} }, fetch };
  vm.runInNewContext(code, context);
  return context.module.exports;
}
test('preview storage supports notebook lifecycle and isolates frames', async () => {
  const { Directory, File, Paths } = runtime();
  const root = new Directory(Paths.document, 'pageish');
  const media = new Directory(root, 'media');
  root.create({ idempotent: true, intermediates: true });
  root.create({ idempotent: true });
  media.create();
  const notebook = new File(root, 'notebook.json');
  assert.equal(notebook.exists, false);
  notebook.create();
  notebook.write(JSON.stringify({ pages: [{ name: 'Edited page' }] }));
  assert.equal(JSON.parse(await notebook.text()).pages[0].name, 'Edited page');
  const image = new File(media, 'photo.png');
  new File('data:text/plain,selected-image').copy(image);
  assert.equal(image.uri, 'data:text/plain,selected-image');
  assert.equal(await image.text(), 'selected-image');
  assert.equal(root.list().length, 2);
  const isolated = runtime();
  assert.equal(new isolated.File(isolated.Paths.document, 'pageish', 'notebook.json').exists, false);
  root.delete();
  assert.equal(notebook.exists, false);
  assert.equal(image.exists, false);
});
test('preview storage rejects device access and invalid operations', () => {
  const { File, Directory, Paths } = runtime();
  assert.throws(() => new File('file:///etc/passwd'), /cannot access device files/);
  assert.throws(() => new File(Paths.document, '..', 'outside'), /Invalid preview path/);
  assert.throws(() => new File(Paths.document, 'absent').textSync(), /not available/);
  assert.throws(() => new File(Paths.document, 'missing', 'child').create(), /parent directory/);
  assert.throws(() => new File(Paths.document, 'binary').write(new Uint8Array(2)), /text only/);
  assert.throws(() => new Directory(Paths.document).create(), /already exists/);
});

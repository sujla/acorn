const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  compilerSpec,
  managedCompilerPath,
  sha256,
  tarEntry,
  verifiedCompiler,
  installPreviewCompiler,
} = require('../src/main/preview-compiler-install.cjs');

function archive(name, contents) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write('0000755\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${contents.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  const padding = Buffer.alloc((512 - contents.length % 512) % 512);
  return Buffer.concat([header, contents, padding, Buffer.alloc(1024)]);
}

test('selects the exact official package and checksum for Apple Silicon', () => {
  const spec = compilerSpec('darwin', 'arm64');
  assert.equal(spec.packageName, '@esbuild/darwin-arm64');
  assert.equal(spec.version, '0.28.2');
  assert.equal(spec.checksum, '10b6243df618d374bb2d5c9cfbe7052e1405f6aa4e53a6164f11a91b9f2e1384');
  assert.equal(spec.url, 'https://registry.npmjs.org/@esbuild/darwin-arm64/-/darwin-arm64-0.28.2.tgz');
});

test('extracts only the requested tar entry', () => {
  const binary = Buffer.from('verified compiler');
  const tar = archive('package/bin/esbuild', binary);
  assert.deepEqual(tarEntry(tar, 'package/bin/esbuild'), binary);
  assert.throws(() => tarEntry(tar, 'package/other'), /expected executable/);
});

test('installs a verified compiler into the managed directory and reuses it', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-compiler-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = Buffer.from('test compiler binary');
  const spec = {
    platform: 'darwin', arch: 'arm64', version: 'test', fileName: 'esbuild',
    archivePath: 'package/bin/esbuild', checksum: sha256(binary), url: 'https://registry.npmjs.org/example.tgz',
  };
  let downloads = 0;
  const downloadArchive = async () => { downloads++; return zlib.gzipSync(archive(spec.archivePath, binary)); };
  const installed = await installPreviewCompiler(directory, { platform: 'darwin', arch: 'arm64', spec, downloadArchive });
  assert.equal(installed.path, managedCompilerPath(directory, spec));
  assert.deepEqual(await fs.readFile(installed.path), binary);
  assert.equal(await verifiedCompiler(directory, { platform: 'darwin', arch: 'arm64', spec }), installed.path);
  const reused = await installPreviewCompiler(directory, { platform: 'darwin', arch: 'arm64', spec, downloadArchive });
  assert.equal(reused.cached, true);
  assert.equal(downloads, 1);
});

test('rejects an archive whose executable does not match the pinned checksum', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-compiler-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const spec = {
    platform: 'darwin', arch: 'arm64', version: 'test', fileName: 'esbuild',
    archivePath: 'package/bin/esbuild', checksum: sha256(Buffer.from('expected')), url: 'https://registry.npmjs.org/example.tgz',
  };
  const downloadArchive = async () => zlib.gzipSync(archive(spec.archivePath, Buffer.from('tampered')));
  await assert.rejects(installPreviewCompiler(directory, { platform: 'darwin', arch: 'arm64', spec, downloadArchive }), /integrity check/);
  await assert.rejects(fs.access(managedCompilerPath(directory, spec)));
});

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gunzip = promisify(zlib.gunzip);
const maxArchiveBytes = 32 * 1024 * 1024;
const maxExpandedArchiveBytes = 64 * 1024 * 1024;
const platformPackages = {
  'darwin/arm64': '@esbuild/darwin-arm64',
  'darwin/x64': '@esbuild/darwin-x64',
  'linux/arm': '@esbuild/linux-arm',
  'linux/arm64': '@esbuild/linux-arm64',
  'linux/ia32': '@esbuild/linux-ia32',
  'linux/loong64': '@esbuild/linux-loong64',
  'linux/mips64el': '@esbuild/linux-mips64el',
  'linux/ppc64': '@esbuild/linux-ppc64',
  'linux/riscv64': '@esbuild/linux-riscv64',
  'linux/s390x': '@esbuild/linux-s390x',
  'linux/x64': '@esbuild/linux-x64',
  'freebsd/arm64': '@esbuild/freebsd-arm64',
  'freebsd/x64': '@esbuild/freebsd-x64',
  'netbsd/arm64': '@esbuild/netbsd-arm64',
  'netbsd/x64': '@esbuild/netbsd-x64',
  'openbsd/arm64': '@esbuild/openbsd-arm64',
  'openbsd/x64': '@esbuild/openbsd-x64',
  'sunos/x64': '@esbuild/sunos-x64',
  'win32/arm64': '@esbuild/win32-arm64',
  'win32/ia32': '@esbuild/win32-ia32',
  'win32/x64': '@esbuild/win32-x64',
};

function compilerSpec(platform = process.platform, arch = process.arch) {
  const metadata = require('esbuild/package.json');
  const packageName = platformPackages[`${platform}/${arch}`];
  const binarySubpath = platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  const version = packageName && metadata.optionalDependencies?.[packageName];
  const checksum = packageName && metadata['esbuild.binaryHashes']?.[`${packageName}/${binarySubpath}`];
  if (!packageName || !version || !checksum) {
    const error = new Error(`No verified preview compiler is available for ${platform}/${arch}.`);
    error.code = 'UNSUPPORTED_PREVIEW_COMPILER';
    throw error;
  }
  const archiveName = packageName.slice(packageName.indexOf('/') + 1);
  return {
    platform,
    arch,
    packageName,
    version,
    checksum,
    archivePath: `package/${binarySubpath}`,
    fileName: path.basename(binarySubpath),
    url: `https://registry.npmjs.org/${packageName}/-/${archiveName}-${version}.tgz`,
  };
}

function managedCompilerPath(directory, spec = compilerSpec()) {
  return path.join(directory, 'preview-compilers', 'esbuild', spec.version, `${spec.platform}-${spec.arch}`, spec.fileName);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function tarEntry(archive, expectedPath) {
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('The preview compiler archive is malformed.');
    const start = offset + 512;
    const end = start + size;
    if (end > archive.length) throw new Error('The preview compiler archive is truncated.');
    if (name === expectedPath) return archive.subarray(start, end);
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error('The preview compiler archive does not contain the expected executable.');
}

function download(url, { get = https.get } = {}) {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { 'User-Agent': 'Acorn preview compiler installer', Accept: 'application/octet-stream' } }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`The preview compiler download failed (HTTP ${response.statusCode || 'unknown'}).`));
        return;
      }
      const declaredLength = Number(response.headers['content-length'] || 0);
      if (declaredLength > maxArchiveBytes) {
        response.destroy(new Error('The preview compiler download is larger than expected.'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxArchiveBytes) response.destroy(new Error('The preview compiler download is larger than expected.'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.setTimeout(30000, () => request.destroy(new Error('The preview compiler download timed out.')));
    request.on('error', reject);
  });
}

async function verifiedCompiler(directory, { platform = process.platform, arch = process.arch, spec = compilerSpec(platform, arch) } = {}) {
  const file = managedCompilerPath(directory, spec);
  try {
    const binary = await fs.readFile(file);
    return sha256(binary) === spec.checksum ? file : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function installPreviewCompiler(directory, { platform = process.platform, arch = process.arch, spec = compilerSpec(platform, arch), downloadArchive = download } = {}) {
  const file = managedCompilerPath(directory, spec);
  const existing = await verifiedCompiler(directory, { platform, arch, spec });
  if (existing) return { path: existing, version: spec.version, platform, arch, cached: true };
  const compressed = await downloadArchive(spec.url);
  const archive = await gunzip(compressed, { maxOutputLength: maxExpandedArchiveBytes });
  const binary = tarEntry(archive, spec.archivePath);
  if (sha256(binary) !== spec.checksum) throw new Error('The preview compiler failed its integrity check. Nothing was installed.');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, binary, { mode: 0o755 });
    await fs.chmod(temporary, 0o755);
    await fs.rm(file, { force: true });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return { path: file, version: spec.version, platform, arch, cached: false };
}

module.exports = { compilerSpec, managedCompilerPath, sha256, tarEntry, download, verifiedCompiler, installPreviewCompiler };

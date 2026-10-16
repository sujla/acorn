const fs = require('node:fs/promises');
const path = require('node:path');

const expoOutputDirectories = ['dist', 'web-build'];

async function isFile(file) {
  try { return (await fs.stat(file)).isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function isExpoPackage(pkg) {
  return Boolean(pkg?.dependencies?.expo || pkg?.devDependencies?.expo);
}

function expoPreviewExclusions(directories, pkg) {
  return isExpoPackage(pkg) ? directories.filter(directory => !expoOutputDirectories.includes(directory)) : directories;
}

async function findExpoStaticPreview(root) {
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!isExpoPackage(pkg)) return null;
  for (const directory of expoOutputDirectories) {
    const candidate = path.join(root, directory);
    // Never accept a server export's client subtree as a standalone application.
    if (await isFile(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

module.exports = { isExpoPackage, expoPreviewExclusions, findExpoStaticPreview };

const fs = require('node:fs/promises');
const path = require('node:path');

const defaultPreviewOutputs = ['dist', 'build', 'out', 'web-build', '.next', '.nuxt', '.output'];
const isViteConfig = name => /^vite\.config\.(?:[cm]?[jt]s)$/.test(name);
const previewOutputDirectories = (configured = []) => [...new Set([...defaultPreviewOutputs, ...configured])];
function isPreviewOutput(file, directories) {
  const relative = file.split(path.sep).join('/');
  return directories.some(directory => relative === directory || relative.startsWith(directory + '/'));
}
async function localPreviewOutputDirectories(root) {
  return previewOutputDirectories(await localOutputDirectories(root));
}

// Read literal Vite output paths without executing project configuration code.
function parseOutputDirectories(source) {
  const uncommented = source.replace(/(["'`])(?:\\.|(?!\1)[^\\])*?\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, token => token.startsWith('//') || token.startsWith('/*') ? ' ' : token);
  const directories = [];
  for (const match of uncommented.matchAll(/\boutDir\s*:\s*(["'])([^"'\r\n]+)\1/g)) {
    const raw = match[2].replaceAll('\\', '/');
    if (raw.includes('${') || raw.startsWith('/') || /^[a-z]:/i.test(raw) || raw.split('/').includes('..')) continue;
    const directory = path.posix.normalize(raw).replace(/\/$/, '');
    if (!directory || directory === '.' || directory === '.git' || /[\x00-\x1f]/.test(directory)) continue;
    directories.push(directory);
  }
  return [...new Set(directories)];
}
async function configuredOutputDirectories(runGit, root, refs) {
  const paths = await Promise.all([...new Set(refs)].map(async ref => {
    const working = ref === '__working_tree__';
    const names = working ? await fs.readdir(root) : (await runGit(root, ['ls-tree', '--name-only', ref])).split('\n');
    const configs = names.filter(name => /^vite\.config\.(?:[cm]?[jt]s)$/.test(name));
    return (await Promise.all(configs.map(async name => {
      const source = working ? await fs.readFile(path.join(root, name), 'utf8') : await runGit(root, ['show', `${ref}:${name}`]);
      return parseOutputDirectories(source);
    }))).flat();
  }));
  return [...new Set(paths.flat())];
}
async function localOutputDirectories(root) {
  const names = (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isFile() && isViteConfig(entry.name)).map(entry => entry.name);
  const directories = await Promise.all(names.map(async name => parseOutputDirectories(await fs.readFile(path.join(root, name), 'utf8'))));
  return [...new Set(directories.flat())];
}
module.exports = { parseOutputDirectories, configuredOutputDirectories, localOutputDirectories, isViteConfig, previewOutputDirectories, isPreviewOutput, localPreviewOutputDirectories };

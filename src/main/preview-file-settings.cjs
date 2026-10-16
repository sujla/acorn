const fs = require('node:fs/promises');
const path = require('node:path');
const { localPreviewOutputDirectories } = require('./generated-output.cjs');
const { expoPreviewExclusions } = require('./expo-preview-output.cjs');
const { analyzePreviewReferences } = require('./preview-references.cjs');

const generated = {
  'android/app/build': 'Android build output',
  'android/build': 'Android build output',
  'android/app/.cxx': 'Native build intermediates',
  'android/.gradle': 'Gradle cache',
  'ios/Pods': 'Installed iOS dependencies',
  'ios/build': 'iOS build output',
};
const internal = new Set(['.git', 'node_modules', '.next', '.expo', '.cache', '.acorn-runtime']);
const safePath = value => typeof value === 'string' && value.length > 0 && value.length < 1024 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..' || internal.has(part) || part === '.env' || part.startsWith('.env.'));
function normalizeSettings(value = {}) {
  const entries = Object.entries(value.overrides || {});
  if (entries.length > 1000 || entries.some(([name, included]) => !safePath(name) || typeof included !== 'boolean')) throw new Error('Invalid preview folder selection.');
  return { overrides: Object.fromEntries(entries) };
}
function automaticExclusions(outputs) { return [...new Set([...outputs, ...Object.keys(generated)])]; }
function includedFolder(name, automatic, settings = {}) {
  const overrides = settings.overrides || {};
  const match = Object.keys(overrides).filter(key => name === key || name.startsWith(key + '/')).sort((a, b) => b.length - a.length)[0];
  if (match) return overrides[match];
  return !automatic.some(key => name === key || name.startsWith(key + '/'));
}
function resolveExclusions(outputs, settings = {}) {
  settings = normalizeSettings(settings);
  const automatic = automaticExclusions(outputs);
  // A selected descendant cannot be reached through an excluded parent. The UI
  // selects ancestors when a child is selected, so malformed combinations fail.
  const excluded = [...new Set([...automatic, ...Object.keys(settings.overrides)])].filter(name => !includedFolder(name, automatic, settings));
  for (const [name, included] of Object.entries(settings.overrides)) {
    if (included && excluded.some(parent => name.startsWith(parent + '/'))) throw new Error('Include the parent folder before including a subfolder.');
  }
  return excluded;
}
async function scanPreviewFolders(root, settings = {}, onProgress = () => {}) {
  settings = normalizeSettings(settings);
  onProgress({ value: 0, message: 'Checking project folders…' });
  const entries = await fs.readdir(root, { withFileTypes: true });
  onProgress({ value: 1, message: 'Checking build output settings…' });
  const pkg = await fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
  const outputs = expoPreviewExclusions(await localPreviewOutputDirectories(root), pkg);
  const automatic = automaticExclusions(outputs);
  onProgress({ value: 2, message: 'Checking generated folders and native dependencies…' });
  const candidates = new Set(entries.filter(entry => entry.isDirectory() && safePath(entry.name)).map(entry => entry.name));
  const presentFolders = new Set(candidates);
  for (const name of [...automatic, ...Object.keys(settings.overrides)]) {
    if (!safePath(name)) continue;
    // Inspect each component without following symlinks outside the repository.
    let present = true, current = root;
    for (const part of name.split('/')) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
      if (!stat?.isDirectory() || stat.isSymbolicLink()) { present = false; break; }
    }
    if (present) presentFolders.add(name);
    if (present || name in settings.overrides) candidates.add(name);
  }
  onProgress({ value: 3, message: 'Following preview source references…' });
  const analysis = await analyzePreviewReferences(root, { automatic, pkg });
  const referenced = name => [...analysis.needed].some(file => file.startsWith(name + '/'));
  // Unknown references must not opt every unrelated folder into the preview.
  // Keep confirmed dependencies; users can explicitly include unresolved ones.
  const recommendationExclusions = [...new Set([...automatic, ...[...candidates].filter(name => !referenced(name))])];
  const folders = [...candidates].sort().map(name => ({
    path: name,
    included: includedFolder(name, recommendationExclusions, settings),
    recommended: !automatic.some(dir => name === dir || name.startsWith(dir + '/')) && referenced(name),
    reason: generated[name] || (automatic.includes(name) ? 'Generated build output' : referenced(name) ? 'Referenced by preview source' : analysis.complete ? 'No reference from preview entries' : 'No confirmed reference; analysis is incomplete'),
    custom: name in settings.overrides,
    present: presentFolders.has(name),
  }));
  onProgress({ value: 4, message: 'Folder check complete' });
  return { folders, settings, automatic: recommendationExclusions, warnings: analysis.warnings };
}
module.exports = { normalizeSettings, scanPreviewFolders, resolveExclusions, includedFolder, automaticExclusions };

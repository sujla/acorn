const fs = require('node:fs/promises');
const path = require('node:path');
const { localPreviewOutputDirectories, isPreviewOutput } = require('./generated-output.cjs');
const { supportsVisualFallback } = require('./preview-visual-support.cjs');

const ignored = new Set(['.git', 'node_modules', '.next', '.expo', '.cache', '.turbo', 'coverage', 'vendor']);
const dynamic = /\[[^\]]+\]|:[\w]+|\*/;
function localPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20]/.test(value)) return null;
  try { const url = new URL(value, 'http://preview.local'); return url.origin === 'http://preview.local' ? value : null; } catch { return null; }
}
async function filesIn(root, outputDirectories) {
  const files = [];
  async function walk(dir, depth = 0) {
    if (depth > 16 || files.length > 12000) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (isPreviewOutput(path.relative(root, full), outputDirectories)) continue;
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  await walk(root);
  return files;
}
function page(route, source, options = {}) {
  const parts = route.split('/').filter(Boolean);
  const group = options.group || parts.slice(0, -1);
  const docs = Boolean(options.docs);
  return {
    id: route,
    path: route,
    label: route === '/' ? 'Home' : parts.at(-1),
    group,
    source,
    note: dynamic.test(route) ? 'Needs a concrete path in .acorn/pages.json' : 'UI only · app guards remain unless a preview entry is configured',
    ...options,
    docs,
    available: !docs && (options.available ?? !dynamic.test(route)),
  };
}
function normalizeManifest(value) {
  if (!value || !Array.isArray(value.pages) || value.pages.length > 1000) throw new Error('.acorn/pages.json must contain a pages array (up to 1000 pages).');
  const ids = new Set();
  return value.pages.map((entry, index) => {
    const route = localPath(entry.path);
    const previewPath = entry.previewPath == null ? route : localPath(entry.previewPath);
    if (!route || !previewPath || dynamic.test(previewPath)) throw new Error(`Page ${index + 1} needs a concrete local path.`);
    const id = String(entry.id || route);
    if (ids.has(id)) throw new Error(`Duplicate page id: ${id}`);
    ids.add(id);
    if (entry.group != null && (!Array.isArray(entry.group) || entry.group.some(part => typeof part !== 'string' || !part))) throw new Error(`Invalid group for ${id}`);
    if (entry.visualFallback != null && typeof entry.visualFallback !== 'boolean') throw new Error(`Invalid visualFallback for ${id}`);
    return page(route, '.acorn/pages.json', { id, label: String(entry.label || route), group: entry.group || [], previewPath, visualFallback: entry.visualFallback === true, available: true, note: entry.previewPath ? 'UI only · project preview entry' : 'UI only · direct route' });
  });
}
async function discoverPages(root, { outputDirectories } = {}) {
  outputDirectories ||= await localPreviewOutputDirectories(root);
  const excludedRoute = route => isPreviewOutput(decodeURIComponent(new URL(route, 'http://preview.local').pathname).replace(/^\//, ''), outputDirectories);
  try {
    const pages = normalizeManifest(JSON.parse(await fs.readFile(path.join(root, '.acorn/pages.json'), 'utf8')));
    const filtered = pages.filter(page => !excludedRoute(page.path) && !excludedRoute(page.previewPath));
    return { pages: filtered, source: 'manifest', warnings: filtered.length === pages.length ? [] : ['Generated output pages are excluded from preview.'] };
  }
  catch (error) { if (error.code !== 'ENOENT') return { pages: [], source: 'manifest', warnings: [error.message] }; }
  const files = await filesIn(root, outputDirectories);
  let pkg = {};
  try { pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); } catch { /* Static project. */ }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const html = files.includes('index.html') ? await fs.readFile(path.join(root, 'index.html'), 'utf8') : '';
  // Only expose screens whose actual DOM exists in the current Acorn UI.
  if (pkg.name === 'acorn' && html.includes('id="app-shell"')) {
    const pages = [page('/', 'index.html', { id: 'acorn:workspace', label: 'Workspace', group: [], adapter: 'acorn', screen: 'workspace', note: 'UI only · empty workspace' })];
    if (html.includes('id="settings-dialog"')) pages.push(page('/', 'index.html', { id: 'acorn:settings-dialog', label: 'Settings', group: [], adapter: 'acorn', screen: 'settings-dialog', note: 'UI only · desktop actions disabled' }));
    return { pages, source: 'acorn', warnings: [] };
  }
  const found = new Map();
  const add = (route, source) => { if (localPath(route) && !excludedRoute(route) && !found.has(route)) found.set(route, page(route, source)); };
  for (const file of files) {
    if (/\.html?$/.test(file) && !/^(dist|build|public)\//.test(file)) add('/' + file.replace(/(^|\/)index\.html?$/, '$1'), file);
    if (deps.next && /^(src\/)?app\/(?:.*\/)?page\.[jt]sx?$/.test(file)) {
      const route = file.replace(/^(src\/)?app\//, '').replace(/\/?page\.[jt]sx?$/, '').split('/').filter(p => p && !/^\(.*\)$/.test(p));
      if (!route.some(p => p.startsWith('@') || p.startsWith('_') || p.startsWith('('))) add('/' + route.join('/'), file);
    }
    if ((deps.next && /^(src\/)?pages\//.test(file)) || (deps['expo-router'] && /^(src\/)?app\//.test(file))) {
      let route = file.replace(/^(src\/)?(pages|app)\//, '');
      if (!/\.[jt]sx?$/.test(route) || /(^|\/)(_|\+|api\/)/.test(route) || /\+api\.[jt]sx?$/.test(route)) continue;
      route = route.replace(/\.[jt]sx?$/, '').split('/').filter(p => !/^\(.*\)$/.test(p)).join('/').replace(/(^|\/)index$/, '');
      add('/' + route.replace(/\/$/, ''), file);
    }
  }
  const routeSources = files.filter(file => /\.[jt]sx?$/.test(file) && !/^(dist|build|public|tests?|scripts)\//.test(file));
  const sourceTexts = new Map();
  const parameterValues = new Map();
  for (const file of routeSources) {
    const stat = await fs.stat(path.join(root, file));
    if (stat.size > 512000) continue;
    const source = await fs.readFile(path.join(root, file), 'utf8');
    sourceTexts.set(file, source);
    for (const match of source.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*\[((?:\s*["'][^"']+["']\s*,?)+)\]\s*(?:as\s+const)?/g)) {
      const values = [...match[2].matchAll(/["']([^"']+)["']/g)].map(item => item[1]);
      if (values.length && values.length <= 50) parameterValues.set(match[1], values);
    }
    // Concrete internal destinations are useful even when their screen file is dynamic.
    for (const match of source.matchAll(/(?:\bhref\s*=|\b(?:push|replace)\s*\()\s*["'](\/[^"'${}\s]+)["']/g)) {
      if (!/\.[a-z0-9]{2,5}(?:[?#]|$)/i.test(match[1])) add(match[1], file);
    }
  }
  for (const candidate of [...found.values()].filter(candidate => dynamic.test(candidate.path))) {
    const parameters = [...candidate.path.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]);
    if (parameters.length !== 1) continue;
    const parameter = parameters[0];
    const values = parameterValues.get(parameter + 's') || [...parameterValues].find(([name]) => name.toLowerCase().endsWith(parameter.toLowerCase() + 's'))?.[1];
    for (const value of values || []) add(candidate.path.replace(`[${parameter}]`, encodeURIComponent(value)), candidate.source);
  }
  // Literal absolute routes only. Relative/nested/computed routes require explicit IA to avoid invented URLs.
  for (const [file, source] of sourceTexts) {
    for (const match of source.matchAll(/<Route\b[^>]*?\bpath\s*=\s*["'](\/[^"']*)["']/g)) add(match[1], file);
  }
  if (!found.size && files.some(file => /\.(?:html?|[cm]?[jt]sx?)$/.test(file) && !/^vite\.config\./.test(file))) add('/', 'entry');
  if (deps['expo-router']) {
    for (const candidate of found.values()) {
      candidate.visualFallback = supportsVisualFallback(sourceTexts.get(candidate.source) || '');
    }
  }
  return { pages: [...found.values()].sort((a, b) => a.path.localeCompare(b.path)), source: 'discovered', warnings: ['Detected routes are not a complete semantic IA. Protected or data-dependent screens need a project preview entry in .acorn/pages.json.'] };
}
module.exports = { discoverPages, normalizeManifest, localPath };

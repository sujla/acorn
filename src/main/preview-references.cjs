const fs = require('node:fs/promises');
const path = require('node:path');
const { parse } = require('@babel/parser');

const textFile = /\.(?:html?|[cm]?[jt]sx?|css|scss|sass|less|json|svg|vue|svelte)$/i;
const extensions = ['', '.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json', '.css', '.svg', '.html'];
const blocked = new Set(['.git', 'node_modules', '.cache', '.next', '.expo', '.acorn-runtime']);
const safe = name => name && !name.startsWith('../') && !path.posix.isAbsolute(name) && !name.split('/').some(p => blocked.has(p) || p === '.env' || p.startsWith('.env.'));
const literal = node => node?.type === 'StringLiteral' ? node.value : node?.type === 'TemplateLiteral' ? node.quasis[0].value.cooked : null;

// Read project text only: never evaluate config files, import modules, or follow links.
async function analyzePreviewReferences(root, { automatic, pkg, maxFiles = 20000, maxBytes = 2000000 }) {
  const files = new Set(), needed = new Set(), queue = [], warnings = new Set();
  const excluded = name => automatic.some(dir => name === dir || name.startsWith(dir + '/'));
  async function walk(dir = '', depth = 0) {
    if (depth > 24 || files.size >= maxFiles) { warnings.add('Project is too large for complete reference analysis.'); return; }
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const name = path.posix.join(dir, entry.name);
      if (!safe(name) || excluded(name) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(name, depth + 1);
      else if (entry.isFile()) { files.add(name); if (files.size >= maxFiles) { warnings.add('Project is too large for complete reference analysis.'); return; } }
    }
  }
  await walk();
  function add(name) { if (files.has(name) && !needed.has(name)) { needed.add(name); queue.push(name); return true; } return files.has(name); }
  function tree(prefix) { for (const name of files) if (name.startsWith(prefix + '/')) add(name); }
  async function read(name) {
    if ((await fs.stat(path.join(root, name))).size > maxBytes) { warnings.add(`Reference analysis skipped a large file: ${name}`); return ''; }
    return fs.readFile(path.join(root, name), 'utf8');
  }
  async function json(name) {
    if (!files.has(name)) return {};
    try { return JSON.parse((await read(name)).replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, token => token.startsWith('/') ? '' : token).replace(/,\s*([}\]])/g, '$1')); }
    catch { warnings.add(`Cannot analyze configuration: ${name}`); return {}; }
  }
  const config = await json(files.has('tsconfig.json') ? 'tsconfig.json' : 'jsconfig.json');
  if (config.extends) warnings.add('Extended path configuration needs review.');
  const baseUrl = config.compilerOptions?.baseUrl || '.';
  const aliases = config.compilerOptions?.paths || {};
  const declarations = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  function resolve(value, importer, { module = false, prefix = false } = {}) {
    if (typeof value !== 'string' || !value || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(value) || (!module && value.startsWith('#'))) return false;
    let raw;
    try { raw = decodeURIComponent(value.startsWith('#') ? value : value.split(/[?#]/)[0]); } catch { return false; }
    const candidates = [];
    for (const [key, targets] of Object.entries(aliases)) {
      const [start, end = ''] = key.split('*');
      if (key.includes('*') ? raw.startsWith(start) && raw.endsWith(end) : raw === key) {
        const middle = raw.slice(start.length, end ? -end.length : undefined);
        for (const target of targets) candidates.push(path.posix.join(baseUrl, target.replace('*', middle)));
      }
    }
    if (raw.startsWith('/')) candidates.push(raw.slice(1), 'public/' + raw.slice(1));
    else if (!module || raw.startsWith('.')) candidates.push(path.posix.join(path.posix.dirname(importer), raw), raw, 'public/' + raw);
    else if (config.compilerOptions?.baseUrl) candidates.push(path.posix.join(baseUrl, raw));
    let found = false;
    for (const candidate of candidates.map(p => path.posix.normalize(p))) {
      if (!safe(candidate)) continue;
      if (prefix) {
        // Keep the directory of a computed path, including modules it may load.
        const dir = candidate.endsWith('/') ? candidate.slice(0, -1) : path.posix.dirname(candidate);
        if (dir === '.') { warnings.add(`Unbounded computed reference in ${importer}`); continue; }
        for (const name of files) if (name.startsWith(dir + '/')) { add(name); found = true; }
      } else {
        for (const suffix of extensions) if (add(candidate + suffix)) { found = true; break; }
        for (const suffix of extensions.slice(1)) if (add(path.posix.join(candidate, 'index' + suffix))) { found = true; break; }
      }
    }
    const packageName = raw.startsWith('@') ? raw.split('/').slice(0, 2).join('/') : raw.split('/')[0];
    if (module && !found && (raw.startsWith('.') || raw.startsWith('/') || !declarations[packageName] || /^(file:|link:|workspace:)/.test(declarations[packageName]))) warnings.add(`Unresolved local import in ${importer}: ${value}`);
    return found;
  }
  const recipe = await json('.acorn/preview.json');
  tree('.acorn');
  let entryFound = false;
  if (recipe.entry) entryFound = resolve(recipe.entry, 'index.html');
  for (const file of files) if (!file.includes('/') && /\.html?$/.test(file)) { add(file); entryFound = true; }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const dir of (deps.next ? ['app', 'src/app', 'pages', 'src/pages'] : deps['expo-router'] ? ['app', 'src/app'] : [])) {
    if ([...files].some(file => file.startsWith(dir + '/'))) { tree(dir); entryFound = true; }
  }
  if (!entryFound) {
    for (const entry of [pkg.main, 'src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js', 'src/index.tsx', 'src/index.jsx', 'src/index.ts', 'src/index.js', 'App.tsx', 'App.jsx', 'App.js', 'index.js'].filter(Boolean)) {
      if (resolve(entry, 'index.html')) { entryFound = true; break; }
    }
  }
  if (!entryFound) {
    for (const file of files) if (/\.html?$/.test(file)) { add(file); entryFound = true; }
  }
  if (!entryFound) warnings.add('No supported preview entry was found.');
  // Public files can be requested by runtime data without appearing in source.
  tree('public');
  if (deps.expo) { add('app.json'); tree('assets'); }
  function scanJS(source, file) {
    let ast;
    try { ast = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx', 'decorators-legacy'], errorRecovery: false }); }
    catch { warnings.add(`Cannot parse source references: ${file}`); return; }
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'StringLiteral') resolve(node.value, file);
      if (node.type === 'TemplateLiteral' && literal(node)?.includes('/')) resolve(literal(node), file, { prefix: node.expressions.length > 0 });
      if (node.type === 'BinaryExpression' && node.operator === '+' && literal(node.left)?.includes('/')) resolve(literal(node.left), file, { prefix: true });
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) resolve(node.source.value, file, { module: true });
      if (node.type === 'CallExpression' && (node.callee.type === 'Import' || node.callee.name === 'require')) {
        const value = literal(node.arguments[0]);
        if (value == null || (node.arguments[0]?.expressions?.length && !value.includes('/'))) warnings.add(`Computed module reference needs review: ${file}`);
        else resolve(value, file, { module: true, prefix: node.arguments[0]?.expressions?.length > 0 });
      }
      if (node.type === 'NewExpression' && node.callee.name === 'URL' && node.arguments[1]?.object?.type === 'MetaProperty') {
        const value = literal(node.arguments[0]);
        if (!value || (node.arguments[0]?.expressions?.length && !value.includes('/'))) warnings.add(`Computed asset URL needs review: ${file}`);
      }
      if (node.type === 'CallExpression' && ['glob', 'globEager', 'context'].includes(node.callee.property?.name)) {
        const values = node.arguments[0]?.type === 'ArrayExpression' ? node.arguments[0].elements : [node.arguments[0]];
        for (const arg of values) {
          const value = literal(arg);
          if (value == null) warnings.add(`Computed file collection needs review: ${file}`);
          else resolve(value.includes('*') ? value.split('*')[0] : value.replace(/\/$/, '') + '/', file, { prefix: true });
        }
      }
      for (const [key, child] of Object.entries(node)) if (!['loc', 'start', 'end', 'extra', 'comments', 'tokens'].includes(key)) {
        if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child);
      }
    }
    visit(ast.program);
  }
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index];
    if (!textFile.test(file)) continue;
    const source = await read(file);
    const js = /\.[cm]?[jt]sx?$/.test(file);
    if (js) {
      scanJS(source, file);
    } else {
      const clean = source.replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g, '');
      if (/\.(scss|sass|less)$/.test(file)) warnings.add(`Stylesheet transform references need review: ${file}`);
      if (/\.json$/.test(file)) {
        try {
          const visit = value => { if (typeof value === 'string') resolve(value, file); else if (value && typeof value === 'object') Object.values(value).forEach(visit); };
          visit(JSON.parse(source));
        } catch { warnings.add(`Cannot parse data references: ${file}`); }
      }
      for (const match of clean.matchAll(/(?:\b(?:src|href|poster|srcset|data-[\w-]+)\s*=\s*|\burl\(\s*|@import\s*)(["'])(.*?)\1/gi)) {
        const values = /^srcset/i.test(match[0]) ? match[2].split(',').map(value => value.trim().split(/\s+/)[0]) : [match[2]];
        for (const value of values) resolve(value.trim(), file);
      }
      for (const match of clean.matchAll(/\b(?:src|href|poster)\s*=\s*([^\s"'=<>`]+)/gi)) resolve(match[1], file);
      for (const match of clean.matchAll(/\burl\(\s*([^"'\s)][^)]*)\)/gi)) resolve(match[1].trim(), file);
      if (/\.html?$/.test(file)) {
        if (/<base\b/i.test(clean)) warnings.add(`HTML base URL needs review: ${file}`);
        for (const script of clean.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
          if (!/\bsrc\s*=/i.test(script[1]) && !/\btype\s*=\s*["'](?:application\/ld\+json|application\/json|importmap)/i.test(script[1])) scanJS(script[2], file);
        }
        for (const style of clean.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
          for (const url of style[1].matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) resolve(url[1], file);
        }
      }
      if (/\.(vue|svelte)$/.test(file)) warnings.add(`Component references need review: ${file}`);
    }
  }
  return { needed, warnings: [...warnings], complete: warnings.size === 0 };
}
module.exports = { analyzePreviewReferences };

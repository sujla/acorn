const fs = require('fs/promises');
const path = require('path');

const IMAGE_EXTENSIONS = new Set(['.avif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp']);

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function localPath(root, value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const cleaned = value.trim().split(/[?#]/, 1)[0];
  if (!cleaned || /^[a-z][a-z\d+.-]*:/i.test(cleaned) || cleaned.startsWith('//')) return null;
  const resolved = path.resolve(root, cleaned.replace(/^[/\\]+/, ''));
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

async function existingImage(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (!IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && stat.size > 0) return candidate;
    } catch {
      // Try the next conventional icon location.
    }
  }
  return null;
}

function htmlIconHrefs(html) {
  const hrefs = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
      .map((match) => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '']));
    if (!attributes.rel?.toLowerCase().split(/\s+/).some((value) => value === 'icon' || value === 'apple-touch-icon')) continue;
    if (attributes.href) hrefs.push(attributes.href);
  }
  return hrefs;
}

async function webIconCandidates(root) {
  const candidates = [];
  for (const relativeHtmlPath of ['index.html', 'public/index.html', 'web/index.html', 'src/index.html']) {
    const htmlPath = path.join(root, relativeHtmlPath);
    try {
      const html = await fs.readFile(htmlPath, 'utf8');
      for (const rawHref of htmlIconHrefs(html)) {
        const href = rawHref.replace(/^%PUBLIC_URL%\/?/, '').replace(/^\$\{[^}]+\}\/?/, '');
        candidates.push(localPath(path.dirname(htmlPath), href));
        candidates.push(localPath(root, href));
        candidates.push(localPath(path.join(root, 'public'), href));
      }
    } catch {
      // This project does not use this HTML entry point.
    }
  }
  for (const relativePath of [
    'public/favicon.ico', 'public/favicon.svg', 'public/favicon.png', 'public/apple-touch-icon.png',
    'favicon.ico', 'favicon.svg', 'favicon.png', 'src/favicon.ico', 'src/favicon.svg', 'src/favicon.png',
  ]) candidates.push(path.join(root, relativePath));
  return candidates;
}

async function configuredAppIconCandidates(root) {
  const candidates = [];
  for (const configName of ['app.json', 'app.config.json']) {
    const config = await readJson(path.join(root, configName));
    const expo = config?.expo || config;
    candidates.push(
      localPath(root, expo?.icon),
      localPath(root, expo?.ios?.icon),
      localPath(root, expo?.android?.icon),
      localPath(root, expo?.android?.adaptiveIcon?.foregroundImage),
    );
  }
  const packageJson = await readJson(path.join(root, 'package.json'));
  candidates.push(
    localPath(root, packageJson?.expo?.icon),
    localPath(root, packageJson?.build?.icon),
    localPath(root, packageJson?.icon),
  );
  return candidates;
}

async function iosAppIconCandidate(root) {
  const iosRoot = path.join(root, 'ios');
  const queue = [{ directory: iosRoot, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < 600) {
    const { directory, depth } = queue.shift();
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    visited += entries.length;
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name === 'AppIcon.appiconset') {
        const contents = await readJson(path.join(entryPath, 'Contents.json'));
        const filenames = (contents?.images || []).map((image) => image.filename).filter(Boolean).reverse();
        const icon = await existingImage(filenames.map((filename) => localPath(entryPath, filename)));
        if (icon) return icon;
      }
      if (entry.isDirectory() && depth < 5 && !['Pods', 'build'].includes(entry.name)) queue.push({ directory: entryPath, depth: depth + 1 });
    }
  }
  return null;
}

async function detectProjectIcon(root, runtime = 'web') {
  const webCandidates = await webIconCandidates(root);
  const appCandidates = await configuredAppIconCandidates(root);
  const conventionalAppCandidates = [
    'assets/icon.png', 'assets/images/icon.png', 'resources/icon.png', 'build/icon.png',
    'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png',
    'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp',
    'android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png',
    'android/app/src/main/res/mipmap-xxhdpi/ic_launcher.webp',
  ].map((relativePath) => path.join(root, relativePath));
  const ordered = runtime === 'web'
    ? [...webCandidates, ...appCandidates, ...conventionalAppCandidates]
    : [...appCandidates, ...conventionalAppCandidates, ...webCandidates];
  return await existingImage(ordered) || await iosAppIconCandidate(root);
}

module.exports = { detectProjectIcon, htmlIconHrefs };

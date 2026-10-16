const fs = require('node:fs/promises');
const path = require('node:path');
async function detectProjectPlatforms(root) {
  const read = async file => { try { return JSON.parse(await fs.readFile(path.join(root, file), 'utf8')); } catch { return {}; } };
  const [pkg, app, names] = await Promise.all([read('package.json'), read('app.json'), fs.readdir(root)]);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const mobile = Boolean(deps.expo || deps['react-native'] || names.includes('pubspec.yaml') || names.includes('android') || names.includes('ios'));
  const desktop = Boolean(deps.electron || deps['@tauri-apps/api'] || names.includes('src-tauri'));
  const declared = app.expo?.platforms;
  const web = Boolean(deps['react-dom'] || deps['react-native-web'] || deps.next || deps.vite || names.includes('index.html') || (Array.isArray(declared) && declared.includes('web')));
  const label = [mobile && 'Mobile App', desktop && 'Desktop App'].filter(Boolean).join(' · ') || (web ? 'Web' : 'Unknown');
  const note = mobile || desktop ? 'Preview is web-based and does not emulate native platforms.' : '';
  return { mobile, desktop, web, label, note };
}
module.exports = { detectProjectPlatforms };

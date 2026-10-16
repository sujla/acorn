const path = require('node:path');

function noPreviewScreen() {
  return Object.assign(new Error('No previewable screen was found in this revision. It may not contain a screen yet, or its entry may be unsupported or excluded in Preview Settings. Try another revision or check Preview Settings.'), { code: 'NO_PREVIEW_SCREEN' });
}

function assertExpoScreen(root, sourceFiles, pkg) {
  const names = sourceFiles.map(file => path.relative(root, file).split(path.sep).join('/'));
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  if (dependencies['expo-router']) {
    const prefix = names.some(name => name.startsWith('src/app/')) ? 'src/app/' : 'app/';
    const routes = names.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length));
    if (!routes.some(name => /\.[jt]sx?$/.test(name) && !/(^|\/)(_|\+|api\/)/.test(name) && !/\+api\.[jt]sx?$/.test(name) && !/\.(native|ios|android)\.[jt]sx?$/.test(name))) throw noPreviewScreen();
  } else if (!pkg.main || /^(?:\.\/)?(?:node_modules\/)?expo\/AppEntry(?:\.js)?$/.test(pkg.main)) {
    if (!names.some(name => /^App(?:\.web)?\.[jt]sx?$/.test(name))) throw noPreviewScreen();
  }
}

module.exports = { noPreviewScreen, assertExpoScreen };

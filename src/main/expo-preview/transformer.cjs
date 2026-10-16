const babel = require('@babel/core');
const { transform: svgTransform } = require('@svgr/core');
const svgPlugin = require('@svgr/plugin-jsx');
const { mapCompatibility } = require('./map-compatibility.cjs');
const { resolveExpoRuntime } = require('./runtime.cjs');

// Only bundled transforms execute here. Never discover Babel/Metro/project plugins.
exports.transform = async ({ filename, src, options, plugins = [] }) => {
  const runtime = resolveExpoRuntime(`${options.customTransformOptions?.acornExpoSdk || ''}.0.0`);
  const preset = require(runtime.preset);
  if (filename.endsWith('.css')) src = await require('./css.cjs').transformCss({ filename: require('node:path').resolve(options.projectRoot, filename),
    roots: JSON.parse(options.customTransformOptions.acornCssRoots),
    inputDirectory: options.customTransformOptions.acornCssInputs,
  });
  src = mapCompatibility(filename, src).source;
  if (filename.endsWith('.svg')) src = svgTransform.sync(src, { native: true, plugins: [svgPlugin], runtimeConfig: false }, { componentName: 'SvgAsset' });
  if (!filename.includes('/node_modules/') && !filename.startsWith(__dirname + '/') && /\.[cm]?[jt]sx?$/.test(filename)) {
    src = babel.transformSync(src, { filename, babelrc: false, configFile: false, parserOpts: { sourceType: 'unambiguous', plugins: ['jsx', ...(/\.[cm]?tsx?$/.test(filename) ? ['typescript'] : [])] }, plugins: [require('./feature-boundary-plugin.cjs'), require('./visual-hook-plugin.cjs')] }).code;
  }
  const result = babel.transformSync(src, {
    filename, cwd: options.projectRoot, root: options.projectRoot,
    babelrc: false, configFile: false, browserslistConfigFile: false,
    ast: true, code: false, sourceType: 'unambiguous', plugins,
    presets: [[preset, { reanimated: false, worklets: false, expoUi: false, reactCompiler: false }]],
    caller: { name: 'metro', bundler: 'metro', platform: 'web', isDev: false,
      isServer: false, isNodeModule: filename.includes('node_modules'),
      isHMREnabled: false, supportsStaticESM: false, preserveEnvVars: true,
      projectRoot: options.projectRoot, routerRoot: options.customTransformOptions?.routerRoot || 'app' },
  });
  return { ast: result.ast, metadata: result.metadata };
};
exports.getCacheKey = () => 'acorn-expo-transform-4';

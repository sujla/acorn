const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { compileExpoPreview } = require('../src/main/expo-preview/compiler.cjs');
const { resolveExpoRuntime, runtimeModule } = require('../src/main/expo-preview/runtime.cjs');
const babelCore = require('@babel/core');
const visualHookPlugin = require('../src/main/expo-preview/visual-hook-plugin.cjs');

async function fixture(t, expoVersion = '57.0.23') {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-expo-unit-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const repositoryPath = path.join(temporary, 'repo');
  const root = path.join(temporary, 'snapshot');
  for (const dir of [root, path.join(repositoryPath, 'node_modules/expo')]) await fs.mkdir(dir, { recursive: true });
  const pkg = JSON.stringify({ dependencies: { expo: expoVersion } });
  for (const dir of [root, repositoryPath]) await fs.writeFile(path.join(dir, 'package.json'), pkg);
  await fs.writeFile(path.join(repositoryPath, 'node_modules/expo/package.json'), JSON.stringify({ name: 'expo', version: expoVersion, main: 'index.js' }));
  await fs.writeFile(path.join(repositoryPath, 'node_modules/expo/index.js'), 'export function registerRootComponent(App) { globalThis.EXPO_TEST_APP = App; }');
  await fs.writeFile(path.join(root, 'App.tsx'), 'import { Text } from "react-native"; export default function App(){return <Text>Original screen</Text>}');
  const marker = path.join(temporary, 'executed');
  for (const file of ['babel.config.js', 'metro.config.js', 'app.config.js']) {
    await fs.writeFile(path.join(root, file), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('Do not execute project config');`);
  }
  return { root, repositoryPath, cacheRoot: path.join(temporary, 'cache'), marker };
}

test('Expo runtime follows the connected project SDK and rejects unknown SDKs', () => {
  for (const sdk of [54, 55, 56, 57]) {
    const runtime = resolveExpoRuntime(`${sdk}.0.1`);
    assert.equal(runtime.sdk, sdk);
    assert.equal(runtimeModule(runtime, 'react/jsx-runtime'), `react-sdk${sdk}/jsx-runtime`);
    assert.equal(runtimeModule(runtime, 'react-dom/client'), `react-dom-sdk${sdk}/client`);
  }
  assert.throws(() => resolveExpoRuntime('53.0.0'), /Supported SDK versions: 54, 55, 56, 57/);
  assert.throws(() => resolveExpoRuntime('not-a-version'), /unknown version/);
});

test('screenless Expo revisions are reported before preparing different dependencies', async t => {
  const options = await fixture(t);
  await fs.unlink(path.join(options.root, 'App.tsx'));
  const pkg = { dependencies: { expo: '57.0.23', 'expo-router': '57.0.21' }, main: 'expo-router/entry' };
  await fs.writeFile(path.join(options.root, 'package.json'), JSON.stringify(pkg));
  await fs.mkdir(path.join(options.root, 'src/app'), { recursive: true });
  for (const name of ['_layout.tsx', 'secret+api.ts', 'index.native.tsx']) await fs.writeFile(path.join(options.root, 'src/app', name), 'export default null;');
  await assert.rejects(compileExpoPreview({ ...options, installDependencies: () => assert.fail('must not install for absent screens') }), { code: 'NO_PREVIEW_SCREEN' });
  await fs.writeFile(path.join(options.root, 'src/app/index.tsx'), 'export default function Screen(){return "Hello"}');
  await assert.rejects(compileExpoPreview(options), { code: 'MISSING_DEPENDENCY_LOCKFILE' });
});

test('Expo CSS modules export scoped classes, apply CSS and track nested dependency assets', { timeout: 120000 }, async t => {
  const options = await fixture(t);
  await fs.writeFile(path.join(options.root, 'App.tsx'), 'import classes from "./icon.module.css"; import other from "./nested/icon.module.css"; import "./global.css"; globalThis.OTHER_CSS = other; export default classes;');
  await fs.mkdir(path.join(options.root, 'nested'));
  await fs.writeFile(path.join(options.root, 'nested/icon.module.css'), '.expoLogoBackground { color: green; }');
  await fs.writeFile(path.join(options.root, 'icon.module.css'), '.expoLogoBackground { background-image: linear-gradient(180deg, #3c9ffe, #0274df); border-radius: 40px; width: 128px; }');
  await fs.writeFile(path.join(options.root, 'global.css'), '@import "./node_modules/theme/colors.css"; body { margin: 0; }');
  const theme = path.join(options.repositoryPath, 'node_modules/theme');
  await fs.mkdir(theme);
  await fs.writeFile(path.join(theme, 'colors.css'), '.global-theme { color: red; background-image: url("./icon.svg"); }');
  await fs.writeFile(path.join(theme, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  const first = await compileExpoPreview(options);
  const styles = [];
  const context = vm.createContext({ document: { getElementById: id => styles.find(style => style.id === id), createElement: () => ({}), head: { appendChild: style => styles.push(style) } } });
  vm.runInContext(await fs.readFile(path.join(first.root, 'app.js'), 'utf8'), context);
  const className = context.EXPO_TEST_APP.expoLogoBackground;
  assert.equal(typeof className, 'string');
  assert.notEqual(className, 'expoLogoBackground');
  assert.notEqual(className, context.OTHER_CSS.expoLogoBackground);
  assert.ok(styles.some(style => style.textContent.includes('.' + className) && style.textContent.includes('linear-gradient')));
  assert.ok(styles.some(style => style.textContent.includes('data:image/svg+xml') && style.textContent.includes('color: red')));
  assert.equal((await compileExpoPreview(options)).cached, true);
  await fs.writeFile(path.join(theme, 'colors.css'), '.global-theme { color: blue; }');
  const changed = await compileExpoPreview(options);
  assert.equal(changed.cached, false);
  assert.match(await fs.readFile(path.join(changed.root, 'app.js'), 'utf8'), /color: blue/);
  await assert.rejects(fs.access(options.marker));
});

test('CSS imports cannot read outside preview roots', async t => {
  const options = await fixture(t);
  await fs.writeFile(path.join(options.root, 'escape.css'), '@import "../outside.css";');
  await fs.writeFile(path.join(path.dirname(options.root), 'outside.css'), '.secret { color: red; }');
  await assert.rejects(require('../src/main/expo-preview/css.cjs').transformCss({ filename: path.join(options.root, 'escape.css'), roots: [options.root] }), /outside the connected project/);
});

test('missing module errors show the source path without temporary paths or resolver candidates', () => {
  const message = 'Unable to resolve module ./missing.css from /tmp/snapshot/src/icon.tsx: \nNone of these files exist:\n * long candidate list';
  const result = require('../src/main/expo-preview/css.cjs').conciseExpoError(new Error(message), '/tmp/snapshot');
  assert.match(result, /Cannot resolve \.\/missing.css.*src\/icon.tsx/);
  assert.doesNotMatch(result, /\/tmp|candidate/);
});

test('automatic Expo preview compiles every supported SDK with its matching runtime', { timeout: 120000 }, async t => {
  for (const sdk of [54, 55, 56, 57]) {
    await t.test(`SDK ${sdk}`, async t => {
      const options = await fixture(t, `${sdk}.0.1`);
      const artifact = await compileExpoPreview(options);
      assert.match(await fs.readFile(path.join(artifact.root, 'app.js'), 'utf8'), /Original screen/);
      assert.ok(artifact.warnings.some(warning => warning.includes(`SDK ${sdk} runtime`)));
    });
  }
});

test('Expo resolves safe tsconfig path aliases from the selected snapshot', { timeout: 120000 }, async t => {
  const options = await fixture(t, '54.0.37');
  await fs.mkdir(path.join(options.root, 'src/theme'), { recursive: true });
  await fs.writeFile(path.join(options.root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
  await fs.writeFile(path.join(options.root, 'src/theme/palette.ts'), 'export const palette = "acorn-purple";');
  await fs.writeFile(path.join(options.root, 'App.tsx'), 'import { Text } from "react-native"; import {palette} from "@/theme/palette"; export default function App(){return <Text>{palette}</Text>}');
  const artifact = await compileExpoPreview(options);
  assert.match(await fs.readFile(path.join(artifact.root, 'app.js'), 'utf8'), /acorn-purple/);
});

test('Expo extensionless aliases prefer TypeScript modules over same-basename JSON', { timeout: 120000 }, async t => {
  const options = await fixture(t, '57.0.23');
  await fs.mkdir(path.join(options.root, 'src/theme'), { recursive: true });
  await fs.writeFile(path.join(options.root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
  await fs.writeFile(path.join(options.root, 'src/theme/tokens.json'), JSON.stringify({ mode: 'json-data' }));
  await fs.writeFile(path.join(options.root, 'src/theme/tokens.ts'), 'import tokens from "./tokens.json"; export const selectedMode = "typescript-wins-" + tokens.mode;');
  await fs.writeFile(path.join(options.root, 'App.tsx'), 'import { selectedMode } from "@/theme/tokens"; export default function App(){return selectedMode}');
  const artifact = await compileExpoPreview(options);
  const bundle = await fs.readFile(path.join(artifact.root, 'app.js'), 'utf8');
  assert.match(bundle, /typescript-wins-/);
});

test('Expo resolves a hoisted package sibling nested under their common dependency owner', { timeout: 120000 }, async t => {
  const options = await fixture(t, '57.0.29');
  const modules = path.join(options.repositoryPath, 'node_modules');
  const expo = JSON.parse(await fs.readFile(path.join(modules, 'expo/package.json'), 'utf8'));
  expo.dependencies = { 'expo-font': '57.0.4', 'expo-asset': '57.0.20' };
  await fs.writeFile(path.join(modules, 'expo/package.json'), JSON.stringify(expo));
  await fs.mkdir(path.join(modules, 'expo-font/build'), { recursive: true });
  await fs.writeFile(path.join(modules, 'expo-font/package.json'), JSON.stringify({ name: 'expo-font', version: '57.0.4', main: 'build/index.js' }));
  await fs.writeFile(path.join(modules, 'expo-font/build/index.js'), 'export { assetLocation } from "./FontLoader.web";');
  await fs.writeFile(path.join(modules, 'expo-font/build/FontLoader.web.js'), 'export { assetLocation } from "expo-asset";');
  await fs.mkdir(path.join(modules, 'expo/node_modules/expo-asset'), { recursive: true });
  await fs.writeFile(path.join(modules, 'expo/node_modules/expo-asset/package.json'), JSON.stringify({ name: 'expo-asset', version: '57.0.20', main: 'index.js' }));
  await fs.writeFile(path.join(modules, 'expo/node_modules/expo-asset/index.js'), 'export const assetLocation = "nested-expo-asset";');
  await fs.writeFile(path.join(options.root, 'App.tsx'), 'import { assetLocation } from "expo-font"; export default function App(){return assetLocation}');
  const artifact = await compileExpoPreview(options);
  assert.match(await fs.readFile(path.join(artifact.root, 'app.js'), 'utf8'), /nested-expo-asset/);
});

test('Expo does not resolve an arbitrary nested package without a shared declared owner', { timeout: 120000 }, async t => {
  const options = await fixture(t, '57.0.29');
  const modules = path.join(options.repositoryPath, 'node_modules');
  await fs.mkdir(path.join(modules, 'expo-font/build'), { recursive: true });
  await fs.writeFile(path.join(modules, 'expo-font/package.json'), JSON.stringify({ name: 'expo-font', version: '57.0.4', main: 'build/index.js' }));
  await fs.writeFile(path.join(modules, 'expo-font/build/index.js'), 'export { assetLocation } from "expo-asset";');
  const unrelated = path.join(modules, 'unrelated/node_modules/expo-asset');
  await fs.mkdir(unrelated, { recursive: true });
  await fs.writeFile(path.join(modules, 'unrelated/package.json'), JSON.stringify({ name: 'unrelated', version: '1.0.0', dependencies: { 'expo-asset': '57.0.20' } }));
  await fs.writeFile(path.join(unrelated, 'package.json'), JSON.stringify({ name: 'expo-asset', version: '57.0.20', main: 'index.js' }));
  await fs.writeFile(path.join(unrelated, 'index.js'), 'export const assetLocation = "must-not-resolve";');
  await fs.writeFile(path.join(options.root, 'App.tsx'), 'import { assetLocation } from "expo-font"; export default function App(){return assetLocation}');
  await assert.rejects(compileExpoPreview(options), /Cannot resolve expo-asset/);
});

test('automatic Expo builds source without web dependencies or project configuration execution and reuses validated cache', { timeout: 120000 }, async t => {
  const options = await fixture(t);
  const first = await compileExpoPreview(options);
  assert.equal(first.cached, false);
  assert.match(await fs.readFile(path.join(first.root, 'app.js'), 'utf8'), /Original screen/);
  await assert.rejects(fs.access(options.marker), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(options.repositoryPath, 'node_modules/react-native-web')), { code: 'ENOENT' });
  const second = await compileExpoPreview(options);
  assert.equal(second.cached, true);
  await fs.writeFile(path.join(options.root, 'App.tsx'), 'export default function App(){return "Updated screen"}');
  const third = await compileExpoPreview(options);
  assert.notEqual(third.cacheKey, first.cacheKey);
  assert.match(await fs.readFile(path.join(third.root, 'app.js'), 'utf8'), /Updated screen/);
});

test('Expo refuses the live checkout and incompatible historical dependencies', async t => {
  const options = await fixture(t);
  await assert.rejects(compileExpoPreview({ ...options, root: options.repositoryPath }), /isolated source snapshot/);
  await fs.writeFile(path.join(options.root, 'yarn.lock'), 'old dependency tree');
  await fs.writeFile(path.join(options.repositoryPath, 'yarn.lock'), 'new dependency tree');
  await assert.rejects(compileExpoPreview(options), /different dependencies/);
});

test('Expo Router context contains selected snapshot screens and excludes native/API files', { timeout: 120000 }, async t => {
  const options = await fixture(t);
  for (const dir of [options.root, options.repositoryPath]) {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { expo: '57.0.23', 'expo-router': '57.0.21' } }));
  }
  const router = path.join(options.repositoryPath, 'node_modules/expo-router');
  await fs.mkdir(router);
  await fs.writeFile(path.join(router, 'package.json'), '{"name":"expo-router","version":"57.0.21","main":"entry.js"}');
  await fs.writeFile(path.join(router, 'entry.js'), 'const {ctx} = require("expo-router/_ctx"); globalThis.routes = ctx.keys().map(key => ctx(key));');
  await fs.mkdir(path.join(options.root, 'app'));
  await fs.writeFile(path.join(options.root, 'app/index.tsx'), 'export default "SNAPSHOT_HOME";');
  await fs.writeFile(path.join(options.root, 'app/secret+api.ts'), 'throw new Error("API_MUST_NOT_BUNDLE");');
  await fs.writeFile(path.join(options.root, 'app/native.ios.tsx'), 'throw new Error("IOS_MUST_NOT_BUNDLE");');
  const artifact = await compileExpoPreview(options);
  const bundle = await fs.readFile(path.join(artifact.root, 'app.js'), 'utf8');
  assert.match(bundle, /SNAPSHOT_HOME/);
  assert.doesNotMatch(bundle, /API_MUST_NOT_BUNDLE|IOS_MUST_NOT_BUNDLE|metroEmptyContext/);
});

test('native-only services have disclosed substitutes and compiler internals are not served', { timeout: 120000 }, async t => {
  const options = await fixture(t);
  await fs.writeFile(path.join(options.root, 'App.tsx'), 'import MapView from "react-native-maps"; import {BannerAd} from "react-native-google-mobile-ads"; import {useShareIntent} from "expo-share-intent"; export default function App(){useShareIntent(); return <><MapView/><BannerAd/></>}');
  const artifact = await compileExpoPreview(options);
  const html = await fs.readFile(path.join(artifact.root, 'index.html'), 'utf8');
  assert.match(html, /Maps use a coordinate schematic/);
  assert.match(html, /charset="utf-8"/);
  assert.ok(artifact.warnings.some(warning => warning.includes('react-native-maps')));
  await assert.rejects(fs.access(path.join(artifact.root, 'entry.js')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(artifact.root, 'routes.js')), { code: 'ENOENT' });
});

test('package main resolves a local source entry without a leading dot', { timeout: 120000 }, async t => {
  const options = await fixture(t);
  const pkg = JSON.parse(await fs.readFile(path.join(options.root, 'package.json'), 'utf8'));
  pkg.main = 'index.js';
  await fs.writeFile(path.join(options.root, 'package.json'), JSON.stringify(pkg));
  await fs.writeFile(path.join(options.root, 'index.js'), 'globalThis.CUSTOM_EXPO_ENTRY = "local entry";');
  const artifact = await compileExpoPreview(options);
  assert.match(await fs.readFile(path.join(artifact.root, 'app.js'), 'utf8'), /CUSTOM_EXPO_ENTRY/);
});

test('Expo switches a previously linked snapshot to isolated historical packages and reuses them', { timeout: 120000 }, async t => {
  const options = await fixture(t);
  const lock = JSON.stringify({ lockfileVersion: 3, packages: {} });
  for (const directory of [options.root, options.repositoryPath]) await fs.writeFile(path.join(directory, 'package-lock.json'), lock);
  await compileExpoPreview(options);
  let installs = 0;
  await fs.writeFile(path.join(options.repositoryPath, 'package-lock.json'), '{}');
  const installDependencies = async ({ directory }) => {
    installs++;
    await fs.cp(path.join(options.repositoryPath, 'node_modules'), path.join(directory, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(directory, 'node_modules/expo/index.js'), 'export function registerRootComponent(App) { globalThis.HISTORICAL_EXPO_APP = App; }');
  };
  const historical = await compileExpoPreview({ ...options, installDependencies });
  assert.match(await fs.readFile(path.join(historical.root, 'app.js'), 'utf8'), /HISTORICAL_EXPO_APP/);
  assert.equal((await compileExpoPreview({ ...options, installDependencies })).cached, true);
  assert.equal(installs, 1);
  assert.match(await fs.readFile(path.join(options.repositoryPath, 'node_modules/expo/index.js'), 'utf8'), /EXPO_TEST_APP/);
});

test('unrelated Expo apps get native feature adapters and local component boundaries', { timeout: 120000 }, async t => {
  const options = await fixture(t);
  await fs.writeFile(path.join(options.root, 'App.tsx'), `import React from 'react'; import {Text,View} from 'react-native'; import {CameraView} from 'expo-camera'; import {WebView} from 'react-native-webview'; function Broken(){throw new Error('missing native view')} export default function App(){return <View><Text>Unaffected content</Text><CameraView/><WebView/><Broken/></View>}`);
  const artifact = await compileExpoPreview(options);
  const bundle = await fs.readFile(path.join(artifact.root, 'app.js'), 'utf8');
  assert.match(bundle, /Unaffected content/);
  assert.match(bundle, /data-acorn-unavailable/);
  assert.match(bundle, /getDerivedStateFromError/);
  assert.ok(artifact.warnings.some(w => w.includes('expo-camera') && w.includes('react-native-webview')));
});

test('state-bearing object hooks pass through the visual preview adapter', () => {
  const result = babelCore.transformSync('const { account, ready, save } = useOnboarding();', { configFile: false, babelrc: false, plugins: [visualHookPlugin] }).code;
  assert.match(result, /globalThis\.__ACORN_VISUAL_HOOK__/);
  assert.match(result, /"useOnboarding"/);
  assert.match(result, /\["account", "ready", "save"\]/);
});

test('ordinary hooks and non-object hook results remain unchanged', () => {
  const result = babelCore.transformSync('const [value, setValue] = useState(0); const { width } = useWindowDimensions();', { configFile: false, babelrc: false, plugins: [visualHookPlugin] }).code;
  assert.doesNotMatch(result, /__ACORN_VISUAL_HOOK__/);
});

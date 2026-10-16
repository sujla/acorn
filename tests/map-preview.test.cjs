const { test } = require('node:test');
const assert = require('node:assert/strict');
const geometry = require('../src/main/expo-preview/map-geometry.cjs');
const { mapCompatibility } = require('../src/main/expo-preview/map-compatibility.cjs');
test('map projection round trips and fits coordinates across the date line', () => {
  const size = { width: 390, height: 844 }, camera = { center: { latitude: 1.3, longitude: 103.8 }, zoom: 14 };
  const coordinate = { latitude: 1.32, longitude: 103.81 };
  const restored = geometry.unproject(geometry.project(coordinate, camera, size), camera, size);
  assert.ok(Math.abs(restored.latitude - coordinate.latitude) < 1e-8);
  assert.ok(Math.abs(restored.longitude - coordinate.longitude) < 1e-8);
  const points = [{ latitude: 1, longitude: 179.9 }, { latitude: 2, longitude: -179.9 }];
  const fitted = geometry.fit(points, size, { left: 20, right: 40, top: 30, bottom: 60 });
  for (const p of points) { const xy = geometry.project(p, fitted, size); assert.ok(xy.x >= 19 && xy.x <= 351 && xy.y >= 29 && xy.y <= 785); }
});
test('map compatibility is scoped to the known wrapper and expected guard, not arbitrary configuration', () => {
  const source = "import Map from 'react-native-maps'; export const GoogleTransitMap = forwardRef(() => { const hasKey = Constants.expoConfig?.extra?.googleMapsConfigured?.[Platform.OS] === true; if (!hasKey) return null; });";
  assert.equal(mapCompatibility('/snapshot/src/components/map/GoogleTransitMap.tsx', source).applied, true);
  assert.equal(mapCompatibility('/snapshot/App.tsx', source).source, source);
  assert.equal(mapCompatibility('/snapshot/src/components/map/GoogleTransitMap.tsx', source.replace('googleMapsConfigured', 'otherSetting')).applied, false);
});

test('feature boundaries preserve declarative navigation, asChild and single key evaluation', () => {
  const babel = require('@babel/core');
  const source = `const screen = <Stack><Stack.Screen name="home"/><Screen name="other"/><Link asChild><Pressable /></Link>{items.map(item => <Card key={nextKey()} />)}</Stack>`;
  const output = babel.transformSync(source, { filename: '/tmp/App.jsx', configFile: false, babelrc: false, parserOpts: { plugins: ['jsx'] }, plugins: [require('../src/main/expo-preview/feature-boundary-plugin.cjs')] }).code;
  assert.match(output, /<Stack>\s*<Stack.Screen/);
  assert.match(output, /<Link asChild><Pressable \/><\/Link>/);
  assert.equal((output.match(/nextKey\(\)/g) || []).length, 1);
  assert.match(output, /feature="Card"/);
});

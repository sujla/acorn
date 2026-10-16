const profiles = Object.freeze({
  54: Object.freeze({ sdk: 54, id: 'expo-sdk-54-v1', preset: 'babel-preset-expo-sdk54', metro: 'metro-sdk54', metroConfig: 'metro-config-sdk54', react: 'react-sdk54', reactDom: 'react-dom-sdk54', reactNativeWeb: 'react-native-web' }),
  55: Object.freeze({ sdk: 55, id: 'expo-sdk-55-v1', preset: 'babel-preset-expo-sdk55', metro: 'metro-sdk55', metroConfig: 'metro-config-sdk55', react: 'react-sdk55', reactDom: 'react-dom-sdk55', reactNativeWeb: 'react-native-web' }),
  56: Object.freeze({ sdk: 56, id: 'expo-sdk-56-v1', preset: 'babel-preset-expo-sdk56', metro: 'metro-sdk56', metroConfig: 'metro-config-sdk56', react: 'react-sdk56', reactDom: 'react-dom-sdk56', reactNativeWeb: 'react-native-web' }),
  57: Object.freeze({ sdk: 57, id: 'expo-sdk-57-v1', preset: 'babel-preset-expo-sdk57', metro: 'metro-sdk57', metroConfig: 'metro-config-sdk57', react: 'react-sdk57', reactDom: 'react-dom-sdk57', reactNativeWeb: 'react-native-web' }),
});

function expoSdk(version) {
  const match = /^(\d+)\./.exec(String(version || ''));
  return match ? Number(match[1]) : null;
}

function resolveExpoRuntime(version) {
  const sdk = expoSdk(version);
  const runtime = sdk === null ? null : profiles[sdk];
  if (runtime) return runtime;
  const supported = Object.keys(profiles).join(', ');
  const detected = sdk === null ? 'with an unknown version' : version;
  throw new Error(`Automatic Expo preview does not yet support Expo ${detected}. Supported SDK versions: ${supported}.`);
}

function runtimeModule(runtime, name) {
  for (const [publicName, packageName] of [
    ['react-native-web', runtime.reactNativeWeb],
    ['react-dom', runtime.reactDom],
    ['react', runtime.react],
  ]) {
    if (name === publicName || name.startsWith(publicName + '/')) return packageName + name.slice(publicName.length);
  }
  return name;
}

module.exports = { expoSdk, profiles, resolveExpoRuntime, runtimeModule };

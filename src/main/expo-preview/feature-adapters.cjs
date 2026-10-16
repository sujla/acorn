// Explicit module contracts; unknown services are never reported as successful.
// Keep web-capable modules on their real implementations unless listed here.
const adapters = {
  'expo-camera': { components: ['CameraView', 'Camera'], permissions: ['useCameraPermissions', 'useMicrophonePermissions'], permissionMethods: ['requestCameraPermissionsAsync', 'getCameraPermissionsAsync', 'requestMicrophonePermissionsAsync', 'getMicrophonePermissionsAsync'] },
  'react-native-webview': { components: ['WebView'], default: 'WebView' },
  'react-native-vision-camera': { components: ['Camera'], permissions: ['useCameraPermission', 'useMicrophonePermission'] },
  'expo-local-authentication': { methods: ['authenticateAsync'], extras: 'export const hasHardwareAsync=async()=>false; export const isEnrolledAsync=async()=>false; export const supportedAuthenticationTypesAsync=async()=>[];' },
};
// Vision Camera permission hooks have a different contract than Expo hooks.
function sourceFor(name) {
  const spec = adapters[name]; if (!spec) return null;
  let source = `import {component,permission,usePermission} from ${JSON.stringify(require.resolve('./native-features.js'))};\n`;
  for (const exported of spec.components || []) source += `export const ${exported}=component(${JSON.stringify(name + ' · ' + exported)});\n`;
  for (const exported of spec.permissions || []) source += `export const ${exported}=${name === 'react-native-vision-camera' ? '()=>({hasPermission:false,requestPermission:async()=>false})' : 'usePermission'};\n`;
  for (const exported of spec.permissionMethods || []) source += `export const ${exported}=permission;\n`;
  for (const exported of spec.methods || []) source += `export const ${exported}=async()=>({success:false,error:'not_available'});\n`;
  source += spec.extras || '';
  if (spec.default) source += `export default ${spec.default};\n`;
  return source;
}
module.exports = { adapters, sourceFor };

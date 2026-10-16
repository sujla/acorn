const { parentPort, workerData } = require('node:worker_threads');
if (workerData.esbuildBinaryPath) process.env.ESBUILD_BINARY_PATH = workerData.esbuildBinaryPath;
const esbuild = require('esbuild');
const options = { ...workerData,
  onProgress: message => parentPort.postMessage({ progress: message }),
  onProcess: pid => parentPort.postMessage({ installerPid: pid }),
};
(async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const pkg = await fs.readFile(path.join(workerData.root, 'package.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
  return require('./expo-preview-output.cjs').isExpoPackage(pkg)
    ? require('./expo-preview/compiler.cjs').compileExpoPreview(options)
    : require('./preview-compiler.cjs').compilePreview(options);
})().then(
  artifact => { esbuild.stop(); parentPort.postMessage({ artifact }); },
  error => { esbuild.stop(); parentPort.postMessage({ error: error.message, code: error.code }); },
);

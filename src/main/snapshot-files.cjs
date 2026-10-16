// Electron's patched fs interprets .asar as directories. Snapshot copies must
// preserve the real bytes (including Electron dependencies) instead.
module.exports = process.versions.electron
  ? require('original-fs').promises
  : require('node:fs/promises');

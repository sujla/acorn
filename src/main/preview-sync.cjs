const { webFrameMain } = require('electron');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const script = ['preview-sync.js', 'preview-overlay.js'].map((file) => readFileSync(path.join(__dirname, '../renderer', file), 'utf8')).join('\n');

function attachPreviewSync(contents) {
  const reportNavigation = (url, isMainFrame, processId, routingId) => {
    if (isMainFrame || contents.isDestroyed()) return;
    const frame = webFrameMain.fromId(processId, routingId);
    if (!frame || frame.parent !== contents.mainFrame || !['base-preview', 'target-preview'].includes(frame.name)) return;
    if (!/^https?:\/\//i.test(url)) return;
    contents.send('preview:navigated', { side: frame.name === 'base-preview' ? 'base' : 'target', url });
  };
  contents.on('did-frame-navigate', (_event, url, _code, _status, isMainFrame, processId, routingId) => {
    reportNavigation(url, isMainFrame, processId, routingId);
  });
  contents.on('did-navigate-in-page', (_event, url, isMainFrame, processId, routingId) => {
    reportNavigation(url, isMainFrame, processId, routingId);
  });
  contents.on('did-frame-finish-load', (_event, isMainFrame, processId, routingId) => {
    if (isMainFrame || contents.isDestroyed()) return;
    const frame = webFrameMain.fromId(processId, routingId);
    if (!frame || frame.parent !== contents.mainFrame || !['base-preview', 'target-preview'].includes(frame.name)) return;
    try {
      const url = new URL(frame.url);
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
      frame.executeJavaScript(script).catch((error) => console.warn('Preview sync could not initialize:', error.message));
    } catch (error) {
      console.warn('Preview sync frame unavailable:', error.message);
    }
  });
}
module.exports = { attachPreviewSync };

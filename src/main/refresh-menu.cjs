// Use explicit actions instead of Electron's reload/forceReload menu roles:
// those roles reload the entire renderer, including the sidebar.
function installRefreshMenu(Menu, getWindow, platform = process.platform) {
  const refresh = full => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('app:refresh', { full });
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { id: 'refresh-preview', label: 'Refresh Preview', accelerator: 'CommandOrControl+R', click: () => refresh(false) },
      { id: 'reload-acorn', label: 'Reload Acorn', accelerator: 'CommandOrControl+Shift+R', click: () => refresh(true) },
      { type: 'separator' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
  ]));
}
module.exports = { installRefreshMenu };

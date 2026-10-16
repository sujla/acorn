const fs = require('node:fs');
const path = require('node:path');

function readLayout(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).acorn;
  const resolve = key => {
    if (typeof config?.[key] !== 'string') throw new Error(`Missing acorn.${key} in package.json`);
    const file = path.resolve(root, config[key]);
    const relative = path.relative(root, file);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error(`acorn.${key} must be inside the application folder`);
    }
    if (!fs.statSync(file).isFile()) throw new Error(`Application file is missing: ${file}`);
    return file;
  };
  return { main: resolve('main'), renderer: resolve('renderer') };
}

function startApplication({ app, BrowserWindow, dialog, load, schedule = setInterval, unschedule = clearInterval }) {
  if (app.isPackaged) {
    const profile = path.join(app.getPath('appData'), 'Acorn Desktop');
    fs.mkdirSync(profile, { recursive: true });
    app.setPath('userData', profile);
    app.setPath('sessionData', profile);
  }
  // Take the lock before loading application modules or registering IPC handlers.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed());
    if (!window) {
      app.whenReady().then(() => app.emit('activate'));
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  try {
    const root = app.getAppPath();
    const initial = readLayout(root);
    app.acornRendererPath = initial.renderer;
    load(initial.main);
    if (app.isPackaged) return;
    let restarting = false;
    const timer = schedule(() => {
      if (restarting) return;
      try {
        // Folder moves may span multiple operations. Wait for a complete layout.
        const current = readLayout(root);
        if (current.main === initial.main && current.renderer === initial.renderer) return;
        restarting = true;
        app.relaunch();
        app.quit();
      } catch {
        // A partial edit/move is not a reason to discard the running workspace.
      }
    }, 1000);
    timer.unref?.();
    app.on('before-quit', () => unschedule(timer));
  } catch (error) {
    dialog.showErrorBox('Acorn could not start', `${error.message}\nCheck the acorn paths in package.json.`);
    app.quit();
  }
}

module.exports = { readLayout, startApplication };

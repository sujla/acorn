const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('acornTheme', {
  setPreference: (preference) => ipcRenderer.send('theme:set', preference),
});

contextBridge.exposeInMainWorld('acornGit', {
  readComparisons: path => ipcRenderer.sendSync('comparisons:read', { path }),
  saveComparisons: (path, comparisons) => ipcRenderer.sendSync('comparisons:write', { path, comparisons }),
  reloadApp: () => ipcRenderer.invoke('app:reload'),
  onRefresh: callback => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('app:refresh', listener);
    return () => ipcRenderer.removeListener('app:refresh', listener);
  },
  openRepositoryLocation: (payload) => ipcRenderer.invoke('repositories:open-location', payload),
  openExternalPreviewLink: (payload) => ipcRenderer.invoke('preview:open-external', payload),
  listRepositories: () => ipcRenderer.invoke('repositories:list'),
  refreshRepositoryRefs: (payload) => ipcRenderer.invoke('repositories:refresh-refs', payload),
  removeRepository: (payload) => ipcRenderer.invoke('repositories:remove', payload),
  reorderRepositories: (repositoryPaths) => ipcRenderer.invoke('repositories:reorder', repositoryPaths),
  chooseLocalRepository: () => ipcRenderer.invoke('repositories:choose-local'),
  chooseDroppedRepository: file => ipcRenderer.invoke('repositories:choose-local', { path: webUtils.getPathForFile(file) }),
  scanPreviewFiles: payload => ipcRenderer.invoke('preview:files:scan', payload),
  savePreviewFiles: payload => ipcRenderer.invoke('preview:files:save', payload),
  cancelPreviewFiles: payload => ipcRenderer.invoke('preview:files:cancel', payload),
  onPreviewFilesProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('preview:files:progress', listener);
    return () => ipcRenderer.removeListener('preview:files:progress', listener);
  },
  resolveRepositoryRefs: (payload) => ipcRenderer.invoke('repositories:resolve-refs', payload),
  getCommits: (payload) => ipcRenderer.invoke('repositories:commits', payload),
  getCommitSummaries: (payload) => ipcRenderer.invoke('repositories:commit-summaries', payload),
  getDiff: (payload) => ipcRenderer.invoke('repositories:diff', payload),
  releaseComparison: payload => ipcRenderer.invoke('preview:release-comparison', payload),
  stopPreviewServer: (payload) => ipcRenderer.invoke('preview:stop', payload),
  listPreviewServers: () => ipcRenderer.invoke('preview:list'),
  onPreviewBlocked: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('preview:blocked', listener);
    return () => ipcRenderer.removeListener('preview:blocked', listener);
  },
  onPreviewNavigation: (callback) => {
    const listener = (_event, navigation) => callback(navigation);
    ipcRenderer.on('preview:navigated', listener);
    return () => ipcRenderer.removeListener('preview:navigated', listener);
  },
  previewDataStatus: payload => ipcRenderer.invoke('preview:data:status', payload),
  allowPreviewData: payload => ipcRenderer.invoke('preview:data:allow', payload),
  refreshPreviewData: payload => ipcRenderer.invoke('preview:data:refresh', payload),
  getPreviewData: payload => ipcRenderer.invoke('preview:data:get', payload),
  onPreviewProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('preview:progress', listener);
    return () => ipcRenderer.removeListener('preview:progress', listener);
  },
  installPreviewCompiler: () => ipcRenderer.invoke('preview:compiler:install'),
  startPreview: (payload) => ipcRenderer.invoke('preview:start', payload),
});

contextBridge.exposeInMainWorld('acornLocalProfile', {
  status: () => ipcRenderer.invoke('local-profile:status'),
  chooseRepository: () => ipcRenderer.invoke('local-profile:choose-repository'),
  continue: (payload) => ipcRenderer.invoke('local-profile:continue', payload),
});

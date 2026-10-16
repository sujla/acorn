(() => {
  const get = id => document.getElementById(id);
  const dialog = get('preview-files-dialog');
  let current = null;
  const list = get('preview-files-list');
  const scrollHint = get('preview-files-scroll');
  const tabs = [...dialog.querySelectorAll('[data-preview-settings-tab]')];
  function selectTab(name, { focus = false } = {}) {
    for (const tab of tabs) {
      const selected = tab.dataset.previewSettingsTab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      get(tab.getAttribute('aria-controls')).hidden = !selected;
      if (selected && focus) tab.focus();
    }
  }
  function lockLoadedDialogHeight(state) {
    requestAnimationFrame(() => {
      if (current !== state) return;
      const selected = tabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.dataset.previewSettingsTab || 'project-files';
      selectTab('project-files');
      dialog.style.minHeight = '';
      dialog.style.minHeight = `${Math.ceil(dialog.getBoundingClientRect().height)}px`;
      selectTab(selected);
    });
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab.dataset.previewSettingsTab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(tabs.indexOf(tab) + direction + tabs.length) % tabs.length];
      selectTab(next.dataset.previewSettingsTab, { focus: true });
    });
  }
  function updateScrollHints() {
    scrollHint.classList.toggle('can-scroll-up', list.scrollTop > 1);
    scrollHint.classList.toggle('can-scroll-down', list.scrollHeight - list.clientHeight - list.scrollTop > 1);
  }
  list.addEventListener('scroll', updateScrollHints, { passive: true });
  new ResizeObserver(updateScrollHints).observe(list);
  const effective = (name, state) => {
    const key = Object.keys(state.overrides).filter(key => name === key || name.startsWith(key + '/')).sort((a, b) => b.length - a.length)[0];
    return key ? state.overrides[key] : !state.automatic.some(key => name === key || name.startsWith(key + '/'));
  };
  function uncheckEmptyAncestors(name, state) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) {
      const parent = parts.join('/');
      const descendants = state.folders.filter(folder => folder.path.startsWith(parent + '/'));
      if (state.folders.some(folder => folder.path === parent) && descendants.length && descendants.every(folder => !effective(folder.path, state))) state.overrides[parent] = false;
      parts.pop();
    }
  }
  function uncheckAllEmptyAncestors(state) {
    for (const folder of state.folders) if (folder.path.includes('/')) uncheckEmptyAncestors(folder.path, state);
  }
  function checkAncestorsPreservingUncheckedDescendants(name, state) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) {
      const parent = parts.join('/');
      if (!effective(parent, state)) {
        for (const folder of state.folders) {
          if (folder.path.startsWith(parent + '/') && !effective(folder.path, state)) state.overrides[folder.path] = false;
        }
        state.overrides[parent] = true;
      }
      parts.pop();
    }
  }
  function countableFolders(state) {
    return state.folders.filter(folder => !state.folders.some(child => child.path.startsWith(folder.path + '/')));
  }
  function externalServiceName(origin) {
    try { return new URL(origin).hostname.replace(/^www\./, ''); }
    catch { return origin; }
  }
  function renderExternalData(state) {
    const sources = state.externalDataSources || [];
    if (!sources.length) {
      get('preview-external-data-list').replaceChildren();
      get('preview-external-data-status').textContent = 'This project does not load any external data.';
      get('preview-external-data-status').hidden = false;
      get('preview-external-data-scroll').hidden = true;
      return;
    }
    const serviceInputs = [];
    let allInput;
    const updateAll = () => {
      if (!allInput) return;
      const selected = sources.filter(source => source.allowed).length;
      allInput.checked = selected === sources.length;
      allInput.indeterminate = selected > 0 && selected < sources.length;
    };
    const rows = sources.map(source => {
      const row = document.createElement('label'); row.className = 'preview-external-data-row';
      row.classList.toggle('is-new', state.externalDataNewOrigins?.has(source.origin));
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = source.allowed; input.dataset.origin = source.origin;
      const name = document.createElement('strong'); name.textContent = externalServiceName(source.origin);
      const url = document.createElement('small'); url.textContent = source.origin; url.title = source.origin;
      row.append(input, name, url);
      serviceInputs.push(input);
      input.addEventListener('change', () => { source.allowed = input.checked; updateAll(); });
      return row;
    });
    if (sources.length > 1) {
      const row = document.createElement('label'); row.className = 'preview-external-data-row preview-external-data-all';
      allInput = document.createElement('input'); allInput.type = 'checkbox';
      const name = document.createElement('strong'); name.textContent = 'All';
      const url = document.createElement('small'); url.textContent = 'All detected services';
      row.append(allInput, name, url);
      allInput.addEventListener('change', () => {
        for (let index = 0; index < sources.length; index++) {
          sources[index].allowed = allInput.checked;
          serviceInputs[index].checked = allInput.checked;
        }
        allInput.indeterminate = false;
      });
      rows.unshift(row);
      updateAll();
    }
    get('preview-external-data-list').replaceChildren(...rows);
    get('preview-external-data-status').hidden = true;
    get('preview-external-data-scroll').hidden = false;
  }
  async function loadExternalData(state, { preserveSelections = false, newOrigins = [] } = {}) {
    const loadId = state.externalDataLoadId = (state.externalDataLoadId || 0) + 1;
    state.externalDataLoaded = false;
    state.externalDataNewOrigins ||= new Set();
    for (const origin of newOrigins) state.externalDataNewOrigins.add(origin);
    get('preview-external-data-status').hidden = false;
    get('preview-external-data-status').textContent = 'Checking external data…';
    get('preview-external-data-scroll').hidden = true;
    if (state.connecting) {
      state.externalDataSources = [];
      state.externalDataLoaded = true;
      renderExternalData(state);
      return;
    }
    try {
      const result = await window.acornGit.previewDataStatus({ path: state.repository.path });
      if (current !== state || state.externalDataLoadId !== loadId) return;
      if (result.error) throw new Error(result.error);
      const selections = preserveSelections ? new Map((state.externalDataSources || []).map(source => [source.origin, source.allowed])) : new Map();
      state.externalDataSources = (result.sources || []).map(source => ({ ...source, allowed: selections.has(source.origin) ? selections.get(source.origin) : source.allowed }));
      state.externalDataLoaded = true;
      renderExternalData(state);
    } catch (error) {
      if (current !== state || state.externalDataLoadId !== loadId) return;
      get('preview-external-data-status').textContent = 'External data could not be loaded.';
      get('preview-files-error').textContent = error.message;
    }
  }
  function render() {
    const state = current;
    uncheckAllEmptyAncestors(state);
    const rows = state.folders.map(folder => {
      const label = document.createElement('label'); label.className = 'preview-folder-row';
      label.dataset.depth = String(folder.path.split('/').length - 1);
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = effective(folder.path, state); input.dataset.folder = folder.path;
      input.indeterminate = input.checked && state.folders.some(child => child.path.startsWith(folder.path + '/') && !effective(child.path, state));
      const copy = document.createElement('span'); copy.className = 'preview-folder-copy';
      const name = document.createElement('strong'); name.textContent = folder.path;
      copy.append(name);
      if (state.automatic.some(path => folder.path === path || folder.path.startsWith(path + '/'))) {
        const reason = document.createElement('small'); reason.textContent = 'Opt-out recommended';
        copy.append(reason);
      }
      label.append(input, copy);
      input.addEventListener('change', () => {
        state.overrides[folder.path] = input.checked;
        // Apply parent changes to all its displayed descendants; selecting a
        // child also opens its ancestor folders so it remains reachable.
        for (const key of Object.keys(state.overrides)) if (key.startsWith(folder.path + '/')) delete state.overrides[key];
        if (input.checked) checkAncestorsPreservingUncheckedDescendants(folder.path, state);
        render();
        get('preview-files-list').querySelectorAll('input').forEach(item => { if (item.dataset.folder === folder.path) item.focus({ preventScroll: true }); });
      });
      return label;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'preview-files-note'; empty.textContent = 'No selectable folders. Root files will be included.'; rows.push(empty); }
    get('preview-files-list').replaceChildren(...rows);
    requestAnimationFrame(updateScrollHints);
    const folders = countableFolders(state);
    get('preview-files-count').textContent = `${folders.filter(folder => effective(folder.path, state)).length} of ${folders.length} folders selected`;
  }
  async function scan(state) {
    get('preview-files-error').textContent = ''; get('preview-files-retry').hidden = true;
    get('preview-files-warning').hidden = true;
    get('preview-files-warning').open = false;
    get('preview-files-warning-list').replaceChildren();
    get('preview-files-scan').hidden = false; get('preview-files-selection').hidden = true; get('preview-files-save').disabled = true;
    get('preview-files-progress').value = 0; get('preview-files-status').textContent = 'Checking project folders…';
    try {
      const result = await window.acornGit.scanPreviewFiles({ path: state.repository.path, requestId: state.id });
      if (current !== state) return;
      if (result.error) throw new Error(result.error);
      Object.assign(state, { folders: result.folders, automatic: result.automatic, overrides: { ...result.settings.overrides } });
      const warnings = result.warnings || [];
      get('preview-files-warning-list').replaceChildren(...warnings.map(message => {
        const item = document.createElement('li'); item.textContent = message; return item;
      }));
      get('preview-files-warning').hidden = warnings.length === 0;
      render(); get('preview-files-scan').hidden = true; get('preview-files-selection').hidden = false; get('preview-files-save').disabled = false;
      lockLoadedDialogHeight(state);
    } catch (error) {
      if (current !== state) return;
      get('preview-files-status').textContent = 'Folder check could not be completed';
      get('preview-files-error').textContent = error.message; get('preview-files-retry').hidden = false;
    }
  }
  function close(saved = false) {
    if (!current || current.saving) return;
    const state = current; current = null; state.unsubscribe?.(); dialog.close();
    if (!saved && state.connecting) window.acornGit.cancelPreviewFiles({ path: state.repository.path }).catch(() => {});
    state.resolve(saved);
  }
  get('preview-files-close').onclick = () => close();
  get('preview-files-cancel').onclick = () => close();
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  get('preview-files-retry').onclick = () => scan(current);
  get('preview-files-reset').onclick = () => { current.overrides = {}; render(); };
  get('preview-files-save').onclick = async () => {
    const state = current; if (!state || state.saving) return;
    state.saving = true;
    dialog.querySelectorAll('button, input').forEach(item => { item.disabled = true; });
    get('preview-files-error').textContent = '';
    try {
      if (!state.connecting && state.externalDataLoaded) {
        const selectedOrigins = (state.externalDataSources || []).filter(source => source.allowed).map(source => source.origin);
        const dataResult = await window.acornGit.allowPreviewData({ path: state.repository.path, origins: selectedOrigins, automatic: false });
        if (dataResult.error) throw new Error(dataResult.error);
      }
      // Save the effective selection, including recommendation defaults. Export
      // paths must not revert to the old include-everything default on refresh.
      const overrides = { ...state.overrides, ...Object.fromEntries(state.folders.map(folder => [folder.path, effective(folder.path, state)])) };
      const result = await window.acornGit.savePreviewFiles({ path: state.repository.path, settings: { overrides } });
      if (result.error) throw new Error(result.error);
      state.saving = false; close(result);
    } catch (error) { state.saving = false; get('preview-files-error').textContent = error.message; }
    finally { dialog.querySelectorAll('button, input').forEach(item => { item.disabled = false; }); }
  };
  window.PreviewFilePicker = {
    open(repository, { connecting = false, initialTab = 'project-files', newExternalDataOrigins = [] } = {}) {
      if (current) return Promise.resolve(false);
      return new Promise(resolve => {
        const state = current = { repository, connecting, resolve, id: crypto.randomUUID(), externalDataNewOrigins: new Set(newExternalDataOrigins) };
        dialog.style.minHeight = '';
        get('preview-files-title').textContent = repository.name || repository.path.split('/').at(-1);
        get('preview-files-kicker').textContent = connecting ? 'CONNECT REPOSITORY' : 'PREVIEW SETTINGS';
        get('preview-files-save').textContent = connecting ? 'Connect & Preview' : 'Save & Refresh';
        get('preview-settings-tabs').hidden = connecting;
        selectTab(connecting ? 'project-files' : initialTab);
        state.unsubscribe = window.acornGit.onPreviewFilesProgress(progress => {
          if (current !== state || progress.requestId !== state.id || progress.path !== repository.path) return;
          get('preview-files-progress').max = progress.max || 4;
          get('preview-files-progress').value = progress.value; get('preview-files-status').textContent = progress.message;
        });
        dialog.showModal(); scan(state);
        if (!connecting) loadExternalData(state);
      });
    },
    currentRepositoryPath() { return current?.repository.path || null; },
    refreshExternalData(repositoryPath, { newOrigins = [] } = {}) {
      if (!current || current.repository.path !== repositoryPath || current.connecting) return Promise.resolve(false);
      return loadExternalData(current, { preserveSelections: true, newOrigins }).then(() => true);
    },
  };
})();

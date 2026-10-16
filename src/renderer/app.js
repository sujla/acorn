const get = (id) => document.getElementById(id);
const bridge = window.acornGit;
const baseRef = get('base-ref');
const targetRef = get('target-ref');
const refPickers = new Map();
const runtimeMode = get('runtime-mode');
let selectedRuntime = 'web';
const toast = get('toast');
const shell = get('app-shell');
let repositories = [];
let activeRepository = null;
let activeComparison = null;
let comparisonMenuContext = null;
let comparisonRenameContext = null;
let repositoryDeleteContext = null;
const repositoryComparisons = new Map();
const collapsedRepositories = new Set();
let selectedFile = null;
let previewUrls = null;
const projectPreviewSessions = new Map();
const maxRetainedProjects = 3;
let overlayDiff = null;
const diffCache = createDiffCache();
let diffRequestVersion = 0;
const overlayCounts = {};
const overlayRequests = {};
const overlayMatchedFiles = {};
let diffLoadError = null;
let overlayRequestSequence = 0;
let diffProgressHideTimeout;
const toastDuration = 3000;
const detailToastDuration = 6000;
let previewRefresh = Promise.resolve();
let previewCleanup = Promise.resolve();
const previewRevision = { base: 0, target: 0 };
const previewState = { base: 'stopped', target: 'stopped' };
const pagePickers = new Map();
const selectedPages = { base: null, target: null };
const pendingPageLandings = { base: null, target: null };
const pendingMirroredNavigations = { base: null, target: null };
const visualPreviewMode = { base: false, target: false };
let pageSelectionSynced = true;
let expandedSide = null;
let diffCloseTimeout;
let resizingDiff = false;
let draggedRepositoryPath = null;
const customPreviewSize = { value: null };
const previewGeometry = {};
const previewZoom = { base: 100, target: 100 };
const previewFit = { base: null, target: null };
let previewResizeDrag = null;
let toastAlertSequence = 0;
let filePreviewMenu = null;
let filePreviewMenuTrigger = null;
let filePreviewMenuToggleTrigger = null;
const detailToasts = new Set();

function layoutToastAlerts() {
  const alerts = [get('diff-progress'), get('toast'), ...detailToasts]
    .filter((alert) => alert.dataset.toastVisible === 'true')
    .sort((a, b) => Number(b.dataset.toastOrder) - Number(a.dataset.toastOrder));
  let bottom = 96;
  for (const alert of alerts) {
    alert.style.setProperty('--toast-bottom', `${bottom}px`);
    bottom += alert.offsetHeight + 6;
  }
}

function setToastAlertVisible(alert, visible, { bringToFront = false } = {}) {
  const wasVisible = alert.dataset.toastVisible === 'true';
  if (visible) {
    alert.dataset.toastVisible = 'true';
    if (!wasVisible || bringToFront) alert.dataset.toastOrder = String(++toastAlertSequence);
  } else {
    delete alert.dataset.toastVisible;
    delete alert.dataset.toastOrder;
  }
  window.requestAnimationFrame(layoutToastAlerts);
}

function notify(message, { title, dismissible = false, tone = 'default', duration = title ? detailToastDuration : toastDuration, action } = {}) {
  if (title) {
    const alert = document.createElement('div');
    alert.className = 'toast toast-detail';
    alert.classList.toggle('error', tone === 'error');
    alert.setAttribute('role', 'status');
    alert.setAttribute('aria-live', 'polite');
    alert.setAttribute('popover', 'manual');
    const content = document.createElement('div');
    content.className = 'toast-content';
    const heading = document.createElement('strong');
    heading.className = 'toast-title';
    heading.textContent = title;
    const body = document.createElement('p');
    body.className = 'toast-body';
    body.textContent = message;
    content.append(heading, body);
    alert.append(content);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      alert.classList.remove('show');
      setToastAlertVisible(alert, false);
      if (typeof alert.hidePopover === 'function' && alert.matches(':popover-open')) alert.hidePopover();
      window.setTimeout(() => { detailToasts.delete(alert); alert.remove(); }, 220);
    };
    if (action?.label && typeof action.onClick === 'function') {
      const actionButton = document.createElement('button');
      actionButton.type = 'button';
      actionButton.className = 'toast-action';
      actionButton.textContent = action.label;
      content.append(actionButton);
      actionButton.addEventListener('click', () => action.onClick({ button: actionButton, close }));
    }
    if (dismissible) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toast-close';
      button.setAttribute('aria-label', 'Dismiss notification');
      button.innerHTML = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
      button.addEventListener('click', close);
      alert.append(button);
    }
    document.body.append(alert);
    detailToasts.add(alert);
    if (typeof alert.showPopover === 'function') alert.showPopover();
    alert.classList.add('show');
    setToastAlertVisible(alert, true);
    if (!dismissible) window.setTimeout(close, duration);
    return alert;
  }
  toast.textContent = message;
  toast.classList.toggle('error', tone === 'error');
  if (typeof toast.showPopover === 'function' && !toast.matches(':popover-open')) toast.showPopover();
  toast.classList.add('show');
  setToastAlertVisible(toast, true, { bringToFront: true });
  window.clearTimeout(notify.timeout);
  notify.timeout = window.setTimeout(() => {
    toast.classList.remove('show');
    setToastAlertVisible(toast, false);
    if (typeof toast.hidePopover === 'function' && toast.matches(':popover-open')) toast.hidePopover();
  }, duration);
}

window.addEventListener('acorn:notify', (event) => {
  if (event.detail?.message) notify(event.detail.message, { title: event.detail.title, dismissible: event.detail.dismissible, tone: event.detail.tone });
});

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function displaySha(value) {
  return String(value || '').slice(0, 7);
}

function showConnectionModal(show = true) {
  if (show && !bridge) {
    notify('Git repository connections are available in the Acorn macOS app.');
    return;
  }
  get('connection-modal').hidden = !show;
  get('connection-error').textContent = '';
  if (show) get('connect-local').focus();
}

function setSelectOptions(select, repository, selected) {
  const branchOptions = repository.branches.map((branch) => {
    const commit = repository.commits.find((commit) => commit.sha === branch.sha || commit.shortSha === branch.sha);
    return new Option(`${branch.name} • ${displaySha(branch.sha)}${commit ? ` • ${commit.subject}` : ''}`, branch.name, false, branch.name === selected);
  });
  const commits = repository.commits;
  const commitOptions = commits.map((commit) => new Option(`${displaySha(commit.shortSha || commit.sha)} • ${commit.subject}`, commit.sha, false, commit.sha === selected));
  if (selected && selected !== '__working_tree__' && !repository.branches.some(branch => branch.name === selected) && !commits.some(commit => commit.sha === selected)) {
    commitOptions.push(new Option(displaySha(selected), selected, false, true));
  }
  // Native optgroups indent their items. Disabled section labels keep the
  // native menu while aligning titles and entries in the same column.
  const branchesTitle = new Option('Branches', '__branches_title__');
  branchesTitle.disabled = true;
  const commitsTitle = new Option('Commit log', '__commits_title__');
  commitsTitle.disabled = true;
  select.replaceChildren(new Option('Working folder • uncommitted changes', '__working_tree__', false, selected === '__working_tree__'), branchesTitle, ...branchOptions, commitsTitle, ...commitOptions);
  select.dataset.selectedRef = select.value;
  refPickers.get(select)?.render({ hasMore: repository.commitHistory?.hasMore, loading: repository.loadingCommits });
}

function setRuntimeOptions(repository) {
  const available = repository.runtimes.filter((runtime) => runtime.available);
  const runtime = available.find((runtime) => runtime.id === repository.defaultRuntime) || available[0];
  selectedRuntime = runtime?.id || 'web';
  runtimeMode.textContent = repository.platforms?.label || 'Unknown';
  const nativeProject = repository.platforms?.mobile || repository.platforms?.desktop;
  if (nativeProject) {
    runtimeMode.dataset.tooltip = 'Preview is web-based and does not emulate native platforms.';
    runtimeMode.tabIndex = 0;
  } else {
    delete runtimeMode.dataset.tooltip;
    runtimeMode.removeAttribute('tabindex');
  }
  runtimeMode.hidden = false;
}

function clearProjectDropIndicators() {
  for (const item of document.querySelectorAll('.repository-group')) item.classList.remove('drag-before', 'drag-after');
}

const repositoryEndDropZone = document.querySelector('.sidebar-spacer');
repositoryEndDropZone.addEventListener('dragover', (event) => {
  clearProjectDropIndicators();
  const lastRepository = repositories.at(-1);
  if (!draggedRepositoryPath || !lastRepository || draggedRepositoryPath === lastRepository.path) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const lastGroup = get('project-list').lastElementChild;
  lastGroup.classList.add('drag-after');
  lastGroup.scrollIntoView({ block: 'nearest' });
});
repositoryEndDropZone.addEventListener('dragleave', (event) => {
  if (!repositoryEndDropZone.contains(event.relatedTarget)) clearProjectDropIndicators();
});
repositoryEndDropZone.addEventListener('drop', (event) => {
  const lastRepository = repositories.at(-1);
  if (!draggedRepositoryPath || !lastRepository) return;
  event.preventDefault();
  const draggedPath = draggedRepositoryPath;
  draggedRepositoryPath = null;
  clearProjectDropIndicators();
  moveRepository(draggedPath, lastRepository.path, true);
});

async function moveRepository(draggedPath, targetPath, placeAfter) {
  const moved = repositories.find((repository) => repository.path === draggedPath);
  if (!moved || draggedPath === targetPath) return;
  const reordered = repositories.filter((repository) => repository.path !== draggedPath);
  const targetIndex = reordered.findIndex((repository) => repository.path === targetPath);
  if (targetIndex < 0) return;
  reordered.splice(targetIndex + (placeAfter ? 1 : 0), 0, moved);
  repositories = reordered;
  renderProjectList();
  const result = await bridge?.reorderRepositories(repositories.map((repository) => repository.path));
  if (result?.error) notify(result.error, { title: 'Could not save repository order', dismissible: true, tone: 'error' });
}

function comparisonsFor(repository) {
  if (repositoryComparisons.has(repository.path)) return repositoryComparisons.get(repository.path);
  let comparisons;
  const stored = typeof bridge !== 'undefined' && bridge?.readComparisons?.(repository.path);
  if (stored?.error) throw new Error(`Could not load comparisons: ${stored.error}`);
  try {
    const saved = stored?.comparisons ?? JSON.parse(localStorage.getItem(`acorn.comparisons:${repository.path}`));
    if (Array.isArray(saved)) {
      const ids = new Set();
      comparisons = saved.filter(item => {
        if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)
          || typeof item.base !== 'string' || !item.base || typeof item.target !== 'string' || !item.target) return false;
        ids.add(item.id);
        return true;
      });
      if (saved.length && !comparisons.length) comparisons = undefined;
    }
  } catch { /* Start with a default comparison if storage is unavailable. */ }
  if (!comparisons) {
    const branch = repository.branches.find(item => item.name === 'main')
      || repository.branches.find(item => item.name === repository.defaultBranch);
    comparisons = [{ id: crypto.randomUUID(), base: '__working_tree__', target: repository.commits.find(commit => commit.sha.startsWith(branch?.sha || '!'))?.sha || branch?.name || repository.commits[0].sha }];
  }
  repositoryComparisons.set(repository.path, comparisons);
  // Migrate legacy storage and persist the initial comparison's stable ID.
  if (stored && stored.comparisons === null) persistComparisons(repository);
  return comparisons;
}

function persistComparisons(repository) {
  const comparisons = comparisonsFor(repository);
  try {
    if (typeof bridge !== 'undefined' && bridge?.saveComparisons) {
      const result = bridge.saveComparisons(repository.path, comparisons);
      if (!result?.success) throw new Error(result?.error || 'Storage did not confirm the save.');
    } else {
      localStorage.setItem(`acorn.comparisons:${repository.path}`, JSON.stringify(comparisons));
    }
    return true;
  } catch (error) {
    notify(error.message, { title: 'Comparisons could not be saved', tone: 'error', dismissible: true });
    return false;
  }
}

function legacyProjectViewOptions(repository) {
  try {
    const saved = JSON.parse(localStorage.getItem(`acorn.view-options:${repository.path}`));
    return saved && typeof saved === 'object' ? saved : {};
  } catch { return {}; }
}

function comparisonViewOptionsStorageKey(repository, comparison) {
  return `acorn.comparison-view-options:${JSON.stringify([repository.path, comparison.id])}`;
}

function readComparisonViewOptions(repository, comparison) {
  const defaults = { mouseSync: true, diffOverlay: false };
  try {
    const stored = localStorage.getItem(comparisonViewOptionsStorageKey(repository, comparison));
    const saved = stored === null ? legacyProjectViewOptions(repository) : JSON.parse(stored);
    if (!saved || typeof saved !== 'object') return defaults;
    return {
      mouseSync: typeof saved.mouseSync === 'boolean' ? saved.mouseSync : defaults.mouseSync,
      diffOverlay: typeof saved.diffOverlay === 'boolean' ? saved.diffOverlay : defaults.diffOverlay,
    };
  } catch { return defaults; }
}

function persistComparisonViewOptions(repository = activeRepository, comparison = activeComparison) {
  if (!repository || !comparison) return;
  const options = {
    mouseSync: get('mouse-sync').checked,
    diffOverlay: get('diff-overlay').checked,
  };
  try { localStorage.setItem(comparisonViewOptionsStorageKey(repository, comparison), JSON.stringify(options)); }
  catch { /* Keep the current controls usable when browser storage is unavailable. */ }
}

function repositoryViewOptionsStorageKey(repository) {
  return `acorn.repository-view-options:${repository.path}`;
}

function readRepositoryViewOptions(repository) {
  try {
    const stored = localStorage.getItem(repositoryViewOptionsStorageKey(repository));
    const saved = stored === null ? legacyProjectViewOptions(repository) : JSON.parse(stored);
    return { previewableOnly: typeof saved?.previewableOnly === 'boolean' ? saved.previewableOnly : false };
  } catch { return { previewableOnly: false }; }
}

function persistRepositoryViewOptions(repository = activeRepository) {
  if (!repository) return;
  const options = { previewableOnly: get('previewable-only').checked };
  try { localStorage.setItem(repositoryViewOptionsStorageKey(repository), JSON.stringify(options)); }
  catch { /* Keep the current control usable when browser storage is unavailable. */ }
}

function restoreViewOptions(repository, comparison) {
  const comparisonOptions = readComparisonViewOptions(repository, comparison);
  const repositoryOptions = readRepositoryViewOptions(repository);
  get('mouse-sync').checked = comparisonOptions.mouseSync;
  get('diff-overlay').checked = comparisonOptions.diffOverlay;
  get('previewable-only').checked = repositoryOptions.previewableOnly;
  applyPreviewableOnlyFilter();
  configureMouseSync();
  configureDiffOverlay();
}

function comparisonName(repository, comparison) {
  if (typeof comparison.name === 'string' && comparison.name.trim()) return comparison.name.trim();
  const main = repository.branches.find(branch => branch.name === 'main');
  const label = ref => {
    if (ref === '__working_tree__') return 'Working Folder';
    const sha = repository.branches.find(branch => branch.name === ref)?.sha || ref;
    if (main && (ref === main.name || (main.sha && sha.length >= 7
      && (sha.startsWith(main.sha) || main.sha.startsWith(sha))))) return 'Main';
    return displaySha(sha);
  };
  return `${label(comparison.base)} • ${label(comparison.target)}`;
}

function runtimeServerDetail(repository, server) {
  if (server.workingTree) return 'Working Folder';
  const mainSha = repository?.branches.find(branch => branch.name === 'main')?.sha;
  const isMain = mainSha && server.sha?.length >= 7
    && (server.sha.startsWith(mainSha) || mainSha.startsWith(server.sha));
  return isMain ? `Main · ${displaySha(server.sha)}` : displaySha(server.sha);
}

function runtimeUsedServerUrls(currentPreviews = previewUrls, sessions = projectPreviewSessions) {
  const urls = new Set();
  const collect = (previews) => {
    for (const preview of Object.values(previews || {})) {
      const url = preview?.upstreamUrl || preview?.url;
      if (url) urls.add(url);
    }
  };
  collect(currentPreviews);
  for (const session of sessions.values()) collect(session.previews);
  return urls;
}

function comparisonSessionKey(repository, comparison) {
  return JSON.stringify([repository.path, comparison.id]);
}

function addComparison(repository) {
  const commits = repository.commits;
  const comparison = { id: crypto.randomUUID(), base: commits[0].sha, target: (commits[1] || commits[0]).sha };
  comparisonsFor(repository).push(comparison);
  persistComparisons(repository);
  collapsedRepositories.delete(repository.path);
  activateRepository(repository.path, comparison.id);
}

function renderProjectList() {
  closeComparisonMenu();
  const list = get('project-list');
  list.replaceChildren(...repositories.map((repository) => {
    const group = document.createElement('div');
    group.className = 'repository-group';
    const row = document.createElement('div');
    row.className = 'repository-row';
    const button = document.createElement('button');
    button.className = 'project-item';
    button.type = 'button';
    const collapsed = collapsedRepositories.has(repository.path);
    button.setAttribute('aria-expanded', String(!collapsed));
    button.draggable = true;
    button.setAttribute('aria-label', repository.name);
    button.addEventListener('pointerenter', () => {
      if (shell.classList.contains('sidebar-collapsed')) showIconTooltip(button, repository);
    });
    button.addEventListener('focus', () => {
      if (shell.classList.contains('sidebar-collapsed') && button.matches(':focus-visible')) showIconTooltip(button, repository);
    });
    button.addEventListener('pointerleave', scheduleIconTooltipHide);
    button.addEventListener('blur', scheduleIconTooltipHide);
    button.addEventListener('click', hideIconTooltip);

    const folderPath = collapsed
      ? 'M2.75 6.25A1.75 1.75 0 0 1 4.5 4.5h3.1l1.8 2h6.1a1.75 1.75 0 0 1 1.75 1.75v6.25a1.75 1.75 0 0 1-1.75 1.75h-11a1.75 1.75 0 0 1-1.75-1.75V6.25Z'
      : 'M2.75 14.5V6.25A1.75 1.75 0 0 1 4.5 4.5h3.1l1.8 2h6.1a1.75 1.75 0 0 1 1.75 1.75v1M2.75 14.5l2-4.25A1.25 1.25 0 0 1 5.88 9.5H17a1 1 0 0 1 .91 1.41l-1.95 4.34a1.25 1.25 0 0 1-1.14.75H4.5a1.75 1.75 0 0 1-1.75-1.5Z';
    const marker = `<svg class="sidebar-icon project-folder" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${folderPath}"/></svg>`;
    button.innerHTML = `${marker}<span class="project-name">${escapeHtml(repository.name)}</span>`;
    button.addEventListener('click', () => {
      if (shell.classList.contains('sidebar-collapsed')) {
        setSidebarCollapsed(false);
        collapsedRepositories.delete(repository.path);
      } else if (collapsed) collapsedRepositories.delete(repository.path);
      else collapsedRepositories.add(repository.path);
      renderProjectList();
    });
    button.addEventListener('dragstart', (event) => {
      draggedRepositoryPath = repository.path;
      button.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', repository.path);
    });
    group.addEventListener('dragover', (event) => {
      clearProjectDropIndicators();
      if (!draggedRepositoryPath || draggedRepositoryPath === repository.path) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const bounds = group.getBoundingClientRect();
      const placeAfter = event.clientY >= bounds.top + bounds.height / 2;
      group.classList.add(placeAfter ? 'drag-after' : 'drag-before');
    });
    group.addEventListener('dragleave', (event) => {
      if (!group.contains(event.relatedTarget)) clearProjectDropIndicators();
    });
    group.addEventListener('drop', (event) => {
      if (!draggedRepositoryPath || draggedRepositoryPath === repository.path) return;
      event.preventDefault();
      const draggedPath = draggedRepositoryPath;
      const bounds = group.getBoundingClientRect();
      const placeAfter = event.clientY >= bounds.top + bounds.height / 2;
      draggedRepositoryPath = null;
      clearProjectDropIndicators();
      moveRepository(draggedPath, repository.path, placeAfter);
    });
    button.addEventListener('dragend', () => {
      draggedRepositoryPath = null;
      button.classList.remove('dragging');
      clearProjectDropIndicators();
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'new-comparison';
    add.setAttribute('aria-label', 'New Comparison');
    add.dataset.tooltip = 'New Comparison';
    add.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>';
    add.addEventListener('pointerenter', () => showIconTooltip(add));
    add.addEventListener('pointerleave', hideIconTooltip);
    add.addEventListener('focus', () => { if (add.matches(':focus-visible')) showIconTooltip(add); });
    add.addEventListener('blur', hideIconTooltip);
    add.addEventListener('click', () => { hideIconTooltip(); addComparison(repository); });
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'repository-more';
    more.setAttribute('aria-label', `Actions for ${repository.name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.3"/><circle cx="10" cy="10" r="1.3"/><circle cx="16" cy="10" r="1.3"/></svg>';
    more.addEventListener('click', () => openComparisonMenu(repository, null, more));
    row.append(button, more, add);
    const children = document.createElement('div');
    children.className = 'comparison-list';
    children.hidden = collapsed;
    children.setAttribute('role', 'group');
    children.setAttribute('aria-label', `${repository.name} comparisons`);
    for (const comparison of comparisonsFor(repository)) {
      const child = document.createElement('button');
      child.type = 'button';
      const active = repository.path === activeRepository?.path && comparison.id === activeComparison?.id;
      child.className = `comparison-item${active ? ' active' : ''}`;
      child.textContent = comparisonName(repository, comparison);

      if (active) child.setAttribute('aria-current', 'page');
      child.addEventListener('click', () => activateRepository(repository.path, comparison.id));
      const comparisonRow = document.createElement('div');
      comparisonRow.className = 'comparison-row';
      comparisonRow.dataset.comparisonId = comparison.id;
      comparisonRow.dataset.repositoryPath = repository.path;
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'comparison-more';
      more.setAttribute('aria-label', `Actions for ${child.textContent}`);
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      more.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.3"/><circle cx="10" cy="10" r="1.3"/><circle cx="16" cy="10" r="1.3"/></svg>';
      more.addEventListener('click', () => openComparisonMenu(repository, comparison, more));
      comparisonRow.append(child, more);
      children.append(comparisonRow);
    }
    group.append(row, children);
    return group;
  }));
}

function comparisonActionButton(repository, comparison) {
  return [...get('project-list').querySelectorAll('.comparison-row')]
    .find(row => row.dataset.repositoryPath === repository.path && row.dataset.comparisonId === comparison.id)
    ?.querySelector('.comparison-more');
}

function closeComparisonMenu() {
  const menu = get('comparison-menu');
  if (menu.matches(':popover-open')) menu.hidePopover();
  comparisonMenuContext?.button.setAttribute('aria-expanded', 'false');
  comparisonMenuContext = null;
}

function openComparisonMenu(repository, comparison, button) {
  const alreadyOpen = comparisonMenuContext?.button === button;
  closeComparisonMenu();
  if (alreadyOpen) return;
  hideIconTooltip();
  comparisonMenuContext = { repository, comparison, button };
  button.setAttribute('aria-expanded', 'true');
  const menu = get('comparison-menu');
  get('comparison-rename').hidden = !comparison;
  get('comparison-delete').textContent = comparison ? 'Delete' : 'Remove Repository';
  menu.setAttribute('aria-label', comparison ? 'Comparison actions' : 'Repository actions');
  menu.showPopover();
  const bounds = button.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(bounds.left + (bounds.width - size.width) / 2, innerWidth - size.width - 8))}px`;
  menu.style.top = `${bounds.bottom + size.height + 12 <= innerHeight ? bounds.bottom + 4 : Math.max(8, bounds.top - size.height - 4)}px`;
  menu.querySelector('button:not([hidden])').focus();
}

function renameComparison(repository, comparison, name) {
  const value = name.trim();
  if (!value || !comparisonsFor(repository).includes(comparison)) return;
  comparison.name = value;
  persistComparisons(repository);
  renderProjectList();
}

function showEmptyComparisons(repository) {
  if (activeComparison) saveProjectPreviewSession();
  for (const side of ['base', 'target']) {
    get(`${side}-preview-frame`)?.remove();
    ++previewRevision[side];
    previewState[side] = 'stopped';
    selectedPages[side] = null;
    pendingPageLandings[side] = null;
    visualPreviewMode[side] = false;
  }
  activeRepository = null;
  activeComparison = null;
  previewUrls = {};
  selectedFile = null;
  overlayDiff = null;
  ++diffRequestVersion;
  setDiffLoading(false);
  setExpandedPanel(null);
  activateProjectFrames();
  for (const picker of refPickers.values()) picker.close();
  for (const picker of pagePickers.values()) picker.close();
  get('comparison-controls').hidden = true;
  get('comparison-top-actions').hidden = true;
  get('preview-grid').hidden = true;
  get('connection-empty').hidden = true;
  get('comparison-empty').hidden = false;
  get('project-title').textContent = repository.name;
  renderProjectMetadata(repository);
  get('empty-comparison').onclick = () => addComparison(repository);
  renderProjectList();
  updateRefreshAllState();
}

async function deleteRepository(repository) {
  closeComparisonMenu();
  const comparisons = [...comparisonsFor(repository)];
  try {
    const result = await bridge?.removeRepository({ path: repository.path, comparisonIds: comparisons.map(item => item.id) });
    if (!result?.success) throw new Error(result?.error || 'Repository removal is unavailable.');
  } catch (error) {
    notify(error.message, { title: 'Could not delete repository', dismissible: true, tone: 'error' });
    return;
  }
  repositories = repositories.filter(item => item.path !== repository.path);
  collapsedRepositories.delete(repository.path);
  if (activeRepository?.path === repository.path || !activeRepository) {
    if (repositories.length) activateRepository(repositories[0].path);
    else {
      showEmptyComparisons(repository);
      get('comparison-empty').hidden = true;
      get('empty-comparison').onclick = null;
      get('connection-empty').hidden = false;
      get('project-title').textContent = 'Connect a repository';
      get('project-remote').textContent = 'Connect a repository to begin';
      runtimeMode.hidden = true;
    }
  }
  clearRepositoryClientState(repository, comparisons);
  renderProjectList();
  runtimeListSignature = '';
  refreshRuntimeServers();
}

function clearRepositoryClientState(repository, comparisons = []) {
  for (const [key, session] of projectPreviewSessions) {
    if (JSON.parse(key)[0] !== repository.path) continue;
    for (const frame of Object.values(session.frames || {})) frame.remove();
    projectPreviewSessions.delete(key);
  }
  try {
    localStorage.removeItem(`acorn.comparisons:${repository.path}`);
    localStorage.removeItem(`acorn.view-options:${repository.path}`);
    localStorage.removeItem(repositoryViewOptionsStorageKey(repository));
    for (const comparison of comparisons) localStorage.removeItem(comparisonViewOptionsStorageKey(repository, comparison));
    const retainedKeys = [];
    for (let index = 0; index < Number(localStorage.length || 0); index++) {
      const key = localStorage.key?.(index);
      if (!key?.startsWith('acorn.comparison-view-options:')) continue;
      try {
        const identity = JSON.parse(key.slice('acorn.comparison-view-options:'.length));
        if (Array.isArray(identity) && identity[0] === repository.path) retainedKeys.push(key);
      } catch { /* Ignore unrelated malformed browser storage. */ }
    }
    for (const key of retainedKeys) localStorage.removeItem(key);
  } catch { /* Native cleanup still makes the next connection fresh. */ }
  repositoryComparisons.delete(repository.path);
}

function deleteComparison(repository, comparison) {
  const comparisons = comparisonsFor(repository);
  const index = comparisons.indexOf(comparison);
  if (index < 0) return Promise.resolve();
  closeComparisonMenu();
  const key = comparisonSessionKey(repository, comparison);
  const isActive = activeRepository?.path === repository.path && activeComparison?.id === comparison.id;
  comparisons.splice(index, 1);
  persistComparisons(repository);
  if (isActive) {
    const nextRepository = comparisons.length ? repository : repositories.find(item => comparisonsFor(item).length);
    if (nextRepository) activateRepository(nextRepository.path, comparisons[Math.min(index, comparisons.length - 1)]?.id);
    else showEmptyComparisons(repository);
  } else renderProjectList();
  for (const frame of Object.values(projectPreviewSessions.get(key)?.frames || {})) frame.remove();
  projectPreviewSessions.delete(key);
  // Send release immediately: waiting for previewRefresh would let deleted builds finish.
  const cleanup = (bridge?.releaseComparison
    ? bridge.releaseComparison({ path: repository.path, comparisonId: comparison.id })
    : Promise.resolve({ stopped: [] }))
    .then(result => {
      if (result.error) throw new Error(result.error);
      for (const server of result.stopped || []) invalidateRetainedPreviews(server);
    })
    .catch(error => notify(error.message, { title: 'Comparison deleted, but server cleanup failed', dismissible: true, tone: 'error' }))
    .finally(() => { runtimeListSignature = ''; refreshRuntimeServers(); });
  previewRefresh = Promise.allSettled([previewRefresh, cleanup]);
  return previewRefresh;
}

get('comparison-menu').addEventListener('toggle', event => {
  if (event.newState === 'closed' && !get('comparison-menu').matches(':popover-open')) closeComparisonMenu();
});
get('comparison-menu').addEventListener('keydown', event => {
  const items = [...get('comparison-menu').querySelectorAll('button:not([hidden])')];
  const index = items.indexOf(document.activeElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    const button = comparisonMenuContext?.button;
    closeComparisonMenu();
    button?.focus();
  }
});
get('comparison-rename').addEventListener('click', () => {
  if (!comparisonMenuContext) return;
  comparisonRenameContext = comparisonMenuContext;
  closeComparisonMenu();
  get('comparison-name').value = comparisonName(comparisonRenameContext.repository, comparisonRenameContext.comparison);
  get('comparison-rename-dialog').showModal();
  get('comparison-name').select();
});
get('comparison-delete').addEventListener('click', () => {
  if (!comparisonMenuContext) return;
  const { repository, comparison } = comparisonMenuContext;
  if (comparison) deleteComparison(repository, comparison);
  else {
    repositoryDeleteContext = comparisonMenuContext;
    closeComparisonMenu();
    get('repository-delete-title').textContent = `Remove ${repository.name}`;
    get('repository-delete-dialog').showModal();
    get('repository-delete-cancel').focus();
  }
});
get('repository-delete-cancel').addEventListener('click', () => get('repository-delete-dialog').close());
get('repository-delete-confirm').addEventListener('click', () => {
  if (!repositoryDeleteContext) return;
  const { repository } = repositoryDeleteContext;
  repositoryDeleteContext = null;
  get('repository-delete-dialog').close();
  deleteRepository(repository);
});
get('repository-delete-dialog').addEventListener('close', () => {
  repositoryDeleteContext?.button.focus();
  repositoryDeleteContext = null;
});
get('comparison-rename-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = get('comparison-name').value.trim();
  if (!name || !comparisonRenameContext) return;
  renameComparison(comparisonRenameContext.repository, comparisonRenameContext.comparison, name);
  get('comparison-rename-dialog').close();
});
get('comparison-rename-cancel').addEventListener('click', () => get('comparison-rename-dialog').close());
get('comparison-rename-dialog').addEventListener('close', () => {
  if (comparisonRenameContext) comparisonActionButton(comparisonRenameContext.repository, comparisonRenameContext.comparison)?.focus();
  comparisonRenameContext = null;
});
window.addEventListener('resize', closeComparisonMenu);
document.querySelector('.sidebar-section').addEventListener('scroll', closeComparisonMenu, true);

function updateRefs(sides = ['base', 'target'], options = {}) {
  if (!activeRepository) return;
  const resolveRef = (value) => value === '__working_tree__' ? { workingTree: true } : activeRepository.branches.find((branch) => branch.name === value)
    || activeRepository.commits.find((commit) => commit.sha === value) || (/^[0-9a-f]{7,40}$/i.test(value) ? { sha: value } : null);
  const base = resolveRef(baseRef.value);
  const target = resolveRef(targetRef.value);
  if (!base || !target) return;
  for (const select of [baseRef, targetRef]) {
    select.title = select.selectedOptions[0]?.textContent || '';
    select.dataset.selectedRef = select.value;
    refPickers.get(select)?.render({ hasMore: activeRepository.commitHistory?.hasMore, loading: activeRepository.loadingCommits });
  }
  if (activeComparison) {
    activeComparison.base = baseRef.value;
    activeComparison.target = targetRef.value;
    persistComparisons(activeRepository);
    renderProjectList();
  }
  loadDiff();
  schedulePreview(sides, options);
}

function previewRouteUrl(value, serverUrl) {
  const base = new URL(serverUrl);
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const input = value.trim();
  // The displayed path is origin-relative; copied URLs keep this local server.
  const path = /^https?:\/\//i.test(input)
    ? (() => { const url = new URL(input); return `${url.pathname}${url.search}${url.hash}`; })()
    : input;
  const url = new URL(path || base.pathname, base);
  if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Enter a page path on this preview server.');
  }
  return url.href;
}

function displayPreviewAddress(side, value) {
  // The hidden field remains internal state for sizing and refresh code.
  get(`${side}-url`).value = value;
}

function updateRoute(sides = ['base', 'target'], { replace = false } = {}) {
  for (const side of sides) {
    const preview = previewUrls?.[side];
    const page = selectedPages[side];
    if (!preview?.url || !page?.available) continue;
    if (preview.visual && page.visualFallback !== true) {
      visualPreviewMode[side] = false;
      schedulePreview([side], { reuse: true, visual: false });
      continue;
    }
    const url = new URL(previewRouteUrl(page.previewPath || page.path, preview.url));
    url.searchParams.set('__acorn_page', page.id);
    get(`${side}-url`).value = page.path;
    if (preview.currentUrl !== url.href) {
      const frame = get(`${side}-preview-frame`);
      // Mirrored loads must not add an entry to the frames' joint history.
      if (replace) frame.contentWindow.location.replace(url.href);
      else frame.src = url.href;
    }
    preview.currentUrl = url.href;
  }
}

function matchingPage(side, page) {
  const pages = previewUrls?.[side]?.catalog?.pages || [];
  return pages.find(candidate => candidate.id === page?.id)
    || pages.find(candidate => candidate.path === page?.path);
}

function markPendingMirroredNavigation(side, source) {
  const previous = pendingMirroredNavigations.base || pendingMirroredNavigations.target;
  const pageSyncWasEnabled = previous?.pageSyncWasEnabled ?? pageSelectionSynced;
  clearPendingMirroredNavigation(previous);
  const pending = { source, target: side, pageSyncWasEnabled, settleTimer: null, expiryTimer: null };
  pendingMirroredNavigations.base = pending;
  pendingMirroredNavigations.target = pending;
  if (pageSyncWasEnabled) setPageSync(false);
  // A mirrored click may open a modal without changing the route. Keep the
  // transaction alive long enough for a delayed route transition on the
  // other revision, but do not compare the pages until one actually changes.
  pending.expiryTimer = window.setTimeout(() => settlePendingMirroredNavigation(pending), 5000);
}

function pendingMirroredNavigation(side) {
  return pendingMirroredNavigations[side];
}

function clearPendingMirroredNavigation(pending) {
  if (pending?.settleTimer) window.clearTimeout(pending.settleTimer);
  if (pending?.expiryTimer) window.clearTimeout(pending.expiryTimer);
  for (const side of ['base', 'target']) {
    if (pendingMirroredNavigations[side] === pending) pendingMirroredNavigations[side] = null;
  }
}

function settlePendingMirroredNavigation(pending) {
  if (!pending || !['base', 'target'].some(side => pendingMirroredNavigations[side] === pending)) return;
  const basePage = selectedPages.base;
  const targetPage = selectedPages.target;
  const targetMatch = matchingPage('target', basePage);
  const samePage = Boolean(basePage && targetPage && targetMatch?.id === targetPage.id);
  if (pending.pageSyncWasEnabled && samePage) {
    setPageSync(true);
  } else if (pending.pageSyncWasEnabled && basePage && targetPage) {
    notify('The same click produced different results, so each preview will keep its own page.', { title: 'Page sync was unlocked' });
  }
  clearPendingMirroredNavigation(pending);
}

function schedulePendingMirroredNavigationCheck(pending, delay = 500) {
  if (pending.settleTimer) window.clearTimeout(pending.settleTimer);
  pending.settleTimer = window.setTimeout(() => settlePendingMirroredNavigation(pending), delay);
}

function renderPageSync() {
  const button = get('page-sync');
  button.classList.toggle('is-locked', pageSelectionSynced);
  button.setAttribute('aria-pressed', String(pageSelectionSynced));
  button.setAttribute('aria-label', pageSelectionSynced ? 'Unlock page selection' : 'Sync page selection');
  button.title = pageSelectionSynced ? 'Page selection synced' : 'Page selection independent';
}

function setPageSync(value, { notifyMissing = false } = {}) {
  pageSelectionSynced = value;
  renderPageSync();
  if (notifyMissing) notify('That page does not exist in the other revision. You can select pages independently.', { title: 'Page sync was unlocked' });
}

function syncPageFrom(side, page, { fromNavigation = false } = {}) {
  if (!pageSelectionSynced || !page) return true;
  const other = side === 'base' ? 'target' : 'base';
  if (previewState[other] === 'loading' || !previewUrls?.[other]) return true;
  const match = matchingPage(other, page);
  if (!match) { setPageSync(false, { notifyMissing: true }); return false; }
  // A mirrored load reports navigation too. Do not echo it into the source
  // iframe: reloading that document discards the app router's in-memory stack.
  if (fromNavigation && selectedPages[other]?.id === match.id) return true;
  selectedPages[other] = match;
  pagePickers.get(other)?.select(match.id);
  if (!previewUrls[other]?.visual) markPendingPageLanding(other, match);
  updateRoute([other], { replace: true });
  return true;
}

function markPendingPageLanding(side, page) {
  // A route mismatch alone does not establish an auth/data prerequisite.
  // The catalog must identify a supported state guard or an explicit opt-in.
  if (page.visualFallback !== true) {
    pendingPageLandings[side] = null;
    return;
  }
  const landing = { page };
  pendingPageLandings[side] = landing;
  window.setTimeout(() => { if (pendingPageLandings[side] === landing) pendingPageLandings[side] = null; }, 1500);
}

function choosePage(side, page) {
  selectedPages[side] = page;
  pagePickers.get(side)?.select(page.id);
  if (!previewUrls?.[side]?.visual) markPendingPageLanding(side, page);
  updateRoute([side]);
  syncPageFrom(side, page);
}

function normalizedSourcePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function previewPagesForFile(file) {
  const source = normalizedSourcePath(file);
  const matches = new Map();
  const add = (side, page) => {
    if (!page?.available) return;
    const key = String(page.id || page.path);
    const match = matches.get(key) || { id: key, label: page.label || page.path, path: page.path, group: page.group || [], pages: {} };
    match.pages[side] = page;
    matches.set(key, match);
  };
  for (const side of ['base', 'target']) {
    for (const page of previewUrls?.[side]?.catalog?.pages || []) {
      if (!page.available || normalizedSourcePath(page.source) !== source) continue;
      add(side, page);
    }
    if (overlayMatchedFiles[side]?.has(source)) add(side, selectedPages[side]);
  }
  return [...matches.values()].sort((a, b) => a.path.localeCompare(b.path) || a.label.localeCompare(b.label));
}

function previewSideForPage(match) {
  const scope = get('diff-scope').querySelector('input:checked').value;
  if (scope !== 'both' && match.pages[scope]) return scope;
  for (const side of canvasSides()) if (match.pages[side]) return side;
  return match.pages.target ? 'target' : 'base';
}

function viewPageFromDiff(match) {
  const side = previewSideForPage(match);
  const page = match.pages[side];
  if (!page) return;
  if (!canvasSides().includes(side)) {
    const input = get('layout-mode').querySelector(`input[value="${side}"]`);
    if (input) { input.checked = true; applyLayoutMode(side); }
  }
  choosePage(side, page);
  if (!get('diff-overlay').checked) {
    get('diff-overlay').checked = true;
    persistComparisonViewOptions();
    configureDiffOverlay();
  }
  filePreviewMenu?.hidePopover?.();
}

function ensureFilePreviewMenu() {
  if (filePreviewMenu) return filePreviewMenu;
  filePreviewMenu = document.createElement('div');
  filePreviewMenu.id = 'file-preview-menu';
  filePreviewMenu.className = 'file-preview-menu';
  filePreviewMenu.setAttribute('popover', 'auto');
  filePreviewMenu.setAttribute('role', 'menu');
  filePreviewMenu.setAttribute('aria-label', 'Choose a preview page');
  document.body.append(filePreviewMenu);
  filePreviewMenu.addEventListener('toggle', (event) => {
    if (event.newState === 'open') {
      filePreviewMenu.querySelector('button')?.focus();
      return;
    }
    filePreviewMenuTrigger?.setAttribute('aria-expanded', 'false');
    filePreviewMenuTrigger = null;
  });
  filePreviewMenu.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...filePreviewMenu.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
    event.preventDefault();
    buttons[next]?.focus();
  });
  return filePreviewMenu;
}

function openFilePreviewMenu(button, pages) {
  const menu = ensureFilePreviewMenu();
  if (filePreviewMenuToggleTrigger === button || (menu.matches(':popover-open') && filePreviewMenuTrigger === button)) {
    filePreviewMenuToggleTrigger = null;
    if (menu.matches(':popover-open')) menu.hidePopover();
    button.setAttribute('aria-expanded', 'false');
    button.focus();
    return;
  }
  filePreviewMenuToggleTrigger = null;
  filePreviewMenuTrigger?.setAttribute('aria-expanded', 'false');
  filePreviewMenuTrigger = button;
  button.setAttribute('aria-expanded', 'true');
  menu.replaceChildren(...pages.map((match) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.setAttribute('role', 'menuitem');
    const location = [...match.group, match.label].join(' / ');
    option.innerHTML = `<span class="file-preview-menu-scroll"><span class="file-preview-menu-scroll-text"><span class="file-preview-menu-label">${escapeHtml(location)}</span><small class="file-preview-menu-path">${escapeHtml(match.path)}</small></span></span>`;
    option.addEventListener('click', () => viewPageFromDiff(match));
    return option;
  }));
  const bounds = button.getBoundingClientRect();
  menu.style.visibility = 'hidden';
  menu.showPopover();
  for (const line of menu.querySelectorAll('.file-preview-menu-scroll')) {
    const text = line.querySelector('.file-preview-menu-scroll-text');
    const overflow = Math.ceil(text.scrollWidth - line.clientWidth);
    if (overflow <= 0) continue;
    line.classList.add('is-overflowing');
    line.title = text.textContent;
    line.style.setProperty('--marquee-distance', `${overflow}px`);
    line.style.setProperty('--marquee-duration', `${Math.max(3, overflow / 30 + 2).toFixed(2)}s`);
  }
  const menuBounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(bounds.right - menuBounds.width, innerWidth - menuBounds.width - 8))}px`;
  menu.style.top = `${bounds.bottom + menuBounds.height + 8 <= innerHeight ? bounds.bottom + 4 : Math.max(8, bounds.top - menuBounds.height - 4)}px`;
  menu.style.visibility = '';
}

function applyPreviewableOnlyFilter() {
  const previewableOnly = get('previewable-only').checked;
  for (const row of get('file-list').querySelectorAll('.file')) {
    row.hidden = previewableOnly && !row.classList.contains('has-preview-action');
  }
}

function refreshFilePreviewActions() {
  for (const row of get('file-list').querySelectorAll('.file')) {
    const trailing = row.querySelector('.file-trailing');
    trailing?.querySelector('.file-preview-action')?.remove();
    row.classList.remove('has-preview-action');
    const pages = previewPagesForFile(row.dataset.file);
    if (!trailing || !pages.length) continue;
    row.classList.add('has-preview-action');
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'file-preview-action';
    action.innerHTML = `View in Preview${pages.length > 1 ? '<span aria-hidden="true">▾</span>' : ''}`;
    action.setAttribute('aria-label', pages.length > 1 ? `View ${row.dataset.file} in preview; choose a page` : `View ${row.dataset.file} in preview`);
    if (pages.length > 1) {
      action.setAttribute('aria-haspopup', 'menu');
      action.setAttribute('aria-expanded', 'false');
      action.addEventListener('pointerdown', () => {
        filePreviewMenuToggleTrigger = filePreviewMenu?.matches(':popover-open') && filePreviewMenuTrigger === action ? action : null;
      });
      action.addEventListener('pointercancel', () => { filePreviewMenuToggleTrigger = null; });
    }
    action.addEventListener('click', () => pages.length === 1 ? viewPageFromDiff(pages[0]) : openFilePreviewMenu(action, pages));
    trailing.append(action);
  }
  applyPreviewableOnlyFilter();
}

get('previewable-only').addEventListener('change', () => {
  persistRepositoryViewOptions();
  applyPreviewableOnlyFilter();
});

bridge?.onPreviewBlocked?.(() => notify('External or server-only actions are unavailable in UI preview.', { title: 'Action unavailable' }));

bridge?.onPreviewNavigation?.(({ side, url }) => {
  const preview = previewUrls?.[side];
  if (!preview?.url) return;
  try {
    const current = new URL(url);
    if (current.origin !== new URL(preview.url).origin) return;
    const page = preview.catalog.pages.find(page => page.id === current.searchParams.get('__acorn_page'))
      || preview.catalog.pages.find(page => {
        const route = new URL(page.previewPath || page.path, preview.url);
        return route.pathname === current.pathname && (!route.hash || route.hash === current.hash);
      });
    const landing = pendingPageLandings[side];
    // An initial URL notification precedes React's asynchronous guard redirect.
    // Keep watching eligible screens until the bounded landing window expires.
    if (landing?.page.visualFallback === true && page?.id !== landing.page.id && !preview.visual) {
      pendingPageLandings[side] = null;
      selectedPages[side] = landing.page;
      pagePickers.get(side)?.select(landing.page.id);
      visualPreviewMode[side] = true;
      schedulePreview([side], { reuse: true, visual: true });
      return;
    }
    preview.currentUrl = current.href;
    if (page) {
      const previousPage = selectedPages[side];
      selectedPages[side] = page;
      pagePickers.get(side)?.select(page.id);
      if (preview.visual && page.visualFallback !== true) updateRoute([side]);
      const mirrored = pendingMirroredNavigation(side);
      if (mirrored) {
        // Modals commonly push an in-page history entry before the mirrored
        // revision finishes its delayed route transition. Only a real page
        // change means the two click outcomes are ready to compare.
        if (previousPage?.id !== page.id) schedulePendingMirroredNavigationCheck(mirrored);
        return;
      }
      syncPageFrom(side, page, { fromNavigation: true });
    }
  } catch { /* Ignore incomplete URLs. */ }
});

function resizeDevicePreviews() {
  const workspace = document.querySelector('.workspace');
  const workspaceStyles = window.getComputedStyle(workspace);
  const gridTop = get('preview-grid').getBoundingClientRect().top - workspace.getBoundingClientRect().top + workspace.scrollTop;
  const bottomClearance = parseFloat(workspaceStyles.paddingBottom) + 2;
  for (const id of ['base', 'target']) {
    const isExpanded = expandedSide === id;
    const customSize = customPreviewSize.value;
    const fit = previewFit[id];
    const inlineMargin = 0;
    const blockMargin = 0;
    const container = get(`${id}-preview-viewport`);
    const deviceFrame = get(`${id}-device-frame`);
    const frame = get(`${id}-preview-frame`);
    const styles = window.getComputedStyle(container);
    const panel = container.closest('.preview-panel');
    const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const panelChromeHeight = [...panel.children].filter((child) => child !== container).reduce((height, child) => height + child.getBoundingClientRect().height, 0);
    const availableWidth = Math.max(0, container.clientWidth - horizontalPadding - inlineMargin * 2);
    const expandedSectionHeight = container.clientHeight || window.innerHeight - panelChromeHeight - 2;
    const availableHeight = isExpanded
      ? Math.max(0, expandedSectionHeight - verticalPadding - blockMargin)
      : Math.max(0, workspace.clientHeight - gridTop - panelChromeHeight - verticalPadding - bottomClearance);
    container.style.height = '';
    const initialWidth = availableWidth;
    const defaultSize = fit || (activeRepository?.platforms?.mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 900 });
    const scale = availableWidth > 0 && availableHeight > 0
      ? (fit
        ? Math.min(availableWidth / defaultSize.width, availableHeight / defaultSize.height)
        : Math.min(1, initialWidth / defaultSize.width, availableHeight / defaultSize.height))
      : 0;
    const maxWidth = scale ? availableWidth / scale : 0;
    const maxHeight = scale ? availableHeight / scale : 0;
    const viewport = {
      width: Math.min(customSize?.width ?? defaultSize.width, fit ? Infinity : maxWidth),
      height: Math.min(customSize?.height ?? defaultSize.height, fit ? Infinity : maxHeight),
    };
    previewGeometry[id] = { ...viewport, scale, availableWidth, availableHeight, maxWidth: scale ? availableWidth / scale : 0, maxHeight: scale ? availableHeight / scale : 0 };
    const renderedWidth = viewport.width * scale;
    const renderedHeight = viewport.height * scale;
    container.style.setProperty('--preview-rendered-width', `${renderedWidth}px`);
    container.style.setProperty('--preview-rendered-height', `${renderedHeight}px`);
    const resizeHintClearance = 8;
    container.classList.toggle('has-inline-preview-space', availableWidth - renderedWidth > resizeHintClearance);
    container.classList.toggle('has-block-preview-space', availableHeight - renderedHeight > resizeHintClearance);
    if (isExpanded) {
      const sectionHeight = availableHeight + blockMargin;
      const top = Math.max(blockMargin, Math.min((sectionHeight - renderedHeight) / 2, sectionHeight - renderedHeight));
      container.style.setProperty('--preview-top', `${top}px`);
    }
    deviceFrame.style.width = `${renderedWidth}px`;
    deviceFrame.style.height = `${renderedHeight}px`;
    // Keep the visible frame fixed while changing the content's layout viewport,
    // so zoom also reflows responsive pages instead of cropping them.
    const zoom = previewZoom[id] / 100;
    frame.style.width = `${viewport.width / zoom}px`;
    frame.style.height = `${viewport.height / zoom}px`;
    frame.style.transform = `scale(${scale * zoom})`;
  }
}

function fitPreview(side) {
  resizeDevicePreviews();
  const geometry = previewGeometry[side];
  if (!geometry?.width || !geometry.height || !geometry.availableWidth || !geometry.availableHeight) return;
  previewFit[side] = {
    width: geometry.width,
    height: geometry.height,
  };
  resizeDevicePreviews();
}

function setPreviewZoom(side, percent) {
  previewZoom[side] = Math.max(30, Math.min(200, percent));
  get(`${side}-zoom-label`).textContent = `${previewZoom[side]}%`;
  get(`${side}-zoom-out`).disabled = previewZoom[side] === 30;
  get(`${side}-zoom-in`).disabled = previewZoom[side] === 200;
  resizeDevicePreviews();
}

function resetPreviewView(sides = ['base', 'target']) {
  finishPreviewResize();
  customPreviewSize.value = null;
  for (const side of sides) {
    previewFit[side] = null;
    get(`${side}-url`).value = '/';
    setPreviewZoom(side, 100);
  }
}

function changePreviewSize(side, axis, start, deltaX, deltaY) {
  const geometry = previewGeometry[side];
  if ((expandedSide && expandedSide !== side) || !geometry?.scale) return;
  const clamp = (value, max) => Math.min(max, Math.round(Math.max(Math.min(240, max), value)));
  customPreviewSize.value = {
    width: clamp(start.width + (axis === 'height' ? 0 : deltaX / start.scale), geometry.maxWidth),
    height: clamp(start.height + (axis === 'width' ? 0 : deltaY / start.scale), geometry.maxHeight),
  };
  resizeDevicePreviews();
}

function finishPreviewResize() {
  const drag = previewResizeDrag;
  previewResizeDrag = null;
  document.body.classList.remove('resizing-preview');
  if (drag?.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
}

for (const handle of document.querySelectorAll('.preview-resize-handle')) {
  const { side, axis, edge = 'bottom-right' } = handle.dataset;
  const directDeltas = (x, y) => [edge.includes('left') ? -x : x, edge.includes('top') ? -y : y];
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (expandedSide && expandedSide !== side) || !previewGeometry[side]?.scale) return;
    event.preventDefault();
    finishPreviewResize();
    previewResizeDrag = { handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY, ...previewGeometry[side] };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-preview');
  });
  handle.addEventListener('pointermove', (event) => {
    const drag = previewResizeDrag;
    if (!drag || drag.handle !== handle || drag.pointerId !== event.pointerId) return;
    const [x, y] = directDeltas((event.clientX - drag.x) * 2, (event.clientY - drag.y) * 2);
    changePreviewSize(side, axis, drag, x, y);
  });
  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    handle.addEventListener(eventName, (event) => {
      if (previewResizeDrag?.handle === handle && previewResizeDrag.pointerId === event.pointerId) finishPreviewResize();
    });
  }
  handle.addEventListener('dblclick', () => {
    if (expandedSide && expandedSide !== side) return;
    customPreviewSize.value = null;
    resizeDevicePreviews();
  });
  handle.addEventListener('keydown', (event) => {
    const deltas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!deltas[event.key] || (expandedSide && expandedSide !== side) || !previewGeometry[side]?.scale) return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 10;
    const [x, y] = deltas[event.key];
    const [directedX, directedY] = directDeltas(x * step, y * step);
    changePreviewSize(side, axis, previewGeometry[side], directedX, directedY);
  });
}
window.addEventListener('blur', finishPreviewResize);

let finishSidebarLogoAnimation = null;

function setSidebarCollapsed(collapsed, { persist = true } = {}) {
  finishSidebarLogoAnimation?.();
  const animateLogo = persist && !collapsed && shell.classList.contains('sidebar-collapsed')
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const heading = document.querySelector('.sidebar-heading');
  const iconRect = animateLogo
    ? heading.querySelector('.sidebar-toggle-logo').getBoundingClientRect() : null;
  shell.classList.toggle('sidebar-collapsed', collapsed);
  positionSidebarMenus();
  if (iconRect) {
    const wordmark = heading.querySelector('.brand-wordmark');
    const logoRect = wordmark.getBoundingClientRect();
    // Keep the icon opaque while the lettering fades in as a single piece.
    const icon = heading.querySelector('.sidebar-toggle-logo').cloneNode(true);
    const headingRect = heading.getBoundingClientRect();
    Object.assign(icon.style, {
      display: 'block', position: 'absolute', pointerEvents: 'none',
      left: `${logoRect.left - headingRect.left}px`, top: `${logoRect.top - headingRect.top}px`,
      width: `${logoRect.height}px`, height: `${logoRect.height}px`,
    });
    heading.append(icon);
    const shrink = icon.animate([
      {
        transform: `translate(${iconRect.left - logoRect.left}px, ${iconRect.top - logoRect.top}px) scale(${iconRect.height / logoRect.height})`,
        transformOrigin: 'left top',
      },
      { transform: 'translate(0, 0) scale(1)', transformOrigin: 'left top' },
    ], { duration: 160, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' });
    // The fixed clip excludes only the icon; it never sweeps across the text.
    const lettersOnly = `inset(0 0 0 ${logoRect.height}px)`;
    const animation = wordmark.animate([
      { opacity: 0, clipPath: lettersOnly },
      { opacity: 1, clipPath: lettersOnly },
    ], { duration: 220, delay: 140, easing: 'ease-out', fill: 'both' });
    const cleanup = () => {
      animation.cancel();
      shrink.cancel();
      icon.remove();
      if (finishSidebarLogoAnimation === cleanup) finishSidebarLogoAnimation = null;
    };
    finishSidebarLogoAnimation = cleanup;
    animation.onfinish = cleanup;
  }
  get('sidebar-toggle').setAttribute('aria-expanded', String(!collapsed));
  get('sidebar-toggle').setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  if (persist) {
    try { localStorage.setItem('acorn.sidebarCollapsed', String(collapsed)); } catch { /* Apply for this session. */ }
  }
}

try {
  setSidebarCollapsed(localStorage.getItem('acorn.sidebarCollapsed') === 'true', { persist: false });
} catch { /* Keep the default sidebar state when storage is unavailable. */ }

function openDiffPanel() {
  window.clearTimeout(diffCloseTimeout);
  setSidebarCollapsed(true);
  get('changes-panel').hidden = false;
  shell.classList.add('diff-open');
  get('show-diff').setAttribute('aria-expanded', 'true');
  get('show-diff').textContent = 'Close Diff';
  window.requestAnimationFrame(resizeDevicePreviews);
}

function closeDiffPanel({ focus = true, immediate = false } = {}) {
  window.clearTimeout(diffCloseTimeout);
  shell.classList.remove('diff-open');
  get('show-diff').setAttribute('aria-expanded', 'false');
  get('show-diff').textContent = 'Show Diff';
  if (immediate) get('changes-panel').hidden = true;
  else diffCloseTimeout = window.setTimeout(() => {
    if (!shell.classList.contains('diff-open')) get('changes-panel').hidden = true;
  }, 220);
  if (focus) get('show-diff').focus();
  window.requestAnimationFrame(resizeDevicePreviews);
}

function setDiffPanelWidth(width) {
  const max = window.innerWidth / 2;
  const min = Math.min(320, max);
  const next = Math.min(max, Math.max(min, width));
  shell.style.setProperty('--diff-width', `${next}px`);
  get('diff-resizer').setAttribute('aria-valuemax', String(Math.round(max)));
  get('diff-resizer').setAttribute('aria-valuenow', String(Math.round(next)));
}

let refreshingRuntimeServers = false;
let runtimeListSignature = '';
let stoppingRuntimeServer = false;
let runtimeServers = [];
async function refreshRuntimeServers() {
  if (!bridge?.listPreviewServers || refreshingRuntimeServers || stoppingRuntimeServer) return;
  refreshingRuntimeServers = true;
  try {
    const { servers, error } = await bridge.listPreviewServers();
    if (error) throw new Error(error);
    runtimeServers = servers;
    const count = servers.length;
    get('runtime-count').textContent = count;
    get('runtime-title-count').textContent = count;
    get('runtime-status').setAttribute('aria-label', `Running Servers ${count}`);
    get('runtime-status').removeAttribute('title');
    get('runtime-status').classList.toggle('has-servers', count > 0);
    get('runtime-clear-all').disabled = count === 0;
    get('runtime-clear-all').hidden = count === 0;
    const usedUrls = runtimeUsedServerUrls();
    const signature = JSON.stringify([servers, repositories.map(repository => repository.path), [...usedUrls].sort()]);
    if (signature === runtimeListSignature) return;
    runtimeListSignature = signature;
    const groups = new Map();
    for (const server of servers) {
      if (!groups.has(server.repositoryPath)) groups.set(server.repositoryPath, []);
      groups.get(server.repositoryPath).push(server);
    }
    const repositoryOrder = new Map(repositories.map((repository, index) => [repository.path, index]));
    const orderedGroups = [...groups].sort(([a, aServers], [b, bServers]) => {
      const usageOrder = Number(bServers.some(server => usedUrls.has(server.url))) - Number(aServers.some(server => usedUrls.has(server.url)));
      return usageOrder || (repositoryOrder.get(a) ?? Infinity) - (repositoryOrder.get(b) ?? Infinity);
    });
    get('runtime-list').replaceChildren(...orderedGroups.map(([repositoryPath, projectServers]) => {
      const repository = repositories.find(item => item.path === repositoryPath);
      const group = document.createElement('li');
      group.className = 'runtime-project';
      const title = document.createElement('h3');
      title.textContent = repository?.name || projectServers[0].projectName;
      const list = document.createElement('ul');
      const orderedServers = projectServers.toSorted((a, b) => Number(usedUrls.has(b.url)) - Number(usedUrls.has(a.url)));
      for (const server of orderedServers) {
        const row = document.createElement('li');
        row.className = 'runtime-server';
        row.classList.toggle('is-unused', !usedUrls.has(server.url));
        const info = document.createElement('div');
        info.className = 'runtime-server-info';
        const detail = document.createElement('span');
        detail.textContent = runtimeServerDetail(repository, server);
        const url = document.createElement('code');
        url.textContent = server.url;
        info.append(detail, url);
        const stop = document.createElement('button');
        stop.className = 'icon-button runtime-stop';
        stop.setAttribute('aria-label', `Stop ${title.textContent} server ${displaySha(server.sha)}`);
        stop.title = 'Stop server';
        stop.innerHTML = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
        stop.addEventListener('click', () => stopListedServer(server, stop));
        row.append(info, stop);
        list.append(row);
      }
      group.append(title, list);
      return group;
    }));
    if (!count) get('runtime-list').innerHTML = '<li class="runtime-empty">No running servers</li>';
  } catch {
    runtimeServers = [];
    runtimeListSignature = '';
    get('runtime-count').textContent = '?';
    get('runtime-title-count').textContent = '?';
    get('runtime-clear-all').disabled = true;
    get('runtime-clear-all').hidden = true;
    get('runtime-status').classList.remove('has-servers');
    get('runtime-status').setAttribute('aria-label', 'Server status unavailable');
    get('runtime-status').title = 'Server status unavailable';
    get('runtime-list').innerHTML = '<li class="runtime-empty">Unable to load server status. Try again.</li>';
  } finally {
    refreshingRuntimeServers = false;
  }
}
async function stopListedServer(server, button) {
  if (stoppingRuntimeServer) return;
  stoppingRuntimeServer = true;
  button.disabled = true;
  try {
    const result = await bridge.stopPreviewServer({ repositoryPath: server.repositoryPath, url: server.url, runtime: server.runtime });
    if (result.error) throw new Error(result.error);
    invalidateRetainedPreviews(server);
    for (const side of ['base', 'target']) {
      if (previewUrls?.[side]?.upstreamUrl !== server.url) continue;
      ++previewRevision[side];
      delete previewUrls[side];
      previewState[side] = 'stopped';
      pagePickers.get(side)?.failed('Preview stopped. Refresh to browse pages.');
      get(`${side}-preview-frame`).removeAttribute('src');
      get(`${side}-preview-loading`).hidden = true;
      get(`${side}-refresh`).disabled = false;
      get(`${side}-url`).readOnly = true;
      get(`${side}-url`).title = 'Server stopped — click Refresh to restart';
    }
    updateRefreshAllState();
    notify('Server stopped.');
  } catch (error) {
    notify(error.message, { title: 'Could not stop server', dismissible: true, tone: 'error' });
  } finally {
    stoppingRuntimeServer = false;
    button.disabled = false;
    runtimeListSignature = '';
    await refreshRuntimeServers();
    get('runtime-list').querySelector('button')?.focus();
  }
}
async function clearRuntimeServers() {
  if (stoppingRuntimeServer || !bridge?.stopPreviewServer || !runtimeServers.length) return;
  stoppingRuntimeServer = true;
  const button = get('runtime-clear-all');
  button.disabled = true;
  try {
    const results = await Promise.all(runtimeServers.map((server) => bridge.stopPreviewServer({
      repositoryPath: server.repositoryPath,
      url: server.url,
      runtime: server.runtime,
    })));
    const failed = results.find((result) => result.error);
    if (failed) throw new Error(failed.error);
    runtimeServers = [];
    invalidateRetainedPreviews();
    for (const side of ['base', 'target']) {
      ++previewRevision[side];
      delete previewUrls?.[side];
      previewState[side] = 'stopped';
      pagePickers.get(side)?.failed('Preview stopped. Refresh to browse pages.');
      get(`${side}-preview-frame`).removeAttribute('src');
      get(`${side}-preview-loading`).hidden = true;
      get(`${side}-refresh`).disabled = false;
      get(`${side}-url`).readOnly = true;
      get(`${side}-url`).title = 'Server stopped — click Refresh to restart';
    }
    updateRefreshAllState();
    notify('All servers stopped.');
  } catch (error) {
    notify(error.message, { title: 'Could not stop all servers', dismissible: true, tone: 'error' });
  } finally {
    stoppingRuntimeServer = false;
    runtimeListSignature = '';
    await refreshRuntimeServers();
    button.focus();
  }
}
function positionSidebarMenus() {
  for (const [menuId, buttonId] of [['runtime-popover', 'runtime-status']]) {
    const menu = get(menuId);
    if (!shell.classList.contains('sidebar-collapsed')) {
      menu.style.removeProperty('inset');
      continue;
    }
    if (!menu.matches(':popover-open')) continue;
    const bounds = get(buttonId).getBoundingClientRect();
    const height = menu.getBoundingClientRect().height;
    const top = Math.max(8, Math.min(bounds.bottom - height, innerHeight - height - 8));
    menu.style.inset = `${top}px auto auto ${bounds.right + 10}px`;
  }
}
for (const menuId of ['runtime-popover']) {
  get(menuId).addEventListener('toggle', positionSidebarMenus);
  new ResizeObserver(positionSidebarMenus).observe(get(menuId));
}
window.addEventListener('resize', positionSidebarMenus);
get('runtime-clear-all').addEventListener('click', clearRuntimeServers);
get('runtime-popover').addEventListener('toggle', (event) => {
  if (event.newState === 'open') refreshRuntimeServers();
});
window.setInterval(refreshRuntimeServers, 3000);
refreshRuntimeServers();

function updateRefreshAllState() {
  get('refresh-all').disabled = !activeRepository || Object.values(previewState).includes('loading');
}

const previewUnavailableMessage = 'Unable to load the preview.\nTry another branch or commit from the history.';

function showPreviewUnavailable(side) {
  const empty = get(`${side}-preview-loading`);
  empty.classList.add('preview-empty');
  empty.setAttribute('aria-label', 'Preview unavailable');
  empty.querySelector('p').textContent = previewUnavailableMessage;
}

function schedulePreview(sides = ['base', 'target'], { reuse = false, visual } = {}) {
  if (!bridge || !activeRepository) return;
  previewUrls ||= {};
  for (const id of sides) {
    const revision = ++previewRevision[id];
    const ref = id === 'base' ? baseRef.value : targetRef.value;
    // The existing bridge reuses a single server when both refs are identical.
    const request = { path: activeRepository.path, comparisonId: activeComparison.id, side: id, base: ref, target: ref, runtime: selectedRuntime, reuse, visual: selectedPages[id]?.visualFallback === true && (visual ?? visualPreviewMode[id]) };
    const previousPage = selectedPages[id];
    delete previewUrls[id];
    previewState[id] = 'loading';
    pagePickers.get(id)?.loading();
    get(`${id}-refresh`).disabled = true;
    get(`${id}-device-frame`).hidden = true;
    get(`${id}-preview-frame`).removeAttribute('src');
    get(`${id}-preview-loading`).querySelector('p').textContent = 'Waiting for previous preview tasks to finish…';
    get(`${id}-preview-loading`).classList.remove('preview-empty');
    get(`${id}-preview-loading`).setAttribute('aria-label', `Preparing ${id} preview`);
    get(`${id}-preview-loading`).hidden = false;
    updateRoute([id]);
    const preparation = (async () => {
      await previewCleanup;
      const isCurrent = () => revision === previewRevision[id] && activeRepository?.path === request.path && activeComparison?.id === request.comparisonId;
      if (!isCurrent()) return;
      const unsubscribeProgress = bridge.onPreviewProgress?.(progress => {
        if (isCurrent() && progress.path === request.path && progress.ref === ref) {
          get(`${id}-preview-loading`).querySelector('p').textContent = progress.message;
        }
      });
      try {
        get(`${id}-preview-loading`).querySelector('p').textContent = 'Requesting preview…';
        const result = await bridge.startPreview(request);
        if (!isCurrent()) return;
        if (result.error) throw Object.assign(new Error(result.error), { code: result.code });
        const preview = result.previews.base;
        visualPreviewMode[id] = Boolean(preview.visual);
        get(`${id}-device-frame`).dataset.previewMode = preview.visual ? 'visual' : 'live';
        const choice = pagePickers.get(id).setCatalog(preview.catalog);
        previewUrls[id] = preview;
        refreshFilePreviewActions();
        selectedPages[id] = pagePickers.get(id).select(previousPage?.id) || choice.selected;
        if (pageSelectionSynced) {
          const other = id === 'base' ? 'target' : 'base';
          const shared = matchingPage(id, selectedPages[other]);
          if (selectedPages[other] && previewUrls?.[other]) {
            if (shared) { selectedPages[id] = shared; pagePickers.get(id)?.select(shared.id); }
            else setPageSync(false, { notifyMissing: true });
          }
        }
        if (choice.missing) notify('The selected page is not present in this revision. Showing the first available page.', { title: 'Page unavailable' });
        previewState[id] = 'ready';
        get(`${id}-device-frame`).hidden = !selectedPages[id];
        if (!selectedPages[id]) {
          previewState[id] = 'empty';
          showPreviewUnavailable(id);
        }
        updateRoute([id]);
        resizeDevicePreviews();
      } catch (error) {
        if (!isCurrent()) return;
        const noScreen = error.code === 'NO_PREVIEW_SCREEN';
        previewState[id] = noScreen ? 'empty' : 'failed';
        pagePickers.get(id)?.failed(error.message);
        get(`${id}-url`).title = error.message.split('\n').at(-1);
        get(`${id}-url`).readOnly = true;
        showPreviewUnavailable(id);
        if (!noScreen) {
          const options = { title: `${id === 'base' ? 'Base' : 'Target'} preview unavailable`, dismissible: true, tone: 'error' };
          if (error.code === 'PREVIEW_COMPILER_MISSING') {
            options.action = {
              label: 'Install preview compiler',
              onClick: async ({ button, close }) => {
                button.disabled = true;
                button.textContent = 'Installing…';
                let result;
                try { result = await bridge.installPreviewCompiler(); }
                catch (error) { result = { error: error.message || 'The preview compiler could not be installed.' }; }
                if (result.error) {
                  button.disabled = false;
                  button.textContent = 'Try again';
                  notify(result.error, { title: 'Preview compiler installation failed', dismissible: true, tone: 'error' });
                  return;
                }
                close();
                notify(`Preview compiler ${result.compiler.version} installed. Retrying preview…`);
                schedulePreview([id]);
              },
            };
          }
          notify(error.message, options);
        }
      } finally {
        unsubscribeProgress?.();
        refreshRuntimeServers();
        if (isCurrent()) {
          get(`${id}-preview-loading`).hidden = !['empty', 'failed'].includes(previewState[id]);
          get(`${id}-refresh`).disabled = false;
          updateRefreshAllState();
        }
      }
    })();
    previewRefresh = Promise.allSettled([previewRefresh, preparation]);
  }
  updateRefreshAllState();
}

function restoreExpandedPanelControls(side) {
  if (!side) return;
  const panel = document.querySelector(`.${side}-panel`);
  panel.querySelector('.preview-header').append(panel.querySelector('.preview-actions'));
  panel.querySelector('.address-bar').append(panel.querySelector('.preview-zoom'));
}

function setExpandedPanel(side) {
  finishPreviewResize();
  const previous = expandedSide;
  expandedSide = side;
  shell.classList.toggle('preview-expanded', Boolean(side));
  const toggle = get('expanded-switch');
  const toolbar = get('expanded-toolbar');
  const diffControl = document.querySelector('.diff-control');
  const comparisonActions = document.querySelector('.comparison-actions');
  const expandedZoom = toolbar.querySelector('.expanded-preview-zoom');
  const expandedActions = toolbar.querySelector('.expanded-preview-actions');
  toolbar.hidden = !side;
  if (side) {
    if (previous && previous !== side) restoreExpandedPanelControls(previous);
    const panel = document.querySelector(`.${side}-panel`);
    panel.prepend(toolbar);
    toolbar.querySelector('.expanded-preview-options').append(diffControl);
    expandedZoom.append(panel.querySelector('.address-bar .preview-zoom'));
    expandedActions.append(panel.querySelector('.preview-actions'), get('expanded-close'));
    for (const input of toggle.querySelectorAll('input')) input.checked = input.value === side;
  } else {
    restoreExpandedPanelControls(previous);
    expandedActions.append(get('expanded-close'));
    comparisonActions.append(diffControl);
    get('preview-grid').insertBefore(toolbar, document.querySelector('.base-panel'));
  }
  for (const id of ['base', 'target']) {
    const expanded = side === id;
    const panel = document.querySelector(`.${id}-panel`);
    panel.classList.toggle('is-expanded', expanded);
    panel.inert = Boolean(side && !expanded);
    const button = get(`${id}-expand`);
    button.hidden = expanded;
    button.setAttribute('aria-pressed', String(expanded));
    // The hidden expand control keeps its SVG: replacing a hovered SVG can
    // leave Chromium's :hover state stuck when the control is shown again.
  }
  for (const element of document.querySelectorAll('.sidebar, .topbar, .comparison-controls, .changes-panel')) element.inert = Boolean(side);
  if (side && previous && side !== previous) toggle.querySelector('input:checked').focus();
  else if (side) get('expanded-close').focus();
  else if (previous) {
    get('canvas-expand').focus();
  }
  updateCanvasZoom();
  window.requestAnimationFrame(resizeDevicePreviews);
}

function renderPatch(patch, source, detailType = 'text') {
  if (detailType === 'media') return '<code class="diff-empty">Preview is not available for media files.</code>';
  if (!patch) {
    const message = source === 'working-tree'
      ? 'Cannot load a diff for this working folder.'
      : 'There is no text diff between these refs, or the file is binary.';
    return `<code class="diff-empty">${message}</code>`;
  }
  return `<code>${patch.split('\n').map((line) => {
    const kind = line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : 'neutral';
    return `<span class="line ${kind}">${escapeHtml(line)}</span>`;
  }).join('')}</code>`;
}

function setDiffLoading(loading) {
  const view = get('diff-view');
  view.classList.toggle('is-loading', loading);
  view.setAttribute('aria-busy', String(loading));
  if (loading) view.innerHTML = '<span class="diff-loading-spinner" aria-hidden="true"></span><span class="sr-only">Loading changes</span>';
}

// Session-only LRU cache. The size estimate limits retained data, not total heap usage.
function createDiffCache({ maxBytes = 32 * 1024 * 1024, maxEntries = 100 } = {}) {
  const entries = new Map();
  let bytes = 0;
  const keyFor = (request) => JSON.stringify([request.path, request.base, request.target, request.file || null]);
  const remove = (key) => {
    bytes -= entries.get(key)?.bytes || 0;
    entries.delete(key);
  };
  const trim = () => {
    while (bytes > maxBytes || entries.size > maxEntries) remove(entries.keys().next().value);
  };
  return {
    peek(request) {
      let key = keyFor(request);
      if (!entries.has(key) && request.file) {
        const defaultKey = keyFor({ ...request, file: null });
        if (entries.get(defaultKey)?.result?.diff?.selectedFile === request.file) key = defaultKey;
      }
      const entry = entries.get(key);
      if (!entry?.result) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry.result;
    },
    invalidate(repositoryPath) {
      for (const [key, entry] of entries) if (entry.path === repositoryPath) remove(key);
    },
    async load(request, fetchDiff) {
      const key = keyFor(request);
      const cached = this.peek(request);
      if (cached) return cached;
      if (entries.get(key)?.pending) return entries.get(key).pending;
      const entry = { path: request.path, bytes: 0 };
      entries.set(key, entry);
      trim();
      entry.pending = Promise.resolve().then(() => fetchDiff(request)).then((result) => {
        // A refresh or eviction must not be undone by an older response.
        if (entries.get(key) !== entry) return result;
        if (result.error) { remove(key); return result; }
        entry.result = result;
        entry.bytes = JSON.stringify(result).length * 2;
        if (entry.bytes > maxBytes) {
          entry.bytes = 0;
          remove(key);
          return result;
        }
        bytes += entry.bytes;
        entry.pending = null;
        trim();
        return result;
      }).catch((error) => {
        if (entries.get(key) === entry) remove(key);
        throw error;
      });
      return entry.pending;
    },
  };
}

async function loadDiff({ preserveHeader = false, refresh = false } = {}) {
  if (!bridge || !activeRepository) return;
  const version = ++diffRequestVersion;
  const request = { path: activeRepository.path, base: baseRef.value, target: targetRef.value, file: selectedFile };
  if (refresh) diffCache.invalidate(request.path);
  const cached = diffCache.peek(request);
  diffLoadError = null;
  if (!cached) {
    overlayDiff = null;
    configureDiffOverlay();
    if (!preserveHeader) get('changes-title').textContent = 'Loading changes';
    setDiffLoading(true);
  }
  const result = cached || await diffCache.load(request, (payload) => bridge.getDiff(payload))
    .catch((error) => ({ error: error.message || String(error) }));
  if (version !== diffRequestVersion) return;
  if (result.error) {
    diffLoadError = 'Unable to load changes. Refresh to try again.';
    updateDiffProgress();
    notify(`${result.error}\nRefresh to try again.`, { title: 'Diff unavailable', dismissible: true, tone: 'error' });
    get('changes-title').textContent = 'Unable to load changes';
    setDiffLoading(false);
    get('diff-view').innerHTML = `<code>${escapeHtml(result.error)}</code>`;
    return;
  }
  const { diff } = result;
  overlayDiff = diff;
  configureDiffOverlay();
  selectedFile = diff.selectedFile;
  const totals = Number.isFinite(diff.totals?.added) && Number.isFinite(diff.totals?.deleted)
    ? ` <span>+${diff.totals.added} −${diff.totals.deleted}</span>` : '';
  get('changes-title').innerHTML = `${diff.files.length} files changed${totals}`;
  const list = get('file-list');
  list.replaceChildren(...diff.files.map((file) => {
    const row = document.createElement('div');
    row.className = `file${file.file === selectedFile ? ' active' : ''}`;
    row.dataset.file = file.file;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(file.file === selectedFile));
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'file-select';
    select.innerHTML = `<span class="file-status">${escapeHtml(file.status)}</span><span class="file-path">${escapeHtml(file.file)}</span>`;
    select.addEventListener('click', () => { selectedFile = file.file; loadDiff({ preserveHeader: true }); });
    const trailing = document.createElement('span');
    trailing.className = 'file-trailing';
    trailing.innerHTML = `<em>+${escapeHtml(file.added)} −${escapeHtml(file.deleted)}</em>`;
    row.append(select, trailing);
    return row;
  }));
  refreshFilePreviewActions();
  setDiffLoading(false);
  get('diff-view').innerHTML = renderPatch(diff.patch, diff.source, diff.detailType);
}

function renderProjectMetadata(repository) {
  get('project-preview-settings').disabled = !bridge;
  get('project-remote').textContent = `../${repository.path.split('/').filter(Boolean).at(-1)}`;
  get('project-directory').dataset.tooltip = repository.path;
  get('project-directory').setAttribute('aria-label', `Open directory in Finder: ${repository.path}`);
  const github = githubRepository(repository.remoteUrl);
  get('project-branch').textContent = github?.name || 'No GitHub remote';
  get('project-github').disabled = !github;
  get('project-github').dataset.tooltip = github ? 'Open on GitHub' : 'No GitHub remote connected';
  get('project-github').setAttribute('aria-label', github ? `Open ${github.name} on GitHub` : 'No GitHub remote connected');
}
for (const [id, destination] of [['project-directory', 'directory'], ['project-github', 'github']]) {
  get(id).addEventListener('click', async () => {
    if (!activeRepository) return;
    if (!bridge?.openRepositoryLocation) {
      notify('Open repository locations from the Acorn desktop app.');
      return;
    }
    try {
      const result = await bridge.openRepositoryLocation({ path: activeRepository.path, destination });
      if (result?.error) notify(result.error, { tone: 'error' });
    } catch { notify('Could not open the repository location.', { tone: 'error' }); }
  });
}

function captureWorkspaceSession() {
  return {
    base: baseRef.value, target: targetRef.value, selectedFile,
    previews: { ...previewUrls }, pages: { ...selectedPages }, states: { ...previewState },
    synced: pageSelectionSynced, zoom: { ...previewZoom }, fit: { ...previewFit },
    size: customPreviewSize.value ? { ...customPreviewSize.value } : null,
    layout: get('layout-mode').querySelector('input:checked')?.value || 'split', frames: {},
  };
}

function persistWorkspace() {
  if (!activeRepository || !activeComparison) return;
  const sessions = new Map(projectPreviewSessions);
  sessions.set(comparisonSessionKey(activeRepository, activeComparison), captureWorkspaceSession());
  try {
    sessionStorage.setItem('acorn.workspace', JSON.stringify({
      repository: activeRepository.path, comparison: activeComparison.id,
      sessions: [...sessions].map(([key, value]) => [key, { ...value, frames: {} }]),
    }));
  } catch { /* The current in-memory workspace remains usable. */ }
}

async function restoreWorkspace() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('acorn.workspace'));
    if (!saved || !Array.isArray(saved.sessions)) return null;
    const { servers = [] } = await bridge.listPreviewServers();
    const running = new Set(servers.map(server => server.url));
    for (const [key, session] of saved.sessions) {
      session.frames = {};
      for (const side of ['base', 'target']) {
        if (!running.has(session.previews?.[side]?.upstreamUrl || session.previews?.[side]?.url)) {
          delete session.previews[side];
          session.states[side] = 'stopped';
        }
      }
      projectPreviewSessions.set(key, session);
    }
    return saved;
  } catch { return null; }
}
window.addEventListener('beforeunload', persistWorkspace);

function saveProjectPreviewSession() {
  if (!activeRepository) return;
  const session = captureWorkspaceSession();
  for (const side of ['base', 'target']) {
    const frame = get(`${side}-preview-frame`);
    session.frames[side] = frame;
    // Keep the browsing context attached: moving/removing an iframe reloads it.
    frame.removeAttribute('id');
    frame.hidden = true;
    ++previewRevision[side];
  }
  const key = comparisonSessionKey(activeRepository, activeComparison);
  projectPreviewSessions.delete(key);
  projectPreviewSessions.set(key, session);
}

function invalidateRetainedPreviews(server) {
  for (const session of projectPreviewSessions.values()) {
    for (const side of ['base', 'target']) {
      const preview = session.previews[side];
      if (server && preview?.upstreamUrl !== server.url && preview?.url !== server.url) continue;
      delete session.previews[side];
      session.states[side] = 'stopped';
      session.frames[side]?.removeAttribute('src');
    }
  }
}

function activateProjectFrames(session) {
  for (const side of ['base', 'target']) {
    let frame = session?.frames[side];
    if (!frame) {
      frame = document.createElement('iframe');
      frame.className = 'preview-frame';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      frame.name = `${side}-preview`;
      frame.title = `${side === 'base' ? 'Base' : 'Target'} preview`;
      const preview = session?.previews[side];
      if (session?.states[side] === 'ready' && preview?.url) frame.src = preview.currentUrl || preview.url;
      get(`${side}-device-frame`).prepend(frame);
    }
    frame.id = `${side}-preview-frame`;
    frame.hidden = false;
  }
  // Retain selection metadata for older projects even when their documents are evicted.
  const retained = [...projectPreviewSessions.values()].filter(item => Object.keys(item.frames).length);
  while (retained.length >= maxRetainedProjects) {
    const oldest = retained.shift();
    for (const frame of Object.values(oldest.frames)) frame.remove();
    oldest.frames = {};
  }
}

function activateRepository(repositoryPath, comparisonId) {
  const repository = repositories.find((item) => item.path === repositoryPath);
  if (!repository) return;
  const comparisons = comparisonsFor(repository);
  const comparison = comparisons.find(item => item.id === comparisonId) || comparisons[0];
  if (!comparison) { showEmptyComparisons(repository); return; }
  if (activeRepository?.path === repositoryPath && activeComparison?.id === comparison.id) return;
  if (activeRepository) saveProjectPreviewSession();
  else for (const side of ['base', 'target']) get(`${side}-preview-frame`).remove();
  const key = comparisonSessionKey(repository, comparison);
  const session = projectPreviewSessions.get(key);
  projectPreviewSessions.delete(key);
  activeRepository = repository;
  activeComparison = comparison;
  customPreviewSize.value = session?.size ? { ...session.size } : null;
  activateProjectFrames(session);
  previewUrls = { ...session?.previews };
  for (const side of ['base', 'target']) {
    pendingPageLandings[side] = null;
    visualPreviewMode[side] = Boolean(previewUrls?.[side]?.visual);
  }
  overlayDiff = null;
  restoreViewOptions(repository, comparison);
  setExpandedPanel(null);
  for (const picker of refPickers.values()) picker.close();
  for (const picker of pagePickers.values()) { picker.close(); picker.setCatalog({ pages: [], warnings: [] }, false); }
  selectedPages.base = session?.pages?.base || null;
  selectedPages.target = session?.pages?.target || null;
  setPageSync(true);
  selectedFile = session?.selectedFile || null;
  displayPreviewAddress('base', '/');
  displayPreviewAddress('target', '/');
  const base = comparison.base;
  const target = comparison.target;
  get('project-title').textContent = activeRepository.name;
  renderProjectMetadata(activeRepository);
  setSelectOptions(baseRef, activeRepository, base);
  setSelectOptions(targetRef, activeRepository, target);
  hydrateSelectedCommits(activeRepository, [base, target]);
  setRuntimeOptions(activeRepository);
  get('comparison-controls').hidden = false;
  get('comparison-top-actions').hidden = false;
  get('preview-grid').hidden = false;
  get('connection-empty').hidden = true;
  get('comparison-empty').hidden = true;
  get('show-diff').disabled = false;
  renderProjectList();
  const missing = [];
  for (const side of ['base', 'target']) {
    const preview = previewUrls[side];
    const ready = session?.states[side] === 'ready' && preview?.url;
    previewState[side] = ready ? 'ready' : 'stopped';
    previewZoom[side] = session?.zoom[side] || 100;
    previewFit[side] = session?.fit[side] || null;
    get(`${side}-preview-loading`).hidden = true;
    get(`${side}-refresh`).disabled = false;
    get(`${side}-device-frame`).hidden = !ready;
    get(`${side}-device-frame`).dataset.previewMode = preview?.visual ? 'visual' : 'live';
    if (ready) {
      const choice = pagePickers.get(side).setCatalog(preview.catalog, false);
      selectedPages[side] = pagePickers.get(side).select(session.pages[side]?.id) || choice.selected;
      displayPreviewAddress(side, selectedPages[side]?.path || '/');
    } else missing.push(side);
  }
  setPageSync(session?.synced ?? true);
  const layout = session?.layout || 'split';
  for (const input of get('layout-mode').querySelectorAll('input')) input.checked = input.value === layout;
  applyLayoutMode(layout);
  updateRefs(missing, { reuse: true });
  resizeDevicePreviews();
  updateCanvasZoom();
  updateRefreshAllState();
}

async function addConnection(result, { reopenModalOnCancel = true, showErrorsInModal = true } = {}) {
  if (result?.error) {
    if (result.error === 'The selected folder is not a Git repository.') notify(result.error, { tone: 'error' });
    else if (showErrorsInModal) get('connection-error').textContent = result.error;
    else notify(result.error, { tone: 'error' });
    return;
  }
  if (!result?.repository) return;
  showConnectionModal(false);
  const selection = await window.PreviewFilePicker.open(result.repository, { connecting: true });
  if (!selection) {
    if (reopenModalOnCancel) showConnectionModal();
    return;
  }
  result.repository = selection.repository || result.repository;
  const freshConnection = !repositories.some(repository => repository.path === result.repository.path);
  if (freshConnection) clearRepositoryClientState(result.repository, repositoryComparisons.get(result.repository.path) || []);
  repositories = [result.repository, ...repositories.filter((repository) => repository.path !== result.repository.path)];
  showConnectionModal(false);
  activateRepository(result.repository.path);
  notify(`${result.repository.name} is connected.`);
}

async function loadMoreCommits() {
  const repository = activeRepository;
  if (!bridge?.getCommits || !repository?.commitHistory?.hasMore || repository.loadingCommits) return;
  const historyGeneration = repository.commitHistoryGeneration || 0;
  const refreshOptions = () => {
    if (activeRepository !== repository) return;
    for (const select of [baseRef, targetRef]) setSelectOptions(select, repository, select.value);
  };
  repository.loadingCommits = true;
  refreshOptions();
  try {
    const result = await bridge.getCommits({ path: repository.path, ...repository.commitHistory });
    if (result.error) throw new Error(result.error);
    if ((repository.commitHistoryGeneration || 0) !== historyGeneration) return;
    const known = new Set(repository.commits.map((commit) => commit.sha));
    repository.commits.push(...result.commits.filter((commit) => !known.has(commit.sha)));
    repository.commitHistory = result.commitHistory;
  } catch (error) {
    if (activeRepository === repository) notify(error.message, { title: 'Could not load commits', dismissible: true, tone: 'error' });
  } finally {
    repository.loadingCommits = false;
    refreshOptions();
  }
}

async function hydrateSelectedCommits(repository, refs) {
  if (!bridge?.getCommitSummaries || !repository) return;
  const branches = new Set(repository.branches.map(branch => branch.name));
  const known = new Set(repository.commits.map(commit => commit.sha));
  const missing = [...new Set(refs)].filter(ref => /^[a-f0-9]{7,64}$/i.test(ref) && !branches.has(ref) && !known.has(ref));
  if (!missing.length) return;
  try {
    const result = await bridge.getCommitSummaries({ path: repository.path, refs: missing });
    if (result.error) throw new Error(result.error);
    if (!repositories.includes(repository)) return;
    const current = new Set(repository.commits.map(commit => commit.sha));
    repository.commits.push(...result.commits.filter(commit => !current.has(commit.sha)));
    if (activeRepository !== repository) return;
    const selections = { base: baseRef.value, target: targetRef.value };
    setSelectOptions(baseRef, repository, selections.base);
    setSelectOptions(targetRef, repository, selections.target);
  } catch {
    // Ref validation and preview preparation surface missing commits elsewhere.
  }
}

async function refreshRepositoryRefs(repository) {
  if (!bridge?.refreshRepositoryRefs || !repository) return;
  const selectedRefs = activeRepository === repository ? new Set([baseRef.value, targetRef.value]) : new Set();
  const selectedCommits = repository.commits.filter(commit => selectedRefs.has(commit.sha));
  const historyGeneration = (repository.commitHistoryGeneration || 0) + 1;
  repository.commitHistoryGeneration = historyGeneration;
  try {
    const result = await bridge.refreshRepositoryRefs({ path: repository.path });
    if (result.error) throw new Error(result.error);
    if (!repositories.includes(repository) || repository.commitHistoryGeneration !== historyGeneration) return;
    const commits = [...result.commits];
    const knownCommits = new Set(commits.map(commit => commit.sha));
    commits.push(...selectedCommits.filter(commit => !knownCommits.has(commit.sha)));
    Object.assign(repository, {
      branches: result.branches,
      commits,
      commitHistory: result.commitHistory,
      currentBranch: result.currentBranch,
      defaultBranch: result.defaultBranch,
    });
    renderProjectList();
    if (activeRepository !== repository) return;
    const selections = { base: baseRef.value, target: targetRef.value };
    setSelectOptions(baseRef, repository, selections.base);
    setSelectOptions(targetRef, repository, selections.target);
    hydrateSelectedCommits(repository, [selections.base, selections.target]);
    renderProjectMetadata(repository);
  } catch (error) {
    if (activeRepository === repository) notify(error.message, { title: 'Could not refresh Git history', dismissible: true, tone: 'error' });
  }
}
for (const [side, select] of [['base', baseRef], ['target', targetRef]]) {
  refPickers.set(select, createRefPicker(select, loadMoreCommits));
  select.addEventListener('change', () => {
    select.dataset.selectedRef = select.value;
    updateRefs([side]);
  });
}
function hardRefreshPreview(side) {
  window.requestAnimationFrame(updateCanvasZoom);
  schedulePreview([side]);
  loadDiff({ refresh: true });
}
for (const id of ['base', 'target']) {
  get(`${id}-zoom-out`).addEventListener('click', () => setPreviewZoom(id, previewZoom[id] - 10));
  get(`${id}-zoom-in`).addEventListener('click', () => setPreviewZoom(id, previewZoom[id] + 10));
  get(`${id}-zoom-reset`).addEventListener('click', () => setPreviewZoom(id, 100));
  const refreshButton = get(`${id}-refresh`);
  refreshButton.title = `Refresh ${id} preview`;
  refreshButton.setAttribute('aria-label', `Refresh ${id} preview`);
  refreshButton.addEventListener('click', () => hardRefreshPreview(id));
  get(`${id}-fit`).addEventListener('click', () => fitPreview(id));
  get(`${id}-expand`).addEventListener('click', () => setExpandedPanel(expandedSide === id ? null : id));
}
function canvasSides() {
  const layout = document.querySelector('input[name="layout"]:checked').value;
  return layout === 'split' ? ['base', 'target'] : [layout];
}
function updateCanvasZoom() {
  const values = canvasSides().map((side) => previewZoom[side]);
  get('canvas-zoom-label').textContent = values.every((value) => value === values[0]) ? `${values[0]}%` : 'Mixed';
  get('canvas-zoom-out').disabled = values.every((value) => value === 30);
  get('canvas-zoom-in').disabled = values.every((value) => value === 200);
}
for (const [action, delta] of [['out', -10], ['in', 10], ['reset', 0]]) {
  get(`canvas-zoom-${action}`).addEventListener('click', () => {
    for (const side of canvasSides()) setPreviewZoom(side, delta ? previewZoom[side] + delta : 100);
    updateCanvasZoom();
  });
}
get('canvas-fit').addEventListener('click', () => canvasSides().forEach(fitPreview));
get('canvas-expand').addEventListener('click', () => setExpandedPanel(canvasSides()[0]));
get('expanded-close').addEventListener('click', () => setExpandedPanel(null));
get('expanded-switch').addEventListener('change', (event) => {
  if (expandedSide && ['base', 'target'].includes(event.target.value)) setExpandedPanel(event.target.value);
});
for (const id of ['base', 'target']) {
  pagePickers.set(id, createPagePicker(get(`${id}-url`), page => {
    choosePage(id, page);
  }));
  get(`${id}-address-form`).addEventListener('submit', event => event.preventDefault());
}
get('page-sync').addEventListener('click', () => {
  if (pageSelectionSynced) { setPageSync(false); return; }
  const page = selectedPages.base || selectedPages.target;
  if (!page) return;
  const source = selectedPages.base ? 'base' : 'target';
  const other = source === 'base' ? 'target' : 'base';
  const match = matchingPage(other, page);
  if (!match) { notify('This page is not available in both revisions, so page sync cannot be locked.', { title: 'Page sync unavailable' }); return; }
  setPageSync(true);
  selectedPages[other] = match;
  pagePickers.get(other)?.select(match.id);
  updateRoute([other]);
});
renderPageSync();
const notifiedPreviewDataProjects = new Set();
const previewDataDiscoveries = new Map();
const previewDataQuietPeriod = 500;
const previewDataMaximumWait = 1500;
function notifyMissingPreviewData(projectPath) {
  if (!projectPath || notifiedPreviewDataProjects.has(projectPath)) return;
  notifiedPreviewDataProjects.add(projectPath);
  notify('An external public-data request failed. Acorn only allows public HTTPS JSON GET requests without credentials. Base and Target reuse the same response for an identical URL.', { title: 'Preview data unavailable' });
}
function previewDataDiscovery(projectPath) {
  if (!previewDataDiscoveries.has(projectPath)) {
    previewDataDiscoveries.set(projectPath, { pending: new Set(), presented: new Set(), quietTimer: null, maximumTimer: null });
  }
  return previewDataDiscoveries.get(projectPath);
}
function clearPreviewDataDiscoveryTimers(discovery) {
  clearTimeout(discovery.quietTimer);
  clearTimeout(discovery.maximumTimer);
  discovery.quietTimer = null;
  discovery.maximumTimer = null;
}
function presentPendingPreviewData(projectPath) {
  const discovery = previewDataDiscoveries.get(projectPath);
  if (!discovery?.pending.size) return;
  clearPreviewDataDiscoveryTimers(discovery);
  if (activeRepository?.path !== projectPath) {
    previewDataDiscoveries.delete(projectPath);
    return;
  }
  const pickerProjectPath = window.PreviewFilePicker.currentRepositoryPath();
  if (pickerProjectPath && pickerProjectPath !== projectPath) {
    discovery.quietTimer = setTimeout(() => presentPendingPreviewData(projectPath), previewDataQuietPeriod);
    return;
  }
  const origins = [...discovery.pending];
  discovery.pending.clear();
  for (const origin of origins) discovery.presented.add(origin);
  if (pickerProjectPath === projectPath) {
    void window.PreviewFilePicker.refreshExternalData(projectPath, { newOrigins: origins });
    return;
  }
  void openPreviewSettings(activeRepository, { initialTab: 'external-data', newExternalDataOrigins: origins });
}
function discoverPreviewData(projectPath, url) {
  let origin;
  try { origin = new URL(url).origin; }
  catch { return; }
  const discovery = previewDataDiscovery(projectPath);
  if (discovery.presented.has(origin)) return;
  if (window.PreviewFilePicker.currentRepositoryPath() === projectPath) {
    discovery.presented.add(origin);
    void window.PreviewFilePicker.refreshExternalData(projectPath, { newOrigins: [origin] });
    return;
  }
  discovery.pending.add(origin);
  clearTimeout(discovery.quietTimer);
  discovery.quietTimer = setTimeout(() => presentPendingPreviewData(projectPath), previewDataQuietPeriod);
  discovery.maximumTimer ||= setTimeout(() => presentPendingPreviewData(projectPath), previewDataMaximumWait);
}
window.addEventListener('message', async event => {
  if (event.data?.channel !== 'acorn-ui-preview') return;
  const side = ['base', 'target'].find(id => event.source === get(`${id}-preview-frame`).contentWindow && previewUrls?.[id]?.url && event.origin === new URL(previewUrls[id].url).origin);
  if (!side) return;
  if (event.data.type === 'data-request' && typeof event.data.id === 'string' && event.data.id.length < 100) {
    const projectPath = activeRepository?.path;
    const source = event.source;
    let result;
    if (previewUrls?.[side]?.visual) result = { error: 'External data is disabled in Visual Preview.' };
    else try { result = await bridge.getPreviewData({ path: projectPath, url: event.data.url, method: event.data.method }); }
    catch { result = { error: 'Could not load preview data.' }; }
    source.postMessage({ channel: 'acorn-data-response', id: event.data.id, result }, event.origin);
    if (result.error && !result.needsPermission && activeRepository?.path === projectPath) {
      notifyMissingPreviewData(projectPath);
    }
    if (result.needsPermission && activeRepository?.path === projectPath) {
      discoverPreviewData(projectPath, event.data.url);
    }
  }
  if (event.data.type === 'needs-fixture') notifyMissingPreviewData(activeRepository?.path);
  if (event.data.type === 'external-link' && typeof event.data.url === 'string') {
    try {
      const result = await bridge.openExternalPreviewLink({ url: event.data.url });
      if (result?.error) notify(result.error, { title: 'Could not open link', tone: 'error' });
    } catch {
      notify('The external page could not be opened.', { title: 'Could not open link', tone: 'error' });
    }
  }
  if (event.data.type === 'blocked') notify('This action needs a server or desktop connection and is unavailable in UI preview.', { title: 'Action unavailable' });
  if (event.data.type === 'unavailable') notify('This screen needs a UI preview entry for this revision.', { title: 'Preview unavailable', dismissible: true, tone: 'error' });
  if (event.data.type === 'runtime-error' && typeof event.data.message === 'string') {
    const message = event.data.message.trim().slice(0, 1000);
    if (message) notify(message, { title: `${side === 'base' ? 'Base' : 'Target'} preview error`, dismissible: true, tone: 'error' });
  }
});
get('sidebar-toggle').addEventListener('click', () => {
  setSidebarCollapsed(!shell.classList.contains('sidebar-collapsed'));
});
function applyLayoutMode(value, { announce = false } = {}) {
  const grid = get('preview-grid');
  grid.classList.remove('show-base', 'show-target');
  if (value === 'base') grid.classList.add('show-base');
  if (value === 'target') grid.classList.add('show-target');
  updateCanvasZoom();
  window.requestAnimationFrame(resizeDevicePreviews);
  if (announce) notify({ split: 'Split comparison', base: 'Base preview', target: 'Target preview' }[value]);
}
get('layout-mode').addEventListener('change', (event) => {
  applyLayoutMode(event.target.value, { announce: true });
});
get('swap-refs').addEventListener('click', () => {
  const current = baseRef.value;
  baseRef.value = targetRef.value;
  targetRef.value = current;
  const basePath = get('base-url').value;
  get('base-url').value = get('target-url').value;
  get('target-url').value = basePath;
  updateRefs();
  notify('Base and target have been swapped.');
});
get('refresh-all').addEventListener('click', () => {
  window.requestAnimationFrame(updateCanvasZoom);
  refreshRepositoryRefs(activeRepository);
  schedulePreview();
  loadDiff({ refresh: true });
});
const refreshShortcut = /Mac/i.test(navigator.platform) ? '⌘R' : 'Ctrl+R';
get('refresh-all').dataset.tooltip = refreshShortcut;
get('refresh-all').setAttribute('aria-keyshortcuts', /Mac/i.test(navigator.platform) ? 'Meta+R' : 'Control+R');
let appReloading = false;
async function handleRefreshShortcut({ full = false } = {}) {
  if (!full) { if (!appReloading) get('refresh-all').click(); return; }
  if (appReloading || !bridge?.reloadApp) return;
  persistWorkspace();
  appReloading = true;
  try {
    const result = await bridge.reloadApp();
    if (result?.error) throw new Error(result.error);
  } catch (error) {
    appReloading = false;
    notify(error.message, { title: 'Could not reload Acorn', tone: 'error', dismissible: true });
  }
}
bridge?.onRefresh?.(handleRefreshShortcut);
// Also prevent DOM reload when the renderer is running with an older main process.
// Native interception prevents this event when the desktop handler owns the shortcut.
window.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'r') return;
  event.preventDefault();
  if (!event.repeat) handleRefreshShortcut({ full: event.shiftKey });
});
get('show-diff').addEventListener('click', () => {
  if (shell.classList.contains('diff-open')) closeDiffPanel();
  else openDiffPanel();
});
get('show-diff').dataset.tooltip = '⇧D';
get('show-diff').setAttribute('aria-keyshortcuts', 'Shift+D');
window.addEventListener('keydown', (event) => {
  const isDKey = event.code === 'KeyD' || event.key.toLowerCase() === 'd';
  if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || !isDKey) return;
  if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  event.preventDefault();
  if (!event.repeat) get('show-diff').click();
});
get('diff-resizer').addEventListener('pointerdown', (event) => {
  resizingDiff = true;
  shell.classList.add('resizing-diff');
  event.currentTarget.setPointerCapture(event.pointerId);
  event.preventDefault();
});
get('diff-resizer').addEventListener('pointermove', (event) => {
  if (!resizingDiff) return;
  setDiffPanelWidth(window.innerWidth - event.clientX);
});
get('diff-resizer').addEventListener('pointerup', (event) => {
  resizingDiff = false;
  shell.classList.remove('resizing-diff');
  event.currentTarget.releasePointerCapture(event.pointerId);
});
get('diff-resizer').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const direction = event.key === 'ArrowLeft' ? 1 : -1;
  setDiffPanelWidth(get('changes-panel').getBoundingClientRect().width + direction * 16);
  event.preventDefault();
});
get('add-project').addEventListener('click', () => showConnectionModal());
get('empty-connect').addEventListener('click', async () => {
  if (!bridge) {
    notify('Git repository connections are available in the Acorn macOS app.');
    return;
  }
  const button = get('empty-connect');
  if (button.disabled) return;
  button.disabled = true;
  try { await addConnection(await bridge.chooseLocalRepository(), { reopenModalOnCancel: false, showErrorsInModal: false }); }
  catch (error) { notify(error.message, { tone: 'error' }); }
  finally { button.disabled = false; }
});
get('modal-close').addEventListener('click', () => showConnectionModal(false));
async function chooseConnection(file) {
  const button = get('connect-local'); button.disabled = true;
  get('connection-error').textContent = '';
  try { await addConnection(await (file ? bridge.chooseDroppedRepository(file) : bridge.chooseLocalRepository())); }
  catch (error) { get('connection-error').textContent = error.message; }
  finally { button.disabled = false; }
}
get('connect-local').addEventListener('click', () => chooseConnection());
get('connect-local').addEventListener('dragover', event => {
  event.preventDefault();
  event.dataTransfer.dropEffect = get('connect-local').disabled ? 'none' : 'copy';
});
get('connect-local').addEventListener('drop', event => {
  event.preventDefault();
  if (get('connect-local').disabled) return;
  const files = [...event.dataTransfer.files];
  if (files.length !== 1) {
    get('connection-error').textContent = 'Drop one repository folder at a time.';
    return;
  }
  chooseConnection(files[0]);
});
async function openPreviewSettings(repository = activeRepository, options) {
  if (!repository || !bridge) return;
  const saved = await window.PreviewFilePicker.open(repository, options);
  if (!saved) return false;
  for (const [key, session] of projectPreviewSessions) {
    if (JSON.parse(key)[0] !== repository.path) continue;
    for (const frame of Object.values(session.frames || {})) frame.remove();
    projectPreviewSessions.delete(key);
  }
  if (activeRepository?.path === repository.path) {
    previewCleanup = previewRefresh;
    schedulePreview();
  }
  persistWorkspace();
  notify('Saved');
  return true;
}
get('project-preview-settings').addEventListener('click', () => { void openPreviewSettings(); });

const previewResizeObserver = new ResizeObserver(resizeDevicePreviews);
previewResizeObserver.observe(get('base-preview-viewport'));
previewResizeObserver.observe(get('target-preview-viewport'));
window.addEventListener('resize', () => {
  if (shell.classList.contains('diff-open')) setDiffPanelWidth(get('changes-panel').getBoundingClientRect().width);
  resizeDevicePreviews();
});
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!get('connection-modal').hidden) {
    event.preventDefault();
    showConnectionModal(false);
    return;
  }
  if (expandedSide) { setExpandedPanel(null); return; }
  if (get('changes-panel').hidden) return;
  closeDiffPanel();
});
setDiffPanelWidth(360);
resizeDevicePreviews();

async function initializeProjects() {
  shell.classList.add('projects-loading');
  get('project-loading').hidden = false;
  get('project-loading').setAttribute('aria-busy', 'true');
  get('project-loading-dots').hidden = false;
  get('project-loading-message').textContent = 'Loading repositories…';
  get('retry-projects').hidden = true;
  get('connection-empty').hidden = true;
  try {
    if (!bridge) {
      get('connection-empty').querySelector('p').textContent = 'Local Git repository connections are available in the Acorn macOS app.';
      get('connection-empty').hidden = false;
    } else {
      repositories = await bridge.listRepositories();
      renderProjectList();
      const saved = await restoreWorkspace();
      const repository = repositories.find(item => item.path === saved?.repository) || repositories[0];
      if (repository) {
        activateRepository(repository.path, saved?.comparison);
      }
      else get('connection-empty').hidden = false;
    }
    if (!get('connection-empty').hidden) {
      get('project-title').textContent = 'Connect a repository';
      get('project-remote').textContent = 'Connect a repository to begin';
    }
    get('project-loading').hidden = true;
  } catch (error) {
    get('project-loading-dots').hidden = true;
    get('project-loading-message').textContent = 'Could not load repositories. Please try again.';
    get('retry-projects').hidden = false;
    get('project-title').textContent = 'Repositories unavailable';
    get('project-remote').textContent = '';
    console.error('Could not load repositories:', error);
  } finally {
    shell.classList.remove('projects-loading');
    get('project-loading').setAttribute('aria-busy', 'false');
  }
}
get('retry-projects').addEventListener('click', initializeProjects);
window.addEventListener('acorn:projects-changed', initializeProjects);
initializeProjects();

// A top-layer tooltip stays visible outside clipped panel and sidebar edges.
const iconTooltip = document.createElement('div');
iconTooltip.id = 'icon-tooltip';
iconTooltip.className = 'icon-tooltip';
iconTooltip.setAttribute('popover', 'manual');
iconTooltip.setAttribute('role', 'tooltip');
document.body.append(iconTooltip);
let tooltipButton = null;
let tooltipHideTimer = null;
function cancelIconTooltipHide() {
  clearTimeout(tooltipHideTimer);
  tooltipHideTimer = null;
}
function scheduleIconTooltipHide() {
  cancelIconTooltipHide();
  tooltipHideTimer = setTimeout(hideIconTooltip, 100);
}
function hideIconTooltip() {
  cancelIconTooltipHide();
  iconTooltip.hidePopover();
  iconTooltip.classList.remove('repository-tooltip', 'preview-mode-tooltip');
  iconTooltip.setAttribute('role', 'tooltip');
  iconTooltip.removeAttribute('aria-label');
  tooltipButton?.removeAttribute('aria-describedby');
  tooltipButton = null;
}
function showIconTooltip(button, repository = null) {
  hideIconTooltip();
  if (button.classList.contains('modal-close')) return;
  if ((button.id === 'runtime-status' || button.id === 'open-settings')
    && !shell.classList.contains('sidebar-collapsed')) return;
  if (button.id === 'runtime-status' && shell.classList.contains('sidebar-collapsed')
    && get('runtime-popover').matches(':popover-open')) return;
  const label = button.dataset.tooltip || button.getAttribute('aria-label') || button.title;
  if (!label || (button.disabled && !button.dataset.tooltip)) return;
  button.removeAttribute('title');
  tooltipButton = button;
  button.setAttribute('aria-describedby', iconTooltip.id);
  const shortLabel = button.id.endsWith('-fit') ? 'Fit to section'
    : button.id.endsWith('-refresh') ? 'Refresh'
    : button.id.endsWith('-expand') ? (button.getAttribute('aria-pressed') === 'true' ? 'Collapse' : 'Expand')
    : button.id === 'sidebar-toggle' ? (button.getAttribute('aria-expanded') === 'true' ? 'Collapse' : 'Expand')
    : button.getAttribute('popovertargetaction') === 'hide' ? 'Close'
    : label;
  if (repository) {
    iconTooltip.classList.add('repository-tooltip');
    iconTooltip.setAttribute('role', 'dialog');
    iconTooltip.setAttribute('aria-label', `${repository.name} comparisons`);
    const name = document.createElement('div');
    name.className = 'repository-tooltip-name';
    name.textContent = repository.name;
    const comparisonButtons = comparisonsFor(repository).map(comparison => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'repository-tooltip-comparison';
      item.textContent = comparisonName(repository, comparison);
      if (repository.path === activeRepository?.path && comparison.id === activeComparison?.id) {
        item.setAttribute('aria-current', 'page');
      }
      item.addEventListener('click', () => {
        hideIconTooltip();
        activateRepository(repository.path, comparison.id);
      });
      return item;
    });
    iconTooltip.replaceChildren(name, ...comparisonButtons);
  } else {
    iconTooltip.textContent = shortLabel;
  }
  if (!repository && button.id === 'runtime-status') {
    const count = document.createElement('span');
    count.className = 'runtime-tooltip-count';
    count.textContent = get('runtime-count').textContent;
    iconTooltip.replaceChildren(document.createTextNode('Running Servers '), count);
  }
  const isPreviewModeTag = button.classList.contains('preview-mode-tag');
  iconTooltip.classList.toggle('preview-mode-tooltip', isPreviewModeTag);
  iconTooltip.showPopover();
  const bounds = button.getBoundingClientRect();
  const tooltip = iconTooltip.getBoundingClientRect();
  const gap = ['refresh-all', 'show-diff'].includes(button.id) ? 4 : 6;
  if (isPreviewModeTag) {
    iconTooltip.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - tooltip.width - 8))}px`;
    iconTooltip.style.top = `${Math.max(8, bounds.top - tooltip.height - gap)}px`;
    return;
  }
  if (shell.classList.contains('sidebar-collapsed') && button.closest('.sidebar')) {
    iconTooltip.style.left = `${bounds.right + 10}px`;
    iconTooltip.style.top = `${repository
      ? bounds.top
      : Math.max(8, Math.min(bounds.top + (bounds.height - tooltip.height) / 2, innerHeight - tooltip.height - 8))}px`;
    return;
  }
  iconTooltip.style.left = `${Math.max(8, Math.min(bounds.left + (bounds.width - tooltip.width) / 2, innerWidth - tooltip.width - 8))}px`;
  iconTooltip.style.top = `${bounds.bottom + tooltip.height + gap + 8 <= innerHeight ? bounds.bottom + gap : Math.max(8, bounds.top - tooltip.height - gap)}px`;
}
iconTooltip.addEventListener('pointerenter', cancelIconTooltipHide);
iconTooltip.addEventListener('pointerleave', scheduleIconTooltipHide);
iconTooltip.addEventListener('focusin', cancelIconTooltipHide);
iconTooltip.addEventListener('focusout', scheduleIconTooltipHide);
for (const button of document.querySelectorAll('.icon-button, .sidebar-toggle, [data-tooltip], #runtime-mode, #runtime-status, #open-settings')) {
  button.addEventListener('pointerenter', () => showIconTooltip(button));
  button.addEventListener('focus', () => {
    if (button.matches(':focus-visible')) showIconTooltip(button);
  });
  button.addEventListener('pointerleave', hideIconTooltip);
  button.addEventListener('blur', hideIconTooltip);
  button.addEventListener('click', hideIconTooltip);
}
window.addEventListener('scroll', hideIconTooltip, true);
window.addEventListener('resize', hideIconTooltip);
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideIconTooltip(); });

function sendPreviewSync(side, message) {
  const preview = previewUrls?.[side];
  if (!preview?.url) return;
  get(`${side}-preview-frame`).contentWindow?.postMessage({ channel: 'acorn-preview-sync', ...message }, new URL(preview.url).origin);
}
function configureMouseSync() {
  for (const side of ['base', 'target']) sendPreviewSync(side, { type: 'configure', enabled: get('mouse-sync').checked });
}
get('mouse-sync').addEventListener('change', () => {
  persistComparisonViewOptions();
  configureMouseSync();
});
window.addEventListener('message', (event) => {
  const data = event.data;
  if (data?.channel !== 'acorn-preview-sync') return;
  const side = ['base', 'target'].find((id) => event.source === get(`${id}-preview-frame`).contentWindow && previewUrls?.[id]?.url && event.origin === new URL(previewUrls[id].url).origin);
  if (!side) return;
  if (data.type === 'ready') { configureMouseSync(); return; }
  if (data.type === 'overlay-ready') { configureDiffOverlay([side]); return; }
  if (data.type === 'overlay-status' && data.version === diffRequestVersion && data.requestId === overlayRequests[side] && Number.isInteger(data.count) && data.count >= 0) {
    overlayCounts[side] = data.count;
    overlayMatchedFiles[side] = new Set(Array.isArray(data.matchedFiles) ? data.matchedFiles.map(normalizedSourcePath) : []);
    refreshFilePreviewActions();
    updateDiffProgress();
    return;
  }
  if (!get('mouse-sync').checked || !['click', 'scroll', 'keydown', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel'].includes(data.type)) return;
  const other = side === 'base' ? 'target' : 'base';
  // Some routers commit navigation from pointerup, before the later click
  // event reaches this bridge. Start the transaction at pointerdown so that
  // the first mirrored navigation cannot force the other revision to follow.
  if (data.type === 'pointerdown') markPendingMirroredNavigation(other, side);
  if (data.type === 'click' && !pendingMirroredNavigation(side)) markPendingMirroredNavigation(other, side);
  sendPreviewSync(other, data);
});

function updateDiffProgress() {
  const enabled = get('diff-overlay').checked;
  const pending = enabled && !diffLoadError && (!overlayDiff || selectedDiffSides().some((side) =>
    (overlayDiff.hints?.[side]?.length || 0) > 0 && overlayCounts[side] == null));
  const alert = get('diff-progress');
  const message = get('diff-progress-message');
  const hide = () => {
    alert.hidden = true;
    alert.classList.remove('show');
    alert.setAttribute('aria-busy', 'false');
    setToastAlertVisible(alert, false);
  };
  const show = (state, text) => {
    alert.hidden = false;
    alert.classList.add('show');
    alert.classList.toggle('is-loading', state === 'loading');
    alert.classList.toggle('is-complete', state === 'complete');
    alert.setAttribute('aria-busy', String(state === 'loading'));
    message.textContent = text;
    setToastAlertVisible(alert, true);
  };

  if (!enabled) {
    window.clearTimeout(diffProgressHideTimeout);
    hide();
    return;
  }
  if (diffLoadError) {
    window.clearTimeout(diffProgressHideTimeout);
    hide();
    return;
  }
  if (pending) {
    window.clearTimeout(diffProgressHideTimeout);
    show('loading', 'Loading diff...');
    return;
  }
  if (!alert.hidden && alert.classList.contains('is-loading')) {
    show('complete', 'Loaded');
    diffProgressHideTimeout = window.setTimeout(hide, toastDuration);
    return;
  }
  if (!alert.classList.contains('is-complete')) hide();
}
function selectedDiffSides() {
  const scope = get('diff-scope').querySelector('input:checked').value;
  return scope === 'both' ? ['base', 'target'] : [scope];
}
function configureDiffOverlay(sides = ['base', 'target']) {
  get('diff-scope').hidden = !get('diff-overlay').checked;
  const selectedSides = selectedDiffSides();
  for (const side of sides) {
    delete overlayCounts[side];
    delete overlayMatchedFiles[side];
    const requestId = ++overlayRequestSequence;
    overlayRequests[side] = requestId;
    const enabled = get('diff-overlay').checked && selectedSides.includes(side) && Boolean(overlayDiff);
    const hints = overlayDiff?.hints?.[side] || [];
    if (enabled && hints.length === 0) overlayCounts[side] = 0;
    sendPreviewSync(side, {
      type: 'diff-overlay', enabled, locate: Boolean(overlayDiff), requestId,
      hints, version: diffRequestVersion,
      theme: document.documentElement.dataset.theme,
      color: getComputedStyle(document.documentElement).getPropertyValue('--purple').trim(),
    });
    updateDiffProgress();
  }
}
get('diff-overlay').addEventListener('change', () => {
  persistComparisonViewOptions();
  configureDiffOverlay();
});
get('diff-scope').addEventListener('change', () => configureDiffOverlay());
new MutationObserver(() => configureDiffOverlay()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

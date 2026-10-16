/* Finder-style column browser for pages, not repository files. */
function buildPageTree(pages) {
  const root = { label: 'Pages', children: [] };
  for (const page of pages.filter(page => page.available && !page.docs)) {
    let parent = root;
    for (const label of page.group || []) {
      let folder = parent.children.find(item => item.children && item.label === label);
      if (!folder) { folder = { label, children: [] }; parent.children.push(folder); }
      parent = folder;
    }
    parent.children.push({ label: page.label, page });
  }
  const sort = node => { node.children?.sort((a, b) => Number(Boolean(b.children)) - Number(Boolean(a.children)) || a.label.localeCompare(b.label)); node.children?.forEach(sort); };
  sort(root);
  return root;
}

function createPagePicker(input, onSelect) {
  input.hidden = true;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'page-picker-trigger';
  trigger.setAttribute('aria-label', `${input.id.startsWith('base') ? 'Base' : 'Target'} page`);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.disabled = true;
  input.after(trigger);
  const menu = document.createElement('div');
  menu.id = `${input.id}-pages`;
  menu.className = 'page-picker-menu';
  menu.setAttribute('popover', 'auto');
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Choose a page for UI preview');
  trigger.setAttribute('popovertarget', menu.id);
  trigger.setAttribute('aria-controls', menu.id);
  document.body.append(menu);
  let catalog = { pages: [], warnings: [] }, selected = null, tree = buildPageTree([]), folders = [];
  function position() {
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(rect.width, innerWidth - 24);
    menu.style.width = `${width}px`;
    const height = Math.min(380, Math.max(120, menu.scrollHeight));
    menu.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
    if (trigger.closest('.preview-panel.is-expanded')) {
      menu.style.top = `${rect.bottom + 6}px`;
      menu.style.maxHeight = `${Math.min(380, innerHeight - rect.bottom - 18)}px`;
    } else {
      menu.style.top = `${Math.max(12, rect.top - height - 6)}px`;
      menu.style.maxHeight = `${Math.min(380, rect.top - 18)}px`;
    }
  }
  function close() { if (menu.matches(':popover-open')) menu.hidePopover(); }
  function syncFolders() {
    folders = [];
    let parent = tree;
    for (const name of selected?.group || []) {
      const folder = parent.children.find(item => item.children && item.label === name);
      if (!folder) break;
      folders.push(folder);
      parent = folder;
    }
  }
  function label() {
    trigger.textContent = selected ? [...(selected.group || []), selected.label].join(' / ') : 'No previewable pages';
    trigger.title = [selected ? `${selected.path} · ${selected.note || 'UI only'}` : 'Browse pages in this revision', ...(catalog.warnings || [])].join('\n');
  }
  function render() {
    menu.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'page-picker-heading';
    heading.textContent = 'Pages';
    const columns = document.createElement('div'); columns.className = 'page-picker-columns';
    for (const [depth, node] of [tree, ...folders].entries()) {
      const column = document.createElement('div'); column.className = 'page-picker-column';
      column.setAttribute('role', 'group'); column.setAttribute('aria-label', node.label);
      for (const item of node.children) {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'page-picker-row';
        const active = item.children ? folders[depth] === item : selected?.id === item.page.id;
        row.classList.toggle('is-selected', active);
        if (item.children) { row.setAttribute('aria-expanded', String(active)); }
        else { row.setAttribute('aria-current', active ? 'page' : 'false'); }
        const icon = document.createElement('span'); icon.className = 'page-picker-icon'; icon.innerHTML = item.children ? '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.75 6.25A1.75 1.75 0 0 1 4.5 4.5h3.1l1.8 2h6.1a1.75 1.75 0 0 1 1.75 1.75v6.25a1.75 1.75 0 0 1-1.75 1.75h-11a1.75 1.75 0 0 1-1.75-1.75V6.25Z"/></svg>' : '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.75" y="3.25" width="14.5" height="13.5" rx="2"/><path d="M3 7.25h14M5.5 5.25h.01m2.25 0h.01"/></svg>'; icon.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span'); text.className = 'page-picker-name'; text.textContent = item.label;
        const arrow = document.createElement('span'); arrow.className = 'page-picker-arrow';
        if (item.children) arrow.textContent = '›';
        else if (active) {
          arrow.classList.add('page-picker-check');
          arrow.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>';
        }
        row.append(icon, text, arrow);
        row.title = item.page ? `${item.page.path}\n${item.page.note || ''}\n${item.page.source}` : item.label;
        row.addEventListener('click', () => {
          if (item.children) { folders = [...folders.slice(0, depth), item]; render(); columns.scrollLeft = columns.scrollWidth; menu.querySelectorAll('.page-picker-column')[depth + 1]?.querySelector('button')?.focus(); }
          else { selected = item.page; syncFolders(); label(); close(); trigger.focus(); onSelect(selected); }
        });
        row.addEventListener('keydown', event => {
          const rows = [...column.querySelectorAll('button')]; const index = rows.indexOf(row);
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault(); rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
          } else if (event.key === 'ArrowRight' && item.children) { event.preventDefault(); row.click(); }
          else if (event.key === 'ArrowLeft' && depth > 0) { event.preventDefault(); folders = folders.slice(0, depth - 1); render(); menu.querySelectorAll('.page-picker-column')[depth - 1]?.querySelector('.is-selected, button')?.focus(); }
        });
        column.append(row);
      }
      if (!node.children.length) { const empty = document.createElement('p'); empty.textContent = 'No pages available in this revision.'; column.append(empty); }
      columns.append(column);
    }
    const footer = document.createElement('div'); footer.className = 'page-picker-footer'; footer.setAttribute('role', 'status');
    footer.textContent = 'Use page navigation to inspect the UI. Some features may not work in UI preview.';
    menu.append(heading, columns, footer);
    requestAnimationFrame(() => { position(); columns.scrollLeft = columns.scrollWidth; });
  }
  menu.addEventListener('toggle', () => {
    const open = menu.matches(':popover-open'); trigger.setAttribute('aria-expanded', String(open));
    if (open) { syncFolders(); render(); menu.querySelector('[aria-current="page"]')?.focus(); }
  });
  menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); trigger.focus(); } });
  window.addEventListener('resize', () => { if (menu.matches(':popover-open')) position(); });
  label();
  return {
    close,
    select(id) {
      const match = catalog.pages.find(page => page.id === id);
      if (match) { selected = match; syncFolders(); label(); if (menu.matches(':popover-open')) render(); }
      return match;
    },
    loading() { close(); trigger.disabled = true; trigger.textContent = 'Finding pages…'; },
    failed(message) { trigger.disabled = true; trigger.textContent = 'Pages unavailable'; trigger.title = message; },
    setCatalog(value, preserve = true) {
      catalog = { ...(value || {}), pages: (value?.pages || []).filter(page => page.available && !page.docs) }; tree = buildPageTree(catalog.pages); folders = [];
      const previous = preserve && selected;
      selected = (previous && catalog.pages.find(page => page.available && page.id === previous.id)) || catalog.pages.find(page => page.available) || null;
      syncFolders();
      trigger.disabled = !catalog.pages.length; label();
      if (menu.matches(':popover-open')) render();
      return { selected, missing: Boolean(previous && !catalog.pages.some(page => page.id === previous.id)) };
    },
  };
}
if (typeof module !== 'undefined') module.exports = { buildPageTree };

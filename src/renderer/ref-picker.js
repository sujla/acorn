function renderRefLabel(element, text, compact = false) {
  const revision = text.match(/^(.*?\b[a-f0-9]{7,40})([ •·-]+)(.*)$/i);
  element.textContent = text;
  if (!revision) return;
  const summary = document.createElement('span');
  summary.className = 'ref-summary';
  summary.textContent = `${compact ? ' ' : revision[2]}${revision[3]}`;
  element.replaceChildren(document.createTextNode(revision[1]), summary);
}

// Preserve the select as application state; a themed popover handles scrolling.
function createRefPicker(select, loadMore) {
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ref-picker-trigger';
  trigger.setAttribute('aria-label', select.getAttribute('aria-label'));
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.id = `${select.id}-menu`;
  menu.className = 'ref-picker-menu';
  menu.setAttribute('popover', 'auto');
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', select.getAttribute('aria-label'));
  menu.tabIndex = 0;
  trigger.setAttribute('aria-controls', menu.id);
  trigger.setAttribute('popovertarget', menu.id);
  select.hidden = true;
  select.before(trigger);
  document.body.append(menu);
  let rows = [];
  let active = select.value;
  let loading = false;
  let hasMore = false;
  let search = '';
  let searchTime = 0;
  let openAtPointerDown = false;
  const isOpen = () => menu.matches(':popover-open');
  function position() {
    if (!isOpen()) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(rect.width, innerWidth - 16);
    const below = innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const height = Math.min(440, Math.max(below, above));
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${Math.max(80, height)}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
    menu.style.top = `${below >= Math.min(440, above) ? rect.bottom + 7 : Math.max(8, rect.top - Math.min(menu.scrollHeight, height) - 7)}px`;
  }
  function highlight(scroll = false) {
    for (const row of rows) row.classList.toggle('is-active', row.dataset.value === active);
    const row = rows.find(item => item.dataset.value === active);
    if (row) {
      menu.setAttribute('aria-activedescendant', row.id);
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    }
  }
  function checkBottom() {
    if (isOpen() && hasMore && !loading && menu.scrollTop + menu.clientHeight >= menu.scrollHeight - 16) loadMore();
  }
  function close() { if (isOpen()) menu.hidePopover(); }
  function choose(value) {
    select.value = value;
    active = value;
    close();
    trigger.focus();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function render(state = {}) {
    hasMore = Boolean(state.hasMore);
    loading = Boolean(state.loading);
    trigger.textContent = select.selectedOptions[0]?.textContent || 'Select revision';
    trigger.title = trigger.textContent;
    renderRefLabel(trigger, trigger.textContent, true);
    const top = menu.scrollTop;
    const children = [];
    rows = [];
    for (const option of select.options) {
      const row = document.createElement('div');
      renderRefLabel(row, option.textContent);
      if (option.disabled) {
        row.className = 'ref-picker-section';
        row.setAttribute('role', 'presentation');
      } else {
        row.id = `${menu.id}-option-${rows.length}`;
        row.className = 'ref-picker-option';
        row.dataset.value = option.value;
        row.title = option.textContent;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(option.value === select.value));
        row.addEventListener('pointermove', () => { active = option.value; highlight(); });
        row.addEventListener('click', () => choose(option.value));
        rows.push(row);
      }
      children.push(row);
    }
    if (loading) {
      const status = document.createElement('div');
      status.className = 'ref-picker-loading';
      status.setAttribute('role', 'status');
      status.textContent = 'Loading commits…';
      children.push(status);
    }
    menu.replaceChildren(...children);
    menu.setAttribute('aria-busy', String(loading));
    if (!rows.some(row => row.dataset.value === active)) active = select.value;
    highlight();
    menu.scrollTop = top;
    position();
  }
  function open() {
    active = select.value;
    menu.showPopover();
    position();
    menu.focus();
    highlight(true);
  }
  trigger.addEventListener('pointerdown', () => { openAtPointerDown = isOpen(); });
  trigger.addEventListener('click', event => {
    // Cancel the native popover action so it cannot paint at its default
    // position for one frame before our anchored position is applied.
    event.preventDefault();
    const shouldClose = openAtPointerDown || isOpen();
    openAtPointerDown = false;
    if (shouldClose) close();
    else open();
  });
  trigger.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); }
  });
  menu.addEventListener('toggle', () => {
    const opened = isOpen();
    trigger.setAttribute('aria-expanded', String(opened));
    if (!opened) return;
    active = select.value;
    position();
    menu.focus();
    highlight(true);
  });
  menu.addEventListener('scroll', checkBottom, { passive: true });
  menu.addEventListener('wheel', event => { if (event.deltaY > 0) checkBottom(); }, { passive: true });
  menu.addEventListener('keydown', event => {
    const index = rows.findIndex(row => row.dataset.value === active);
    let next;
    if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1);
    if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = rows.length - 1;
    if (event.key === 'PageDown') next = Math.min(rows.length - 1, index + 10);
    if (event.key === 'PageUp') next = Math.max(0, index - 10);
    if (next !== undefined) { event.preventDefault(); active = rows[next]?.dataset.value; highlight(true); checkBottom(); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (active) choose(active); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); trigger.focus(); }
    else if (event.key === 'Tab') { close(); trigger.focus(); }
    else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      search = performance.now() - searchTime > 700 ? event.key : search + event.key;
      searchTime = performance.now();
      const match = rows.find(row => row.textContent.toLowerCase().startsWith(search.toLowerCase()));
      if (match) { active = match.dataset.value; highlight(true); }
    }
  });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', event => { if (event.target !== menu) position(); }, true);
  return { render, close };
}

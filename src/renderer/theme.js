(() => {
  const storageKey = 'acorn.theme';
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const validThemes = new Set(['system', 'light', 'dark']);
  let preference = 'system';

  try {
    const saved = localStorage.getItem(storageKey);
    if (validThemes.has(saved)) preference = saved;
  } catch { /* System remains the default when storage is unavailable. */ }

  function applyTheme() {
    document.documentElement.dataset.theme = preference === 'system'
      ? (systemTheme.matches ? 'dark' : 'light') : preference;
    window.acornTheme?.setPreference(preference);
    for (const option of document.querySelectorAll('[data-theme-option]')) {
      option.setAttribute('aria-checked', String(option.dataset.themeOption === preference));
    }
  }

  applyTheme();
  systemTheme.addEventListener('change', applyTheme);
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = validThemes.has(event.newValue) ? event.newValue : 'system';
    applyTheme();
  });
  document.addEventListener('DOMContentLoaded', () => {
    const choices = document.getElementById('appearance-menu');
    applyTheme();
    choices.addEventListener('click', (event) => {
      const option = event.target.closest('[data-theme-option]');
      if (!option) return;
      preference = validThemes.has(option.dataset.themeOption) ? option.dataset.themeOption : 'system';
      try { localStorage.setItem(storageKey, preference); } catch { /* Apply for this session. */ }
      applyTheme();
      choices.hidePopover();
      document.getElementById('open-settings')?.focus();
    });
    choices.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const options = [...choices.querySelectorAll('[data-theme-option]')];
      const current = options.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    });
  });
})();

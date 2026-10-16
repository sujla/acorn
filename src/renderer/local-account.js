// Local profile display. No account or sign-in is required.
(() => {
  const get = (id) => document.getElementById(id);
  get('open-settings').addEventListener('click', () => get('account-menu').hidePopover());
  async function loadProfile() {
    try {
      const result = await window.acornLocalProfile?.status();
      if (result?.error) throw new Error(result.error);
      const name = result?.profile?.name || '';
      get('account-login').textContent = name;
      get('account-menu-login').textContent = name;
      const label = name ? `Local profile: ${name}` : 'Local profile';
      get('account-trigger').setAttribute('aria-label', label);
      get('account-trigger').removeAttribute('title');
    } catch {
      window.dispatchEvent(new CustomEvent('acorn:notify', {
        detail: { message: 'Could not load the local profile.', tone: 'error' },
      }));
    }
  }
  loadProfile();
})();

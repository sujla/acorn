// Share backdrop dismissal while preserving each modal's cancellation cleanup.
(() => {
  const bindBackdrop = (surface, outside, dismiss) => {
    let backdropPointerDown = false;
    surface.addEventListener('pointerdown', event => {
      backdropPointerDown = event.button === 0 && outside(event);
    });
    surface.addEventListener('pointercancel', () => { backdropPointerDown = false; });
    surface.addEventListener('click', event => {
      const dismissing = backdropPointerDown && outside(event);
      backdropPointerDown = false;
      if (dismissing) dismiss();
    });
  };
  for (const dialog of document.querySelectorAll('dialog')) {
    // Let native Escape cancellation run without dismissing the workspace behind it.
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') event.stopPropagation();
    });
    bindBackdrop(dialog, event => {
      const rect = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom);
    }, () => {
      if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
    });
  }
  const connection = document.getElementById('connection-modal');
  bindBackdrop(connection, event => event.target === connection,
    () => document.getElementById('modal-close').click());
})();

(() => {
  const dialog = document.getElementById('settings-dialog');
  const trigger = document.getElementById('open-settings');
  if (!dialog || !trigger || trigger.hasAttribute('popovertarget')) return;
  trigger.addEventListener('click', () => {
    if (!dialog.open) dialog.showModal();
  });
  document.getElementById('close-settings').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => trigger.focus());
  for (const button of dialog.querySelectorAll('[data-settings-section]')) {
    button.addEventListener('click', () => {
      for (const item of dialog.querySelectorAll('[data-settings-section]')) {
        const active = item === button;
        item.toggleAttribute('aria-current', active);
        if (active) item.setAttribute('aria-current', 'page');
        document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
      }
    });
  }
})();

// Runs inside local preview pages, without Node.js or application bridge access.
(() => {
  if (window.__acornPreviewSync) return;
  window.__acornPreviewSync = true;
  const channel = 'acorn-preview-sync';
  let enabled = false;
  let mutedUntil = 0;
  let pendingScroll = 0;
  let outgoingDrag = null;
  let incomingDrag = null;
  let pendingPointerMove = 0;
  let pendingPointerPayload = null;
  const send = (type, payload = {}) => parent.postMessage({ channel, type, ...payload }, '*');
  const pageScroller = (element) => element === document || element === document.documentElement || element === document.body || element === document.scrollingElement;
  function describe(element) {
    if (!(element instanceof Element)) return null;
    const node = element.closest('a, button, input, select, textarea, [role="button"], [role="tab"]') || element;
    let selector;
    if (node.id) selector = `#${CSS.escape(node.id)}`;
    else if (node.hasAttribute('data-testid')) selector = `[data-testid="${CSS.escape(node.getAttribute('data-testid'))}"]`;
    else if (node.getAttribute('aria-label')) selector = `${node.localName}[aria-label="${CSS.escape(node.getAttribute('aria-label'))}"]`;
    else if (node.getAttribute('name')) selector = `${node.localName}[name="${CSS.escape(node.getAttribute('name'))}"]`;
    const parts = [];
    for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
      const siblings = [...current.parentElement.children].filter((sibling) => sibling.localName === current.localName);
      parts.unshift(`${current.localName}:nth-of-type(${siblings.indexOf(current) + 1})`);
    }
    return { selector, path: parts.join(' > '), tag: node.localName, text: node.textContent.trim().slice(0, 200), href: node.localName === 'a' ? new URL(node.href).pathname + new URL(node.href).search + new URL(node.href).hash : null };
  }
  function locate(target) {
    if (!target) return null;
    try {
      if (target.selector) {
        const found = document.querySelector(target.selector);
        if (found) return found;
      }
      if (target.href) {
        const found = [...document.querySelectorAll('a[href]')].find((link) => {
          const url = new URL(link.href);
          return url.pathname + url.search + url.hash === target.href;
        });
        if (found) return found;
      }
      if (['button', 'a'].includes(target.tag) && target.text) {
        const matches = [...document.querySelectorAll(target.tag)].filter((node) => node.textContent.trim().slice(0, 200) === target.text);
        if (matches.length === 1) return matches[0];
      }
      return target.path ? document.querySelector(target.path) : null;
    } catch { return null; }
  }
  function preservesSourceFocus(element) {
    if (!(element instanceof Element)) return false;
    return Boolean(element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'));
  }
  function focusMirroredTarget(element) {
    if (!preservesSourceFocus(element)) element.focus?.({ preventScroll: true });
  }
  function dismissMirroredPopovers(target) {
    const invoker = target.closest?.('[popovertarget]');
    for (const popover of [...document.querySelectorAll('[popover]')].reverse()) {
      if (!popover.matches?.(':popover-open') || popover.getAttribute('popover') === 'manual') continue;
      if (popover.contains(target) || (popover.id && invoker?.getAttribute('popovertarget') === popover.id)) continue;
      popover.hidePopover?.();
    }
  }
  function pointerPayload(event, node, target, rect = node.getBoundingClientRect()) {
    return {
      target,
      x: (event.clientX - rect.left) / Math.max(1, rect.width),
      y: (event.clientY - rect.top) / Math.max(1, rect.height),
      viewportX: event.clientX / Math.max(1, innerWidth),
      viewportY: event.clientY / Math.max(1, innerHeight),
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      button: event.button,
      buttons: event.buttons,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    };
  }
  function sendPendingPointerMove() {
    pendingPointerMove = 0;
    if (!pendingPointerPayload) return;
    send('pointermove', pendingPointerPayload);
    pendingPointerPayload = null;
  }
  function dispatchPointer(type, drag, data) {
    if (!drag?.node || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return false;
    // A gesture may replace its original child (e.g. a turning page). Keep
    // delivering to the nearest surviving ancestor and retain the start geometry.
    if (drag.node.isConnected === false) drag.node = drag.ancestors.find(node => node.isConnected !== false);
    if (!drag.node) return false;
    const rect = drag.rect;
    const clientX = rect.left + data.x * Math.max(1, rect.width);
    const clientY = rect.top + data.y * Math.max(1, rect.height);
    const EventClass = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    mutedUntil = performance.now() + 200;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      pointerId: drag.pointerId,
      pointerType: drag.pointerType,
      isPrimary: data.isPrimary !== false,
      button: Number.isFinite(data.button) ? data.button : (type === 'pointermove' ? -1 : 0),
      buttons: Number.isFinite(data.buttons) ? data.buttons : (type === 'pointerup' || type === 'pointercancel' ? 0 : 1),
      altKey: data.altKey === true,
      ctrlKey: data.ctrlKey === true,
      metaKey: data.metaKey === true,
      shiftKey: data.shiftKey === true,
    };
    const allowed = drag.node.dispatchEvent(new EventClass(type, init));
    // dispatchEvent(PointerEvent) does not generate the browser's compatibility
    // mouse events. React Native Web's PanResponder listens to those events.
    // Preserve preventDefault on pointerdown, just as a real pointer does.
    if (type === 'pointerdown') drag.mouseCompatibility = drag.pointerType === 'mouse' && allowed;
    if (drag.mouseCompatibility) {
      const mouseType = { pointerdown: 'mousedown', pointermove: 'mousemove', pointerup: 'mouseup', pointercancel: 'mouseup' }[type];
      if (mouseType) drag.node.dispatchEvent(new MouseEvent(mouseType, {
        ...init,
        button: 0,
        buttons: type === 'pointercancel' ? 0 : init.buttons,
      }));
    }
    drag.last = data;
    return true;
  }
  document.addEventListener('pointerdown', (event) => {
    if (!enabled || !event.isTrusted || event.button !== 0 || event.isPrimary === false || !(event.target instanceof Element)) return;
    const target = describe(event.target);
    outgoingDrag = {
      pointerId: event.pointerId,
      node: event.target,
      rect: event.target.getBoundingClientRect(),
      target,
      initial: pointerPayload(event, event.target, target),
      started: false,
    };
  }, true);
  document.addEventListener('pointermove', (event) => {
    if (!enabled || !event.isTrusted || !outgoingDrag || event.pointerId !== outgoingDrag.pointerId) return;
    if (!outgoingDrag.started) {
      outgoingDrag.started = true;
      send('pointerdown', outgoingDrag.initial);
    }
    pendingPointerPayload = pointerPayload(event, outgoingDrag.node, undefined, outgoingDrag.rect);
    if (!pendingPointerMove) pendingPointerMove = requestAnimationFrame(sendPendingPointerMove);
  }, true);
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, (event) => {
    if (!enabled || !event.isTrusted || !outgoingDrag || event.pointerId !== outgoingDrag.pointerId) return;
    if (pendingPointerMove) cancelAnimationFrame(pendingPointerMove);
    if (outgoingDrag.started) {
      sendPendingPointerMove();
      send(type, pointerPayload(event, outgoingDrag.node, undefined, outgoingDrag.rect));
    }
    outgoingDrag = null;
  }, true);
  document.addEventListener('click', (event) => {
    if (!enabled || !event.isTrusted || event.button !== 0) return;
    send('click', { target: describe(event.target), x: event.clientX / innerWidth, y: event.clientY / innerHeight });
  }, true);
  document.addEventListener('keydown', (event) => {
    if (!enabled || !event.isTrusted || event.key !== 'Escape') return;
    send('keydown', {
      key: event.key,
      code: event.code,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });
  }, true);
  document.addEventListener('scroll', (event) => {
    if (!enabled || performance.now() < mutedUntil) return;
    const node = pageScroller(event.target) ? document.scrollingElement : event.target;
    if (!(node instanceof Element)) return;
    cancelAnimationFrame(pendingScroll);
    pendingScroll = requestAnimationFrame(() => {
      if (!enabled || performance.now() < mutedUntil) return;
      send('scroll', {
        target: pageScroller(node) ? null : describe(node),
        x: node.scrollLeft / Math.max(1, node.scrollWidth - node.clientWidth),
        y: node.scrollTop / Math.max(1, node.scrollHeight - node.clientHeight),
      });
    });
  }, true);
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parent || data?.channel !== channel) return;
    if (data.type === 'configure') {
      enabled = data.enabled === true;
      if (!enabled) {
        if (pendingPointerMove) cancelAnimationFrame(pendingPointerMove);
        pendingPointerMove = 0;
        pendingPointerPayload = null;
        outgoingDrag = null;
        incomingDrag = null;
      }
      return;
    }
    if (!enabled) return;
    if (data.type === 'pointerdown' && Number.isFinite(data.x) && Number.isFinite(data.y)) {
      const node = locate(data.target) || (Number.isFinite(data.viewportX) && Number.isFinite(data.viewportY)
        ? document.elementFromPoint(data.viewportX * innerWidth, data.viewportY * innerHeight) : null);
      if (!node) return;
      const ancestors = [];
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) ancestors.push(ancestor);
      incomingDrag = { node, ancestors, rect: node.getBoundingClientRect(), pointerId: Number.isFinite(data.pointerId) ? data.pointerId : 1, pointerType: data.pointerType || 'mouse', last: data };
      // Focusing the other iframe blurs the source and cancels its live gesture.
      if (!dispatchPointer('pointerdown', incomingDrag, data)) incomingDrag = null;
    } else if (['pointermove', 'pointerup', 'pointercancel'].includes(data.type)) {
      if (!incomingDrag || (Number.isFinite(data.pointerId) && data.pointerId !== incomingDrag.pointerId)) return;
      const finished = data.type === 'pointerup' || data.type === 'pointercancel';
      if (!dispatchPointer(data.type, incomingDrag, data) || finished) incomingDrag = null;
    } else if (data.type === 'scroll' && Number.isFinite(data.x) && Number.isFinite(data.y)) {
      const node = data.target ? locate(data.target) : document.scrollingElement;
      if (!node) return;
      cancelAnimationFrame(pendingScroll);
      mutedUntil = performance.now() + 200;
      node.scrollTo({ left: Math.max(0, Math.min(1, data.x)) * (node.scrollWidth - node.clientWidth), top: Math.max(0, Math.min(1, data.y)) * (node.scrollHeight - node.clientHeight), behavior: 'instant' });
    } else if (data.type === 'keydown' && data.key === 'Escape') {
      mutedUntil = performance.now() + 200;
      const node = document.activeElement instanceof Element ? document.activeElement : document;
      const allowed = node.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        composed: true,
        key: 'Escape',
        code: data.code || 'Escape',
        altKey: data.altKey === true,
        ctrlKey: data.ctrlKey === true,
        metaKey: data.metaKey === true,
        shiftKey: data.shiftKey === true,
      }));
      if (!allowed) return;
      const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
      if (dialog?.open && dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
    } else if (data.type === 'click' && Number.isFinite(data.x) && Number.isFinite(data.y)) {
      const node = locate(data.target) || document.elementFromPoint(data.x * innerWidth, data.y * innerHeight);
      if (!node) return;
      mutedUntil = performance.now() + 200;
      focusMirroredTarget(node);
      node.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: Math.max(0, Math.min(1, data.x)) * innerWidth,
        clientY: Math.max(0, Math.min(1, data.y)) * innerHeight,
        button: 0,
      }));
      dismissMirroredPopovers(node);
    }
  });
  for (const type of ['wheel', 'pointerdown', 'keydown']) document.addEventListener(type, (event) => { if (event.isTrusted) mutedUntil = 0; }, { capture: true, passive: true });
  send('ready');
})();

// Runs inside the local preview. All annotations live in a separate shadow tree.
(() => {
  const ready = () => parent.postMessage({ channel: 'acorn-preview-sync', type: 'overlay-ready' }, '*');
  if (window.__acornDiffOverlay) { ready(); return; }
  window.__acornDiffOverlay = true;
  let config = { enabled: false, locate: false, hints: [] };
  let host;
  let layer;
  let timer;
  let pending;
  let signature = '';
  function clear() {
    clearInterval(timer);
    cancelAnimationFrame(pending);
    host?.remove();
    host = layer = null;
    signature = '';
  }
  function draw() {
    if (!config.enabled && !config.locate) return;
    if (config.enabled && !host?.isConnected) {
      host = document.createElement('acorn-diff-overlay');
      host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;';
      host.setAttribute('aria-hidden', 'true');
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = '.change-label:hover { z-index: 2 !important; }';
      layer = document.createElement('div');
      shadow.append(style, layer);
      document.documentElement.append(host);
    }
    const matches = new Map();
    const locatedFiles = new Set();
    const locatableElements = (nodes) => [...nodes].filter((node) => node !== host && !['SCRIPT', 'STYLE', 'HEAD', 'LINK', 'META'].includes(node.tagName));
    const safeElements = (nodes) => [...nodes].filter((node) => node !== host && !['HTML', 'BODY', 'SCRIPT', 'STYLE', 'HEAD', 'LINK', 'META'].includes(node.tagName));
    let textIndex;
    for (const hint of config.hints) {
      try {
        let nodes = [];
        if (hint.kind === 'selector') nodes = document.querySelectorAll(hint.value);
        else if (hint.kind === 'attribute' && ['id', 'class', 'data-testid', 'aria-label'].includes(hint.attribute)) {
          const selector = hint.attribute === 'class'
            ? hint.value.trim().split(/\s+/).map((name) => `.${CSS.escape(name)}`).join('')
            : `[${hint.attribute}="${CSS.escape(hint.value)}"]`;
          nodes = document.querySelectorAll(selector);
        } else if (hint.kind === 'text') {
          if (!textIndex) {
            textIndex = new Map();
            for (const node of safeElements(document.querySelectorAll('body *'))) {
              if (node.children.length) continue;
              const text = node.textContent.trim();
              if (!textIndex.has(text)) textIndex.set(text, []);
              textIndex.get(text).push(node);
            }
          }
          nodes = textIndex.get(hint.value) || [];
          // Repeated text does not reliably identify a changed element.
          if (nodes.length !== 1) continue;
        }
        const locatedNodes = locatableElements(nodes);
        if (hint.file && locatedNodes.length) locatedFiles.add(hint.file);
        for (const node of safeElements(locatedNodes)) {
          if (matches.size >= 80 && !matches.has(node)) continue;
          const rect = node.getBoundingClientRect();
          if (!rect.width || !rect.height || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth || getComputedStyle(node).visibility === 'hidden') continue;
          const match = matches.get(node) || { rect, files: new Set(), changes: new Set() };
          if (hint.file) match.files.add(hint.file);
          for (const property of hint.changes || []) {
            if (typeof property === 'string' && /^(?:--)?[a-zA-Z][\w-]*$/.test(property)) match.changes.add(property);
          }
          matches.set(node, match);
        }
      } catch { /* Unsupported selectors or source expressions have no overlay. */ }
    }
    const rectangles = [...matches.values()].map(({ rect, files, changes }) => ({ changes: [...changes].sort(), left: Math.max(0, rect.left), top: Math.max(0, rect.top), width: Math.min(innerWidth, rect.right) - Math.max(0, rect.left), height: Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top), files: [...files] }));
    const matchedFiles = [...locatedFiles];
    const nextSignature = JSON.stringify([rectangles, matchedFiles, config.color, config.theme, config.version, innerWidth, innerHeight]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    if (config.enabled) {
      const color = CSS.supports('color', config.color) ? config.color : '#6810e8';
      const light = config.theme === 'light';
      const labels = [];
      layer.replaceChildren(...rectangles.map((rect) => {
        const box = document.createElement('div');
        box.style.cssText = `position:fixed;box-sizing:border-box;pointer-events:none;border:2px dashed color-mix(in srgb, ${color} ${light ? 45 : 100}%, transparent);background:color-mix(in srgb, ${color} ${light ? 3 : 8}%, transparent);border-radius:4px;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
        if (!rect.changes.length) return box;
        const label = document.createElement('span');
        label.className = 'change-label';
        label.textContent = rect.changes.join(', ');
        label.title = label.textContent;
        label.style.cssText = `position:fixed;z-index:1;pointer-events:auto;box-sizing:border-box;top:${Math.max(0, rect.top - 18)}px;left:${rect.left}px;width:max-content;max-width:${Math.max(0, Math.min(400, innerWidth - 8))}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:${color};color:white;font:10px/16px system-ui;padding:0 4px;border-radius:0 0 3px 0;`;
        labels.push(label);
        return box;
      }));
      // Labels share one stacking context, above every highlighted region.
      layer.append(...labels);
      const placed = [];
      for (const label of labels) {
        const measured = label.getBoundingClientRect();
        const maxLeft = Math.max(0, innerWidth - measured.width);
        const preferredLeft = Math.max(0, Math.min(measured.left, maxLeft));
        const maxTop = Math.max(0, innerHeight - measured.height);
        const preferredTop = Math.min(measured.top, maxTop);
        const overlaps = placed.filter((other) => preferredLeft < other.right && preferredLeft + measured.width > other.left
          && preferredTop < other.bottom && preferredTop + measured.height > other.top);
        // Keep labels attached to their region; expose a small edge for hovering.
        const offset = Math.min(12, overlaps.length * 4);
        const left = Math.max(0, preferredLeft + (preferredLeft + offset <= maxLeft ? offset : -offset));
        const top = Math.max(0, preferredTop + (preferredTop + offset <= maxTop ? offset : -offset));
        label.style.left = `${left}px`;
        label.style.top = `${top}px`;
        placed.push({ left, right: left + measured.width, top, bottom: top + measured.height });
      }
    }
    parent.postMessage({ channel: 'acorn-preview-sync', type: 'overlay-status', version: config.version, requestId: config.requestId, count: rectangles.length, matchedFiles }, '*');
  }
  function schedule() { cancelAnimationFrame(pending); pending = requestAnimationFrame(draw); }
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.channel !== 'acorn-preview-sync' || event.data.type !== 'diff-overlay') return;
    clear();
    config = { ...event.data, hints: Array.isArray(event.data.hints) ? event.data.hints.slice(0, 500) : [] };
    if (config.enabled || config.locate) draw();
    if (config.enabled) timer = setInterval(schedule, 500);
  });
  document.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('pagehide', clear);
  ready();
})();

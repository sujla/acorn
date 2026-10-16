const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');


function fixture() {
  const element = (height) => ({
    dataset: {},
    offsetHeight: height,
    style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
  });
  const elements = { 'diff-progress': element(38), toast: element(34) };
  const sidebar = { collapsed: false };
  const context = vm.createContext({
    shell: { classList: { contains: () => sidebar.collapsed } },
    get: id => elements[id],
    window: { requestAnimationFrame: callback => callback() },
  });
  const start = appSource.indexOf('let toastAlertSequence = 0;');
  const end = appSource.indexOf('function notify(', start);
  vm.runInContext(appSource.slice(start, end), context);
  return { context, elements, sidebar };
}

test('toast alerts start at 96px and the newest alert pushes the earlier alert up by 6px', () => {
  assert.match(styles, /inset: auto auto var\(--toast-bottom, 96px\)/);
  const { context, elements } = fixture();
  context.setToastAlertVisible(elements['diff-progress'], true);
  assert.equal(elements['diff-progress'].style.values['--toast-bottom'], '96px');

  context.setToastAlertVisible(elements.toast, true, { bringToFront: true });
  assert.equal(elements.toast.style.values['--toast-bottom'], '96px');
  assert.equal(elements['diff-progress'].style.values['--toast-bottom'], '136px');

  context.setToastAlertVisible(elements.toast, false);
  assert.equal(elements['diff-progress'].style.values['--toast-bottom'], '96px');
});

test('a later diff alert moves an existing general alert above it', () => {
  const { context, elements } = fixture();
  context.setToastAlertVisible(elements.toast, true, { bringToFront: true });
  context.setToastAlertVisible(elements['diff-progress'], true);
  assert.equal(elements['diff-progress'].style.values['--toast-bottom'], '96px');
  assert.equal(elements.toast.style.values['--toast-bottom'], '140px');
});


test('visible toasts keep a 96px bottom offset in both sidebar states', () => {
  const { context, elements, sidebar } = fixture();
  context.setToastAlertVisible(elements.toast, true);
  context.setToastAlertVisible(elements['diff-progress'], true);
  sidebar.collapsed = true;
  context.layoutToastAlerts();
  assert.equal(elements['diff-progress'].style.values['--toast-bottom'], '96px');
  assert.equal(elements.toast.style.values['--toast-bottom'], '140px');
  sidebar.collapsed = false;
  context.layoutToastAlerts();
  assert.equal(elements['diff-progress'].style.values['--toast-bottom'], '96px');
  assert.equal(elements.toast.style.values['--toast-bottom'], '140px');
});

function notificationFixture() {
  const timers = new Map();
  let timerId = 0;
  const element = () => {
    const classes = new Set();
    return {
      dataset: {}, children: [], attributes: {}, events: {}, offsetHeight: 40,
      style: { setProperty() {} },
      classList: {
        add: value => classes.add(value), remove: value => classes.delete(value),
        toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
        contains: value => classes.has(value),
      },
      setAttribute(key, value) { this.attributes[key] = value; },
      append(...children) { this.children.push(...children); },
      addEventListener(key, callback) { this.events[key] = callback; },
      showPopover() { this.open = true; }, hidePopover() { this.open = false; },
      matches() { return Boolean(this.open); }, remove() { this.removed = true; },
    };
  };
  const elements = { toast: element(), 'diff-progress': element() };
  const document = { createElement: element, body: element() };
  const context = vm.createContext({
    toast: elements.toast, get: id => elements[id], document,
    window: {
      requestAnimationFrame: callback => callback(),
      clearTimeout: id => timers.delete(id),
      setTimeout(callback, duration) { const id = ++timerId; timers.set(id, { callback, duration }); return id; },
    },
  });
  vm.runInContext(appSource.slice(appSource.indexOf('const toastDuration ='), appSource.indexOf('let previewRefresh =')), context);
  vm.runInContext(appSource.slice(appSource.indexOf('let toastAlertSequence ='), appSource.indexOf("window.addEventListener('acorn:notify'")), context);
  const fire = (id) => { const timer = timers.get(id); timers.delete(id); timer.callback(); };
  return { context, elements, timers, fire };
}

test('short notifications expire after three seconds', () => {
  const { context, elements, timers, fire } = notificationFixture();
  context.notify('Saved');
  assert.equal(elements.toast.textContent, 'Saved');
  assert.equal([...timers.values()][0].duration, 3000);
  fire([...timers.keys()][0]);
  assert.equal(elements.toast.open, false);
  assert.equal(elements.toast.dataset.toastVisible, undefined);
});

test('title and body notifications without a close button expire after six seconds', () => {
  const { context, timers, fire } = notificationFixture();
  const alert = context.notify('<reason>', { title: 'Preview unavailable' });
  assert.equal(alert.children.length, 1);
  assert.equal(alert.children[0].children[0].textContent, 'Preview unavailable');
  assert.equal(alert.children[0].children[1].textContent, '<reason>');
  assert.equal([...timers.values()][0].duration, 6000);
  fire([...timers.keys()][0]);
  assert.equal(alert.open, false);
  assert.equal(alert.removed, undefined);
  fire([...timers.keys()][0]);
  assert.equal(alert.removed, true);
});

test('dismissible descriptions persist across new notifications until their own close button is clicked', () => {
  const { context, timers, fire } = notificationFixture();
  const first = context.notify('Reason one', { title: 'Base preview unavailable', dismissible: true });
  const second = context.notify('Reason two', { title: 'Target preview unavailable', dismissible: true });
  assert.equal(timers.size, 0);
  context.notify('Saved');
  fire([...timers.keys()][0]);
  assert.equal(first.open, true);
  assert.equal(second.open, true);
  const close = first.children[1];
  assert.equal(close.attributes['aria-label'], 'Dismiss notification');
  assert.match(close.innerHTML, /class="ui-icon"/);
  assert.match(close.innerHTML, /d="m6 6 12 12M18 6 6 18"/);
  close.events.click();
  assert.equal(first.open, false);
  assert.equal(second.open, true);
  fire([...timers.keys()][0]);
  assert.equal(first.removed, true);
});

test('detail notifications can expose a text action', () => {
  const { context } = notificationFixture();
  let received;
  const alert = context.notify('Compiler missing', {
    title: 'Preview unavailable', dismissible: true,
    action: { label: 'Install preview compiler', onClick: value => { received = value; } },
  });
  const action = alert.children[0].children[2];
  assert.equal(action.textContent, 'Install preview compiler');
  assert.equal(action.type, 'button');
  action.events.click();
  assert.equal(received.button, action);
  assert.equal(typeof received.close, 'function');
});

test('a missing Git root appears in the existing modal error area', async () => {
  const notices = [];
  const connectionError = { textContent: '' };
  const context = vm.createContext({
    notify: (message, options) => notices.push({ message, options }),
    get: id => id === 'connection-error' ? connectionError : null,
  });
  const start = appSource.indexOf('async function addConnection(');
  const end = appSource.indexOf('async function loadMoreCommits(', start);
  vm.runInContext(appSource.slice(start, end), context);
  await context.addConnection({ error: 'Could not find a git root for this project' });
  assert.equal(notices.length, 0);
  assert.equal(connectionError.textContent, 'Could not find a git root for this project');
});


test('missing data requests across both previews produce one informational notice per project', () => {
  const notices = [];
  const context = vm.createContext({ notify: (message, options) => notices.push({ message, options }) });
  const start = appSource.indexOf('const notifiedPreviewDataProjects = new Set();');
  const end = appSource.indexOf("window.addEventListener('message'", start);
  vm.runInContext(appSource.slice(start, end), context);
  for (let index = 0; index < 100; index++) context.notifyMissingPreviewData('/project/expo');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].options.dismissible, undefined, 'Notice expires normally');
  assert.equal(notices[0].options.tone, undefined, 'Missing external data is not a build error');
  context.notifyMissingPreviewData('/project/other');
  context.notifyMissingPreviewData('/project/expo');
  assert.equal(notices.length, 2);
});

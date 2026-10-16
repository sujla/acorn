const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/preview-sync.js'), 'utf8');

function harness() {
  const messages = [];
  const documentListeners = {};
  const windowListeners = {};
  const frames = new Map();
  let nextFrame = 1;
  class MockElement {
    constructor(id, rect) {
      this.id = id;
      this.localName = 'div';
      this.textContent = '';
      this.rect = rect;
      this.events = [];
      this.attributes = {};
      this.isConnected = true;
    }
    closest(selector) {
      if (selector.includes('[contenteditable]') || selector.includes('[role="textbox"]')) {
        return ['input', 'textarea', 'select'].includes(this.localName) ? this : null;
      }
      return this;
    }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    getBoundingClientRect() { return this.rect; }
    dispatchEvent(event) { this.events.push(event); return true; }
    focus() { this.focused = true; }
    matches(selector) { return selector === ':popover-open' && this.popoverOpen === true; }
    contains(node) { return node === this; }
    hidePopover() { this.popoverOpen = false; }
  }
  class MockPointerEvent {
    constructor(type, init) { this.type = type; Object.assign(this, init); }
  }
  const root = new MockElement('', { left: 0, top: 0, width: 1000, height: 800 });
  root.children = [];
  const sourceNode = new MockElement('source', { left: 100, top: 50, width: 200, height: 100 });
  const targetNode = new MockElement('target', { left: 20, top: 30, width: 400, height: 200 });
  const popoverNode = new MockElement('popover', { left: 200, top: 100, width: 300, height: 400 });
  popoverNode.attributes.popover = '';
  for (const node of [sourceNode, targetNode]) { node.parentElement = root; root.children.push(node); }
  const nodes = { '#source': sourceNode, '#target': targetNode };
  const parent = { postMessage: message => messages.push(message) };
  const document = {
    documentElement: root,
    body: root,
    scrollingElement: root,
    activeElement: targetNode,
    addEventListener(type, listener) { (documentListeners[type] ||= []).push(listener); },
    querySelector: selector => nodes[selector] || null,
    querySelectorAll: selector => {
      if (selector === '[popover]') return [popoverNode];
      return selector === 'dialog[open]' && targetNode.localName === 'dialog' && targetNode.open ? [targetNode] : [];
    },
    elementFromPoint: () => targetNode,
  };
  const window = { addEventListener(type, listener) { (windowListeners[type] ||= []).push(listener); } };
  const context = vm.createContext({
    CSS: { escape: value => value },
    Element: MockElement,
    Event: MockPointerEvent,
    KeyboardEvent: MockPointerEvent,
    MouseEvent: MockPointerEvent,
    PointerEvent: MockPointerEvent,
    URL,
    cancelAnimationFrame: id => frames.delete(id),
    document,
    innerHeight: 800,
    innerWidth: 1000,
    parent,
    performance: { now: () => 100 },
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    window,
  });
  vm.runInContext(source, context);
  const fireDocument = (type, event) => documentListeners[type].forEach(listener => listener(event));
  const fireMessage = data => windowListeners.message.forEach(listener => listener({ source: parent, data }));
  return { messages, sourceNode, targetNode, popoverNode, fireDocument, fireMessage };
}

test('trusted pointer drag is normalized to its starting element and sent in order', () => {
  const h = harness();
  h.fireMessage({ channel: 'acorn-preview-sync', type: 'configure', enabled: true });
  const event = (clientX, clientY, buttons) => ({
    target: h.sourceNode, clientX, clientY, buttons, button: 0, pointerId: 7,
    pointerType: 'mouse', isPrimary: true, isTrusted: true,
  });
  h.fireDocument('pointerdown', event(150, 75, 1));
  h.fireDocument('pointermove', event(250, 125, 1));
  h.fireDocument('pointerup', event(250, 125, 0));

  const drag = h.messages.filter(message => message.type.startsWith('pointer'));
  assert.deepEqual(drag.map(message => message.type), ['pointerdown', 'pointermove', 'pointerup']);
  assert.equal(drag[0].target.selector, '#source');
  assert.equal(drag[0].x, 0.25);
  assert.equal(drag[0].y, 0.25);
  assert.equal(drag[1].x, 0.75);
  assert.equal(drag[1].y, 0.75);
});

test('a simple click waits until click before it touches the mirrored preview', () => {
  const h = harness();
  h.fireMessage({ channel: 'acorn-preview-sync', type: 'configure', enabled: true });
  const event = {
    target: h.sourceNode, clientX: 150, clientY: 75, buttons: 0, button: 0,
    pointerId: 7, pointerType: 'mouse', isPrimary: true, isTrusted: true,
  };
  h.fireDocument('pointerdown', { ...event, buttons: 1 });
  h.fireDocument('pointerup', event);
  h.fireDocument('click', event);

  assert.deepEqual(h.messages.filter(message => ['pointerdown', 'pointerup', 'click'].includes(message.type)).map(message => message.type), ['click']);
});

test('incoming drag stays on the located target and scales relative coordinates', () => {
  const h = harness();
  h.fireMessage({ channel: 'acorn-preview-sync', type: 'configure', enabled: true });
  const base = { channel: 'acorn-preview-sync', target: { selector: '#target' }, pointerId: 4, pointerType: 'mouse', isPrimary: true };
  h.fireMessage({ ...base, type: 'pointerdown', x: 0.25, y: 0.5, button: 0, buttons: 1 });
  h.fireMessage({ channel: base.channel, type: 'pointermove', pointerId: 4, x: 1.25, y: 0.75, button: -1, buttons: 1 });
  h.fireMessage({ channel: base.channel, type: 'pointerup', pointerId: 4, x: 1.25, y: 0.75, button: 0, buttons: 0 });

  assert.deepEqual(h.targetNode.events.map(event => event.type), ['pointerdown', 'mousedown', 'pointermove', 'mousemove', 'pointerup', 'mouseup']);
  assert.equal(h.targetNode.events[0].clientX, 120);
  assert.equal(h.targetNode.events[0].clientY, 130);
  assert.equal(h.targetNode.events[2].clientX, 520);
  assert.equal(h.targetNode.events[2].clientY, 180);
  assert.equal(h.targetNode.focused, undefined);
});

test('incoming interaction does not move focus to the mirrored form control', () => {
  const h = harness();
  h.targetNode.localName = 'input';
  h.fireMessage({ channel: 'acorn-preview-sync', type: 'configure', enabled: true });
  const target = { selector: '#target' };

  h.fireMessage({ channel: 'acorn-preview-sync', type: 'pointerdown', target, pointerId: 5, pointerType: 'mouse', x: 0.5, y: 0.5, button: 0, buttons: 1 });
  h.fireMessage({ channel: 'acorn-preview-sync', type: 'pointerup', pointerId: 5, x: 0.5, y: 0.5, button: 0, buttons: 0 });
  h.fireMessage({ channel: 'acorn-preview-sync', type: 'click', target, x: 0.5, y: 0.5 });

  assert.deepEqual(h.targetNode.events.map(event => event.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  assert.equal(h.targetNode.focused, undefined);
  assert.equal(h.targetNode.events[4].clientX, 500);
  assert.equal(h.targetNode.events[4].clientY, 400);
});

test('Escape is mirrored and closes an unhandled native dialog', () => {
  const h = harness();
  h.targetNode.localName = 'dialog';
  h.targetNode.open = true;
  h.targetNode.close = () => { h.targetNode.open = false; };
  h.fireMessage({ channel: 'acorn-preview-sync', type: 'configure', enabled: true });

  h.fireDocument('keydown', { key: 'Escape', code: 'Escape', isTrusted: true });
  assert.equal(h.messages.at(-1).type, 'keydown');
  assert.equal(h.messages.at(-1).key, 'Escape');

  h.fireMessage({ channel: 'acorn-preview-sync', type: 'keydown', key: 'Escape', code: 'Escape' });
  assert.deepEqual(h.targetNode.events.map(event => event.type), ['keydown', 'cancel']);
  assert.equal(h.targetNode.open, false);
});

test('an outside mirrored click light-dismisses an automatic popover', () => {
  const h = harness();
  h.popoverNode.popoverOpen = true;
  h.fireMessage({ channel: 'acorn-preview-sync', type: 'configure', enabled: true });

  h.fireMessage({ channel: 'acorn-preview-sync', type: 'click', target: { selector: '#target' }, x: 0.8, y: 0.8 });

  assert.equal(h.popoverNode.popoverOpen, false);
  assert.equal(h.targetNode.events.at(-1).type, 'click');
});

test('pointer cancellation releases mirrored mouse listeners without a click', () => {
  const h = harness();
  h.fireMessage({ channel: 'acorn-preview-sync', type: 'configure', enabled: true });
  const drag = { channel: 'acorn-preview-sync', target: { selector: '#target' }, pointerId: 1, pointerType: 'mouse', x: 0.5, y: 0.5 };
  h.fireMessage({ ...drag, type: 'pointerdown', buttons: 1 });
  h.fireMessage({ ...drag, type: 'pointercancel', buttons: 1 });
  assert.deepEqual(h.targetNode.events.map(event => event.type), ['pointerdown', 'mousedown', 'pointercancel', 'mouseup']);
  assert.equal(h.targetNode.events.at(-1).buttons, 0);
});

test('prevented pointerdown suppresses compatibility mouse events', () => {
  const h = harness();
  h.targetNode.dispatchEvent = event => { h.targetNode.events.push(event); return event.type !== 'pointerdown'; };
  h.fireMessage({ channel: 'acorn-preview-sync', type: 'configure', enabled: true });
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) h.fireMessage({
    channel: 'acorn-preview-sync', target: { selector: '#target' }, type, pointerId: 1, pointerType: 'mouse', x: 0.5, y: 0.5,
  });
  assert.deepEqual(h.targetNode.events.map(event => event.type), ['pointerdown', 'pointermove', 'pointerup']);
});

test('touch pointers do not also produce mouse gestures', () => {
  const h = harness();
  h.fireMessage({ channel: 'acorn-preview-sync', type: 'configure', enabled: true });
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) h.fireMessage({
    channel: 'acorn-preview-sync', target: { selector: '#target' }, type, pointerId: 1, pointerType: 'touch', x: 0.5, y: 0.5,
  });
  assert.deepEqual(h.targetNode.events.map(event => event.type), ['pointerdown', 'pointermove', 'pointerup']);
});

test('outgoing drag retains its start geometry when the original child disappears', () => {
  const h = harness();
  h.fireMessage({ channel: 'acorn-preview-sync', type: 'configure', enabled: true });
  const event = { target: h.sourceNode, clientX: 150, clientY: 75, button: 0, buttons: 1, pointerId: 7, pointerType: 'mouse', isTrusted: true };
  h.fireDocument('pointerdown', event);
  h.sourceNode.rect = { left: 0, top: 0, width: 0, height: 0 };
  h.sourceNode.isConnected = false;
  h.fireDocument('pointermove', { ...event, clientX: 250, clientY: 125 });
  h.fireDocument('pointerup', { ...event, clientX: 250, clientY: 125, buttons: 0 });
  const move = h.messages.find(message => message.type === 'pointermove');
  assert.equal(move.x, 0.75);
  assert.equal(move.y, 0.75);
});

test('mirrored release reaches the surviving ancestor after a child is replaced', () => {
  const h = harness();
  h.fireMessage({ channel: 'acorn-preview-sync', type: 'configure', enabled: true });
  const drag = { channel: 'acorn-preview-sync', target: { selector: '#target' }, pointerId: 1, pointerType: 'mouse', x: 0.5, y: 0.5 };
  h.fireMessage({ ...drag, type: 'pointerdown', buttons: 1 });
  h.targetNode.isConnected = false;
  h.targetNode.rect = { left: 0, top: 0, width: 0, height: 0 };
  h.fireMessage({ ...drag, type: 'pointermove', x: 0.75, buttons: 1 });
  h.fireMessage({ ...drag, type: 'pointerup', x: 0.75, buttons: 0 });
  const events = h.targetNode.parentElement.events;
  assert.deepEqual(events.map(event => event.type), ['pointermove', 'mousemove', 'pointerup', 'mouseup']);
  assert.equal(events.at(-1).clientX, 320);
  assert.equal(events.at(-1).clientY, 130);
});

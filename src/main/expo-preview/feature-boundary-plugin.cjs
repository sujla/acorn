const path = require('node:path');
// Boundaries belong around component elements, not native DOM nodes. Transform
// project JSX only; never rewrite dependencies or execute project plugins.
module.exports = function ({ types: t }) {
  return { visitor: {
    Program: { enter(p, state) {
      const filename = state.filename || '';
      state.acornBoundary = null;
      if (!filename.includes(`${path.sep}node_modules${path.sep}`) && !filename.startsWith(__dirname + path.sep)) state.acornBoundary = p.scope.generateUidIdentifier('AcornFeatureBoundary');
    }, exit(p, state) {
      if (state.acornBoundaryUsed) p.unshiftContainer('body', t.importDeclaration([t.importSpecifier(state.acornBoundary, t.identifier('FeatureBoundary'))], t.stringLiteral(path.join(__dirname, 'feature-boundary.js'))));
    } },
    JSXElement: { exit(p, state) {
      if (!state.acornBoundary || p.node.__acornBoundary) return;
      const name = p.node.openingElement.name;
      // Navigation declarations and context members require their original child types.
      const label = t.isJSXIdentifier(name) ? name.name : null;
      if (!label || !/^[A-Z]/.test(label) || /^(Fragment|Screen|Group|Route|Slot|Stack|Tabs|Drawer|Navigator|Provider|Consumer|Suspense)$/.test(label)) return;
      const parent = p.parentPath;
      if (parent.isJSXElement() && parent.node.openingElement.attributes.some(a => t.isJSXAttribute(a) && a.name.name === 'asChild' && (!a.value || !t.isJSXExpressionContainer(a.value) || !t.isBooleanLiteral(a.value.expression, { value: false })))) return;
      state.acornBoundaryUsed = true;
      const key = p.node.openingElement.attributes.find(a => t.isJSXAttribute(a) && a.name.name === 'key');
      const attrs = [t.jsxAttribute(t.jsxIdentifier('feature'), t.stringLiteral(label))];
      if (key) { attrs.push(t.cloneNode(key, true)); p.node.openingElement.attributes = p.node.openingElement.attributes.filter(a => a !== key); }
      const id = t.jsxIdentifier(state.acornBoundary.name);
      p.node.__acornBoundary = true;
      const wrapper = t.jsxElement(t.jsxOpeningElement(id, attrs), t.jsxClosingElement(id), [p.node], false);
      wrapper.__acornBoundary = true; p.replaceWith(wrapper); p.skip();
    } },
  } };
};

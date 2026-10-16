const { parse } = require('@babel/parser');

// Automatic fallback is limited to guards that the existing Expo hook adapter
// can supply state for. A redirect or a loading flag alone is not evidence.
function supportsVisualFallback(source) {
  let ast;
  try { ast = parse(source, { sourceType: 'unambiguous', plugins: ['jsx', 'typescript'] }); }
  catch { return false; }
  const redirects = new Set();
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== 'expo-router') continue;
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.imported.name === 'Redirect') redirects.add(specifier.local.name);
    }
  }
  const keys = new Set(['account', 'user', 'session', 'profile', 'authenticated', 'isAuthenticated', 'consent']);
  let state = false;
  let redirect = false;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'JSXOpeningElement' && node.name.type === 'JSXIdentifier' && redirects.has(node.name.name)) redirect = true;
    if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern'
      && node.init?.type === 'CallExpression' && node.init.callee.type === 'Identifier'
      && /^use[A-Z]/.test(node.init.callee.name)
      && node.id.properties.some(property => property.type === 'ObjectProperty' && keys.has(property.key.name))) state = true;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast.program);
  return state && redirect;
}

module.exports = { supportsVisualFallback };

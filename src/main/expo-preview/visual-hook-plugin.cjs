module.exports = function visualHookPlugin({ types: t }) {
  const stateKeys = new Set(['account', 'user', 'session', 'profile', 'ready', 'loading', 'isLoading', 'authenticated', 'isAuthenticated', 'consent', 'restoreError']);
  return {
    name: 'acorn-visual-hook-state',
    visitor: {
      VariableDeclarator(path) {
        if (!t.isObjectPattern(path.node.id) || !t.isCallExpression(path.node.init) || !t.isIdentifier(path.node.init.callee)) return;
        const hook = path.node.init.callee.name;
        if (!/^use[A-Z]/.test(hook)) return;
        const keys = path.node.id.properties
          .filter(property => t.isObjectProperty(property) && t.isIdentifier(property.key))
          .map(property => property.key.name);
        if (!keys.some(key => stateKeys.has(key))) return;
        const hookName = t.identifier('_hook');
        const hookValue = t.identifier('_value');
        path.node.init = t.callExpression(
          t.logicalExpression('||',
            t.memberExpression(t.identifier('globalThis'), t.identifier('__ACORN_VISUAL_HOOK__')),
            t.arrowFunctionExpression([hookName, hookValue], hookValue),
          ),
          [t.stringLiteral(hook), path.node.init, t.arrayExpression(keys.map(key => t.stringLiteral(key)))],
        );
      },
    },
  };
};

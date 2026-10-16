const fs = require('node:fs/promises');
const path = require('node:path');

async function loadPathAliases(root) {
  let config;
  try { config = JSON.parse(await fs.readFile(path.join(root, 'tsconfig.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return [];
    throw error;
  }
  const compiler = config.compilerOptions || {};
  const base = path.resolve(root, compiler.baseUrl || '.');
  const aliases = [];
  for (const [pattern, targets] of Object.entries(compiler.paths || {})) {
    if (!Array.isArray(targets) || !targets.length) continue;
    const star = pattern.indexOf('*');
    if (star !== pattern.lastIndexOf('*')) continue;
    for (const target of targets) {
      if (typeof target !== 'string' || target.indexOf('*') !== target.lastIndexOf('*')) continue;
      aliases.push({ pattern, prefix: star < 0 ? pattern : pattern.slice(0, star), suffix: star < 0 ? '' : pattern.slice(star + 1), target, base });
    }
  }
  return aliases.sort((a, b) => b.pattern.length - a.pattern.length);
}

function resolvePathAlias(aliases, name, root) {
  for (const alias of aliases) {
    const star = alias.pattern.includes('*');
    if ((!star && name !== alias.pattern) || (star && (!name.startsWith(alias.prefix) || !name.endsWith(alias.suffix)))) continue;
    const value = star ? name.slice(alias.prefix.length, name.length - alias.suffix.length) : '';
    const target = path.resolve(alias.base, alias.target.replace('*', value));
    if (target === root || target.startsWith(root + path.sep)) return target;
  }
  return null;
}

module.exports = { loadPathAliases, resolvePathAlias };

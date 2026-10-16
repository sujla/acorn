const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function validComparisons(items) {
  const ids = new Set();
  return Array.isArray(items) && items.every(item => {
    if (!item || !['id', 'base', 'target'].every(key => typeof item[key] === 'string' && item[key])
      || ids.has(item.id) || (item.name !== undefined && typeof item.name !== 'string')) return false;
    ids.add(item.id);
    return true;
  });
}

function comparisonStore(root) {
  const fileFor = repositoryPath => {
    if (typeof repositoryPath !== 'string' || !path.isAbsolute(repositoryPath)) throw new Error('Invalid repository path.');
    return path.join(root, 'comparisons', `${createHash('sha256').update(repositoryPath).digest('hex')}.json`);
  };
  return {
    read(repositoryPath) {
      let content;
      try { content = fs.readFileSync(fileFor(repositoryPath), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      const items = JSON.parse(content);
      if (!validComparisons(items)) throw new Error('Saved comparisons are invalid.');
      return items;
    },
    write(repositoryPath, items) {
      if (!validComparisons(items)) throw new Error('Invalid comparisons.');
      const file = fileFor(repositoryPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        // Complete the small write before acknowledging it, including immediate quit/reload.
        fs.writeFileSync(temporary, JSON.stringify(items), { mode: 0o600, flush: true });
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
    },
    remove(repositoryPath) {
      fs.rmSync(fileFor(repositoryPath), { force: true });
    },
  };
}

module.exports = { comparisonStore };

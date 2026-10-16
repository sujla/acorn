function repositoryRecord(value) {
  if (typeof value === 'string' && value) return { path: value };
  if (!value || typeof value.path !== 'string' || !value.path) return null;
  return { path: value.path };
}

function repositoryRecords(value) {
  return Array.isArray(value) ? value.map(repositoryRecord).filter(Boolean) : [];
}

function saveRecord(records, repositoryPath) {
  return [{ path: repositoryPath }, ...records.filter(item => item.path !== repositoryPath)];
}

function reorderRecords(records, repositoryPaths) {
  const requested = Array.isArray(repositoryPaths) ? repositoryPaths : [];
  const byPath = new Map(records.map(record => [record.path, record]));
  const ordered = [...new Set(requested)].filter(repositoryPath => byPath.has(repositoryPath)).map(repositoryPath => byPath.get(repositoryPath));
  const included = new Set(ordered.map(record => record.path));
  return [...ordered, ...records.filter(record => !included.has(record.path))];
}

module.exports = { repositoryRecord, repositoryRecords, saveRecord, reorderRecords };

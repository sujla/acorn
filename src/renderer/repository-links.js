// Normalize GitHub origin URLs for the metadata label and native open action.
function githubRepository(remote) {
  const input = String(remote || '').trim();
  const normalized = input.replace(/^git@github\.com:/i, 'https://github.com/');
  try {
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() !== 'github.com' || !['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    const parts = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
    if (parts.length !== 2 || parts.some(part => !/^[\w.-]+$/.test(part) || ['.', '..'].includes(part))) return null;
    return { name: parts.join('/'), url: `https://github.com/${parts.join('/')}` };
  } catch { return null; }
}
if (typeof module !== 'undefined') module.exports = { githubRepository };

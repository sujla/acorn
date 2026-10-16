const https = require('node:https');
const dns = require('node:dns/promises');
function publicIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a,b,c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2 && c === 0))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
function dataUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid data address.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Only public HTTPS data sources are supported.');
  url.hash = '';
  return url;
}
async function readPublicJson(url, { resolve = hostname => dns.resolve4(hostname), request = https.request } = {}) {
  const addresses = await resolve(url.hostname);
  if (!addresses.length || addresses.some(address => !publicIPv4(address))) throw new Error('Private or local data sources are not supported.');
  return new Promise((resolveResult, reject) => {
    let size = 0;
    const chunks = [];
    const req = request(url, {
      method: 'GET', agent: false,
      // Pin the checked address for this connection, preserving the TLS hostname.
      lookup: (_hostname, options, callback) => callback(null, options?.all ? [{ address: addresses[0], family: 4 }] : addresses[0], 4),
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
    }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); reject(new Error(`Data source returned HTTP ${response.statusCode}; redirects are not followed.`)); return; }
      if (!/(?:application\/(?:[\w.-]+\+)?json|text\/plain)\b/i.test(response.headers['content-type'] || '')) { response.resume(); reject(new Error('The source did not return JSON.')); return; }
      response.on('data', chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) { req.destroy(new Error('Data response exceeds 32 MB.')); return; } chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try { const body = Buffer.concat(chunks).toString('utf8'); JSON.parse(body); resolveResult({ body, status: response.statusCode, fetchedAt: new Date().toISOString() }); }
        catch { reject(new Error('The source returned invalid JSON.')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Data request timed out.')), 20000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
}
function createPreviewData({ read = readPublicJson, automatic = false } = {}) {
  const projects = new Map();
  const state = project => {
    if (!projects.has(project)) projects.set(project, { sources: new Map(), automatic, blocked: new Set(), allowed: new Set(), cache: new Map(), bytes: 0, successes: 0, errors: new Map(), refreshedAt: null });
    return projects.get(project);
  };
  const allowed = (s, origin) => s.automatic ? !s.blocked.has(origin) : s.allowed.has(origin);
  return {
    status(project) {
      const s = state(project);
      return { automatic: s.automatic, sources: [...s.sources].map(([origin, requests]) => ({ origin, requests: requests.size, allowed: allowed(s, origin), error: s.errors.get(origin) || null })), cached: s.successes, refreshedAt: s.refreshedAt };
    },
    allow(project, origins, automatic = false) {
      const s = state(project);
      if (!Array.isArray(origins) || origins.some(origin => !s.sources.has(origin))) throw new Error('Choose a detected data source.');
      if (typeof automatic !== 'boolean') throw new Error('Invalid automatic data setting.');
      s.automatic = automatic;
      s.allowed = new Set(origins);
      s.blocked = new Set([...s.sources.keys()].filter(origin => !s.allowed.has(origin)));
      return this.status(project);
    },
    refresh(project) { const s = state(project); s.cache = new Map(); s.bytes = 0; s.successes = 0; s.errors.clear(); s.refreshedAt = new Date().toISOString(); return this.status(project); },
    remove(project) { return projects.delete(project); },
    async get(project, value, method = 'GET') {
      if (method !== 'GET') return { error: 'Only read requests are supported.' };
      let url;
      try { url = dataUrl(value); } catch (error) { return { error: error.message }; }
      const s = state(project);
      if (!s.sources.has(url.origin)) {
        if (s.sources.size >= 32) return { error: 'Too many data sources.' };
        s.sources.set(url.origin, new Set());
      }
      const requests = s.sources.get(url.origin);
      if (requests.size < 128) requests.add(url.href);
      if (!allowed(s, url.origin)) return { needsPermission: true, error: 'Allow this source in Preview Data.' };
      const cache = s.cache;
      if (!cache.has(url.href)) {
        if (cache.size >= 128) return { error: 'Data snapshot is full. Refresh data to start a new snapshot.' };
        cache.set(url.href, Promise.resolve().then(() => read(url)).then(response => {
          if (cache !== s.cache) return { error: 'Data was refreshed. Reload this preview.' };
          const bytes = Buffer.byteLength(response.body);
          if (s.bytes + bytes > 128 * 1024 * 1024) return { error: 'Data snapshot exceeds 128 MB.' };
          s.bytes += bytes; s.successes++;
          s.errors.delete(url.origin);
          s.refreshedAt ||= response.fetchedAt || new Date().toISOString();
          return response;
        }).catch(error => { if (cache === s.cache) s.errors.set(url.origin, error.message); return { error: error.message }; }));
      }
      const result = await cache.get(url.href);
      return allowed(s, url.origin) ? result : { error: 'Data source access was revoked.' };
    },
  };
}
module.exports = { createPreviewData, readPublicJson, publicIPv4, dataUrl };

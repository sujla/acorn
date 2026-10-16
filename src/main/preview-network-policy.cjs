function requestOrigin(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ? url.origin : null;
  } catch { return null; }
}

function createPreviewNetworkPolicy(session) {
  const strictOrigins = new Map();
  session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      const initiator = requestOrigin(details.initiator || details.referrer || details.frame?.url);
      const target = requestOrigin(details.url);
      // Loading the local preview origin itself is allowed. Once code is running
      // in that origin, every network scheme is confined to the same origin.
      callback({ cancel: Boolean(initiator && strictOrigins.has(initiator) && target !== initiator) });
    },
  );
  return {
    register(url, scope) {
      const origin = requestOrigin(url);
      if (!origin || typeof scope !== 'string' || !scope) throw new Error('Invalid visual preview network scope.');
      const scopes = strictOrigins.get(origin) || new Set();
      scopes.add(scope);
      strictOrigins.set(origin, scopes);
      return origin;
    },
    async release(url, scope) {
      const origin = requestOrigin(url);
      const scopes = origin && strictOrigins.get(origin);
      if (!scopes) return false;
      scopes.delete(scope);
      if (scopes.size) return false;
      strictOrigins.delete(origin);
      await session.clearStorageData({ origin });
      return true;
    },
    has(url) {
      const origin = requestOrigin(url);
      return Boolean(origin && strictOrigins.has(origin));
    },
    origins() { return [...strictOrigins.keys()]; },
  };
}

module.exports = { createPreviewNetworkPolicy, requestOrigin };

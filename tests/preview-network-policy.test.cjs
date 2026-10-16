const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPreviewNetworkPolicy, requestOrigin } = require('../src/main/preview-network-policy.cjs');

function harness() {
  let listener;
  const cleared = [];
  const session = {
    webRequest: { onBeforeRequest: (_filter, callback) => { listener = callback; } },
    clearStorageData: async options => { cleared.push(options); },
  };
  const policy = createPreviewNetworkPolicy(session);
  const request = details => new Promise(resolve => listener(details, resolve));
  return { policy, request, cleared };
}

test('strict visual origins can load themselves but cannot reach another origin', async () => {
  const { policy, request } = harness();
  policy.register('http://127.0.0.1:5180/page', 'repo:comparison:base');
  assert.deepEqual(await request({ initiator: 'http://127.0.0.1:5180', url: 'http://127.0.0.1:5180/app.js' }), { cancel: false });
  assert.deepEqual(await request({ initiator: 'http://127.0.0.1:5180', url: 'https://api.example.com/data' }), { cancel: true });
  assert.deepEqual(await request({ referrer: '', frame: { url: 'http://127.0.0.1:5180/page' }, url: 'wss://events.example.com/socket' }), { cancel: true });
  assert.deepEqual(await request({ initiator: 'http://127.0.0.1:5190', url: 'https://api.example.com/data' }), { cancel: false });
});

test('comparison scopes share an origin until the last release and then clear its storage', async () => {
  const { policy, cleared } = harness();
  const url = 'http://127.0.0.1:5180/';
  policy.register(url, 'comparison-a');
  policy.register(url, 'comparison-b');
  assert.equal(await policy.release(url, 'comparison-a'), false);
  assert.equal(policy.has(url), true);
  assert.equal(await policy.release(url, 'comparison-b'), true);
  assert.equal(policy.has(url), false);
  assert.deepEqual(cleared, [{ origin: 'http://127.0.0.1:5180' }]);
});

test('only network origins are accepted', () => {
  assert.equal(requestOrigin('data:text/plain,hello'), null);
  assert.equal(requestOrigin('not a url'), null);
  assert.equal(requestOrigin('wss://example.com/socket'), 'wss://example.com');
});

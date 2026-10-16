const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPreviewData, readPublicJson, publicIPv4, dataUrl } = require('../src/main/preview-data.cjs');

test('data access requires project consent and shares one response across concurrent previews', async () => {
  let reads = 0;
  const data = createPreviewData({ automatic: false, read: async () => ({ body: JSON.stringify({ value: ++reads }), status: 200 }) });
  const url = 'https://example.com/data.json';
  assert.equal((await data.get('repo', url)).needsPermission, true);
  assert.equal(reads, 0);
  data.allow('repo', ['https://example.com']);
  const [base, target] = await Promise.all([data.get('repo', url), data.get('repo', url)]);
  assert.deepEqual(base, target); assert.equal(reads, 1);
  assert.equal((await data.get('other-repo', url)).needsPermission, true);
  data.refresh('repo');
  assert.equal(JSON.parse((await data.get('repo', url)).body).value, 2);
  data.allow('repo', []);
  assert.equal((await data.get('repo', url)).needsPermission, true);
  assert.equal(reads, 2);
});
test('private addresses, credentials, non-HTTPS and writes are refused', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '224.0.0.1']) assert.equal(publicIPv4(ip), false, ip);
  assert.equal(publicIPv4('1.1.1.1'), true);
  for (const url of ['http://example.com/data', 'https://user:secret@example.com/data', 'https://example.com:8443/data']) assert.throws(() => dataUrl(url));
  await assert.rejects(readPublicJson(new URL('https://example.com/data'), { resolve: async () => ['127.0.0.1'], request: () => { throw new Error('Must not connect'); } }), /Private/);
  const data = createPreviewData();
  assert.match((await data.get('repo', 'https://example.com/data', 'POST')).error, /read requests/);
  assert.throws(() => data.allow('repo', ['https://unseen.example']), /detected/);
});
test('refresh isolates in-flight results and revocation prevents delivery', async () => {
  let finish;
  const data = createPreviewData({ automatic: false, read: () => new Promise(resolve => { finish = resolve; }) });
  const url = 'https://example.com/data';
  await data.get('repo', url); data.allow('repo', ['https://example.com']);
  const first = data.get('repo', url); await Promise.resolve();
  data.refresh('repo'); finish({ body: '{}', status: 200 });
  assert.match((await first).error, /refreshed/);
  const second = data.get('repo', url); await Promise.resolve();
  data.allow('repo', []); finish({ body: '{}', status: 200 });
  assert.match((await second).error, /revoked/);
});

test('JSON transport pins the checked IP, sends no credentials, and does not follow redirects', async () => {
  const { EventEmitter } = require('node:events');
  let captured, calls = 0;
  const request = (url, options, callback) => {
    captured = options; calls++;
    const req = new EventEmitter();
    req.destroy = error => { if (error) req.emit('error', error); req.emit('close'); };
    req.end = () => process.nextTick(() => {
      const response = new EventEmitter(); response.statusCode = url.pathname === '/redirect' ? 302 : 200;
      response.headers = { 'content-type': 'text/plain', location: 'https://127.0.0.1/secret' };
      response.resume = () => req.emit('close');
      callback(response);
      if (response.statusCode === 200) { response.emit('data', Buffer.from('{"ok":true}')); response.emit('end'); req.emit('close'); }
    });
    return req;
  };
  const options = { resolve: async () => ['1.1.1.1'], request };
  const result = await readPublicJson(new URL('https://example.com/json'), options);
  assert.deepEqual(JSON.parse(result.body), {ok:true});
  assert.deepEqual(captured.headers, { Accept:'application/json', 'Accept-Encoding':'identity' });
  captured.lookup('example.com', {all:true}, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{address:'1.1.1.1',family:4}]); });
  await assert.rejects(readPublicJson(new URL('https://example.com/redirect'), options), /redirects are not followed/);
  assert.equal(calls, 2);
});

test('public data is opt-in by default; explicit selections and automatic mode are respected', async () => {
  let reads = 0;
  const data = createPreviewData({ read: async () => ({ body: JSON.stringify({ value: ++reads }), status: 200 }) });
  const first = 'https://example.com/a';
  assert.equal((await data.get('repo', first)).needsPermission, true);
  assert.equal(reads, 0);
  assert.equal(data.status('repo').automatic, false);
  data.allow('repo', ['https://example.com'], false);
  const pair = await Promise.all([data.get('repo', first), data.get('repo', first)]);
  assert.deepEqual(pair[0], pair[1]); assert.equal(reads, 1);
  assert.equal((await data.get('repo', 'https://other.example/b')).needsPermission, true);
  data.allow('repo', ['https://example.com'], true);
  assert.ok((await data.get('repo', 'https://new.example/c')).body);
  assert.equal(reads, 2);
  data.allow('repo', [], true);
  assert.equal((await data.get('repo', first)).needsPermission, true);
  assert.equal(reads, 2);
});

test('removing a project discards its preview data permissions and cached responses', async () => {
  let reads = 0;
  const data = createPreviewData({ automatic: false, read: async () => ({ body: JSON.stringify({ value: ++reads }), status: 200 }) });
  const url = 'https://example.com/data';
  await data.get('repo', url);
  data.allow('repo', ['https://example.com']);
  assert.ok((await data.get('repo', url)).body);
  assert.equal(data.remove('repo'), true);
  assert.equal(data.status('repo').sources.length, 0);
  assert.equal((await data.get('repo', url)).needsPermission, true);
});

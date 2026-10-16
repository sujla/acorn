const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLocalProfile, normalizeLocalProfileName, readLocalProfile } = require('../src/main/local-profile.cjs');

test('creates a named local profile with its own space', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-local-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  const uuids = ['11111111-2222-4333-8444-555555555555', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'];

  assert.equal(await readLocalProfile(app), null);
  const created = await createLocalProfile(app, '  Sample User  ', () => uuids.shift());
  assert.equal(created.id, 'local_11111111-2222-4333-8444-555555555555');
  assert.equal(created.spaceId, 'space_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(created.name, 'Sample User');
  assert.equal(created.provider, 'local');
  assert.deepEqual(await readLocalProfile(app), created);
});

test('ignores malformed local profiles', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-local-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  await fs.writeFile(path.join(root, 'local-profile.json'), '{"id":"someone-else"}', 'utf8');
  assert.equal(await readLocalProfile(app), null);
});

test('requires a usable local profile name', () => {
  assert.throws(() => normalizeLocalProfileName('   '), /This field is required/);
  assert.throws(() => normalizeLocalProfileName('a'.repeat(61)), /60 characters/);
  assert.throws(() => normalizeLocalProfileName('테스트'), /^Error: English letters only\.$/);
  assert.throws(() => normalizeLocalProfileName('Sample123'), /^Error: English letters only\.$/);
  assert.throws(() => normalizeLocalProfileName('Sample!'), /^Error: English letters only\.$/);
  assert.equal(normalizeLocalProfileName('Local Person'), 'Local Person');
});

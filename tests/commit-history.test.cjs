const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getCommitPage } = require('../src/main/commit-history.cjs');
test('pages through anchored history without duplicates when HEAD changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acorn-history-test-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } }).trim();
  try {
    git('init', '-q');
    const tree = git('mktree');
    let sha;
    for (let i = 0; i < 113; i++) sha = git('commit-tree', tree, ...(sha ? ['-p', sha] : []), '-m', `Commit ${i}`);
    git('update-ref', 'HEAD', sha);
    const run = async (_root, args) => git(...args);
    const first = await getCommitPage(run, root);
    assert.equal(first.commits.length, 50);
    assert.equal(first.commitHistory.hasMore, true);
    git('update-ref', 'HEAD', git('commit-tree', tree, '-p', sha, '-m', 'New head'));
    const second = await getCommitPage(run, root, first.commitHistory);
    const third = await getCommitPage(run, root, second.commitHistory);
    assert.equal(second.commits.length, 50);
    assert.equal(third.commits.length, 13);
    assert.equal(third.commitHistory.hasMore, false);
    const all = [...first.commits, ...second.commits, ...third.commits];
    assert.equal(new Set(all.map(commit => commit.sha)).size, 113);
    assert.equal(all[0].subject, 'Commit 112');
    assert.equal(all.at(-1).subject, 'Commit 0');
    const exact = await getCommitPage(run, root, { anchor: sha, offset: 63 });
    assert.equal(exact.commits.length, 50);
    assert.equal(exact.commitHistory.hasMore, false);
    await assert.rejects(getCommitPage(run, root, { offset: -1 }), /Invalid/);
    await assert.rejects(getCommitPage(run, root, { anchor: '--all' }), /Invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

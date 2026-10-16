const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { inspectRepositoryRefs } = require('../src/main/repository-refs.cjs');
const { getCommitSummaries } = require('../src/main/commit-history.cjs');

test('refreshes local branches and starts commit pagination from the latest HEAD', async () => {
  const calls = [];
  const runGit = async (_root, args) => {
    calls.push(args);
    if (args[0] === 'branch') return 'feature\tbbbbbbb\t\nmain\taaaaaaa\t*';
    if (args[0] === 'rev-parse') return 'a'.repeat(40);
    if (args[0] === 'log') return `${'a'.repeat(40)}\taaaaaaa\tAcorn\t2026-10-14\tLatest`;
    throw new Error(`Unexpected command: ${args[0]}`);
  };

  const result = await inspectRepositoryRefs(runGit, '/repo');

  assert.equal(result.currentBranch, 'main');
  assert.equal(result.defaultBranch, 'main');
  assert.deepEqual(result.branches.map(branch => branch.name), ['feature', 'main']);
  assert.equal(result.commits[0].subject, 'Latest');
  assert.deepEqual(result.commitHistory, { anchor: 'a'.repeat(40), offset: 1, hasMore: false });
  assert.equal(calls.filter(args => args[0] === 'log').length, 1);
});

test('uses the first branch when there is no main, master, or current marker', async () => {
  const runGit = async (_root, args) => {
    if (args[0] === 'branch') return 'release\tccccccc\t\nfeature\tbbbbbbb\t';
    if (args[0] === 'rev-parse') return 'c'.repeat(40);
    if (args[0] === 'log') return `${'c'.repeat(40)}\tccccccc\tAcorn\t2026-10-14\tRelease`;
    throw new Error(`Unexpected command: ${args[0]}`);
  };

  const result = await inspectRepositoryRefs(runGit, '/repo');
  assert.equal(result.currentBranch, 'release');
  assert.equal(result.defaultBranch, 'release');
});

test('loads selected commit summaries directly when they are outside the first page', async () => {
  const requested = [];
  const runGit = async (_root, args) => {
    requested.push(args);
    const ref = args.at(-2);
    return `${ref}\t${ref.slice(0, 7)}\tAcorn\t2026-10-14\tSelected older commit`;
  };
  const old = '1'.repeat(40);

  const commits = await getCommitSummaries(runGit, '/repo', [old]);

  assert.equal(commits[0].sha, old);
  assert.equal(commits[0].subject, 'Selected older commit');
  assert.deepEqual(requested[0].slice(0, 2), ['log', '--max-count=1']);
  await assert.rejects(getCommitSummaries(runGit, '/repo', ['main']), /Invalid commit references/);
});

test('initial repository activation hydrates an older selected commit without opening the picker', async () => {
  const appSource = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
  const start = appSource.indexOf('async function hydrateSelectedCommits(');
  const end = appSource.indexOf('\nasync function refreshRepositoryRefs(', start);
  const old = '1'.repeat(40);
  const repository = { path: '/repo', branches: [{ name: 'main' }], commits: [] };
  const renders = [];
  const context = vm.createContext({
    repository,
    repositories: [repository],
    activeRepository: repository,
    baseRef: { value: 'main' },
    targetRef: { value: old },
    bridge: { getCommitSummaries: async () => ({ commits: [{ sha: old, shortSha: old.slice(0, 7), subject: 'Selected older commit' }] }) },
    setSelectOptions: (_select, _repository, selected) => renders.push(selected),
  });
  vm.runInContext(appSource.slice(start, end), context);

  await vm.runInContext('hydrateSelectedCommits(repository, ["main", targetRef.value])', context);

  assert.equal(repository.commits[0].subject, 'Selected older commit');
  assert.deepEqual(renders, ['main', old]);
  const activation = appSource.slice(appSource.indexOf('function activateRepository('), appSource.indexOf('\nasync function addConnection('));
  assert.match(activation, /hydrateSelectedCommits\(activeRepository, \[base, target\]\)/);
});

test('client refresh preserves selected refs and ignores an older response that finishes last', async () => {
  const appSource = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
  const start = appSource.indexOf('async function refreshRepositoryRefs(');
  const end = appSource.indexOf("for (const [side, select]", start);
  const pending = [];
  const selectedCommit = { sha: '1'.repeat(40), shortSha: '1'.repeat(7), subject: 'Selected older commit' };
  const repository = {
    path: '/repo', branches: [], commits: [selectedCommit], commitHistory: {}, currentBranch: 'main', defaultBranch: 'main',
  };
  const selections = [];
  const context = vm.createContext({
    repository,
    repositories: [repository],
    activeRepository: repository,
    baseRef: { value: 'main' },
    targetRef: { value: '1'.repeat(40) },
    bridge: { refreshRepositoryRefs: () => new Promise(resolve => pending.push(resolve)) },
    renderProjectList() {},
    renderProjectMetadata() {},
    setSelectOptions: (select, _repository, selected) => selections.push([select, selected]),
    notify: message => assert.fail(`Unexpected notification: ${message}`),
    hydrateSelectedCommits() {},
  });
  vm.runInContext(appSource.slice(start, end), context);
  const first = vm.runInContext('refreshRepositoryRefs(repository)', context);
  const second = vm.runInContext('refreshRepositoryRefs(repository)', context);
  const refs = subject => ({
    branches: [{ name: 'main', sha: subject.slice(0, 7), current: true }],
    commits: [{ sha: subject, shortSha: subject.slice(0, 7), subject }],
    commitHistory: { anchor: subject, offset: 1, hasMore: false },
    currentBranch: 'main',
    defaultBranch: 'main',
  });

  pending[1](refs('2'.repeat(40)));
  await second;
  pending[0](refs('3'.repeat(40)));
  await first;

  assert.equal(repository.commits[0].sha, '2'.repeat(40));
  assert.equal(repository.commits[1].subject, 'Selected older commit');
  assert.deepEqual(selections.map(([, selected]) => selected), ['main', '1'.repeat(40)]);
});

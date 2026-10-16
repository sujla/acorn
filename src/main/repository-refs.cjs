const { getCommitPage } = require('./commit-history.cjs');

function parseBranches(output) {
  return output.split('\n').filter(Boolean).map((line) => {
    const [name, sha, current] = line.split('\t');
    return { name, sha: sha.slice(0, 7), current: current === '*' };
  });
}

async function inspectRepositoryRefs(runGit, root) {
  const [branchesOutput, commitPage] = await Promise.all([
    runGit(root, ['branch', '--format=%(refname:short)\t%(objectname:short)\t%(HEAD)']),
    getCommitPage(runGit, root),
  ]);
  const branches = parseBranches(branchesOutput);
  if (!branches.length) throw new Error('Choose a Git repository with at least one commit.');
  const defaultBranch = branches.find((branch) => ['main', 'master'].includes(branch.name))?.name || branches[0].name;
  const currentBranch = branches.find((branch) => branch.current)?.name || defaultBranch;
  return { branches, commits: commitPage.commits, commitHistory: commitPage.commitHistory, currentBranch, defaultBranch };
}

module.exports = { inspectRepositoryRefs, parseBranches };

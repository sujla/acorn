const PAGE_SIZE = 50;
function parseCommits(output) {
  return output.split('\n').filter(Boolean).map((line) => {
    const [sha, shortSha, author, date, ...subject] = line.split('\t');
    return { sha, shortSha: shortSha.slice(0, 7), author, date, subject: subject.join('\t') };
  });
}

async function getCommitPage(runGit, repositoryPath, { anchor, offset = 0 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid commit offset.');
  if (anchor !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(anchor)) throw new Error('Invalid commit history reference.');
  const historyHead = anchor || await runGit(repositoryPath, ['rev-parse', 'HEAD']);
  const output = await runGit(repositoryPath, ['log', `--max-count=${PAGE_SIZE + 1}`, `--skip=${offset}`, '--date=short', '--format=%H\t%h\t%an\t%ad\t%s', historyHead, '--']);
  const rows = parseCommits(output);
  const commits = rows.slice(0, PAGE_SIZE);
  return { commits, commitHistory: { anchor: historyHead, offset: offset + commits.length, hasMore: rows.length > PAGE_SIZE } };
}

async function getCommitSummaries(runGit, repositoryPath, refs) {
  if (!Array.isArray(refs) || refs.length > 2 || refs.some(ref => !/^[a-f0-9]{7,64}$/i.test(ref))) throw new Error('Invalid commit references.');
  const commits = await Promise.all([...new Set(refs)].map(async ref => {
    const output = await runGit(repositoryPath, ['log', '--max-count=1', '--date=short', '--format=%H\t%h\t%an\t%ad\t%s', ref, '--']);
    return parseCommits(output)[0];
  }));
  return commits.filter(Boolean);
}

module.exports = { getCommitPage, getCommitSummaries, parseCommits };

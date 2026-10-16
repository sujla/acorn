const git = require('isomorphic-git');
const { resolveExclusions } = require('./preview-file-settings.cjs');
const { expoPreviewExclusions } = require('./expo-preview-output.cjs');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createTwoFilesPatch, diffLines } = require('diff');
const { isGeneratedFile } = require('./diff-overlay.cjs');
const { parseOutputDirectories, isViteConfig, previewOutputDirectories, isPreviewOutput } = require('./generated-output.cjs');

async function options(dir) {
  const root = await git.findRoot({ fs, filepath: dir });
  const info = await fsp.lstat(path.join(root, '.git'));
  if (!info.isDirectory()) throw new Error('Linked worktrees need a separate Git-directory access adapter. Choose a standalone repository for this version.');
  // Reuse packfile data across tree/blob reads, scoped to this operation only.
  return { fs, dir: root, cache: {} };
}
async function resolve(opts, ref) {
  const oid = await git.resolveRef({ ...opts, ref: ref.replace(/\^\{commit\}$/, '') });
  await git.readCommit({ ...opts, oid });
  return oid;
}
async function treeFiles(opts, ref, excludedDirectories = [], signal) {
  const result = new Map();
  await git.walk({ ...opts, trees: [git.TREE({ ref })], map: async (file, [entry]) => {
    signal?.throwIfAborted();
    if (file === '.') return;
    if (isPreviewOutput(file, excludedDirectories)) return null;
    if (await entry.type() === 'blob') result.set(file, { oid: await entry.oid(), mode: await entry.mode() });
  } });
  return result;
}
async function blob(opts, item) { return item ? Buffer.from((await git.readBlob({ ...opts, oid: item.oid })).blob) : Buffer.alloc(0); }
async function exportRevision(dir, ref, destination, { excludeBuildOutputs = false, preserveExpoExport = false, previewFileSettings, signal } = {}) {
  signal?.throwIfAborted();
  const opts = await options(dir);
  let outputDirectories = [];
  if (excludeBuildOutputs) {
    // Read only this revision's root configuration before walking output trees.
    const oid = await resolve(opts, ref);
    const { tree } = await git.readTree({ ...opts, oid });
    const configs = tree.filter(entry => entry.type === 'blob' && entry.mode !== '120000' && isViteConfig(entry.path));
    const configured = await Promise.all(configs.map(async entry => parseOutputDirectories((await blob(opts, entry)).toString())));
    outputDirectories = previewOutputDirectories(configured.flat());
    if (preserveExpoExport) {
      const entry = tree.find(entry => entry.path === 'package.json' && entry.type === 'blob' && entry.mode !== '120000');
      if (entry) outputDirectories = expoPreviewExclusions(outputDirectories, JSON.parse((await blob(opts, entry)).toString()));
    }
  }
  if (previewFileSettings) outputDirectories = resolveExclusions(outputDirectories, previewFileSettings);
  const entries = await treeFiles(opts, ref, outputDirectories, signal);
  for (const [file, item] of entries) {
    signal?.throwIfAborted();
    if (item.mode === 0o120000 || file.split('/').some(part => ['node_modules', '.git'].includes(part)) || /(^|\/)\.env(?:\.|$)/.test(file)) continue;
    const target = path.resolve(destination, file);
    if (!target.startsWith(path.resolve(destination) + path.sep)) throw new Error('Invalid Git tree path.');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, await blob(opts, item));
  }
  return { outputDirectories };
}
async function runGit(dir, args) {
  const opts = await options(dir);
  const [command, ...rest] = args;
  if (command === 'rev-parse') return rest[0] === '--show-toplevel' ? opts.dir : resolve(opts, rest[0]);
  if (command === 'remote') return (await git.listRemotes(opts)).find(remote => remote.remote === rest[1])?.url || '';
  if (command === 'branch') {
    const current = await git.currentBranch(opts);
    return (await Promise.all((await git.listBranches(opts)).map(async name => `${name}\t${(await resolve(opts, name)).slice(0, 7)}\t${name === current ? '*' : ''}`))).join('\n');
  }
  if (command === 'log') {
    const count = Number(rest.find(x => x.startsWith('--max-count='))?.split('=')[1] || 51);
    const skip = Number(rest.find(x => x.startsWith('--skip='))?.split('=')[1] || 0);
    const ref = rest.find(x => !x.startsWith('--')) || 'HEAD';
    const commits = await git.log({ ...opts, ref, depth: count + skip });
    return commits.slice(skip).map(({ oid, commit }) => `${oid}\t${oid.slice(0, 7)}\t${commit.author.name}\t${new Date((commit.author.timestamp - commit.author.timezoneOffset * 60) * 1000).toISOString().slice(0, 10)}\t${commit.message.split('\n')[0]}`).join('\n');
  }
  if (command === 'ls-tree') return (await git.readTree({ ...opts, oid: await resolve(opts, rest.at(-1)) })).tree.map(item => item.path).join('\n');
  if (command === 'show') {
    const separator = rest[0].indexOf(':');
    return Buffer.from((await git.readBlob({ ...opts, oid: await resolve(opts, rest[0].slice(0, separator)), filepath: rest[0].slice(separator + 1) })).blob).toString();
  }
  if (command !== 'diff') throw new Error('Unsupported read-only Git operation: ' + command);
  const marker = rest.indexOf('--');
  const flags = marker < 0 ? rest : rest.slice(0, marker);
  const paths = marker < 0 ? [] : rest.slice(marker + 1);
  const refs = flags.filter(flag => !flag.startsWith('-'));
  const before = await treeFiles(opts, refs[0] || 'HEAD');
  const after = refs[1] ? await treeFiles(opts, refs[1]) : null;
  const all = new Set([...before.keys(), ...(after ? after.keys() : await git.listFiles(opts))]);
  const context = Number(flags.find(flag => flag.startsWith('--unified='))?.split('=')[1] || 3);
  const literal = paths.filter(file => !file.startsWith(':('));
  const exclusions = paths.filter(file => file.startsWith(':(exclude,literal)')).map(file => file.slice(':(exclude,literal)'.length));
  const output = [];
  for (const file of [...all].sort()) {
    if (literal.length && !literal.includes(file)) continue;
    if (paths.some(file => file.startsWith(':(')) && isGeneratedFile(file, exclusions)) continue;
    let a = await blob(opts, before.get(file));
    let b;
    let exists = true;
    if (after) { b = await blob(opts, after.get(file)); exists = after.has(file); }
    else {
      try {
        const filename = path.join(opts.dir, file);
        if ((await fsp.lstat(filename)).isSymbolicLink()) b = Buffer.from(await fsp.readlink(filename));
        else b = await fsp.readFile(filename);
      } catch (error) { if (error.code !== 'ENOENT') throw error; b = Buffer.alloc(0); exists = false; }
    }
    let oldExists = before.has(file);
    if (flags.includes('-R')) { [a, b] = [b, a]; [oldExists, exists] = [exists, oldExists]; }
    if (a.equals(b) && oldExists === exists) continue;
    if (flags.includes('--name-status')) { output.push(`${!oldExists ? 'A' : !exists ? 'D' : 'M'}\t${file}`); continue; }
    const binary = a.includes(0) || b.includes(0);
    if (flags.includes('--numstat')) {
      let added = 0, deleted = 0;
      if (!binary) for (const chunk of diffLines(a.toString(), b.toString())) { if (chunk.added) added += chunk.count; if (chunk.removed) deleted += chunk.count; }
      output.push(`${binary ? '-' : added}\t${binary ? '-' : deleted}\t${file}`);
    } else output.push(`diff --git a/${file} b/${file}\n` + (binary ? 'Binary files differ\n' : createTwoFilesPatch(oldExists ? 'a/' + file : '/dev/null', exists ? 'b/' + file : '/dev/null', a.toString(), b.toString(), '', '', { context })));
  }
  return output.join('\n').trim();
}
module.exports = { runGit, exportRevision };

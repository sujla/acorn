// Compare the production shared-cache exporter with the uncached baseline in memory.
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const git = require('isomorphic-git');
app.whenReady().then(async () => {
  let scratch;
  try {
    const repository = process.argv[2];
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-export-profile-'));
    const filename = path.resolve(__dirname, '../src/main/local-git.cjs');
    const original = await fs.readFile(filename, 'utf8');
    const source = original.replace('return { fs, dir: root, cache: {} };', 'return { fs, dir: root };');
    const experimental = new Module(filename, module);
    experimental.filename = filename; experimental.paths = module.paths;
    experimental._compile(source, filename);
    const sha = await experimental.exports.runGit(repository, ['rev-parse', 'HEAD']);
    const realReadBlob = git.readBlob;
    let reads = 0, readMs = 0;
    git.readBlob = async options => { const start = performance.now(); try { return await realReadBlob(options); } finally { reads++; readMs += performance.now() - start; } };
    for (const mode of ['shared-cache-1', 'shared-cache-2', 'uncached-baseline']) {
      reads = 0; readMs = 0;
      const destination = path.join(scratch, mode); await fs.mkdir(destination);
      const implementation = mode === 'uncached-baseline' ? experimental.exports : require('../src/main/local-git.cjs');
      const start = performance.now();
      await implementation.exportRevision(repository, sha, destination);
      console.log(JSON.stringify({ mode, elapsedMs: +(performance.now() - start).toFixed(1), blobReads: reads, blobReadMs: +readMs.toFixed(1) }));
    }
    const digest = async root => {
      const result = {};
      const walk = async dir => { for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) await walk(file);
        else result[path.relative(root, file)] = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
      } };
      await walk(root); return Object.entries(result).sort();
    };
    require('node:assert/strict').deepEqual(await digest(path.join(scratch, 'uncached-baseline')), await digest(path.join(scratch, 'shared-cache-1')));
    console.log('All exported file paths and contents match.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (scratch) await fs.rm(scratch, { recursive: true, force: true }); app.exit(process.exitCode || 0); }
});

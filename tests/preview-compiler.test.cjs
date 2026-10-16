const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { compilePreview } = require('../src/main/preview-compiler.cjs');
const { runGit, exportRevision } = require('../src/main/local-git.cjs');

async function fixture(t, data) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acorn-compiler-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  for (const [name, content] of Object.entries(data)) { await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true }); await fs.writeFile(path.join(repo, name), content); }
  return { root, repo, cache: path.join(root, 'cache') };
}
test('compiles historical TS sources, reads Git and diffs without system commands, reuses cache', async t => {
  const { root, repo, cache } = await fixture(t, {
    'index.html': '<div id="root"></div><script type="module" src="/src/main.ts"></script>',
    'src/main.ts': 'import "./style.css"; const value: string = "Before"; document.getElementById("root")!.textContent=value;',
    'src/style.css': 'body { color: red; }',
    'package.json': '{"scripts":{"dev":"touch SHOULD_NOT_EXIST"}}',
    'vite.config.js': 'throw new Error("must never execute")',
  });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@test.test', 'commit', '-qm', 'before');
  const before = git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(repo, 'src/main.ts'), 'const value: string = "After"; document.getElementById("root")!.textContent=value;');
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@test.test', 'commit', '-qm', 'after');
  const after = git('rev-parse', 'HEAD');
  assert.equal(await runGit(repo, ['rev-parse', 'HEAD']), after);
  assert.match(await runGit(repo, ['log', '--max-count=2', '--skip=0', 'HEAD']), /before/);
  assert.match(await runGit(repo, ['diff', '--unified=3', before, after]), /\+const value.*After/);
  assert.match(await runGit(repo, ['diff', '--name-status', before, after]), /M\tsrc\/main.ts/);
  for (const [sha, expected] of [[before, 'Before'], [after, 'After']]) {
    const snapshot = path.join(root, sha); await fs.mkdir(snapshot);
    await exportRevision(repo, sha, snapshot);
    const artifact = await compilePreview({ root: snapshot, repositoryPath: repo, cacheRoot: cache });
    const script = await fs.readFile(path.join(artifact.root, '_acorn/entry-0.js'), 'utf8');
    assert.match(script, new RegExp(expected));
    assert.match(await fs.readFile(path.join(artifact.root, 'index.html'), 'utf8'), /_acorn\/entry-0.js/);
    assert.equal((await compilePreview({ root: snapshot, repositoryPath: repo, cacheRoot: cache })).cached, true);
  }
  assert.equal(git('status', '--porcelain'), '');
  await assert.rejects(fs.access(path.join(repo, 'SHOULD_NOT_EXIST')));
});
test('local-only pages render despite changed or missing live lockfiles', async t => {
  const { root, repo, cache } = await fixture(t, {
    'index.html': '<h1>Historical screen</h1><script src="/classic.js"></script><script type="module" src="/main.ts"></script>',
    'classic.js': 'window.classicReady = true;',
    'main.ts': 'import "./style.css"; import {label} from "./label.ts"; document.body.dataset.label = label;',
    'label.ts': 'export const label: string = "Historical";',
    'style.css': 'body { color: purple; }',
    'package.json': '{"devDependencies":{"unused":"1"}}',
    'package-lock.json': '{"version":1}',
  });
  const snapshot = path.join(root, 'snapshot'); await fs.cp(repo, snapshot, { recursive: true });
  await fs.writeFile(path.join(repo, 'package-lock.json'), '{"version":2}');
  const options = { root: snapshot, repositoryPath: repo, cacheRoot: cache };
  const artifact = await compilePreview(options);
  assert.match(await fs.readFile(path.join(artifact.root, 'index.html'), 'utf8'), /Historical screen/);
  assert.equal(await fs.readFile(path.join(artifact.root, 'classic.js'), 'utf8'), 'window.classicReady = true;');
  assert.match(await fs.readFile(path.join(artifact.root, '_acorn/entry-0.js'), 'utf8'), /Historical/);
  assert.match(await fs.readFile(path.join(artifact.root, '_acorn/entry-0.css'), 'utf8'), /purple/);
  assert.deepEqual(artifact.warnings, []);
  assert.equal((await compilePreview(options)).cached, true);
  await fs.rm(path.join(repo, 'package-lock.json'));
  assert.equal((await compilePreview(options)).cached, true);
  assert.equal((await compilePreview({ ...options, cacheRoot: path.join(root, 'fresh-cache') })).cached, false);
});

test('invalid historical lockfiles fail clearly, including warm caches', async t => {
  const { root, repo, cache } = await fixture(t, {
    'index.html': '<script type="module" src="/main.js"></script>',
    'main.js': 'import {value} from "example"; document.body.textContent = value;',
    'package.json': '{"dependencies":{"example":"1"}}',
    'package-lock.json': '{"version":1}',
  });
  const snapshot = path.join(root, 'snapshot'); await fs.cp(repo, snapshot, { recursive: true });
  await fs.mkdir(path.join(repo, 'node_modules/example'), { recursive: true });
  await fs.writeFile(path.join(repo, 'node_modules/example/package.json'), '{"main":"index.js"}');
  await fs.writeFile(path.join(repo, 'node_modules/example/index.js'), 'exports.value = "Example";');
  const options = { root: snapshot, repositoryPath: repo, cacheRoot: cache };
  await compilePreview(options);
  assert.equal((await compilePreview(options)).cached, true);
  await fs.writeFile(path.join(repo, 'package-lock.json'), '{"version":2}');
  await assert.rejects(compilePreview(options), /historical dependencies/);
  await fs.rm(path.join(repo, 'package-lock.json'));
  await assert.rejects(compilePreview(options), /historical dependencies/);
});

test('external scripts still fail visibly without checking unused dependencies', async t => {
  const { root, repo, cache } = await fixture(t, { 'index.html': '<script src="https://example.com/a.js"></script>', 'package-lock.json': '{"version":1}' });
  const snapshot = path.join(root, 'snapshot'); await fs.cp(repo, snapshot, { recursive: true });
  await fs.writeFile(path.join(repo, 'package-lock.json'), '{"version":2}');
  await assert.rejects(compilePreview({ root: snapshot, repositoryPath: repo, cacheRoot: cache }), /External script/);
});
test('dependency URLs resolve to emitted JS and CSS when the cache uses canonical filesystem paths', async t => {
  const { root, repo } = await fixture(t, {
    'package.json': '{"dependencies":{"example":"1"}}',
    'index.html': '<script type="module" src="/main.js"></script>',
    'main.js': 'import {value} from "example"; document.body.textContent=value;',
    'node_modules/example/package.json': '{"main":"index.js"}',
    'node_modules/example/index.js': 'import "./style.css"; export const value="Rendered";',
    'node_modules/example/style.css': 'body {color: purple}',
  });
  const options = { root: repo, repositoryPath: repo, cacheRoot: path.join(await fs.realpath(root), 'Application Support', 'cache') };
  for (let run = 0; run < 2; run++) {
    const artifact = await compilePreview(options);
    assert.equal(artifact.cached, run === 1);
    const html = await fs.readFile(path.join(artifact.root, 'index.html'), 'utf8');
    const imports = JSON.parse(html.match(/<script type="importmap">([^<]+)<\/script>/)[1]).imports;
    const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(match => match[1]);
    assert.equal(styles.length, 1);
    for (const url of [...Object.values(imports), ...styles]) {
      const prefix = `/_acorn_deps/${artifact.dependencyKey}/`;
      assert.ok(url.startsWith(prefix));
      const relative = url.slice(prefix.length);
      assert.ok(!relative.split('/').includes('..'), url);
      assert.equal(new URL(url, 'http://localhost').pathname, url);
      await fs.access(path.join(artifact.dependencyRoot, relative));
    }
  }
});

test('React JSX and CSS use a dependency cache shared by changed commits', async t => {
  const { repo, cache } = await fixture(t, {
    'package.json': '{"dependencies":{"react":"test","react-dom":"test"}}',
    'index.html': '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    'main.tsx': 'import {createRoot} from "react-dom/client"; import {useState} from "react"; import "./style.css"; function App(){const [n,setN]=useState(0);return <button onClick={()=>setN(n+1)}>Count {n}</button>} createRoot(document.getElementById("root")!).render(<App/>);',
    'style.css': 'button { color: purple; }',
  });
  for (const name of ['react', 'react-dom', 'scheduler']) await fs.cp(path.join(__dirname, '../node_modules', name), path.join(repo, 'node_modules', name), { recursive: true });
  const artifact = await compilePreview({ root: repo, repositoryPath: repo, cacheRoot: cache });
  assert.match(await fs.readFile(path.join(artifact.root, '_acorn/entry-0.css'), 'utf8'), /purple/);
  assert.equal(artifact.dependencyCached, false);
  assert.match(await fs.readFile(path.join(artifact.root, 'index.html'), 'utf8'), /type="importmap"/);
  assert.equal((await compilePreview({ root: repo, repositoryPath: repo, cacheRoot: cache })).cached, true);
  await fs.writeFile(path.join(repo, 'main.tsx'), 'import {createRoot} from "react-dom/client"; import {useState} from "react"; function App(){const [n]=useState(1);return <button>Changed commit {n}</button>} createRoot(document.getElementById("root")).render(<App/>);');
  const changedSource = await compilePreview({ root: repo, repositoryPath: repo, cacheRoot: cache });
  assert.notEqual(changedSource.cacheKey, artifact.cacheKey);
  assert.equal(changedSource.dependencyKey, artifact.dependencyKey);
  assert.equal(changedSource.dependencyCached, true);
  await fs.writeFile(path.join(repo, 'main.tsx'), 'import {createRoot} from "react-dom/client"; import {useMemo} from "react"; function App(){const n=useMemo(()=>2,[]);return <button>Different imports {n}</button>} createRoot(document.getElementById("root")).render(<App/>);');
  const changedImports = await compilePreview({ root: repo, repositoryPath: repo, cacheRoot: cache });
  assert.notEqual(changedImports.dependencyKey, artifact.dependencyKey);
  assert.equal(changedImports.dependencyCached, false);
  await fs.appendFile(path.join(repo, 'node_modules/react/index.js'), '\n// changed dependency');
  const changedDependency = await compilePreview({ root: repo, repositoryPath: repo, cacheRoot: cache });
  assert.equal(changedDependency.cached, false);
  assert.equal(changedDependency.dependencyCached, false);
});

test('ignores configured deployment HTML while compiling source pages without executing Vite config', async t => {
  const { repo, cache } = await fixture(t, {
    'index.html': '<div id="root"></div><script type="module" src="/src/main.ts"></script>',
    'src/main.ts': 'import "./style.css"; document.getElementById("root")!.textContent = "Source preview";',
    'src/style.css': 'header { filter: url(#flyer-header-torn-edge); }',
    'projects/example/index.html': '<h1>Source project page</h1>',
    'vite.config.ts': 'throw new Error("Do not execute"); export default { base: "/portfolio/", build: { outDir: "docs" } };',
    'docs/index.html': '<script type="module" src="/portfolio/assets/main-missing.js"></script>',
    'docs/projects/example/index.html': '<script src="/portfolio/assets/project-missing.js"></script>',
    'docs-extra/index.html': '<h1>Not a build output</h1>',
  });
  const artifact = await compilePreview({ root: repo, repositoryPath: repo, cacheRoot: cache });
  assert.match(await fs.readFile(path.join(artifact.root, '_acorn/entry-0.js'), 'utf8'), /Source preview/);
  assert.match(await fs.readFile(path.join(artifact.root, 'projects/example/index.html'), 'utf8'), /Source project page/);
  assert.match(await fs.readFile(path.join(artifact.root, 'docs-extra/index.html'), 'utf8'), /Not a build output/);
  assert.match(await fs.readFile(path.join(artifact.root, '_acorn/entry-0.css'), 'utf8'), /url\(#flyer-header-torn-edge\)/);
  // Missing scripts outside the exact output directory must still report errors.
  await fs.writeFile(path.join(repo, 'docs-extra/index.html'), '<script src="/missing.js"></script>');
  await assert.rejects(compilePreview({ root: repo, repositoryPath: repo, cacheRoot: cache }), /ENOENT/);
});

test('packed Git history exports exact revisions and observes subsequent commits', async t => {
  const data = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`files/item-${i}.txt`, 'Common content\n'.repeat(100) + `Before ${i}\n`]));
  data['image.bin'] = Buffer.from([0, 1, 255, 128, 42]);
  const { root, repo } = await fixture(t, data);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  const commit = message => { git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@test.test', 'commit', '-qm', message); return git('rev-parse', 'HEAD').toString().trim(); };
  git('init', '-q');
  const before = commit('before');
  await fs.writeFile(path.join(repo, 'files/item-3.txt'), 'Changed content\n');
  const after = commit('after');
  git('gc', '--prune=now');
  assert.ok((await fs.readdir(path.join(repo, '.git/objects/pack'))).some(name => name.endsWith('.pack')));
  for (const sha of [before, after]) {
    const destination = path.join(root, sha);
    await fs.mkdir(destination);
    await exportRevision(repo, sha, destination);
    for (const file of Object.keys(data)) assert.deepEqual(await fs.readFile(path.join(destination, file)), git('show', `${sha}:${file}`));
  }
  assert.match(await runGit(repo, ['diff', '--unified=3', before, after]), /\+Changed content/);
  await fs.writeFile(path.join(repo, 'files/item-3.txt'), 'Newest content\n');
  const newest = commit('newest');
  const destination = path.join(root, newest); await fs.mkdir(destination);
  await exportRevision(repo, 'HEAD', destination);
  assert.equal(await fs.readFile(path.join(destination, 'files/item-3.txt'), 'utf8'), 'Newest content\n');
  assert.equal(git('status', '--porcelain').toString(), '');
});

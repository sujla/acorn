import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  }));
  return files.flat();
}

const files = ['desktop.cjs', 'desktop-lifecycle.cjs', ...(await sourceFiles('src')).filter((file) => {
  const extension = extname(file);
  return extension === '.cjs' || extension === '.mjs' || (extension === '.js' && file.startsWith(join('src', 'renderer')));
})];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

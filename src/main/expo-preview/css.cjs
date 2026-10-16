const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Compile CSS without evaluating the project's PostCSS or other configuration.
// Imported styles and local assets stay inside the same roots as Metro modules.
async function transformCss({ filename, roots, inputDirectory }) {
  const inputs = {};
  const result = await esbuild.build({
    absWorkingDir: path.dirname(filename),
    stdin: {
      contents: filename.endsWith('.module.css')
        ? `import classes from ${JSON.stringify(filename)}; export default classes;`
        : `import ${JSON.stringify(filename)}; export default {};`,
      resolveDir: path.dirname(filename), loader: 'js',
    },
    outfile: 'acorn-style.js', bundle: true, write: false, format: 'esm',
    logLevel: 'silent', sourcemap: false, tsconfigRaw: {},
    plugins: [{ name: 'acorn-css-inputs', setup(build) {
      build.onResolve({ filter: /.*/ }, async args => {
        if (args.pluginData?.resolved) return;
        if (args.kind === 'url-token' && args.path.startsWith('/')) return { path: args.path, external: true };
        const resolved = await build.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { resolved: true } });
        if (resolved.errors.length || resolved.external) return resolved;
        const real = await fs.realpath(resolved.path);
        if (!roots.some(root => inside(root, real))) throw new Error('CSS import is outside the connected project.');
        // Each Metro CSS module is compiled separately. Unique virtual basenames
        // prevent identically named classes/files from colliding across builds.
        return { path: 'style_' + hash(real).slice(0, 20) + path.extname(real), namespace: 'acorn-css', pluginData: { real } };
      });
      build.onLoad({ filter: /.*/ }, async args => {
        const real = await fs.realpath(args.pluginData?.real || args.path);
        if (!roots.some(root => inside(root, real))) throw new Error('CSS import is outside the connected project.');
        const extension = path.extname(real).toLowerCase();
        const loader = extension === '.css' ? (real.endsWith('.module.css') ? 'local-css' : 'css')
          : /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot)$/.test(extension) ? 'dataurl' : null;
        if (!loader) throw new Error('Unsupported CSS asset type: ' + extension);
        const contents = await fs.readFile(real);
        inputs[real] = hash(contents);
        return { contents, loader, resolveDir: path.dirname(real) };
      });
    } }],
  });
  const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text || '';
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const id = 'acorn-css-' + hash(filename + '\0' + css).slice(0, 20);
  if (inputDirectory) await fs.writeFile(path.join(inputDirectory, hash(filename) + '.json'), JSON.stringify(inputs));
  return `${js}\nif (typeof document !== 'undefined' && !document.getElementById(${JSON.stringify(id)})) { const style = document.createElement('style'); style.id = ${JSON.stringify(id)}; style.textContent = ${JSON.stringify(css)}; document.head.appendChild(style); }`;
}

function conciseExpoError(error, root) {
  const message = String(error.message || error).replace(/\x1b\[[0-9;]*m/g, '');
  const missing = /Unable to resolve module\s+(.+?)\s+from\s+(.+?):(?:\s|$)/.exec(message);
  if (missing) {
    const origin = missing[2].startsWith(root + path.sep) ? path.relative(root, missing[2]) : path.basename(missing[2]);
    return `Cannot resolve ${missing[1]} (imported by ${origin}). Check that the file or dependency exists in this revision.`;
  }
  return message.split(root + path.sep).join('').split('\n').filter(line => line.trim()).slice(0, 3).join(' ').slice(0, 400);
}
module.exports = { transformCss, conciseExpoError };

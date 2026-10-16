const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
const { localPreviewOutputDirectories, isPreviewOutput } = require('./generated-output.cjs');

const { prepareDependencies } = require('./preview-dependencies.cjs');
const VERSION = 'ui-8';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const ignored = new Set(['.git', 'node_modules', '.next', '.expo', '.cache', '.acorn-runtime']);
async function files(root, directory = root, outputDirectories) {
  outputDirectories ||= await localPreviewOutputDirectories(root);
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.')) continue;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || isPreviewOutput(path.relative(root, file), outputDirectories)) continue;
    if (entry.isDirectory()) result.push(...await files(root, file, outputDirectories));
    else if (entry.isFile()) result.push(file);
  }
  return result.sort();
}
async function json(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function checkedPath(root, file) {
  const real = await fs.realpath(file);
  if (!inside(root, real)) throw new Error('Preview input escapes the selected repository: ' + file);
  return real;
}
async function validateInputs(inputs) {
  for (const [file, digest] of Object.entries(inputs)) {
    try { const contents = await fs.readFile(file); if (digest === null || hash(contents) !== digest) return false; }
    catch (error) { if (digest !== null || error.code !== 'ENOENT') return false; }
  }
  return true;
}

function packageName(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

function injectDependencyMap(html, dependency) {
  if (!dependency || !Object.keys(dependency.imports).length) return html;
  const tags = `<script type="importmap">${JSON.stringify({ imports: dependency.imports }).replace(/</g, '\\u003c')}</script>`
    + dependency.styles.map(href => `<link rel="stylesheet" href="${href}">`).join('');
  return /<head\b[^>]*>/i.test(html)
    ? html.replace(/<head\b[^>]*>/i, match => match + tags)
    : html.replace(/^(\s*<!doctype[^>]*>)?/i, (_match, doctype = '') => doctype + tags);
}

function dependencyImports(source, exportedNames) {
  let unsupported = false;
  for (const match of source.matchAll(/\bimport\s+([^;]+?)\s+from\s+["']([^"']+)["'];?/g)) {
    const [, clause, specifier] = match;
    if (clause.trim().startsWith('*')) { unsupported = true; continue; }
    const names = exportedNames.get(specifier) || new Set();
    const named = clause.match(/\{([^}]+)\}/)?.[1];
    if (named) for (const item of named.split(',')) names.add(item.trim().split(/\s+as\s+/)[0]);
    if (!clause.trim().startsWith('{')) names.add('default');
    exportedNames.set(specifier, names);
  }
  if (/\bimport\s*\(/.test(source)) unsupported = true;
  return !unsupported;
}

// No project code/configuration is evaluated by this compiler. Project JS is
// parsed by esbuild and runs only in the guarded browser after compilation.
async function compilePreview({ root, repositoryPath, cacheRoot, outputDirectories, onProgress = () => {}, onProcess, installDependencies }) {
  onProgress('Checking source files and preview cache…');
  root = await fs.realpath(root);
  repositoryPath = await fs.realpath(repositoryPath);
  outputDirectories ||= await localPreviewOutputDirectories(root);
  const sourceFiles = await files(root, root, outputDirectories);
  const sourceHash = crypto.createHash('sha256');
  for (const file of sourceFiles) {
    sourceHash.update(path.relative(root, file)).update('\0').update(await fs.readFile(file)).update('\0');
  }
  const recipe = await json(path.join(root, '.acorn/preview.json'), {});
  const responses = recipe.responses || {};
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) throw new Error('Preview responses must be an object.');
  for (const [key, response] of Object.entries(responses)) {
    if (!/^(GET|POST|PUT|PATCH|DELETE) \/[^\s]*$/.test(key) || !response || typeof response !== 'object') throw new Error('Invalid preview response: ' + key);
  }
  const pkg = await json(path.join(root, 'package.json'), {});
  const livePkg = await json(path.join(repositoryPath, 'package.json'), {});
  const key = hash([VERSION, esbuild.version, repositoryPath, sourceHash.digest('hex')].join('\0'));
  await fs.mkdir(cacheRoot, { recursive: true });
  const destination = path.join(cacheRoot, key);
  const previous = await json(path.join(destination, 'artifact.json'), null);
  const previousDependencyRoot = previous?.dependency?.key ? path.join(cacheRoot, 'dependencies', previous.dependency.key) : null;
  const previousDependencyManifest = previousDependencyRoot ? await json(path.join(previousDependencyRoot, 'dependency.json'), null) : null;
  const previousDependencyValid = !previous?.dependency || (previousDependencyManifest && await validateInputs(previousDependencyManifest.inputs));
  if (previous && previousDependencyValid && await validateInputs(previous.inputs)) {
    onProgress('Reusing cached preview…');
    await fs.utimes(path.join(destination, 'artifact.json'), new Date(), new Date());
    if (previousDependencyRoot) await fs.utimes(path.join(previousDependencyRoot, 'dependency.json'), new Date(), new Date());
    return { root: destination, cacheKey: key, cached: true, responses, warnings: previous.warnings, dependencyRoot: previousDependencyRoot, dependencyKey: previous.dependency?.key || null, dependencyCached: previousDependencyRoot ? true : null };
  }

  const inputs = {};
  const warnings = [];
  const declarations = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  const liveDeclarations = { ...livePkg.dependencies, ...livePkg.devDependencies, ...livePkg.optionalDependencies };
  let dependencyRepository = repositoryPath;
  const dependencySeed = crypto.createHash('sha256').update(JSON.stringify(Object.entries(declarations).sort()));
  // Resolve/install only if a source actually imports a package.
  let dependencyValidation;
  const requireDependencies = () => dependencyValidation ||= (async () => {
    const prepared = await prepareDependencies({ root, repositoryPath, cacheRoot, onProgress, onProcess, install: installDependencies });
    dependencyRepository = prepared.root;
    Object.assign(inputs, prepared.inputs);
    dependencySeed.update(prepared.key).update(JSON.stringify(prepared.inputs));
    warnings.push(prepared.isolated
      ? 'Uses this revision’s separately installed dependencies; package install scripts are disabled.'
      : 'Uses local installed dependencies; installed package contents are fingerprinted, not proven against registry integrity.');
  })();
  const work = await fs.mkdtemp(path.join(cacheRoot, '.building-'));
  try {
    onProgress('Copying preview source files…');
    for (const file of sourceFiles) {
      const relative = path.relative(root, file);
      const output = path.join(work, relative);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(file, output);
    }
    // Vite-style public assets are addressed from the site root.
    for (const file of sourceFiles.filter(file => inside(path.join(root, 'public'), file))) {
      const output = path.join(work, path.relative(path.join(root, 'public'), file));
      if (await fs.access(output).then(() => true, () => false)) continue;
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(file, output);
    }
    let htmlFiles = sourceFiles.filter(file => file.endsWith('.html') && !path.relative(root, file).startsWith('.'));
    let synthetic = null;
    if (!htmlFiles.length) {
      const entry = recipe.entry || ['src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx'].find(name => sourceFiles.includes(path.join(root, name)));
      if (!entry) throw require('./preview-availability.cjs').noPreviewScreen();
      if (isPreviewOutput(entry.replace(/^\.\//, ''), outputDirectories)) throw new Error('The preview entry points to generated output. Choose a browser source entry.');
      await checkedPath(root, path.resolve(root, entry));
      synthetic = '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/' + entry.replace(/[^\w./-]/g, '') + '"></script></body></html>';
      htmlFiles = [path.join(root, 'index.html')];
    }
    const dependencySpecifiers = new Set();
    const inputPlugin = ({ externalPackages = false, recordedInputs = inputs } = {}) => ({
      name: externalPackages ? 'acorn-external-dependencies' : 'acorn-read-only-inputs',
      setup(build) {
        build.onResolve({ filter: /.*/ }, async args => {
          if (args.pluginData?.resolved) return;
          // CSS fragment URLs reference SVG elements in the page, not packages.
          if (args.kind === 'url-token' && args.path.startsWith('#')) return { path: args.path, external: true };
          if (/^(https?:|file:|node:)/.test(args.path)) throw new Error('Unsupported external or server import: ' + args.path);
          const bare = !args.path.startsWith('.') && !path.isAbsolute(args.path);
          let request = args.path;
          let resolveDir = args.resolveDir;
          if (bare) {
            await requireDependencies();
            const name = packageName(args.path);
            if (dependencyRepository === repositoryPath && declarations[name] && declarations[name] !== liveDeclarations[name]) throw new Error('Missing historical dependency: ' + name);
            if (externalPackages) {
              if (!declarations[name]) throw new Error('Undeclared browser dependency: ' + name);
              dependencySpecifiers.add(args.path);
              return { path: args.path, external: true };
            }
            if (!inside(path.join(dependencyRepository, 'node_modules'), args.importer || '')) resolveDir = dependencyRepository;
          } else if (args.path.startsWith('/') && !inside(root, args.path) && !inside(repositoryPath, args.path)) {
            request = path.join(root, args.path.slice(1));
          }
          const resolved = await build.resolve(request, { resolveDir, kind: args.kind, importer: args.importer, pluginData: { resolved: true } });
          if (resolved.errors.length) return { errors: resolved.errors };
          if (resolved.external) throw new Error('External modules are unavailable in UI preview: ' + args.path);
          const real = await fs.realpath(resolved.path);
          if (inside(root, real) && isPreviewOutput(path.relative(root, real), outputDirectories)) throw new Error('Source imports generated output: ' + args.path + '. Use a source module instead.');
          if (!inside(root, real) && !inside(path.join(dependencyRepository, 'node_modules'), real)) throw new Error('Dependency is outside the selected repository: ' + args.path);
          if (/\.node$/.test(real)) throw new Error('Native modules are unavailable in UI preview.');
          if (!inside(root, real) || inside(path.join(dependencyRepository, 'node_modules'), real)) {
            await requireDependencies();
            let dir = path.dirname(real);
            while (inside(dependencyRepository, dir)) {
              const manifest = path.join(dir, 'package.json');
              const bytes = await fs.readFile(manifest).catch(() => null);
              if (bytes) recordedInputs[manifest] = hash(bytes);
              if (dir === dependencyRepository) break;
              dir = path.dirname(dir);
            }
          }
          return { path: real };
        });
        build.onLoad({ filter: /.*/ }, async args => {
          const contents = await fs.readFile(args.path);
          if (!inside(root, args.path) || inside(path.join(dependencyRepository, 'node_modules'), args.path)) recordedInputs[args.path] = hash(contents);
          if (/\.(css|scss|sass)$/.test(args.path) && /@(?:tailwind|apply)\b|@import\s+["']tailwindcss/.test(contents.toString())) throw new Error('Unsupported CSS transform: Tailwind requires a supported Acorn adapter.');
          return null;
        });
      },
    });
    const plugin = inputPlugin({ externalPackages: true });
    const dependencyExports = new Map();
    let sequence = 0;
    const compiledHtml = [];
    for (const htmlFile of htmlFiles) {
      let html = synthetic && htmlFile === path.join(root, 'index.html') ? synthetic : await fs.readFile(htmlFile, 'utf8');
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
      for (const match of scripts) {
        const src = match[1].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
        const module = /\btype\s*=\s*["']module["']/i.test(match[1]);
        if (!src && !module) continue;
        if (src && /^(https?:)?\/\//.test(src)) throw new Error('External script needs a local replacement: ' + src);
        const entry = src ? await checkedPath(root, path.resolve(src.startsWith('/') ? root : path.dirname(htmlFile), src.replace(/^\//, '').split('?')[0])) : null;
        if (entry && isPreviewOutput(path.relative(root, entry), outputDirectories)) throw new Error('The page references generated output: ' + src + '. Use a source script instead.');
        // Preserve classic script global scope and ordering (including Acorn's
        // own static UI); only module/typed entries require bundling.
        if (entry && !module && /\.js$/.test(entry)) continue;
        const name = 'entry-' + sequence++;
        const buildOptions = {
          ...(entry ? { entryPoints: [entry] } : { stdin: { contents: match[2], resolveDir: path.dirname(htmlFile), sourcefile: 'inline.js' } }),
          absWorkingDir: root, outfile: path.join(work, '_acorn', name + '.js'), bundle: true,
          // Do not let esbuild follow arbitrary tsconfig extends paths.
          tsconfigRaw: {},
          platform: 'browser', format: module ? 'esm' : 'iife', jsx: 'automatic',
          write: true, metafile: true, sourcemap: true, logLevel: 'silent',
          nodePaths: [path.join(dependencyRepository, 'node_modules')],
          define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.MODE': '"development"', 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false', 'import.meta.env.BASE_URL': '"/"' },
          loader: { '.png': 'file', '.jpg': 'file', '.jpeg': 'file', '.svg': 'file', '.webp': 'file', '.gif': 'file', '.woff': 'file', '.woff2': 'file' },
          assetNames: 'assets/[name]-[hash]', publicPath: '/_acorn/', plugins: module ? [plugin] : [inputPlugin()],
        };
        onProgress('Building preview…');
        let result = await esbuild.build(buildOptions);
        if (module && !dependencyImports(await fs.readFile(path.join(work, '_acorn', name + '.js'), 'utf8'), dependencyExports)) {
          // Namespace and dynamic imports need the package's complete export
          // shape, which cannot be represented safely by a generated import map.
          await Promise.all(Object.keys(result.metafile.outputs).map(file => fs.rm(path.resolve(root, file), { force: true })));
          result = await esbuild.build({ ...buildOptions, plugins: [inputPlugin()] });
        }
        const css = Object.keys(result.metafile.outputs).some(file => file.endsWith(name + '.css'));
        html = html.replace(match[0], `${css ? '<link rel="stylesheet" href="/_acorn/' + name + '.css">' : ''}<script${module ? ' type="module"' : ''} src="/_acorn/${name}.js"></script>`);
      }
      compiledHtml.push({ htmlFile, html });
    }
    let dependency = null;
    if (dependencySpecifiers.size) {
      const specifiers = [...dependencySpecifiers].sort();
      const exportSignature = specifiers.map(specifier => [specifier, [...(dependencyExports.get(specifier) || [])].sort()]);
      // Keep the cache repository-scoped: identical lockfiles can still point
      // at different workspace/file dependencies on disk.
      const dependencyKey = hash([VERSION, esbuild.version, repositoryPath, dependencySeed.copy().digest('hex'), JSON.stringify(exportSignature)].join('\0'));
      const dependencyCacheRoot = path.join(cacheRoot, 'dependencies');
      const dependencyRoot = path.join(dependencyCacheRoot, dependencyKey);
      const manifestFile = path.join(dependencyRoot, 'dependency.json');
      let dependencyManifest = await json(manifestFile, null);
      let dependencyCached = Boolean(dependencyManifest && await validateInputs(dependencyManifest.inputs));
      onProgress(dependencyCached ? 'Reusing cached library bundle…' : 'Building library bundle…');
      if (!dependencyCached) {
        await fs.mkdir(dependencyCacheRoot, { recursive: true });
        const dependencyWork = await fs.mkdtemp(path.join(dependencyCacheRoot, '.building-'));
        const dependencyInputs = {};
        try {
          const virtualEntries = Object.fromEntries(specifiers.map((_, index) => [`d${index}`, `acorn-dependency:${index}`]));
          const virtualPlugin = {
            name: 'acorn-dependency-entries',
            setup(build) {
              build.onResolve({ filter: /^acorn-dependency:/ }, args => ({ path: args.path, namespace: 'acorn-dependency' }));
              build.onLoad({ filter: /.*/, namespace: 'acorn-dependency' }, args => {
                const index = Number(args.path.split(':').at(-1));
                const specifier = specifiers[index];
                const names = [...(dependencyExports.get(specifier) || [])].filter(name => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name));
                const locals = names.map((name, exportIndex) => `const exported${exportIndex} = dependency.${name} ?? value?.${name};`).join('\n');
                const exports = names.length ? `export { ${names.map((name, exportIndex) => `exported${exportIndex} as ${name}`).join(', ')} };` : '';
                return { contents: `import * as dependency from ${JSON.stringify(specifier)}; const value = dependency.default ?? dependency; export default value;\n${locals}\n${exports}`, loader: 'js', resolveDir: dependencyRepository };
              });
            },
          };
          const result = await esbuild.build({
            absWorkingDir: dependencyRepository, entryPoints: virtualEntries, outdir: dependencyWork,
            bundle: true, splitting: true, platform: 'browser', format: 'esm', write: true,
            metafile: true, sourcemap: true, logLevel: 'silent', tsconfigRaw: {},
            entryNames: '[name]-[hash]', chunkNames: 'chunks/[name]-[hash]', assetNames: 'assets/[name]-[hash]',
            publicPath: `/_acorn_deps/${dependencyKey}/`,
            loader: { '.png': 'file', '.jpg': 'file', '.jpeg': 'file', '.svg': 'file', '.webp': 'file', '.gif': 'file', '.woff': 'file', '.woff2': 'file' },
            define: { 'process.env.NODE_ENV': '"development"' },
            plugins: [virtualPlugin, inputPlugin({ recordedInputs: dependencyInputs })],
          });
          const outputFiles = Object.entries(result.metafile.outputs);
          const imports = {};
          const styles = [];
          for (let index = 0; index < specifiers.length; index++) {
            const [output, metadata] = outputFiles.find(([file, data]) => data.entryPoint && path.basename(file).startsWith(`d${index}-`) && file.endsWith('.js')) || [];
            if (!output) throw new Error('Could not create shared dependency entry: ' + specifiers[index]);
            // Metafile paths are relative to esbuild's absWorkingDir, not the
            // Electron process cwd. Resolve before making public cache URLs.
            imports[specifiers[index]] = `/_acorn_deps/${dependencyKey}/${path.relative(dependencyWork, path.resolve(dependencyRepository, output)).split(path.sep).join('/')}`;
            if (metadata.cssBundle) styles.push(`/_acorn_deps/${dependencyKey}/${path.relative(dependencyWork, path.resolve(dependencyRepository, metadata.cssBundle)).split(path.sep).join('/')}`);
          }
          dependencyManifest = { key: dependencyKey, imports, styles: [...new Set(styles)], inputs: dependencyInputs };
          await fs.writeFile(path.join(dependencyWork, 'dependency.json'), JSON.stringify(dependencyManifest));
          await fs.rm(dependencyRoot, { recursive: true, force: true });
          await fs.rename(dependencyWork, dependencyRoot);
        } catch (error) { await fs.rm(dependencyWork, { recursive: true, force: true }); throw error; }
      } else await fs.utimes(manifestFile, new Date(), new Date());
      dependency = { ...dependencyManifest, root: dependencyRoot, cached: dependencyCached };
    }
    onProgress('Saving preview files…');
    for (const { htmlFile, html } of compiledHtml) await fs.writeFile(path.join(work, path.relative(root, htmlFile)), injectDependencyMap(html, dependency));
    const liveManifest = await fs.readFile(path.join(repositoryPath, 'package.json')).catch(() => null);
    if (liveManifest) inputs[path.join(repositoryPath, 'package.json')] = hash(liveManifest);
    await fs.writeFile(path.join(work, 'artifact.json'), JSON.stringify({ key, inputs, warnings, dependency: dependency && { key: dependency.key, imports: dependency.imports, styles: dependency.styles } }));
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(work, destination);
    return { root: destination, cacheKey: key, cached: false, responses, warnings, dependencyRoot: dependency?.root || null, dependencyKey: dependency?.key || null, dependencyCached: dependency?.cached ?? null };
  } catch (error) {
    await fs.rm(work, { recursive: true, force: true });
    // One actionable install error instead of the same failure for every import.
    if (dependencyValidation) await dependencyValidation;
    throw error;
  }
}
module.exports = { compilePreview, files, hash, validateInputs };

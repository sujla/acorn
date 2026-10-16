const generatedDirectories = ['dist', 'build', '.next', '.nuxt', '.output', 'coverage', 'node_modules', '.cache', '.turbo'];
const generatedPatterns = ['**/*.min.js', '**/*.min.css', '**/*.js.map', '**/*.css.map', '**/*.tsbuildinfo'];
const mediaExtensions = new Set([
  'aac', 'apng', 'avif', 'avi', 'bmp', 'flac', 'gif', 'heic', 'heif', 'ico',
  'jpeg', 'jpg', 'm4a', 'm4v', 'mkv', 'mov', 'mp3', 'mp4', 'mpeg', 'mpg',
  'oga', 'ogg', 'ogv', 'opus', 'png', 'tif', 'tiff', 'wav', 'webm', 'webp',
]);
const mediaPatterns = [...mediaExtensions].map(extension => `**/*.${extension}`);
function isMediaFile(file) {
  const extension = file.split('.').at(-1)?.toLowerCase();
  return Boolean(extension && mediaExtensions.has(extension));
}
function isGeneratedFile(file, outputDirectories = []) {
  return outputDirectories.some(directory => file === directory || file.startsWith(directory + '/')) || file.split('/').some(part => generatedDirectories.includes(part)) || /(?:\.min\.(?:js|css)|\.(?:js|css)\.map|\.tsbuildinfo)$/.test(file);
}
function diffPathspecs(outputDirectories = []) {
  return [
    ...[...generatedDirectories.map(dir => `**/${dir}/**`), ...generatedPatterns].map(pattern => `:(glob,exclude)${pattern}`),
    ...mediaPatterns.map(pattern => `:(glob,icase,exclude)${pattern}`),
    ...outputDirectories.map(directory => `:(exclude,literal)${directory}`),
  ];
}

// Retain declarations per rule so labels describe changed properties, not
// every property sharing the same modified line or neighboring CSS rule.
function cssRuleChanges(hunk) {
  function parse(marker) {
    const lines = hunk.filter(line => line[0] === ' ' || line[0] === marker);
    let offset = 0;
    const changedRanges = [];
    const source = lines.map(line => {
      const text = line.slice(1);
      if (line[0] === marker) changedRanges.push([offset, offset + text.length]);
      offset += text.length + 1;
      return text;
    }).join('\n');
    const rules = new Map();
    const stack = [];
    let pending = '';
    let changed = false;
    const rule = () => {
      const selector = stack.at(-1);
      if (!selector || !/[.#\[]/.test(selector) || /[@&$]/.test(selector)) return null;
      const key = JSON.stringify(stack);
      if (!rules.has(key)) rules.set(key, { value: selector, properties: new Map(), changed: false });
      return rules.get(key);
    };
    const declaration = () => {
      const match = pending.trim().match(/^(--[\w-]+|[a-zA-Z][\w-]*)\s*:\s*([\s\S]+)$/);
      const current = rule();
      if (!match || !current) return;
      const property = match[1].startsWith('--') ? match[1] : match[1].toLowerCase();
      const values = current.properties.get(property) || [];
      values.push(match[2].trim());
      current.properties.set(property, values);
      current.changed ||= changed;
    };
    const tokens = /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{};]|[^{};"'/]+|[\s\S]/g;
    for (const token of source.matchAll(tokens)) {
      const text = token[0];
      if (text.startsWith('/*')) { pending += ' '; continue; }
      const touched = Boolean(text.trim()) && changedRanges.some(([start, end]) => token.index < end && token.index + text.length > start);
      if (text === '{') {
        stack.push(pending.trim());
        const current = rule();
        if (current) current.changed ||= changed || touched;
        pending = ''; changed = false;
      } else if (text === ';' || text === '}') {
        declaration();
        if (text === '}') stack.pop();
        pending = ''; changed = false;
      } else {
        pending += text;
        changed ||= touched;
      }
    }
    declaration();
    return rules;
  }
  const base = parse('-');
  const target = parse('+');
  const result = { base: [], target: [] };
  for (const key of new Set([...base.keys(), ...target.keys()])) {
    const before = base.get(key);
    const after = target.get(key);
    if (!before?.changed && !after?.changed) continue;
    const changes = [...new Set([...(before?.properties.keys() || []), ...(after?.properties.keys() || [])])]
      .filter(property => JSON.stringify(before?.properties.get(property)) !== JSON.stringify(after?.properties.get(property)));
    if (before) result.base.push({ kind: 'selector', value: before.value, changes });
    if (after) result.target.push({ kind: 'selector', value: after.value, changes });
  }
  return result;
}

// Conservative hints only: source changes cannot universally identify rendered elements.
function extractOverlayHints(patch, outputDirectories = []) {
  const hints = { base: [], target: [] };
  let file = '';
  let hunk = [];
  function flush() {
    if (!hunk.some((line) => /^[+-]/.test(line))) { hunk = []; return; }
    if (isGeneratedFile(file, outputDirectories) || !/\.(?:html?|[cm]?[jt]sx?|vue|svelte|css|scss|less)$/i.test(file)) { hunk = []; return; }
    const cssChanges = /\.(?:css|scss|less)$/i.test(file) ? cssRuleChanges(hunk) : null;
    for (const side of ['base', 'target']) {
      const marker = side === 'base' ? '-' : '+';
      const source = hunk.filter(line => line[0] === marker).map(line => line.slice(1)).join('\n');
      const candidates = [];
      for (const match of source.matchAll(/\b(id|class|className|data-testid|aria-label)\s*=\s*["']([^"'\n]+)["']/g)) {
        const attr = match[1] === 'className' ? 'class' : match[1];
        if (/[{}$]/.test(match[2])) continue;
        candidates.push({ kind: 'attribute', attribute: attr, value: match[2] });
      }
      for (const match of source.matchAll(/>\s*([^<>{}\n]{2,160})\s*</g)) candidates.push({ kind: 'text', value: match[1].trim() });
      if (cssChanges) candidates.push(...cssChanges[side]);
      for (const candidate of candidates) {
        const hint = { ...candidate, file };
        if (hints[side].length < 500 && !hints[side].some((old) => JSON.stringify(old) === JSON.stringify(hint))) hints[side].push(hint);
      }
    }
    hunk = [];
  }
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) { flush(); file = ''; }
    else if (line.startsWith('+++ b/')) file = line.slice(6);
    else if (line.startsWith('--- a/') && !file) file = line.slice(6);
    else if (line.startsWith('@@')) flush();
    else if (/^[ +\-]/.test(line) && !/^(---|\+\+\+)/.test(line)) hunk.push(line);
  }
  flush();
  return hints;
}
function comparisonRefs(baseSha, targetSha) {
  const baseWorking = baseSha === '__working_tree__';
  const targetWorking = targetSha === '__working_tree__';
  return {
    refs: baseWorking && targetWorking ? ['HEAD', 'HEAD'] : baseWorking && !targetWorking ? ['-R', targetSha] : targetWorking && !baseWorking ? [baseSha] : [baseSha, targetSha],
    baseWorking, targetWorking,
  };
}
module.exports = { extractOverlayHints, comparisonRefs, isGeneratedFile, isMediaFile, diffPathspecs };

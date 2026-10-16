// Preview-local storage. Never reads or writes the connected project's files.
// Each iframe has its own store; reloading the preview clears it.
const entries = new Map([
  ['acorn-preview:///documents', { directory: true }],
  ['acorn-preview:///cache', { directory: true }],
  ['acorn-preview:///bundle', { directory: true }],
]);
const external = uri => /^(blob:|data:)/.test(uri);
function join(...parts) {
  const values = parts.map(part => typeof part === 'string' ? part : part._path || part.uri);
  if (values.length === 1 && external(values[0])) return values[0];
  const value = values.join('/');
  if (!value.startsWith('acorn-preview:///')) throw new Error('Acorn preview cannot access device files: ' + value);
  const segments = [];
  for (const part of value.slice('acorn-preview:///'.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (segments.length <= 1) throw new Error('Invalid preview path'); segments.pop(); }
    else segments.push(part);
  }
  return 'acorn-preview:///' + segments.join('/');
}
function parent(uri) { return uri.slice(0, uri.lastIndexOf('/')); }
function ensureParent(uri, intermediates) {
  const directory = parent(uri);
  if (!entries.has(directory) && intermediates) new Directory(directory).create({ intermediates: true });
  if (!entries.get(directory)?.directory) throw new Error('Preview parent directory does not exist');
}
class Entry {
  constructor(...parts) { this._path = join(...parts); }
  get uri() { return this._path; }
  get name() { return this._path.split('/').pop(); }
  get parentDirectory() { return new Directory(parent(this._path)); }
  delete() {
    if (!entries.has(this._path)) throw new Error('Preview entry does not exist');
    for (const key of entries.keys()) if (key === this._path || key.startsWith(this._path + '/')) entries.delete(key);
  }
}
export class Directory extends Entry {
  get exists() { return entries.get(this._path)?.directory === true; }
  create(options = {}) {
    if (external(this._path)) throw new Error('Cannot create an external directory');
    if (entries.has(this._path)) {
      if (options.idempotent && this.exists) return;
      throw new Error('Preview entry already exists');
    }
    ensureParent(this._path, options.intermediates);
    entries.set(this._path, { directory: true });
  }
  list() {
    if (!this.exists) throw new Error('Preview directory does not exist');
    return [...entries].filter(([key]) => parent(key) === this._path)
      .map(([key, item]) => item.directory ? new Directory(key) : new File(key));
  }
}
export class File extends Entry {
  get exists() { return external(this._path) || entries.get(this._path)?.directory === false; }
  get uri() { return entries.get(this._path)?.source || this._path; }
  create(options = {}) {
    if (external(this._path)) throw new Error('Cannot write an external file');
    if (entries.has(this._path) && (!options.overwrite || entries.get(this._path).directory)) throw new Error('Preview entry already exists');
    ensureParent(this._path, options.intermediates);
    entries.set(this._path, { directory: false, text: '' });
  }
  write(value) {
    if (typeof value !== 'string') throw new Error('Acorn preview file writes currently support text only');
    if (external(this._path)) throw new Error('Cannot write an external file');
    if (!this.exists) this.create();
    entries.set(this._path, { directory: false, text: value });
  }
  textSync() {
    const entry = entries.get(this._path);
    if (!entry || entry.directory || entry.source) throw new Error('Preview file is not available as synchronous text');
    return entry.text;
  }
  async text() {
    if (external(this.uri)) return (await fetch(this.uri)).text();
    return this.textSync();
  }
  copy(destination) {
    const target = destination instanceof Directory ? new File(destination, this.name) : destination instanceof File ? destination : new File(destination);
    if (!this.exists) throw new Error('Preview source file does not exist');
    if (external(target._path)) throw new Error('Cannot write an external file');
    ensureParent(target._path, false);
    if (entries.has(target._path)) throw new Error('Preview destination already exists');
    entries.set(target._path, external(this.uri)
      ? { directory: false, source: this.uri }
      : { ...entries.get(this._path) });
  }
}
export const Paths = {
  get document() { return new Directory('acorn-preview:///documents'); },
  get cache() { return new Directory('acorn-preview:///cache'); },
  get bundle() { return new Directory('acorn-preview:///bundle'); },
  join,
};

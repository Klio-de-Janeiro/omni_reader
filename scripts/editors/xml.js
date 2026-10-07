import JSZip from 'jszip';
import xmljs from '../../vendor-sources/xml-js/lib/index.js';
export const local = node => node.name?.split(':').at(-1);
export const elements = node => (node.elements || []).filter(item => item.type === 'element');
export const textOf = node => (node?.elements || []).map(child => child.type === 'text' || child.type === 'cdata' ? child.text ?? child.cdata : textOf(child)).join('');
export const node = (name, attributes = {}, children = []) => ({ type: 'element', name, attributes, elements: children });
export const textNode = text => ({ type: 'text', text });
export const attr = (item, key) => item?.attributes?.[key];
export const qualified = (parent, name) => parent.name.includes(':') ? parent.name.split(':')[0] + ':' + name : name;

/** Walk inert XML while retaining each node and its parent for exact updates. */
export function walk(root, visit, parent = null) {
  for (const item of root.elements || []) { if (item.type === 'element') { visit(item, root); walk(item, visit, root); } }
}
export function all(root, name) { const items = []; walk(root, item => { if (local(item) === name) items.push(item); }); return items; }
export function parse(text) { return xmljs.xml2js(text, { compact: false, ignoreDoctype: true }); }
export function serialize(tree) { return xmljs.js2xml(tree, { compact: false }); }

/** Keep untouched ZIP entries byte-identical after decompression. */
export class Package {
  static async open(bytes) {
    const pack = new Package(); pack.zip = await JSZip.loadAsync(bytes); pack.parts = new Map();
    if (Object.keys(pack.zip.files).some(name => name.startsWith('_xmlsignatures/'))) throw new Error('Редактирование подписанного Office-файла не поддерживается.');
    return pack;
  }
  async read(path) {
    if (!this.parts.has(path)) {
      if (!this.zip.file(path)) throw new Error(`В документе нет части ${path}.`);
      this.parts.set(path, parse(await this.zip.file(path).async('string')));
    }
    return this.parts.get(path);
  }
  async export(paths) {
    const output = this.copy();
    for (const path of paths) {
      if (this.parts.has(path)) output.file(path, serialize(this.parts.get(path)), { createFolders: false });
      else output.remove(path);
    }
    return output.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }
  copy() { const output = this.zip.clone(); output.files = Object.assign(Object.create(null), this.zip.files); return output; }
}

export function resolvePart(base, target) {
  if (!target || /[:\\]/.test(target)) throw new Error('Недопустимая ссылка Office.');
  const parts = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const item of target.split('/')) {
    if (item === '..') { if (!parts.length) throw new Error('Недопустимый путь Office.'); parts.pop(); }
    else if (item && item !== '.') parts.push(item);
  }
  return parts.join('/');
}

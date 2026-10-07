import JSZip from 'jszip';
import xmljs from '../vendor-sources/xml-js/lib/index.js';
import { parseAddress } from '../dist/table-core.js';
const MAX_CELLS = 500000;
/** Parse OOXML as inert XML data with no browser DOM or external entities. */
function xml(text) {
  const parsed = xmljs.xml2js(text, { compact: false, ignoreComment: true, ignoreDoctype: true });
  const root = parsed.elements?.find(node => node.type === 'element');
  if (!root) throw new Error('Пустой XML в XLSX.');
  return root;
}
function nodes(root, name) {
  const result = [];
  function visit(node) {
    for (const child of node.elements || []) {
      if (child.type !== 'element') continue;
      if (child.name.split(':').at(-1) === name) result.push(child);
      visit(child);
    }
  }
  visit(root);
  return result;
}
const attr = (node, name) => node?.attributes?.[name] ?? null;
const xmlText = node => (node?.elements || []).map(child => child.type === 'text' ? child.text : child.type === 'cdata' ? child.cdata : xmlText(child)).join('');
const childText = (node, name) => xmlText(nodes(node, name)[0]);
function resolvePart(base, target) {
  const segments = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '..') segments.pop();
    else if (part && part !== '.') segments.push(part);
  }
  const result = segments.join('/');
  if (!result.startsWith('xl/')) throw new Error('Недопустимая ссылка на лист XLSX.');
  return result;
}
/** Read values and cached formulas from worksheets; formulas are never executed. */
export async function readWorkbook(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  async function read(path) {
    const entry = zip.file(path);
    if (!entry) throw new Error(`В XLSX отсутствует ${path}.`);
    return xml(await entry.async('string'));
  }
  const workbook = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const map = new Map(nodes(rels, 'Relationship').filter(rel => attr(rel, 'TargetMode') !== 'External').map(rel => [attr(rel, 'Id'), resolvePart('xl/workbook.xml', attr(rel, 'Target'))]));
  const strings = zip.file('xl/sharedStrings.xml') ? nodes(await read('xl/sharedStrings.xml'), 'si').map(item => nodes(item, 't').map(node => xmlText(node)).join('')) : [];
  let formats = [], customFormats = new Map();
  if (zip.file('xl/styles.xml')) {
    const styles = await read('xl/styles.xml');
    customFormats = new Map(nodes(styles, 'numFmt').map(node => [Number(attr(node, 'numFmtId')), attr(node, 'formatCode')]));
    const cellXfs = nodes(styles, 'cellXfs')[0];
    formats = cellXfs ? (cellXfs.elements || []).filter(node => node.type === 'element').map(node => Number(attr(node, 'numFmtId'))) : [];
  }
  const epoch1904 = ['1', 'true'].includes(attr(nodes(workbook, 'workbookPr')[0], 'date1904'));
  let total = 0;
  const sheets = [];
  for (const node of nodes(workbook, 'sheet')) {
    const relId = attr(node, 'r:id') || Object.entries(node.attributes || {}).find(([key]) => key.endsWith(':id'))?.[1];
    const path = map.get(relId);
    if (!path) continue;
    if (sheets.length >= 100) throw new Error('Лимит XLSX: 100 листов.');
    const doc = await read(path), cells = new Map();
    let rowCount = 1, colCount = 1;
    for (const cell of nodes(doc, 'c')) {
      if (++total > MAX_CELLS) throw new Error('Лимит XLSX: 500 000 заполненных ячеек.');
      const address = attr(cell, 'r'); if (!address) continue;
      const at = parseAddress(address), type = attr(cell, 't');
      const raw = childText(cell, 'v'), formula = childText(cell, 'f');
      const format = formats[Number(attr(cell, 's') || 0)] || 0;
      let text = raw;
      if (type === 's') text = strings[Number(raw)] ?? '';
      else if (type === 'inlineStr') text = nodes(cell, 't').map(part => xmlText(part)).join('');
      else if (type === 'b') text = raw === '1' ? 'TRUE' : 'FALSE';
      else if (raw && !['str', 'e', 'd'].includes(type)) {
        const value = Number(raw);
        const custom = customFormats.get(format) || '';
        const isDate = (format >= 14 && format <= 22) || (format >= 45 && format <= 47) || /[yd]/i.test(custom.replace(/"[^"]*"|\[[^\]]*\]/g, ''));
        if (isDate && Number.isFinite(value)) {
          const millis = Date.UTC(epoch1904 ? 1904 : 1899, epoch1904 ? 0 : 11, epoch1904 ? 1 : 30) + value * 86400000;
          const date = new Date(millis);
          if (Number.isFinite(date.getTime())) text = date.toISOString().replace('T', ' ').replace(/\.000Z$/, '').replace(/ 00:00:00$/, '');
        } else if ((format === 9 || format === 10 || custom.includes('%')) && Number.isFinite(value)) text = `${(value * 100).toFixed(format === 9 ? 0 : 2)}%`;
        else if (format === 2 && Number.isFinite(value)) text = value.toFixed(2);
      }
      if (formula && !raw) text = '(нет сохранённого результата)';
      cells.set(`${at.row}:${at.col}`, { text, raw, formula: formula ? '=' + formula : '' });
      rowCount = Math.max(rowCount, at.row + 1); colCount = Math.max(colCount, at.col + 1);
    }
    const merges = nodes(doc, 'mergeCell').map(node => attr(node, 'ref')).filter(Boolean);
    sheets.push({ name: attr(node, 'name') || `Лист ${sheets.length + 1}`, hidden: attr(node, 'state') === 'hidden', entries: [...cells.entries()].map(([key, value]) => { const [row, col] = key.split(':').map(Number); return { row, col, text: value.text }; }), rows: rowCount, cols: colCount, merges, cell: (row, col) => cells.get(`${row}:${col}`) || { text: '', raw: '', formula: '' } });
  }
  if (!sheets.length) throw new Error('В книге нет доступных листов.');
  return sheets;
}

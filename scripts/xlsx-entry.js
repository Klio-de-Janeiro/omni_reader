import JSZip from 'jszip';
import xmljs from '../vendor-sources/xml-js/lib/index.js';
import { parseAddress, columnName } from '../dist/table-core.js';
import { pdfNumber } from '../dist/pdf-table-core.js';
const MAX_CELLS = 500000;
const escapeXml = value => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** Create an inert OOXML workbook; PDF strings never become executable formulas. */
export async function writeWorkbook(sheets) {
  if (!Array.isArray(sheets) || !sheets.length || sheets.length>100) throw new Error('Книга должна содержать от 1 до 100 листов.');
  const zip = new JSZip(), names = new Set(), relationships = [], contentTypes = [], workbook = [];
  let total = 0;
  for (const [index,sheet] of sheets.entries()) {
    if (typeof sheet.name!=='string' || !sheet.name || sheet.name.length>31 || /[\\/\[\]:*?]/.test(sheet.name) || names.has(sheet.name.toLowerCase()) || !Array.isArray(sheet.rows) || sheet.rows.length>1048576) throw new Error('Неверное имя или размер листа Excel.');
    names.add(sheet.name.toLowerCase());
    const widths = [], rows = [];
    for (const [r,row] of sheet.rows.entries()) {
      if (!Array.isArray(row) || row.length>512) throw new Error('Лимит Excel: 512 столбцов.');
      const cells = [];
      for (const [col,input] of row.entries()) {
        const value = String(input ?? ''); if (!value) continue;
        if (value.length>32767 || ++total>MAX_CELLS) throw new Error('Лимит Excel: 500 000 ячеек, до 32767 символов в ячейке.');
        widths[col] = Math.max(widths[col] || 12,Math.min(48,value.length+2));
        const address = columnName(col)+(r+1), number = pdfNumber(value);
        cells.push(number===null ? `<c r="${address}" t="inlineStr" s="1"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>` : `<c r="${address}"><v>${number}</v></c>`);
      }
      rows.push(`<row r="${r+1}">${cells.join('')}</row>`);
    }
    const id = index+1, filename = `xl/worksheets/sheet${id}.xml`;
    const columns = Array.from({length:widths.length},(_,col) => `<col min="${col+1}" max="${col+1}" width="${widths[col] || 12}" customWidth="1"/>`).join('');
    zip.file(filename,declaration+`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews>${columns ? '<cols>'+columns+'</cols>' : ''}<sheetData>${rows.join('')}</sheetData></worksheet>`);
    workbook.push(`<sheet name="${escapeXml(sheet.name)}" sheetId="${id}" r:id="rId${id}"/>`);
    relationships.push(`<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${id}.xml"/>`);
    contentTypes.push(`<Override PartName="/${filename}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  }
  zip.file('xl/workbook.xml',declaration+`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbook.join('')}</sheets></workbook>`);
  relationships.push('<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
  zip.file('xl/_rels/workbook.xml.rels',declaration+`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`);
  zip.file('_rels/.rels',declaration+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('[Content_Types].xml',declaration+`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${contentTypes.join('')}</Types>`);
  zip.file('xl/styles.xml',declaration+'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  return new Blob([await zip.generateAsync({type:'uint8array',compression:'DEFLATE'})],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
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

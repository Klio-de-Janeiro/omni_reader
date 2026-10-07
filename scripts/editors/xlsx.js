import { History, checkedText } from '../../dist/editors/history.js';
import { parseAddress, columnName } from '../../dist/table-core.js';
import { Package, all, elements, local, attr, textOf, node, textNode, qualified, resolvePart, serialize } from './xml.js';

function canonical(address) { const at = parseAddress(address); return columnName(at.col) + (at.row + 1); }
function inRange(address, range) {
  const at = parseAddress(address), [first, last = first] = range.split(':').map(parseAddress);
  return at.row >= first.row && at.row <= last.row && at.col >= first.col && at.col <= last.col;
}
/** Mutate cells without rebuilding styles, media, shared strings or workbook layout. */
export async function openXlsxEditor(bytes) {
  const pack = await Package.open(bytes), history = new History();
  const workbookPath = 'xl/workbook.xml', relPath = 'xl/_rels/workbook.xml.rels';
  const workbook = await pack.read(workbookPath), rels = await pack.read(relPath);
  const relations = all(rels, 'Relationship').filter(item => attr(item, 'TargetMode') !== 'External');
  const targets = new Map(relations.map(item => [attr(item, 'Id'), resolvePart(workbookPath, attr(item, 'Target'))]));
  const shared = pack.zip.file('xl/sharedStrings.xml') ? all(await pack.read('xl/sharedStrings.xml'), 'si').map(item => all(item, 't').map(textOf).join('')) : [];
  const sheets = []; let cellCount = 0;
  for (const sheet of all(workbook, 'sheet')) {
    const path = targets.get(attr(sheet, 'r:id')); if (!path) continue;
    if (sheets.length >= 100) throw new Error('Лимит редактора: 100 листов.');
    const tree = await pack.read(path), data = all(tree, 'sheetData')[0];
    if (!data) continue;
    const cells = new Map(all(data, 'c').map(cell => [attr(cell, 'r'), cell]));
    cellCount += cells.size; if (cellCount > 500000) throw new Error('Лимит редактора: 500 000 ячеек.');
    const special = all(data, 'f').filter(item => ['array', 'shared', 'dataTable'].includes(attr(item, 't')));
    sheets.push({ name: attr(sheet, 'name'), path, tree, data, cells, protected: all(tree, 'sheetProtection').length > 0,
      blocked: special.map(item => attr(item, 'ref')).filter(Boolean), merges: all(tree, 'mergeCell').map(item => attr(item, 'ref')).filter(Boolean) });
  }
  if (!sheets.length) throw new Error('В книге нет обычных листов.');
  const changed = new Set();
  function getCell(sheetIndex, address) {
    const sheet = sheets[sheetIndex]; if (!sheet) throw new Error('Лист не найден.');
    const cell = sheet.cells.get(canonical(address)); if (!cell) return { value: '', type: 'text' };
    const f = elements(cell).find(item => local(item) === 'f'), v = textOf(elements(cell).find(item => local(item) === 'v'));
    if (f) return { value: '=' + textOf(f), type: 'formula' };
    const type = attr(cell, 't');
    if (type === 's') return { value: shared[Number(v)] || '', type: 'text' };
    if (type === 'inlineStr') return { value: all(cell, 't').map(textOf).join(''), type: 'text' };
    if (type === 'b') return { value: v === '1' ? 'TRUE' : 'FALSE', type: 'boolean' };
    return { value: v, type: ['str', 'e', 'd'].includes(type) ? 'text' : 'number' };
  }
  function install(sheet, address, cell) {
    sheet.data.elements ||= [];
    const at = parseAddress(address); let row = elements(sheet.data).find(item => local(item) === 'row' && Number(attr(item, 'r')) === at.row + 1);
    if (!row && cell) {
      row = node(qualified(sheet.data, 'row'), { r: String(at.row + 1) });
      const next = sheet.data.elements.findIndex(item => local(item) === 'row' && Number(attr(item, 'r')) > at.row + 1);
      sheet.data.elements.splice(next < 0 ? sheet.data.elements.length : next, 0, row);
    }
    if (!row) return;
    const old = row.elements?.findIndex(item => local(item) === 'c' && attr(item, 'r') === address) ?? -1;
    if (old >= 0) row.elements.splice(old, 1);
    if (cell) {
      const next = (row.elements || []).findIndex(item => local(item) === 'c' && parseAddress(attr(item, 'r')).col > at.col);
      row.elements ||= []; row.elements.splice(next < 0 ? row.elements.length : next, 0, cell); sheet.cells.set(address, cell);
    } else sheet.cells.delete(address);
    changed.add(sheet.path);
  }
  return {
    history, sheets, getCell,
    setCell(sheetIndex, address, value, type = 'text') {
      const sheet = sheets[sheetIndex]; if (!sheet) throw new Error('Лист не найден.');
      address = canonical(address); value = checkedText(value);
      if (sheet.protected) throw new Error('Редактирование защищённого листа пока не поддерживается.');
      const current = sheet.cells.get(address), f = current && elements(current).find(item => local(item) === 'f');
      if (sheet.blocked.some(range => inRange(address, range)) || (f && attr(f, 't') && attr(f, 't') !== 'normal')) throw new Error('Ячейка входит в общую или массивную формулу. Её изменение пока не поддерживается.');
      if (sheet.merges.some(range => inRange(address, range) && address !== canonical(range.split(':')[0]))) throw new Error('Изменяйте верхнюю левую ячейку объединённого диапазона.');
      const old = getCell(sheetIndex, address); if (old.value === value && old.type === type) return;
      if (!current && sheets.reduce((n, item) => n + item.cells.size, 0) >= 500000) throw new Error('Лимит редактора: 500 000 ячеек.');
      const before = current ? structuredClone(current) : null;
      const after = before ? structuredClone(before) : node(qualified(sheet.data, 'c'), { r: address });
      after.attributes ||= {}; delete after.attributes.t;
      after.elements = (after.elements || []).filter(item => !['f', 'v', 'is'].includes(local(item)));
      const make = (name, children) => node(qualified(after, name), {}, children);
      let content;
      if (type === 'text') { after.attributes.t = 'inlineStr'; content = make('is', [node(qualified(after, 't'), { 'xml:space': 'preserve' }, [textNode(value)])]); }
      else if (type === 'number') {
        if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) || !Number.isFinite(Number(value))) throw new Error('Введите число с точкой, например 12.5.');
        content = make('v', [textNode(String(Number(value)))]);
      } else if (type === 'boolean') {
        if (!/^(true|false|1|0)$/i.test(value)) throw new Error('Введите TRUE или FALSE.');
        after.attributes.t = 'b'; content = make('v', [textNode(/^(true|1)$/i.test(value) ? '1' : '0')]);
      } else if (type === 'formula') {
        value = value.replace(/^=/, '').trim(); if (!value || /[\r\n]/.test(value)) throw new Error('Введите формулу, например =SUM(B2:B5).');
        content = make('f', [textNode(value)]);
      } else if (type !== 'empty') throw new Error('Неизвестный тип ячейки.');
      if (content) after.elements.unshift(content);
      history.execute(() => install(sheet, address, structuredClone(after)), () => install(sheet, address, before && structuredClone(before)));
    },
    async export() {
      const output = pack.copy();
      if (!history.dirty) return output.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
      for (const sheet of sheets) {
        const tree = structuredClone(sheet.tree);
        for (const cell of all(tree, 'c')) if (elements(cell).some(item => local(item) === 'f')) cell.elements = cell.elements.filter(item => local(item) !== 'v');
        const dimensions = all(tree, 'dimension');
        if (dimensions.length) {
          let lastRow = 0, lastCol = 0;
          for (const address of sheet.cells.keys()) { const at = parseAddress(address); lastRow = Math.max(lastRow, at.row); lastCol = Math.max(lastCol, at.col); }
          dimensions[0].attributes.ref = `A1:${columnName(lastCol)}${lastRow + 1}`;
        }
        output.file(sheet.path, serialize(tree));
      }
      const bookCopy = structuredClone(workbook), bookRoot = elements(bookCopy)[0];
      let calc = all(bookCopy, 'calcPr')[0];
      if (!calc) {
        calc = node(qualified(bookRoot, 'calcPr'));
        const orderAfter = new Set(['oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr', 'webPublishObjects', 'extLst']);
        const index = bookRoot.elements.findIndex(item => orderAfter.has(local(item)));
        bookRoot.elements.splice(index < 0 ? bookRoot.elements.length : index, 0, calc);
      }
      calc.attributes ||= {};
      Object.assign(calc.attributes, { calcMode: 'auto', fullCalcOnLoad: '1', forceFullCalc: '1' });
      output.file(workbookPath, serialize(bookCopy));
      const relCopy = structuredClone(rels), relRoot = elements(relCopy)[0], removed = new Set();
      relRoot.elements = relRoot.elements.filter(item => {
        if (!attr(item, 'Type')?.endsWith('/calcChain')) return true;
        const path = resolvePart(workbookPath, attr(item, 'Target')); output.remove(path); removed.add('/' + path); return false;
      });
      output.file(relPath, serialize(relCopy));
      if (removed.size) {
        const types = structuredClone(await pack.read('[Content_Types].xml')), root = elements(types)[0];
        root.elements = root.elements.filter(item => !removed.has(attr(item, 'PartName'))); output.file('[Content_Types].xml', serialize(types));
      }
      return output.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    },
  };
}

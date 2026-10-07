import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { columnName, parseAddress, parseCsv, detectDelimiter, rangeText } from '../dist/table-core.js';
import { readWorkbook } from '../dist/vendor/xlsx.js';
test('Excel addresses round trip through full column range', () => {
  for (const col of [0, 25, 26, 701, 702, 16383]) assert.deepEqual(parseAddress(columnName(col) + '125'), { row: 124, col });
  assert.throws(() => parseAddress('XFE1'));
  assert.throws(() => parseAddress('A0'));
});
test('CSV preserves quotes, multiline fields, empty cells and CRLF', () => {
  assert.deepEqual(parseCsv('a,b,c\r\n"x\ny","say ""hi""",\r\n'), [['a','b','c'], ['x\ny','say "hi"','']]);
  assert.throws(() => parseCsv('"unfinished'));
  assert.throws(() => parseCsv('"done"oops'));
  assert.equal(detectDelimiter('name;value\nKlio;42\n'), ';');
  assert.equal(detectDelimiter('name\tvalue\nKlio\t42\n'), '\t');
});
test('range copying uses selected coordinates and TSV escaping', () => {
  const values = [['a', 'b\nc'], ['d', 'x"y']];
  const sheet = { cell: (r,c) => ({ text: values[r][c] }) };
  assert.equal(rangeText(sheet,{ row: 1,col: 1 },{ row: 0,col: 0 }), 'a\t"b\nc"\nd\t"x""y"');
});
test('real XLSX: sheets, values, date, percentage, formula and distant row', async () => {
  const data = await readFile(new URL('./fixtures/sample.xlsx', import.meta.url));
  const sheets = await readWorkbook(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].name, 'Данные');
  assert.equal(sheets[0].cell(1,0).text, 'Клио');
  assert.equal(sheets[0].cell(1,1).text, '42');
  assert.equal(sheets[0].cell(1,2).text, '2026-10-03');
  assert.equal(sheets[0].cell(2,1).text, '25.00%');
  assert.equal(sheets[0].cell(3,1).formula, '=SUM(B2:B3)');
  assert.equal(sheets[0].cell(249,1).text, '2500');
  assert.equal(sheets[1].cell(1,1).text, 'hello second sheet');
  assert.equal(sheets[0].cell(2,0).text, '<script>alert(1)</script>');
});

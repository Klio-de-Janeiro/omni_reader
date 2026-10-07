import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { History, checkedText } from '../dist/editors/history.js';
import { CsvEditor } from '../dist/editors/csv.js';
import { WavEditor, readWav, writeWav } from '../dist/editors/wav.js';
import { imageGeometry } from '../dist/editors/image.js';
import { openPdfEditor } from '../dist/editors/pdf.js';
import { openOfficeEditor, openXlsxEditor } from '../dist/vendor/editors.js';
import { PDFDocument } from '../dist/vendor/pdf-lib.js';
import { readWorkbook } from '../dist/vendor/xlsx.js';
import { parseCsv } from '../dist/table-core.js';
import { validateBytes } from '../dist/validation.js';

const fixture = ext => readFile(new URL(`./fixtures/sample.${ext}`, import.meta.url));
const array = data => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
async function output(ext, bytes) { await mkdir('test-results/edited', { recursive: true }); await writeFile(`test-results/edited/sample-edited.${ext}`, bytes); validateBytes(array(bytes), ext); }

test('history supports undo, redo, branch edits and bounded retention', () => {
  const history = new History(); let n = 0;
  history.execute(() => { n = 1; }, () => { n = 0; }); history.undo(); assert.equal(n, 0); assert.equal(history.dirty, false);
  history.redo(); assert.equal(n, 1); history.undo(); history.execute(() => { n = 2; }, () => { n = 0; }); assert.equal(history.future.length, 0);
  for (let i = 0; i < 110; i++) history.execute(() => n++, () => n--);
  assert.equal(history.done.length, 100); while (history.done.length) history.undo(); assert.equal(history.dirty, true);
});
test('editable text rejects corrupt XML characters but retains Unicode and escapes', () => {
  assert.equal(checkedText('Клио <&> 😀'), 'Клио <&> 😀');
  assert.throws(() => checkedText('\u0000')); assert.throws(() => checkedText('\ud800')); assert.throws(() => checkedText('x'.repeat(32768)));
});
test('CSV round-trip keeps multiline fields, literal formula-like strings and undo', async () => {
  const model = new CsvEditor(new TextEncoder().encode('name;value\r\nКлио;42\r\n').buffer);
  model.setCell(0, 'B2', 'Новое; "значение"\nстрока'); model.setCell(0, 'C3', '=1+1');
  const rows = parseCsv(new TextDecoder().decode(await model.export()), ';');
  assert.equal(rows[1][1], 'Новое; "значение"\nстрока'); assert.equal(rows[2][2], '=1+1');
  model.history.undo(); assert.equal(model.rows.length, 2); model.history.redo(); assert.equal(model.getCell(0, 'C3').value, '=1+1');
  await output('csv', await model.export()); assert.throws(() => model.setCell(0, 'XFD1', 'x'));
});
test('CSV detects CP1251 and emits decodable UTF-8', async () => {
  const bytes = await readFile(new URL('./fixtures/cp1251.csv', import.meta.url)); const model = new CsvEditor(array(bytes));
  assert.equal(model.encoding, 'windows-1251'); model.setCell(0, 'A2', 'Клио обновлено');
  assert.match(new TextDecoder('utf-8', { fatal: true }).decode(await model.export()), /Клио обновлено/);
});
for (const ext of ['docx', 'pptx']) test(`${ext} round-trip edits text, preserves all other package entries, supports export then undo`, async () => {
  const original = await fixture(ext), before = await JSZip.loadAsync(original), model = await openOfficeEditor(array(original), ext);
  const old = model.getText(0), path = model.fragments[0].path, replacement = '  Клио <новый> & "текст" 😀  ';
  model.setText(0, replacement); const bytes = await model.export(), reopened = await openOfficeEditor(array(bytes), ext);
  assert.equal(reopened.getText(0), replacement);
  const after = await JSZip.loadAsync(bytes);
  assert.deepEqual(Object.keys(after.files).sort(), Object.keys(before.files).sort());
  for (const name of Object.keys(before.files)) if (!before.files[name].dir && name !== path) assert.deepEqual(await after.file(name).async('uint8array'), await before.file(name).async('uint8array'), name);
  model.history.undo(); assert.equal(model.getText(0), old); assert.equal((await openOfficeEditor(array(await model.export()), ext)).getText(0), old);
  model.history.redo(); await output(ext, await model.export());
});
test('PPTX follows actual slide ordering, not ZIP filename ordering', async () => {
  const zip = await JSZip.loadAsync(await fixture('pptx')), path = 'ppt/presentation.xml';
  const xml = await zip.file(path).async('string'); const ids = xml.match(/<p:sldId\b[^>]*\/>/g);
  zip.file(path, xml.replace(ids.join(''), [...ids].reverse().join('')));
  const model = await openOfficeEditor(array(await zip.generateAsync({ type: 'uint8array' })), 'pptx');
  assert.match(model.getText(0), /слайд 2/);
});
test('XLSX edits text, numbers, formulas, blank cells and preserves styles/media', async () => {
  const original = await fixture('xlsx'), model = await openXlsxEditor(array(original));
  model.setCell(0, 'A2', '<&Клио> 😀', 'text'); model.setCell(0, 'B2', '123.5', 'number');
  model.setCell(0, 'D2', '=SUM(B2:B3)', 'formula'); model.setCell(0, 'E2', '=1+1', 'text');
  model.setCell(1, 'D301', 'TRUE', 'boolean'); model.setCell(0, 'B250', '', 'empty');
  const bytes = await model.export(), reopened = await openXlsxEditor(array(bytes));
  assert.deepEqual(reopened.getCell(0, 'A2'), { value: '<&Клио> 😀', type: 'text' });
  assert.equal(reopened.getCell(0, 'B2').value, '123.5'); assert.equal(reopened.getCell(0, 'D2').value, '=SUM(B2:B3)');
  assert.equal(reopened.getCell(0, 'E2').type, 'text'); assert.equal(reopened.getCell(1, 'D301').value, 'TRUE'); assert.equal(reopened.getCell(0, 'B250').value, '');
  const before = await JSZip.loadAsync(original), after = await JSZip.loadAsync(bytes);
  for (const name of Object.keys(before.files)) if (!before.files[name].dir && !/xl\/worksheets\/|xl\/workbook.xml|xl\/_rels\/workbook.xml.rels/.test(name)) assert.deepEqual(await before.file(name).async('uint8array'), await after.file(name).async('uint8array'), name);
  assert.match(await after.file('xl/workbook.xml').async('string'), /forceFullCalc="1"/);
  const sheets = await readWorkbook(array(bytes)); assert.equal(sheets[1].cell(300, 3).text, 'TRUE');
  assert.throws(() => model.setCell(0, 'B2', 'abc', 'number')); await output('xlsx', bytes);
});
test('XLSX invalidates all cached formula values and calcChain without mutating source on preview', async () => {
  const zip = await JSZip.loadAsync(await fixture('xlsx'));
  let sheet = await zip.file('xl/worksheets/sheet1.xml').async('string'); sheet = sheet.replace('<f>SUM(B2:B3)</f><v></v>', '<f>SUM(B2:B3)</f><v>42.25</v>'); zip.file('xl/worksheets/sheet1.xml', sheet);
  zip.file('xl/calcChain.xml', '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="B4" i="1"/></calcChain>');
  const relPath = 'xl/_rels/workbook.xml.rels'; zip.file(relPath, (await zip.file(relPath).async('string')).replace('</Relationships>', '<Relationship Id="rCalc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>'));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml').async('string')).replace('</Types>', '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>'));
  const bytes = await zip.generateAsync({ type: 'uint8array' }), model = await openXlsxEditor(array(bytes)); model.setCell(0, 'B2', '12', 'number');
  const changed = await JSZip.loadAsync(await model.export()); assert.equal(changed.file('xl/calcChain.xml'), null); assert.doesNotMatch(await changed.file('xl/worksheets/sheet1.xml').async('string'), /<v>42.25<\/v>/);
  assert.doesNotMatch(await changed.file(relPath).async('string'), /calcChain/); assert.doesNotMatch(await changed.file('[Content_Types].xml').async('string'), /calcChain/);
  model.history.undo(); const undone = await JSZip.loadAsync(await model.export()); assert.ok(undone.file('xl/calcChain.xml')); assert.match(await undone.file('xl/worksheets/sheet1.xml').async('string'), /<v>42.25<\/v>/);
});
test('XLSX refuses protected, merged interior and array formula cells', async () => {
  const zip = await JSZip.loadAsync(await fixture('xlsx')), path = 'xl/worksheets/sheet1.xml';
  const source = await zip.file(path).async('string');
  zip.file(path, source.replace('</worksheet>', '<mergeCells count="1"><mergeCell ref="D1:E2"/></mergeCells></worksheet>'));
  let model = await openXlsxEditor(array(await zip.generateAsync({ type: 'uint8array' })));
  assert.throws(() => model.setCell(0, 'E2', 'x'), /объединённого/);
  zip.file(path, source.replace('</worksheet>', '<sheetProtection sheet="1"/></worksheet>'));
  model = await openXlsxEditor(array(await zip.generateAsync({ type: 'uint8array' })));
  assert.throws(() => model.setCell(0, 'A1', 'x'), /защищённого/);
  zip.file(path, source.replace('<f>SUM(B2:B3)</f>', '<f t="array" ref="B4:C4">SUM(B2:B3)</f>'));
  model = await openXlsxEditor(array(await zip.generateAsync({ type: 'uint8array' })));
  assert.throws(() => model.setCell(0, 'C4', 'x'), /массивную/);
});
test('PDF rotation/removal exports a readable PDF and undo restores omitted page', async () => {
  const original = await fixture('pdf'), model = await openPdfEditor(array(original));
  assert.equal(model.pages.length, 2); model.rotate(0); model.toggle(1);
  const bytes = await model.export(), doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1); assert.equal(doc.getPage(0).getRotation().angle, 90);
  assert.throws(() => model.toggle(0), /хотя бы/); model.history.undo(); assert.equal((await PDFDocument.load(await model.export())).getPageCount(), 2);
  model.history.redo(); await output('pdf', await model.export()); assert.equal((await PDFDocument.load(original)).getPageCount(), 2);
});
test('PCM16 WAV trim preserves samples/channel alignment and gain, clipping, undo', async () => {
  const source = array(await fixture('wav')), model = new WavEditor(source), input = readWav(source);
  model.set({ start: .5, end: 1.25, gain: 0 }); let bytes = await model.export(), wav = readWav(array(bytes));
  assert.equal(wav.frames, 12000); assert.equal(wav.rate, input.rate); assert.equal(wav.channels, input.channels);
  assert.deepEqual(bytes.subarray(44), input.bytes.subarray(input.start + 8000 * input.align, input.start + 20000 * input.align));
  model.set({ start: .5, end: 1.25, gain: 6 }); bytes = await model.export(); const view = new DataView(bytes.buffer);
  const before = new DataView(source).getInt16(input.start + 8001 * input.align, true);
  assert.equal(view.getInt16(44 + input.align, true), Math.round(before * 10 ** (6 / 20)));
  model.history.undo(); assert.deepEqual((await model.export()).subarray(44), wav.bytes.subarray(44));
  assert.throws(() => writeWav(input, { start: 1, end: .5, gain: 0 })); assert.throws(() => writeWav(input, { start: 0, end: 2, gain: 100 }));
  const loud = source.slice(0); new DataView(loud).setInt16(input.start, 32000, true); const clipped = writeWav(readWav(loud), { start: 0, end: 1, gain: 24 }); assert.equal(new DataView(clipped.buffer).getInt16(44, true), 32767);
  await output('wav', await model.export());
});
test('image crop/rotation geometry rejects overflow and yields exact output dimensions', () => {
  assert.deepEqual(imageGeometry(1000, 650, { x: 20, y: 30, w: 300, h: 200, turns: 1 }), { width: 200, height: 300 });
  assert.throws(() => imageGeometry(1000, 650, { x: -1, y: 0, w: 300, h: 200, turns: 0 }));
  assert.throws(() => imageGeometry(1000, 650, { x: 999, y: 0, w: 300, h: 200, turns: 0 }));
});

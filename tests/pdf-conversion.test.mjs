import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, degrees } from '../dist/vendor/pdf-lib.js';
import { pdfPageRows, pdfPagesCsv, pdfNumber } from '../dist/pdf-table-core.js';
import { extractPdfPages, convertPdf } from '../dist/pdf-conversion.js';
import { readWorkbook, writeWorkbook } from '../scripts/xlsx-entry.js';
import { parseCsv } from '../dist/table-core.js';
import { validateBlob } from '../dist/validation.js';

const item = (str,x,y,width=str.length*6) => ({str,width,transform:[12,0,0,12,x,y]});

test('PDF geometry restores shuffled rows, blank cells, fragments, and rotated writing', () => {
  const items = [item('6',330,640),item('Name',40,700),item('Qty',210,700),item('Price',330,700),item('Red',40,680),item('apple',62,680),item('2',210,680),item('12,50',330,680),item('Pear',40,660),item('8',330,660),item('Plum',40,640),item('3',210,640)];
  const expected = [['Name','Qty','Price'],['Red apple','2','12,50'],['Pear','','8'],['Plum','3','6']];
  assert.deepEqual(pdfPageRows(items),expected);
  const rotated = items.map(value => { const [a,b,c,d,x,y]=value.transform; return {...value,transform:[-b,a,-d,c,-y,x]}; });
  assert.deepEqual(pdfPageRows(rotated),expected);
  assert.deepEqual(pdfPageRows([item('Обычный текст',20,100),item('Следующая строка',20,80)]),[['Обычный текст'],['Следующая строка']]);
});

test('CSV keeps Cyrillic, page numbers, quoted fields, blank cells, and formula literals', async () => {
  const blob = pdfPagesCsv([{number:1,rows:[['Название','Количество'],['Яблоко; "красное"','12,50'],['0012',''],['=SUM(A1:A2)','-3'],['@cmd','-опасно']]},{number:2,rows:[]}]);
  const bytes = new Uint8Array(await blob.arrayBuffer()); assert.deepEqual([...bytes.slice(0,3)],[239,187,191]);
  const rows = parseCsv(await blob.text(),';');
  assert.deepEqual(rows[2],['1','Яблоко; "красное"','12,50']);
  assert.deepEqual(rows[3],['1','0012','']); assert.equal(rows[4][1],"'=SUM(A1:A2)"); assert.equal(rows[4][2],'-3');
  assert.equal(rows[5][1],"'@cmd"); assert.match(rows[6][1],/OCR/);
});

test('OOXML export preserves values and uses numeric cells only for short unambiguous numbers', async () => {
  const values=['Привет <мир> & "текст"','=1+1','0012','1234567890123456','12,50','-3','', 'https://example.test'];
  const blob=await writeWorkbook([{name:'Страница 1',rows:[values]}]);
  await validateBlob(new File([blob],'converted.xlsx'));
  const sheets=await readWorkbook(await blob.arrayBuffer());
  assert.equal(sheets[0].name,'Страница 1'); assert.equal(sheets[0].cell(0,0).text,values[0]);
  for (const col of [1,2,3,7]) assert.equal(sheets[0].cell(0,col).text,values[col]);
  assert.equal(sheets[0].cell(0,4).raw,'12.5'); assert.equal(sheets[0].cell(0,5).raw,'-3');
  const zip=await JSZip.loadAsync(await blob.arrayBuffer()), xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.doesNotMatch(xml,/<f[ >]/); assert.equal(zip.file('xl/externalLinks'),null);
  assert.equal(pdfNumber('00012'),null); assert.equal(pdfNumber('+5'),null); assert.equal(pdfNumber('-0.25'),-.25);
  await assert.rejects(writeWorkbook([{name:'x',rows:[['x'.repeat(32768)]]}]),/32767/);
  await assert.rejects(writeWorkbook([{name:'x',rows:[]},{name:'X',rows:[]}]),/имя/);
});

async function pdfFixture(scanPage = false) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([460,720]);
  const draw = (value,x,y) => page.drawText(value,{x,y,size:12,font});
  for (const [value,x] of [['Name',40],['Qty',200],['Price',320]]) draw(value,x,670);
  for (const [value,x] of [['Red apple',40],['2',200],['12.50',320]]) draw(value,x,645);
  draw('Pear',40,620); draw('8',320,620);
  const second = doc.addPage([460,720]); second.setRotation(degrees(90));
  second.drawText('Second page',{x:40,y:670,size:12,font});
  second.drawText('Value',{x:200,y:670,size:12,font});
  second.drawText('007',{x:40,y:645,size:12,font});
  second.drawText('4',{x:200,y:645,size:12,font});
  if (scanPage) doc.addPage([200,200]);
  const file = new File([await doc.save()],'tables.pdf');
  file.arrayBuffer = () => { throw new Error('PDF must use ranged reads'); };
  return file;
}

test('Real PDF.js ranged extraction reads all pages, including rotated pages; exports reopen', async () => {
  const file = await pdfFixture(), progress=[];
  const pages=await extractPdfPages(file,{onProgress:(page,total)=>progress.push([page,total])});
  assert.deepEqual(progress,[[1,2],[2,2]]);
  assert.deepEqual(pages[0].rows,[['Name','Qty','Price'],['Red apple','2','12.50'],['Pear','','8']]);
  assert.deepEqual(pages[1].rows,[['Second page','Value'],['007','4']]);
  const excel=await convertPdf(file,'xlsx'), csv=await convertPdf(file,'csv');
  const book=await readWorkbook(await excel.blob.arrayBuffer());
  assert.equal(book.length,2); assert.equal(book[1].cell(1,0).text,'007');
  assert.equal(parseCsv(await csv.blob.text(),';').at(-1)[0],'2');
});

test('Mixed PDF explicitly marks scan pages in CSV and XLSX without silently dropping them', async () => {
  const file=await pdfFixture(true), csv=await convertPdf(file,'csv'), excel=await convertPdf(file,'xlsx');
  assert.match(csv.warning,/страницы 3/); assert.equal(parseCsv(await csv.blob.text(),';').at(-1)[0],'3');
  const book=await readWorkbook(await excel.blob.arrayBuffer());
  assert.equal(book.length,3); assert.match(book[2].cell(0,0).text,/OCR/);
});

test('Scanned-only PDF reports OCR instead of producing an empty export', async () => {
  const doc=await PDFDocument.create(); doc.addPage([200,200]);
  await assert.rejects(convertPdf(new File([await doc.save()],'scan.pdf'),'xlsx'),/нет текстового слоя.*OCR/);
});

test('Abort releases the PDF worker and prevents conversion output', async () => {
  const controller = new AbortController(), file=await pdfFixture();
  await assert.rejects(extractPdfPages(file,{signal:controller.signal,onProgress:()=>controller.abort()}),error=>error.name==='AbortError');
});

test('Unsupported page count and password rejection always release the loading task', async () => {
  const file=await pdfFixture(); let destroyed=0;
  const engine={GlobalWorkerOptions:{},PDFDataRangeTransport:class {},getDocument:()=>({promise:Promise.resolve({numPages:10001}),destroy:async()=>destroyed++})};
  await assert.rejects(extractPdfPages(file,{pdfjs:engine}),/10 000 страниц/); assert.equal(destroyed,1);
  engine.getDocument=()=>({promise:Promise.reject(Object.assign(new Error('password'),{name:'PasswordException'})),destroy:async()=>destroyed++});
  await assert.rejects(extractPdfPages(file,{pdfjs:engine}),/паролем/); assert.equal(destroyed,2);
  await assert.rejects(extractPdfPages({size:500000000}),/500/);
});

test('PDF with more than 100 pages exports to one Excel sheet without losing page provenance', async () => {
  const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica);
  for(let page=1;page<=101;page++)doc.addPage([200,200]).drawText('Page '+page,{x:20,y:100,size:12,font});
  const result=await convertPdf(new File([await doc.save()],'long.pdf'),'xlsx');
  const sheets=await readWorkbook(await result.blob.arrayBuffer());
  assert.equal(sheets.length,1); assert.equal(sheets[0].name,'Данные');
  assert.equal(sheets[0].cell(101,0).text,'101'); assert.equal(sheets[0].cell(101,1).text,'Page 101');
});

test('PDF conversion choices appear in both menus; unsupported files keep their existing actions', async t => {
  const dom = new JSDOM('<button id="edit-file"></button><button id="focus-edit"></button>',{url:'https://omni.test'});
  const previous={window:globalThis.window,document:globalThis.document,navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator')};
  globalThis.window=dom.window; globalThis.document=dom.window.document;
  const saved=[]; window.omniDesktop={save:async value=>{saved.push(value);return true;}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
  t.after(()=>{ globalThis.window=previous.window; globalThis.document=previous.document; if(previous.navigator)Object.defineProperty(globalThis,'navigator',previous.navigator);else delete globalThis.navigator;dom.window.close(); });
  const { initConversion,conversionTargets } = await import('../dist/conversion.js');
  let record={ext:'pdf',name:'report.pdf',blob:await pdfFixture()}, editor=null; const messages=[];
  const controls=initConversion({getRecord:()=>record,getEditor:()=>editor,notify:value=>messages.push(value)}); controls.sync();
  assert.deepEqual(conversionTargets('pdf'),['xlsx','csv']);
  for(const list of document.querySelectorAll('.conversion-options'))assert.deepEqual([...list.children].map(button=>button.textContent),['В Excel (.xlsx)','В CSV']);
  const settle=async()=>{const start=Date.now();while(controls.busy){if(Date.now()-start>5000)throw new Error(messages.at(-1));await new Promise(resolve=>setTimeout(resolve,10));}};
  document.querySelectorAll('.conversion-options')[0].children[0].click(); await settle();
  assert.equal(saved[0].name,'report.xlsx'); assert.match(messages.at(-1),/Готово/);
  assert.equal((await readWorkbook(saved[0].bytes)).length,2);
  document.querySelectorAll('.conversion-options')[1].children[1].click(); await settle();
  assert.equal(saved[1].name,'report.csv'); assert.match(new TextDecoder().decode(saved[1].bytes),/Страница/);
  editor={busy:true}; controls.sync(); assert.ok([...document.querySelectorAll('.conversion-menu>button')].every(button=>button.disabled));
  record={ext:'txt'}; editor=null; controls.sync(); assert.ok([...document.querySelectorAll('.conversion-menu')].every(menu=>menu.hidden));
});

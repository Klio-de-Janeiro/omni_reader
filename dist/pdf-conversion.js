import { pdfPageRows, pdfPagesCsv, pdfRowsWithPages, PDF_TABLE_LIMITS } from './pdf-table-core.js';
import { validateBlob, MAX_FILE_BYTES } from './validation.js';
const aborted = signal => { if (signal?.aborted) throw new DOMException('Aborted','AbortError'); };

/** Read PDF pages sequentially through blob ranges, never the complete input buffer. */
export async function extractPdfPages(file, {signal,onProgress,pdfjs:engine} = {}) {
  if (!Number.isSafeInteger(file.size) || file.size<=0 || file.size>=MAX_FILE_BYTES) throw new Error('Размер PDF должен быть больше нуля и меньше 500 МБ.');
  await validateBlob(file,'pdf'); aborted(signal);
  const pdfjs = engine || await import('./vendor/pdf/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf/pdf.worker.mjs',import.meta.url).href;
  let rangeError, loading;
  class BlobRange extends pdfjs.PDFDataRangeTransport {
    constructor() { super(file.size,new Uint8Array(),false); this.cancelled=false; }
    requestDataRange(begin,end) {
      void file.slice(begin,end).arrayBuffer().then(data => { if (!this.cancelled) this.onDataRange(begin,new Uint8Array(data)); }).catch(error => { rangeError=error; void loading?.destroy(); });
    }
    abort() { this.cancelled=true; }
  }
  loading = pdfjs.getDocument({range:new BlobRange(),length:file.size,rangeChunkSize:1024*1024,disableAutoFetch:true,disableStream:true,isEvalSupported:false,cMapUrl:new URL('./vendor/pdf/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/pdf/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./vendor/pdf/wasm/',import.meta.url).href});
  const cancel = () => { void loading.destroy(); };
  signal?.addEventListener('abort',cancel,{once:true});
  try {
    aborted(signal);
    const doc = await loading.promise;
    if (doc.numPages>PDF_TABLE_LIMITS.pages) throw new Error('Лимит конвертации PDF: 10 000 страниц. Разделите файл на части.');
    const pages = []; let totalRows=0, totalCells=0, totalText=0;
    for (let number=1;number<=doc.numPages;number++) {
      aborted(signal); onProgress?.(number,doc.numPages);
      const page = await doc.getPage(number);
      try {
        const content = await page.getTextContent(); aborted(signal);
        if (content.items.length>PDF_TABLE_LIMITS.cells) throw new Error('На странице слишком много текстовых фрагментов. Разделите исходный PDF.');
        const rows = pdfPageRows(content.items);
        for (const row of rows) for (const cell of row) { if (cell) totalCells++; totalText+=cell.length; }
        totalRows+=rows.length;
        if (totalRows>PDF_TABLE_LIMITS.rows || totalCells>PDF_TABLE_LIMITS.cells || totalText>PDF_TABLE_LIMITS.text) throw new Error('PDF слишком сложный: лимит 100 000 строк, 500 000 заполненных ячеек и 64 МиБ текста. Разделите файл на части.');
        pages.push({number,rows});
      } finally { page.cleanup?.(); }
    }
    if (!totalCells) throw new Error('В PDF нет текстового слоя. Для конвертации скана необходимо OCR.');
    return pages;
  } catch (error) {
    aborted(signal);
    if (rangeError) throw new Error('Не удалось прочитать PDF: '+rangeError.message);
    if (error.name==='PasswordException') throw new Error('PDF защищён паролем. Сначала сохраните копию без защиты.');
    throw error;
  } finally { signal?.removeEventListener('abort',cancel); await loading.destroy(); }
}

/** Export page sheets, consolidating long PDFs; CSV always includes page provenance. */
export async function convertPdf(file, target, options = {}) {
  if (!['xlsx','csv'].includes(target)) throw new Error('Неподдерживаемый формат конвертации PDF.');
  const pages = await extractPdfPages(file,options); aborted(options.signal);
  const empty = pages.filter(page => !page.rows.length).map(page => page.number);
  let blob;
  if (target==='csv') blob=pdfPagesCsv(pages);
  else {
    const sheets = pages.length<=100 ? pages.map(page => ({name:'Страница '+page.number,rows:page.rows.length ? page.rows : [['Нет текстового слоя — требуется OCR']]})) : [{name:'Данные',rows:pdfRowsWithPages(pages)}];
    blob=await (await import('./vendor/xlsx.js')).writeWorkbook(sheets);
  }
  aborted(options.signal);
  return {blob,warning:empty.length ? 'Без текстового слоя (нужен OCR): страницы '+empty.slice(0,20).join(', ')+(empty.length>20 ? ' и ещё '+(empty.length-20) : '')+'.' : ''};
}

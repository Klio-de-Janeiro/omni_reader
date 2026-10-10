import { LARGE_TEXT_BYTES, openLargeText, openLargeCsv } from '../large-files.js';
import { openPdfUI } from './pdf-ui.js';
import { bindZoomGestures, createVisualZoom } from '../gestures.js';
import { openOfficeUI } from './office-ui.js';
import { CsvEditor } from './csv.js';
import { WavEditor } from './wav.js';
import { openImageEditor } from './image.js';
import { openPdfEditor } from './pdf.js';
import { parseAddress, columnName } from '../table-core.js';
import { openViewer } from '../viewers.js';
import { openMarkupEditor } from '../markup.js';
import { openTextEditor } from '../text-files.js';
import { openNotebookEditor } from '../notebooks.js';
import { TEXT_EXTENSIONS } from '../validation.js';
import { openImageUI } from './image-ui.js';
import { editingShortcut } from '../shortcuts.js';
import { withReadMode } from './read-mode.js';

const node = (tag, text, cls) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el; };
const button = text => { const el = node('button', text); el.type = 'button'; return el; };
const field = (title, control) => { const label = node('label', title); control.setAttribute('aria-label', title); label.append(control); return label; };
const input = (title, type = 'text') => { const el = node('input'); el.type = type; el.setAttribute('aria-label', title); return el; };

/** Mount one editor and expose an explicit export, dirty state and disposal contract. */
async function openEditorUI(record, root, { onSave, onClose, onError, onDirty, signal, viewMode, onViewMode, onShellShortcut, initialPage = 1, initialZoom = 1 }) {
  const largeContext={onSave,onClose,onError,onDirty,signal};
  if(record.blob.size>LARGE_TEXT_BYTES){
    if(record.ext==='csv')return openLargeCsv(record.blob,root,largeContext,true);
    if([...TEXT_EXTENSIONS,'md','ipynb'].includes(record.ext))return openLargeText(record.blob,root,largeContext,true);
  }
  if (record.ext === 'md') return openMarkupEditor(record, root, { onSave, onClose, onError, onDirty, signal, initialZoom });
  if (record.ext === 'ipynb') return openNotebookEditor(record, root, { onSave, onClose, onError, onDirty, signal, initialZoom });
  if (TEXT_EXTENSIONS.includes(record.ext)) return openTextEditor(record, root, { onSave, onClose, onError, onDirty, signal, initialZoom });
  const bytes = await record.blob.arrayBuffer(), ext = record.ext;
  let model;
  if (ext === 'csv') {try{model=new CsvEditor(bytes);}catch(error){if(/Лимит/.test(error.message))return openLargeCsv(record.blob,root,largeContext,true);throw error;}}
  else if (ext === 'wav') model = new WavEditor(bytes);
  else if (ext === 'pdf') model = await openPdfEditor(bytes);
  else if (['jpg', 'jpeg', 'png'].includes(ext)) model = await openImageEditor(new File([bytes], record.name));
  else { const engine = await import('../vendor/editors.js'); model = ext === 'xlsx' ? await engine.openXlsxEditor(bytes) : await engine.openOfficeEditor(bytes, ext); }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (['jpg', 'jpeg', 'png'].includes(ext)) return openImageUI(model,record,root,{signal,onSave,onClose,onError,onDirty,initialZoom});
  if (ext === 'docx' || ext === 'pptx') return openOfficeUI(model,record,root,{signal,onSave,onClose,onError,onDirty,viewMode,onViewMode,onShellShortcut,initialPage,initialZoom});
  if (ext === 'pdf') return openPdfUI(model,record,root,{signal,onSave,onClose,onError,onDirty,viewMode,onViewMode,initialPage,initialZoom});
  let flush = () => {}, pending = () => false, render = () => {}, adjustZoom = () => {}, busy = false, previewController, disposed = false, committingInline = false;
  const panel = node('div', null, 'editor-panel'), bar = node('div', null, 'editor-bar');
  const undo = button('Отменить'), redo = button('Повторить'), save = button('Сохранить копию'), close = button('К просмотру'), preview = button('Предпросмотр');
  save.className = 'primary'; const status = node('span', '', 'editor-status'); status.setAttribute('role', 'status');
  bar.append(undo, redo, preview, save, close, status);
  const body = node('div', null, 'editor-body'), previewArea = node('div', null, 'editor-preview-area'); previewArea.hidden = true;
  const note = node('p', 'Изменения сохраняются в новый файл. Отмена и повтор: до 100 действий.', 'editor-note');
  panel.append(bar, note, body, previewArea); root.replaceChildren(panel);
  const guarded = action => async (...args) => { if (busy) return; try { await action(...args); } catch (error) { onError(error); } };
  function update() {
    if (disposed) return;
    const dirty = model.history.dirty || pending();
    undo.disabled = busy || !(model.history.done.length || pending()); redo.disabled = busy || !model.history.future.length || pending();
    save.disabled = busy || !dirty; close.disabled = busy; preview.disabled = busy;
    status.textContent = busy ? 'Подготавливаем файл…' : dirty ? 'Есть несохранённые изменения' : 'Изменений нет'; onDirty?.(dirty);
  }
  function numberFields(names) {
    const values = {};
    const controls = node('div', null, 'editor-fields');
    for (const [key, label] of names) { const el = input(label, 'number'); el.step = 'any'; el.oninput = update; values[key] = el; controls.append(field(label, el)); }
    body.append(controls); return values;
  }
  if (ext === 'csv' || ext === 'xlsx') {
    let sheetIndex = 0, address = 'A1';
    const controls = node('div', null, 'editor-fields'), sheets = node('select'), at = input('Ячейка'), type = node('select'), value = node('textarea');
    value.rows = 3; value.maxLength = 32767; value.setAttribute('aria-label', 'Значение ячейки'); at.value = address;
    sheets.setAttribute('aria-label', 'Редактируемый лист');
    model.sheets.forEach((sheet, index) => { const option = node('option', sheet.name); option.value = index; sheets.append(option); });
    for (const [id, title] of (ext === 'csv' ? [['text', 'Текст']] : [['text', 'Текст'], ['number', 'Число'], ['boolean', 'TRUE/FALSE'], ['formula', 'Формула'], ['empty', 'Очистить']])) { const option = node('option', title); option.value = id; type.append(option); }
    const go = button('Перейти к ячейке'), apply = button('Применить ячейку');
    controls.append(field('Редактируемый лист', sheets), field('Ячейка', at), go, field('Тип значения', type));
    const grid = node('div', null, 'table-scroll editor-grid');
    grid.style.fontSize='14px';
    const zoomContent=node('div',null,'table-zoom-content');grid.append(zoomContent);
    let gridVisual;
    let gridZoom = initialZoom;
    adjustZoom=delta=>{if(busy || disposed)return;gridZoom=Math.max(0.5,Math.min(3,delta===null?1:gridZoom+delta));gridVisual?.setZoom(gridZoom);};
    bindZoomGestures(grid, { signal, onError, getZoom: () => gridZoom, setZoom(value,point) { gridZoom = value;gridVisual?.setZoom(value,point); } });
    body.append(controls, field('Значение ячейки', value), apply, node('p', ext === 'xlsx' ? 'Редактируются исходные значения. Формулы не вычисляются здесь; результаты обновятся при открытии копии в Excel или LibreOffice. Для текста с начальным «=» оставьте тип «Текст».' : `CSV открыт как ${model.encoding}. Копия сохраняется в UTF-8 с BOM и тем же разделителем.`, 'editor-note'), grid);
    pending = () => { const current = model.getCell(sheetIndex, address); return value.value !== current.value || (type.value !== current.type && !(current.value === '' && type.value === 'text')); };
    flush = () => { if (pending()) model.setCell(sheetIndex, address, value.value, type.value); };
    render = () => {
      const current = model.getCell(sheetIndex, address); value.value = current.value; type.value = current.type; at.value = address;
      const pos = parseAddress(address), firstRow = Math.floor(pos.row / 20) * 20, firstCol = Math.floor(pos.col / 10) * 10;
      const table = node('table'), head = node('tr'); head.append(node('th', ''));
      for (let col = firstCol; col < Math.min(firstCol + 10, ext === 'csv' ? 512 : 16384); col++) head.append(node('th', columnName(col)));
      table.append(head);
      for (let row = firstRow; row < Math.min(firstRow + 20, ext === 'csv' ? 100000 : 1048576); row++) {
        const tr = node('tr'); tr.append(node('th', row + 1));
        for (let col = firstCol; col < Math.min(firstCol + 10, ext === 'csv' ? 512 : 16384); col++) {
          const cellAddress = columnName(col) + (row + 1), td = node('td', model.getCell(sheetIndex, cellAddress).value);
          td.dataset.address = cellAddress; td.tabIndex = 0; td.classList.toggle('active-cell', cellAddress === address);
          td.onclick = guarded(event => {
            if (ext === 'csv' && event?.target.closest('.csv-cell-input')) return;
            flush(); address = cellAddress; render(); update();
            if (ext === 'csv') { const editor = grid.querySelector('.csv-cell-input'); editor?.focus({ preventScroll: true }); editor?.select(); }
          });
          td.onkeydown = event => { if (event.key === 'Enter' && event.target === td) { event.preventDefault(); td.click(); } };
          if (ext === 'csv' && cellAddress === address) {
            const editor = node('textarea', null, 'csv-cell-input'); editor.rows = 1; editor.value = current.value; editor.maxLength = 32767;
            editor.setAttribute('aria-label', `Значение ячейки ${cellAddress}`); editor.spellcheck = false;
            editor.oninput = () => { value.value = editor.value; update(); };
            editor.onblur = () => {
              if (disposed || busy) return;
              // Do not replace the clicked table before the next cell receives its click.
              committingInline = true;
              try { flush(); } catch (error) { onError(error); }
              finally { committingInline = false; update(); }
            };
            editor.onkeydown = event => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); value.value = model.getCell(sheetIndex, address).value; render(); update(); }
              else if (event.key === 'Tab' || event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault(); event.stopPropagation();
                void guarded(() => {
                  flush(); const pos = parseAddress(address);
                  if (event.key === 'Tab') pos.col = Math.max(0, Math.min(511, pos.col + (event.shiftKey ? -1 : 1)));
                  else pos.row = Math.min(99999, pos.row + 1);
                  address = columnName(pos.col) + (pos.row + 1); render(); update();
                  const next = grid.querySelector('.csv-cell-input'); next?.focus({ preventScroll: true }); next?.select();
                })();
              }
            };
            td.replaceChildren(editor);
          }
          tr.append(td);
        }
        table.append(tr);
      }
      zoomContent.replaceChildren(table);
      if(!gridVisual){zoomContent.style.width=Math.max(grid.clientWidth,zoomContent.scrollWidth,zoomContent.offsetWidth,1)+'px';gridVisual=createVisualZoom(grid,zoomContent,{signal,fixedWidth:false});gridVisual.setZoom(gridZoom);}
      else gridVisual.refresh();
    };
    value.oninput = update; type.onchange = update;
    apply.onclick = guarded(() => { flush(); render(); update(); });
    go.onclick = guarded(() => { const next = at.value; const pos = parseAddress(next); if (ext === 'csv' && (pos.col >= 512 || pos.row >= 100000)) throw new Error('Адрес за пределами CSV.'); flush(); address = columnName(pos.col) + (pos.row + 1); render(); update(); });
    at.onkeydown = event => { if (event.key === 'Enter') go.click(); };
    sheets.onchange = guarded(() => { const next = Number(sheets.value); try { flush(); sheetIndex = next; address = 'A1'; render(); update(); } catch (error) { sheets.value = sheetIndex; throw error; } });
  } else if (ext === 'wav') {
    const values = numberFields([['start', 'Начало, секунды'], ['end', 'Конец, секунды'], ['gain', 'Громкость, dB']]), apply = button('Применить звук');
    const next = () => Object.fromEntries(Object.entries(values).map(([key, el]) => [key, el.value === '' ? NaN : Number(el.value)]));
    pending = () => JSON.stringify(next()) !== JSON.stringify(model.state); flush = () => { if (pending()) model.set(next()); };
    render = () => { for (const [key, el] of Object.entries(values)) el.value = model.state[key]; };
    body.append(apply, node('p', `PCM 16-bit · ${model.wav.channels} канал(а) · ${model.wav.rate} Гц · ${model.wav.duration.toFixed(3)} с. Диапазон задаётся по исходной записи. При усилении пики ограничиваются; метаданные WAV не переносятся.`, 'editor-note'));
    apply.onclick = guarded(() => { flush(); render(); update(); });
  }
  model.history.onChange = () => { if (!committingInline) render(); update(); };
  const api = {
    get dirty() { return model.history.dirty || pending(); },
    get busy() { return busy; },
    async export() { flush(); return model.export(); },
    async setFocus(value) {
      if (value && ext === 'wav') await preview.onclick();
    },
    setBusy(value) { busy = value; body.inert = busy; update(); },
    adjustZoom: delta => adjustZoom(delta),
    dispose() { disposed = true; previewController?.abort(); },
  };
  undo.onclick = guarded(() => {
    if (pending()) { try { flush(); } catch { render(); update(); return; } }
    model.history.undo();
  }); redo.onclick = guarded(() => model.history.redo());
  close.onclick = guarded(onClose); save.onclick = guarded(() => onSave(api));
  preview.onclick = guarded(async () => {
    flush(); api.setBusy(true);
    try {
      const data = await model.export(); if (disposed) return;
      previewController?.abort(); previewController = new AbortController();
      const controls = node('div', null, 'editor-fields'), before = button('‹'), after = button('›'), label = node('span');
      const view = node('div', null, 'viewer editor-preview'); let page = 1, pages = 1;
      const modeControl=node('select');modeControl.setAttribute('aria-label','Режим предпросмотра');for(const [value,title] of [['scroll','Прокрутка'],['page','По страницам']]){const option=node('option',title);option.value=value;modeControl.append(option);}controls.append(before,label,after,modeControl); previewArea.replaceChildren(controls, view); previewArea.hidden = false;
      const sync = () => { label.textContent = `${page} / ${pages}`; before.disabled = page <= 1; after.disabled = page >= pages; };
      const viewer = await openViewer(new File([data], record.name), view, { ext, signal: previewController.signal, viewMode, onPages: count => { pages = count; }, onPage: value => {page=value;sync();}, onWarning: onError });
      modeControl.hidden=!viewer.setViewMode;modeControl.value=viewMode==='page'?'page':'scroll';modeControl.onchange=guarded(async()=>{await viewer.setViewMode(modeControl.value);viewMode=modeControl.value;onViewMode?.(viewMode);});controls.hidden=pages<=1 && !viewer.setViewMode;sync();
      const turn = delta => guarded(async () => { page = Math.max(1, Math.min(pages, page + delta)); await viewer.setPage?.(page); sync(); });
      before.onclick = turn(-1); after.onclick = turn(1);
    } finally { api.setBusy(false); }
  });
  panel.addEventListener('keydown',event=>{const action=editingShortcut(event);if(action){event.preventDefault();({save,undo,redo})[action].click();}});
  signal.addEventListener('abort', () => api.dispose(), { once: true }); render(); update(); return api;
}

export async function openEditor(record,root,options) {
  return withReadMode(await openEditorUI(record,root,options),record,root,options);
}

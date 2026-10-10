import {openLargeCsv} from './large-files.js';
import { columnName, parseAddress, parseCsv, detectDelimiter, rangeText } from './table-core.js';
import { copyText } from './clipboard.js';
import { createVisualZoom } from './gestures.js';
const ROWS = 100, COLS = 30;
function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
/** Show a bounded table window with selection across windows and sheets. */
export async function openTable(file, root, context) {
  const data = await file.arrayBuffer();
  let sheets, csvText, delimiter, encoding = 'utf-8', sheetIndex = 0, startRow = 0, startCol = 0;
  let start = { row: 0, col: 0 }, end = { ...start }, hits = [], hitIndex = -1;
  const csv = context.ext === 'csv';
  function makeCsv() {
    csvText = new TextDecoder(encoding).decode(data);
    delimiter ||= detectDelimiter(csvText);
    const rows = parseCsv(csvText, delimiter);
    const count = rows.reduce((n, row) => n + row.length, 0);
    if (count > 500000) throw new Error('Лимит таблицы: 500 000 ячеек.');
    const entries = [];
    rows.forEach((row, r) => row.forEach((text, c) => { if (text) entries.push({ row: r, col: c, text }); }));
    sheets = [{ name: file.name, rows: rows.length, cols: rows.reduce((max, row) => Math.max(max, row.length), 1), merges: [], entries, cell: (r, c) => ({ text: rows[r]?.[c] || '', raw: rows[r]?.[c] || '', formula: '' }) }];
  }
  if (csv) { const bytes = new Uint8Array(data); if (bytes[0] === 255 && bytes[1] === 254) encoding = 'utf-16le'; try{makeCsv();}catch(error){if(/Лимит/.test(error.message))return openLargeCsv(file,root,context);throw error;} } else sheets = await (await import('./vendor/xlsx.js')).readWorkbook(data);
  if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const panel = node('div', null, 'table-panel');
  const tools = node('div', null, 'table-tools');
  const sheetSelect = node('select'); sheetSelect.setAttribute('aria-label', 'Лист книги');
  sheets.forEach((sheet, i) => { const option = node('option', sheet.name + (sheet.hidden ? ' · скрытый' : '')); option.value = i; sheetSelect.append(option); });
  const address = node('input'); address.placeholder = 'A1 или A1:C20'; address.value = 'A1'; address.setAttribute('aria-label', 'Адрес или диапазон ячеек');
  const jump = node('button', 'Перейти'), copy = node('button', 'Копировать диапазон');
  tools.append(sheetSelect, address, jump, copy);
  if (csv) {
    const encodingSelect = node('select'); encodingSelect.setAttribute('aria-label', 'Кодировка CSV');
    for (const [value, text] of [['utf-8', 'UTF-8'], ['windows-1251', 'Windows-1251'], ['utf-16le', 'UTF-16 LE']]) { const option = node('option', text); option.value = value; option.selected = value === encoding; encodingSelect.append(option); }
    const separator = node('select'); separator.setAttribute('aria-label', 'Разделитель CSV');
    for (const [value, text] of [[',', 'Запятая'], [';', 'Точка с запятой'], ['\t', 'Табуляция']]) { const option = node('option', text); option.value = value; option.selected = value === delimiter; separator.append(option); }
    const rebuild = () => { try { encoding = encodingSelect.value; delimiter = separator.value; makeCsv(); reset(); } catch (error) { context.onWarning(error); } };
    encodingSelect.onchange = rebuild; separator.onchange = rebuild; tools.append(encodingSelect, separator);
  }
  const detail = node('div', null, 'cell-detail'); detail.tabIndex = 0; detail.setAttribute('aria-label', 'Содержимое активной ячейки');
  const scroller = node('div', null, 'table-scroll'); scroller.tabIndex = 0;
  scroller.style.fontSize='14px';
  const content=node('div',null,'table-zoom-content');scroller.append(content);
  let visual;
  const navigation = node('div', null, 'table-nav');
  const prevRows = node('button', '−100 строк'), nextRows = node('button', '+100 строк');
  const prevCols = node('button', '← столбцы'), nextCols = node('button', 'столбцы →');
  const status = node('span'); status.setAttribute('role', 'status');
  navigation.append(prevRows, nextRows, prevCols, nextCols, status);
  const searchBar = node('div', null, 'table-tools');
  const search = node('input'); search.placeholder = 'Найти значение на листе'; search.setAttribute('aria-label', 'Поиск в таблице');
  const find = node('button', 'Найти / далее'), searchStatus = node('span');
  searchBar.append(search, find, searchStatus);
  panel.append(tools, detail, scroller, navigation, searchBar);
  if (!csv) panel.append(node('p', 'Просмотр значений: формулы показываются вместе с сохранённым результатом, но не пересчитываются. Стили, диаграммы и объединение ячеек не воспроизводятся.', 'table-note'));
  root.replaceChildren(panel);
  const sheet = () => sheets[sheetIndex];
  function selection() {
    address.value = `${columnName(start.col)}${start.row + 1}` + (start.row !== end.row || start.col !== end.col ? `:${columnName(end.col)}${end.row + 1}` : '');
    const cell = sheet().cell(end.row, end.col);
    detail.textContent = `${columnName(end.col)}${end.row + 1}   ${cell.formula ? cell.formula + '   →   ' : ''}${cell.text}`;
    detail.title = `Исходное значение: ${cell.raw ?? ''}`;
    for (const td of scroller.querySelectorAll('td[data-row]')) {
      const row = Number(td.dataset.row), col = Number(td.dataset.col);
      td.classList.toggle('selected', row >= Math.min(start.row, end.row) && row <= Math.max(start.row, end.row) && col >= Math.min(start.col, end.col) && col <= Math.max(start.col, end.col));
      td.classList.toggle('active-cell', row === end.row && col === end.col);
    }
  }
  function render() {
    const item = sheet();
    startRow = Math.max(0, Math.min(startRow, Math.max(0, item.rows - 1)));
    startCol = Math.max(0, Math.min(startCol, Math.max(0, item.cols - 1)));
    const table = node('table'); table.setAttribute('aria-label', `Лист ${item.name}`);
    const head = node('tr'); head.append(node('th', ''));
    for (let col = startCol; col < Math.min(item.cols, startCol + COLS); col++) head.append(node('th', columnName(col)));
    const thead = node('thead'); thead.append(head); table.append(thead);
    const body = node('tbody');
    for (let row = startRow; row < Math.min(item.rows, startRow + ROWS); row++) {
      const tr = node('tr'); const th = node('th', row + 1); th.scope = 'row'; tr.append(th);
      for (let col = startCol; col < Math.min(item.cols, startCol + COLS); col++) {
        const cell = item.cell(row, col), td = node('td', cell.text);
        td.dataset.row = row; td.dataset.col = col; td.title = cell.formula || cell.text;
        td.onclick = event => { if (!event.shiftKey) start = { row, col }; end = { row, col }; selection(); };
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body); content.replaceChildren(table);visual?.refresh(); selection();
    status.textContent = `${startRow + 1}–${Math.min(item.rows, startRow + ROWS)} / ${item.rows} строк · ${columnName(startCol)}–${columnName(Math.min(item.cols - 1, startCol + COLS - 1))}`;
    prevRows.disabled = startRow === 0; nextRows.disabled = startRow + ROWS >= item.rows;
    prevCols.disabled = startCol === 0; nextCols.disabled = startCol + COLS >= item.cols;
  }
  function go(at, anchor = at) {
    if (at.row >= sheet().rows || at.col >= sheet().cols || anchor.row >= sheet().rows || anchor.col >= sheet().cols) throw new Error('Адрес за пределами данных этого листа.');
    start = anchor; end = at; startRow = Math.floor(at.row / ROWS) * ROWS; startCol = Math.floor(at.col / COLS) * COLS;
    render(); scroller.scrollTop = 0;
    scroller.querySelector(`[data-row="${at.row}"][data-col="${at.col}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function reset() { startRow = 0; startCol = 0; start = { row: 0, col: 0 }; end = { ...start }; hits = []; hitIndex = -1; searchStatus.textContent = ''; render(); }
  function guarded(action) { try { action(); } catch (error) { context.onWarning(error); } }
  sheetSelect.onchange = () => { sheetIndex = Number(sheetSelect.value); reset(); };
  jump.onclick = () => guarded(() => { const parts = address.value.split(':'); if (parts.length > 2) throw new Error('Неверный диапазон.'); go(parseAddress(parts.at(-1)), parseAddress(parts[0])); });
  address.onkeydown = event => { if (event.key === 'Enter') jump.click(); };
  copy.onclick = async () => { try { await copyText(rangeText(sheet(), start, end)); context.onInfo?.('Диапазон скопирован.'); } catch (error) { context.onWarning(error); } };
  prevRows.onclick = () => { startRow -= ROWS; render(); scroller.scrollTop = 0; }; nextRows.onclick = () => { startRow += ROWS; render(); scroller.scrollTop = 0; };
  prevCols.onclick = () => { startCol -= COLS; render(); }; nextCols.onclick = () => { startCol += COLS; render(); };
  search.oninput = () => { hits = []; hitIndex = -1; };
  find.onclick = () => guarded(() => {
    const query = search.value.trim().toLocaleLowerCase(); if (!query) return;
    if (hitIndex < 0) hits = sheet().entries.filter(cell => String(cell.text).toLocaleLowerCase().includes(query)).slice(0, 1000);
    if (!hits.length) { searchStatus.textContent = 'Не найдено'; return; }
    hitIndex = (hitIndex + 1) % hits.length; go(hits[hitIndex]); searchStatus.textContent = `${hitIndex + 1} / ${hits.length}${hits.length === 1000 ? '+' : ''}`;
  });
  search.onkeydown = event => { if (event.key === 'Enter') find.click(); };
  scroller.onkeydown = event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); copy.click(); return; }
    const delta = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
    if (!delta) return; event.preventDefault();
    const next = { row: Math.max(0, Math.min(sheet().rows - 1, end.row + delta[0])), col: Math.max(0, Math.min(sheet().cols - 1, end.col + delta[1])) };
    go(next, event.shiftKey ? start : next);
  };
  render();
  content.style.width=Math.max(scroller.clientWidth,content.scrollWidth,content.offsetWidth,1)+'px';
  visual=createVisualZoom(scroller,content,{signal:context.signal,fixedWidth:false});
  return { copyText: () => rangeText(sheet(), start, end), zoomRoot:scroller, setZoom:visual.setZoom };
}

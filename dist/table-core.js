/** Convert a zero-based column index to an Excel column label. */
export function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}
/** Parse an A1 address, rejecting unsupported ranges and huge coordinates. */
export function parseAddress(value) {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/i.exec(value.trim());
  if (!match) throw new Error('Введите адрес ячейки, например B125.');
  let column = 0;
  for (const char of match[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
  if (column > 16384 || Number(match[2]) > 1048576) throw new Error('Адрес выходит за границы Excel.');
  return { row: Number(match[2]) - 1, col: column - 1 };
}
/** Parse CSV quotes, multiline fields and trailing empty cells without evaluation. */
export function parseCsv(text, delimiter = ',') {
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, '');
  const flush = () => { row.push(field); field = ''; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else field += ch;
    } else if (ch === '"' && !field && !closed) quoted = true;
    else if (ch === delimiter) flush();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      flush(); rows.push(row); row = [];
    } else if (closed && ch.trim()) throw new Error('Некорректный CSV: символ после закрывающей кавычки.');
    else if (!closed) field += ch;
    if (rows.length > 100000 || row.length > 511) throw new Error('Лимит CSV: 100 000 строк и 512 столбцов.');
  }
  if (quoted) throw new Error('Некорректный CSV: незакрытые кавычки.');
  if (field || row.length || closed) { flush(); rows.push(row); }
  if (!rows.length) rows.push(['']);
  return rows;
}
/** Choose a consistent delimiter from non-empty logical CSV records. */
export function detectDelimiter(text) {
  let best = ',', bestScore = -Infinity;
  const sample = text.slice(0, 50000);
  for (const delimiter of [',', ';', '\t']) {
    try {
      const rows = parseCsv(sample, delimiter).slice(0, 20).filter(row => row.some(value => value.trim()));
      const counts = rows.map(row => row.length);
      const max = Math.max(1, ...counts);
      const same = counts.filter(count => count === counts[0]).length;
      const score = max > 1 ? same * 100 + Math.min(max, 80) : 0;
      if (score > bestScore) { bestScore = score; best = delimiter; }
    } catch { /* A truncated quoted record can be parsed after manual selection. */ }
  }
  return best;
}
/** Render a selection as RFC-style tab-separated clipboard text. */
export function rangeText(sheet, start, end) {
  const r1 = Math.min(start.row, end.row), r2 = Math.max(start.row, end.row);
  const c1 = Math.min(start.col, end.col), c2 = Math.max(start.col, end.col);
  if ((r2 - r1 + 1) * (c2 - c1 + 1) > 100000) throw new Error('За раз можно скопировать не более 100 000 ячеек.');
  const quote = value => /[\t\r\n"]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
  const rows = [];
  for (let row = r1; row <= r2; row++) {
    const cells = [];
    for (let col = c1; col <= c2; col++) cells.push(quote(String(sheet.cell(row, col).text ?? '')));
    rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

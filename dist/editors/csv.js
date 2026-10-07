import { History, checkedText } from './history.js';
import { parseCsv, detectDelimiter, parseAddress } from '../table-core.js';

/** Edit CSV fields as literal strings and export an Excel-friendly UTF-8 copy. */
export class CsvEditor {
  constructor(buffer, options = {}) {
    const bytes = new Uint8Array(buffer);
    this.encoding = options.encoding || (bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : 'utf-8');
    let text;
    try { text = new TextDecoder(this.encoding, { fatal: true }).decode(bytes); }
    catch { this.encoding = 'windows-1251'; text = new TextDecoder(this.encoding).decode(bytes); }
    this.delimiter = options.delimiter || detectDelimiter(text);
    this.rows = parseCsv(text, this.delimiter);
    if (this.rows.reduce((n, r) => n + r.length, 0) > 500000) throw new Error('Лимит таблицы: 500 000 ячеек.');
    this.history = new History();
    this.sheets = [{ name: 'CSV' }];
  }
  getCell(_sheet, address) { const at = parseAddress(address); return { value: this.rows[at.row]?.[at.col] || '', type: 'text' }; }
  setCell(_sheet, address, value) {
    const { row, col } = parseAddress(address); value = checkedText(value);
    if (row >= 100000 || col >= 512) throw new Error('Лимит CSV: 100 000 строк и 512 столбцов.');
    const previous = this.rows[row]?.slice(), length = this.rows.length;
    if (previous?.[col] === value) return;
    const cells = this.rows.reduce((n, r) => n + r.length, 0) + Math.max(0, row - length) + Math.max(0, col + 1 - (previous?.length || 0));
    if (cells > 500000) throw new Error('Лимит таблицы: 500 000 ячеек.');
    this.history.execute(() => {
      while (this.rows.length <= row) this.rows.push(['']);
      while (this.rows[row].length <= col) this.rows[row].push('');
      this.rows[row][col] = value;
    }, () => { this.rows.length = length; if (previous) this.rows[row] = previous.slice(); });
  }
  async export() {
    const quote = value => value.includes(this.delimiter) || /["\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
    return new TextEncoder().encode('\uFEFF' + this.rows.map(row => row.map(quote).join(this.delimiter)).join('\r\n') + '\r\n');
  }
}

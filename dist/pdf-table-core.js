export const PDF_TABLE_LIMITS = { pages:10000, rows:100000, columns:512, cells:500000, text:64 * 1024 * 1024 };
const median = values => { const sorted = values.toSorted((a,b) => a-b); return sorted[Math.floor(sorted.length/2)] || 1; };

/** Restore reading order and cell boundaries from PDF text coordinates. */
export function pdfPageRows(items) {
  const source = items.filter(item => typeof item.str === 'string' && item.str.trim() && item.transform?.length === 6);
  if (!source.length) return [];
  const orientations = [0,0,0,0];
  for (const item of source) {
    const angle = Math.atan2(item.transform[1],item.transform[0]);
    orientations[(Math.round(angle/(Math.PI/2))+4)%4] += item.str.length;
  }
  const orientation = orientations.indexOf(Math.max(...orientations));
  const angle = orientation*Math.PI/2, cos = Math.cos(angle), sin = Math.sin(angle);
  const fragments = [];
  for (const item of source) {
    const [a,b,c,d,px,py] = item.transform;
    if (![a,b,c,d,px,py,item.width].every(Number.isFinite)) continue;
    const height = Math.max(1,Math.hypot(c,d) || Math.hypot(a,b));
    const width = Math.max(0,item.width), unit = width/Math.max(1,item.str.length);
    const x = cos*px+sin*py, y = sin*px-cos*py;
    const breaks = /\t+| {2,}/g; let start = 0;
    const append = end => {
      const raw = item.str.slice(start,end), leading = raw.length-raw.trimStart().length, value = raw.trim();
      if (value) fragments.push({ x:x+(start+leading)*unit, end:x+end*unit, y, height, text:value, unit:unit || height*.5 });
    };
    for (const match of item.str.matchAll(breaks)) { append(match.index); start = match.index+match[0].length; }
    append(item.str.length);
  }
  fragments.sort((a,b) => a.y-b.y || a.x-b.x);
  const lines = [];
  for (const fragment of fragments) {
    let line;
    for (let i=lines.length-1;i>=Math.max(0,lines.length-3);i--) {
      const candidate = lines[i];
      if (Math.abs(candidate.y-fragment.y)<=Math.max(2,Math.min(candidate.height,fragment.height)*.45)) { line=candidate; break; }
    }
    if (!line) { line={y:fragment.y,height:fragment.height,fragments:[]}; lines.push(line); }
    line.fragments.push(fragment);
  }
  const rows = lines.map(line => {
    const cells = [];
    for (const fragment of line.fragments.toSorted((a,b) => a.x-b.x)) {
      const previous = cells.at(-1), gap = previous ? fragment.x-previous.end : Infinity;
      if (previous && gap<=Math.max(fragment.height*.85,fragment.unit*1.7)) {
        previous.text += (gap>fragment.unit*.25 ? ' ' : '')+fragment.text;
        previous.end = Math.max(previous.end,fragment.end);
      } else cells.push({...fragment});
    }
    if (cells.length>PDF_TABLE_LIMITS.columns) throw new Error('Лимит конвертации PDF: 512 столбцов на странице.');
    return cells;
  });
  let seed = rows[0];
  for (const row of rows) if (row.length>seed.length) seed=row;
  const cuts = [];
  for (let col=1;col<seed.length;col++) {
    const middle = (seed[col-1].end+seed[col].x)/2, left=[], right=[];
    for (const row of rows) for (let i=1;i<row.length;i++) {
      if (row[i-1].end<middle && row[i].x>middle) { left.push(row[i-1].end); right.push(row[i].x); break; }
    }
    const low = left.length ? median(left) : seed[col-1].end;
    const high = right.length ? median(right) : seed[col].x;
    cuts.push((low+high)/2);
  }
  return rows.map(cells => {
    const row = Array(cuts.length+1).fill('');
    for (const cell of cells) {
      let col = 0; while (col<cuts.length && cell.x>cuts[col]) col++;
      row[col] += (row[col] ? ' ' : '')+cell.text;
      if (row[col].length>32767) throw new Error('Текст ячейки длиннее 32767 символов. Разделите исходный PDF.');
    }
    return row;
  });
}

/** Identify only short, unambiguous decimal values; preserve IDs and long numbers. */
export function pdfNumber(value) {
  if (!/^-?(?:0|[1-9]\d*)(?:[.,]\d+)?$/.test(value) || value.replace(/[^0-9]/g,'').length>15) return null;
  const number = Number(value.replace(',','.'));
  return Number.isFinite(number) ? number : null;
}

/** Combine pages into one table with explicit page provenance and scan placeholders. */
export function pdfRowsWithPages(pages) {
  if (1+pages.reduce((count,page) => count+Math.max(1,page.rows.length),0)>PDF_TABLE_LIMITS.rows) throw new Error('Лимит сводной таблицы: 100 000 строк, включая заголовок. Разделите исходный PDF.');
  const columns = pages.reduce((maximum,page) => page.rows.reduce((count,row) => Math.max(count,row.length),maximum),1);
  if (columns>=PDF_TABLE_LIMITS.columns) throw new Error('В сводной таблице допустимо до 511 столбцов данных и один столбец с номером страницы.');
  const result = [['Страница',...Array.from({length:columns},(_,i) => 'Столбец '+(i+1))]];
  for (const page of pages) {
    const rows = page.rows.length ? page.rows : [['Нет текстового слоя — требуется OCR']];
    for (const row of rows) result.push([String(page.number),...Array.from({length:columns},(_,i) => row[i] || '')]);
  }
  return result;
}

/** UTF-8 CSV for Excel: page provenance, empty cells, quotes and literal formulas. */
export function pdfPagesCsv(pages) {
  const quote = input => {
    let value = String(input ?? '');
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(value) && pdfNumber(value.trim())===null) value="'"+value;
    return /[;"\r\n]/.test(value) ? '"'+value.replaceAll('"','""')+'"' : value;
  };
  const lines = ['\ufeff'];
  for (const row of pdfRowsWithPages(pages)) lines.push(row.map(quote).join(';')+'\r\n');
  return new Blob(lines,{type:'text/csv;charset=utf-8'});
}

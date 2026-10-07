export const TEXT_EXTENSIONS = ['json', 'yaml', 'yml', 'js', 'env', 'txt'];
export const LIMITS = { pdf: 50, docx: 32, pptx: 32, wav: 100, jpg: 25, jpeg: 25, png: 25, xlsx: 32, csv: 20, md: 2, tex: 2, ipynb: 32, json: 8, yaml: 8, yml: 8, js: 8, env: 2, txt: 8 };
const MIB = 1024 * 1024;

/** Return a normalized supported extension or reject an unknown format. */
export function getExtension(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (!Object.hasOwn(LIMITS, ext)) throw new Error('Поддерживаются PDF, DOCX, PPTX, WAV, JPG, PNG, XLSX, CSV, MD, TEX, IPYNB, JSON, YAML/YML, JS, ENV и TXT.');
  return ext;
}

/** Check file limits before allocating the input buffer. */
export function validateFile(file) {
  const ext = getExtension(file.name);
  if (!file.size && !TEXT_EXTENSIONS.includes(ext)) throw new Error('Файл пустой. Выберите другой файл.');
  if (file.size > LIMITS[ext] * MIB) throw new Error(`Лимит для .${ext} — ${LIMITS[ext]} МиБ.`);
  return ext;
}

/** Inspect the central directory without decompressing an Office archive. */
export function validateOffice(data, ext) {
  const view = new DataView(data);
  let end = -1;
  for (let i = data.byteLength - 22; i >= Math.max(0, data.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === data.byteLength) { end = i; break; }
  }
  if (end < 0) throw new Error('Повреждённый ZIP-контейнер Office.');
  const count = view.getUint16(end + 10, true);
  let pos = view.getUint32(end + 16, true);
  const directorySize = view.getUint32(end + 12, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true) || count > 3000 || pos + directorySize > end) throw new Error('Этот контейнер Office не поддерживается или слишком сложный.');
  let total = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || view.getUint32(pos, true) !== 0x02014b50) throw new Error('Повреждённая структура Office.');
    const compressed = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const length = view.getUint16(pos + 28, true);
    const next = pos + 46 + length + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
    if (next > end || view.getUint16(pos + 8, true) & 1) throw new Error('Зашифрованные или повреждённые документы не поддерживаются.');
    total += size;
    if (size > 32 * MIB || total > 128 * MIB || size > Math.max(1, compressed) * 300) throw new Error('Документ слишком большой после распаковки.');
    names.add(new TextDecoder().decode(new Uint8Array(data, pos + 46, length)));
    pos = next;
  }
  if (!names.has('[Content_Types].xml') || !names.has({ docx: 'word/document.xml', pptx: 'ppt/presentation.xml', xlsx: 'xl/workbook.xml' }[ext])) throw new Error(`Содержимое не соответствует формату .${ext}.`);
}

/** Validate signatures rather than trusting a filename or supplied MIME type. */
export function validateBytes(data, ext) {
  const bytes = new Uint8Array(data);
  const ascii = (start, length) => new TextDecoder().decode(bytes.subarray(start, start + length));
  let valid = false;
  if (['csv', 'md', 'tex', 'ipynb', ...TEXT_EXTENSIONS].includes(ext)) {
    const utf16 = bytes[0] === 255 && bytes[1] === 254 || bytes[0] === 254 && bytes[1] === 255;
    if (bytes.subarray(0, 4096).includes(0) && !utf16) throw new Error(`${ext.toUpperCase()} содержит двоичные данные.`);
    return;
  }
  if (ext === 'pdf') valid = ascii(0, 1024).includes('%PDF-');
  if (ext === 'png') valid = [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  if (ext === 'jpg' || ext === 'jpeg') valid = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (ext === 'wav') valid = ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE';
  if (ext === 'docx' || ext === 'pptx' || ext === 'xlsx') { validateOffice(data, ext); return; }
  if (!valid) throw new Error('Файл повреждён или его содержимое не соответствует расширению.');
}

/** Format a size using binary units. */
export function formatSize(bytes) {
  return bytes < MIB ? `${Math.max(1, Math.round(bytes / 1024))} КиБ` : `${(bytes / MIB).toFixed(1)} МиБ`;
}

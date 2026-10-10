/** Bounded CFB reader for the main text story in unencrypted Word 97–2003 files. */
const END = 0xfffffffe, FREE = 0xffffffff;
const check = signal => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
const bad = () => { throw new Error('Повреждённый или неподдерживаемый файл DOC.'); };
export async function openCompound(file, signal) {
  const h = new DataView(await file.slice(0, 512).arrayBuffer());
  if (h.byteLength < 512 || h.getUint32(0, true) !== 0xe011cfd0 || h.getUint32(4, true) !== 0xe11ab1a1 || h.getUint16(28, true) !== 0xfffe) bad();
  const major = h.getUint16(26, true), shift = h.getUint16(30, true), size = 2 ** shift;
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12)) || h.getUint16(32, true) !== 6 || h.getUint32(56, true) !== 4096) bad();
  const sectors = Math.floor(file.size / size) - 1;
  async function sector(id) { check(signal); if (id >= sectors) bad(); const bytes = await file.slice((id + 1) * size, (id + 2) * size).arrayBuffer(); if (bytes.byteLength !== size) bad(); return new DataView(bytes); }
  const fatIds = [], wanted = h.getUint32(44, true);
  if (wanted > sectors) bad();
  for (let i = 0; i < 109; i++) { const id = h.getUint32(76 + i * 4, true); if (id !== FREE) fatIds.push(id); }
  let dif = h.getUint32(68, true); const seen = new Set(), difCount = h.getUint32(72, true);
  if (difCount > sectors) bad();
  for (let n = 0; n < difCount; n++) { if (seen.has(dif)) bad(); seen.add(dif); const d = await sector(dif); for (let i = 0; i < size / 4 - 1; i++) { const id = d.getUint32(i * 4, true); if (id !== FREE) fatIds.push(id); } dif = d.getUint32(size - 4, true); }
  if (fatIds.length !== wanted || new Set(fatIds).size !== wanted || wanted * size / 4 < sectors) bad();
  const fat = new Uint32Array(wanted * size / 4);
  for (let n = 0; n < wanted; n++) { const d = await sector(fatIds[n]); for (let i = 0; i < size / 4; i++) fat[n * size / 4 + i] = d.getUint32(i * 4, true); }
  function chain(first, table, max) {
    const ids = [], visited = new Set(); let id = first;
    while (id !== END) { if (id >= max || id >= table.length || visited.has(id)) bad(); visited.add(id); ids.push(id); id = table[id]; }
    return ids;
  }
  function stream(first, length, table = fat, unit = size, backing = null) {
    if (!Number.isSafeInteger(length) || length < 0 || length > file.size) bad();
    const ids = length ? chain(first, table, backing ? Math.ceil(backing.length / unit) : sectors) : [];
    if (length > ids.length * unit) bad();
    return { length, async read(offset, count) {
      check(signal); if (offset < 0 || count < 0 || offset + count > length) bad();
      const result = new Uint8Array(count); let done = 0;
      while (done < count) {
        check(signal); const at = offset + done, block = Math.floor(at / unit), inner = at % unit; let span = Math.min(count - done, unit - inner);
        while (span < count - done && (inner + span) % unit === 0 && ids[block + (inner + span) / unit] === ids[block] + (inner + span) / unit) span += Math.min(unit, count - done - span);
        const start = ids[block] * unit + inner;
        const bytes = backing ? await backing.read(start, span) : new Uint8Array(await file.slice(size + start, size + start + span).arrayBuffer());
        if (bytes.length !== span) bad(); result.set(bytes, done); done += span;
      }
      return result;
    } };
  }
  const directory = chain(h.getUint32(48, true), fat, sectors), entries = [];
  if (directory.length * size > 16 * 1024 * 1024) bad();
  for (const id of directory) {
    const d = await sector(id);
    for (let at = 0; at < size; at += 128) {
      const type = d.getUint8(at + 66); if (type !== 2 && type !== 5) continue;
      const n = d.getUint16(at + 64, true); if (n < 2 || n > 64 || n % 2) bad();
      const name = new TextDecoder('utf-16le').decode(new Uint8Array(d.buffer, at, n - 2));
      const length = d.getUint32(at + 120, true) + (major === 4 ? d.getUint32(at + 124, true) * 4294967296 : 0);
      entries.push({ name, type, length, first: d.getUint32(at + 116, true) });
    }
  }
  const root = entries.find(e => e.type === 5); if (!root) bad(); let miniFat, miniStream;
  return { async get(name) {
    const entry = entries.find(e => e.type === 2 && e.name === name); if (!entry) bad();
    if (entry.length >= 4096 || !entry.length) return stream(entry.first, entry.length);
    if (!miniFat) {
      const count = h.getUint32(64, true), ids = chain(h.getUint32(60, true), fat, sectors); if (count !== ids.length || count * size > file.size) bad();
      miniFat = new Uint32Array(count * size / 4);
      for (let n = 0; n < count; n++) { const d = await sector(ids[n]); for (let i = 0; i < size / 4; i++) miniFat[n * size / 4 + i] = d.getUint32(i * 4, true); }
      miniStream = stream(root.first, root.length);
    }
    return stream(entry.first, entry.length, miniFat, 64, miniStream);
  } };
}

export async function extractDocText(file, signal) {
  const compound = await openCompound(file, signal), word = await compound.get('WordDocument');
  const header = await word.read(0, Math.min(4096, word.length)), fib = new DataView(header.buffer);
  if (header.length < 34 || fib.getUint16(0, true) !== 0xa5ec || fib.getUint16(2, true) < 0xc1) throw new Error('Поддерживается текст DOC Word 97–2003. Старый DOC откройте в Word или LibreOffice.');
  const flags = fib.getUint16(10, true); if (flags & 0x8100) throw new Error('DOC защищён паролем. Сначала снимите защиту в Word.');
  const lw = 34 + fib.getUint16(32, true) * 2; if (lw + 16 > header.length) bad();
  const pairs = lw + 2 + fib.getUint16(lw, true) * 4;
  if (pairs + 2 + 34 * 8 > header.length || fib.getUint16(pairs, true) < 34) bad();
  const characters = fib.getUint32(lw + 14, true), offset = fib.getUint32(pairs + 2 + 33 * 8, true), length = fib.getUint32(pairs + 6 + 33 * 8, true);
  if (length > 64 * 1024 * 1024) throw new Error('Слишком сложная структура DOC.');
  const table = await compound.get(flags & 0x200 ? '1Table' : '0Table'), bytes = await table.read(offset, length), d = new DataView(bytes.buffer);
  let at = 0;
  while (at < length && bytes[at] === 1) { if (at + 3 > length) bad(); at += 3 + d.getUint16(at + 1, true); }
  if (at + 5 > length || bytes[at] !== 2) bad();
  const pieceLength = d.getUint32(at + 1, true); at += 5;
  if (pieceLength < 4 || (pieceLength - 4) % 12 || at + pieceLength > length) bad();
  const count = (pieceLength - 4) / 12, cp = i => d.getUint32(at + i * 4, true), pieces = at + (count + 1) * 4;
  if (cp(0) !== 0 || cp(count) < characters) bad();
  const output = [], fields = [];
  function clean(text) {
    let result = '';
    for (const char of text) {
      const c = char.charCodeAt(0);
      if (c === 19) { fields.push(false); continue; }
      if (c === 20 && fields.length) { fields[fields.length - 1] = true; continue; }
      if (c === 21) { fields.pop(); continue; }
      if (fields.some(value => !value)) continue;
      if (c === 13 || c === 11 || c === 12) result += '\n'; else if (c === 7) result += '\t'; else if (c >= 32 || c === 9 || c === 10) result += char;
    }
    if (result) output.push(new Blob([result]));
  }
  for (let i = 0; i < count && cp(i) < characters; i++) {
    check(signal); if (cp(i + 1) < cp(i)) bad();
    const fc = d.getUint32(pieces + i * 8 + 2, true), compressed = !!(fc & 0x40000000), unit = compressed ? 1 : 2;
    const start = (fc & 0x3fffffff) / (compressed ? 2 : 1), total = (Math.min(cp(i + 1), characters) - cp(i)) * unit;
    if (!Number.isInteger(start)) bad();
    const decoder = new TextDecoder(compressed ? 'windows-1252' : 'utf-16le');
    for (let n = 0; n < total; n += 1024 * 1024) clean(decoder.decode(await word.read(start + n, Math.min(1024 * 1024, total - n)), { stream: n + 1024 * 1024 < total }));
  }
  return new File(output, (file.name || 'document.doc').replace(/\.doc$/i, '') + '.txt', { type: 'text/plain;charset=utf-8' });
}

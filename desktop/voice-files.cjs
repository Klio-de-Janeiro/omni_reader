const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_WAV = 16000 * 2 * 602 + 65536;
const validId = id => typeof id === 'string' && /^[\w-]{1,80}$/.test(id);

/** Replace only files owned by this service, preserving existing raw audio. */
async function writeJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}
async function readJson(filename, limit = 2 * 1024 * 1024) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Неверный или слишком большой файл данных голоса.');
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

/** Validate the actual WAV bytes, including its PCM data fingerprint. */
async function wavInfo(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.wav') throw new Error('Выберите WAV диктофона.');
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_WAV) throw new Error('WAV недоступен или превышает 602 секунды.');
  const handle = await fs.open(filename, 'r');
  let bytes;
  try {
    const current = await handle.stat();
    if (current.size !== stat.size || current.size > MAX_WAV) throw new Error('WAV изменился во время чтения.');
    bytes = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error('WAV обрезан.');
      offset += result.bytesRead;
    }
  } finally { await handle.close(); }
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Повреждённый WAV.');
  const end = bytes.readUInt32LE(4) + 8;
  if (end > bytes.length || end < 44) throw new Error('WAV обрезан.');
  let format, pcm;
  for (let start = 12; start + 8 <= end;) {
    const size = bytes.readUInt32LE(start + 4), next = start + 8 + size;
    if (next > end) throw new Error('Неверные блоки WAV.');
    const kind = bytes.toString('ascii', start, start + 4);
    if (kind === 'fmt ') {
      if (size < 16) throw new Error('Неверный формат WAV.');
      format = [bytes.readUInt16LE(start + 8), bytes.readUInt16LE(start + 10), bytes.readUInt32LE(start + 12), bytes.readUInt16LE(start + 20), bytes.readUInt16LE(start + 22)];
    } else if (kind === 'data') {
      if (pcm) throw new Error('WAV содержит несколько блоков звука.');
      pcm = bytes.subarray(start + 8, next);
    }
    start = next + (size % 2);
  }
  if (!format || format.join(',') !== '1,1,16000,2,16' || !pcm?.length || pcm.length % 2 || pcm.length > 32000 * 602) throw new Error('Нужен WAV mono PCM16, 16 кГц, до 602 секунд.');
  return { bytes, hash: createHash('sha256').update(pcm).digest('hex'), duration: pcm.length / 32000 };
}
module.exports = { MAX_WAV, validId, writeJson, readJson, wavInfo };

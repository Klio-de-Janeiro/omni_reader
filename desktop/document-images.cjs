const fs = require('node:fs/promises');
const path = require('node:path');

/** Read raster images only within the explicitly opened document's real folder. */
async function readDocumentImage(base, relative) {
  if (typeof relative !== 'string' || relative.length > 2048) return null;
  // The renderer supplies a decoded relative name, which may contain literal % or #.
  const name = relative.replaceAll('\\', '/');
  if (!name || /^[\/]|^[a-z][\w+.-]*:/i.test(name) || /[\u0000-\u001f:]/.test(name) || name.split('/').includes('..') || !/\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(name)) return null;
  try {
    const root = await fs.realpath(base), file = await fs.realpath(path.resolve(root, name));
    const inside = path.relative(root, file);
    if (!inside || path.isAbsolute(inside) || inside.split(path.sep).includes('..')) return null;
    const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 25 * 1024 * 1024) return null;
    const bytes = await fs.readFile(file); if (bytes.length > 25 * 1024 * 1024) return null;
    let mime;
    if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
    else if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) mime = 'image/gif';
    else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
    else if (bytes.toString('ascii', 0, 2) === 'BM') mime = 'image/bmp';
    else if (bytes.toString('ascii', 4, 8) === 'ftyp' && /^avi[fs]$/.test(bytes.toString('ascii', 8, 12))) mime = 'image/avif';
    return mime ? `data:${mime};base64,${bytes.toString('base64')}` : null;
  } catch { return null; }
}
module.exports = { readDocumentImage };

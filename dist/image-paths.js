/** Only local images inside the document's folder; URLs and parent traversal are excluded. */
export function relativeImagePath(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let name;
  try { name = decodeURIComponent(value.trim().split(/[?#]/, 1)[0]).replaceAll('\\', '/'); }
  catch { return null; }
  if (!name || /^[\/]|^[a-z][\w+.-]*:/i.test(name) || /[\u0000-\u001f:]/.test(name)) return null;
  const parts = name.split('/').filter(part => part && part !== '.');
  if (parts.includes('..') || !/\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(parts.at(-1) || '')) return null;
  return parts.join('/');
}

export function imageMime(bytes) {
  const b = new Uint8Array(bytes), text = (start, end) => String.fromCharCode(...b.slice(start, end));
  if (b.length >= 8 && b.slice(0, 8).every((v, i) => v === [137,80,78,71,13,10,26,10][i])) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(text(0, 6))) return 'image/gif';
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
  if (text(0, 2) === 'BM') return 'image/bmp';
  if (text(4, 8) === 'ftyp' && /^avi[fs]$/.test(text(8, 12))) return 'image/avif';
  return null;
}

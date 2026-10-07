import { relativeImagePath, imageMime } from './image-paths.js';

const pending = new WeakMap();
const validData = value => typeof value === 'string' && /^data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,[A-Za-z0-9+/]+=*$/i.test(value);
function storedImage(record, name) {
  const images = record.images || {};
  if (Object.hasOwn(images, name) && validData(images[name])) return images[name];
  // A phone can grant access to individual files without exposing their folders.
  const matches = Object.keys(images).filter(key => key.split('/').at(-1) === name.split('/').at(-1) && validData(images[key]));
  return matches.length === 1 ? images[matches[0]] : null;
}
function changed(record, window) {
  window.dispatchEvent(new window.CustomEvent('omni-images-changed', { detail: record }));
}
async function loadImage(record, name, window) {
  const stored = storedImage(record, name); if (stored) return stored;
  if (!record.imageSource || !window.omniDesktop?.readImage) return null;
  let requests = pending.get(record); if (!requests) pending.set(record, requests = new Map());
  if (!requests.has(name)) requests.set(name, (async () => {
    try {
      const data = await window.omniDesktop.readImage(record.imageSource, name);
      if (!validData(data)) return null;
      record.images ||= {};
      if (Object.values(record.images).reduce((n, value) => n + String(value).length, 0) + data.length > 100 * 1024 * 1024) return null;
      record.images[name] = data; changed(record, window); return data;
    } catch { return null; }
    finally { requests.delete(name); }
  })());
  return requests.get(name);
}

/** Render Markdown images through the scoped native reader, never through network requests. */
export function documentMarkup(renderMarkup, record = {}, signal) {
  return (source, ext, window) => renderMarkup(source, ext, window, {
    resolveImage: async name => {
      // renderMarkup already decoded and checked this path; decoding twice breaks % filenames.
      const path = name; if (!path || signal?.aborted) return null;
      const data = await loadImage(record, path, window);
      return signal?.aborted ? null : storedImage(record, path) || data;
    }
  });
}

export function refreshDocumentImages(root, record) {
  for (const placeholder of root.querySelectorAll('.markdown-image-placeholder[data-image-path]')) {
    const data = storedImage(record, placeholder.dataset.imagePath); if (!data) continue;
    const image = root.ownerDocument.createElement('img'); image.alt = placeholder.dataset.imageAlt || ''; image.src = data;
    placeholder.replaceWith(image);
  }
}

export async function attachDocumentImages(record, files, window) {
  const images = { ...record.images }; let total = Object.values(images).reduce((n, value) => n + String(value).length, 0);
  for (const file of files) {
    const name = relativeImagePath((file.webkitRelativePath || file.name).replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/'));
    if (!name || file.size > 25 * 1024 * 1024) throw new Error(`Недопустимое изображение или размер больше 25 МиБ: ${file.name}`);
    const bytes = new Uint8Array(await file.arrayBuffer()), mime = imageMime(bytes);
    if (!mime) throw new Error(`Не удалось прочитать изображение: ${file.name}`);
    let binary = ''; for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    const data = `data:${mime};base64,${window.btoa(binary)}`;
    total += data.length - (images[name]?.length || 0);
    if (total > 100 * 1024 * 1024) throw new Error('Изображения документа превышают 100 МиБ.');
    images[name] = data;
  }
  record.images = images; changed(record, window);
}

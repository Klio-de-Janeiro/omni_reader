import { validateBlob, MAX_FILE_BYTES } from './validation.js';
import { isNative, saveOriginal, printDocumentPdf } from './native.js';
import { openViewer } from './viewers.js';

export const conversionTargets = ext => ({ jpg: ['pdf', 'png'], jpeg: ['pdf', 'png'], png: ['jpg', 'pdf'], docx: ['pdf'], ogg: ['wav'] }[ext] || []);
export async function convertImage(file, target) {
  if (!['jpg', 'png', 'pdf'].includes(target)) throw new Error('Неподдерживаемый формат конвертации.');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }), canvas = document.createElement('canvas');
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 80000000) throw new Error('Изображение слишком большое для конвертации (максимум 80 Мп).');
    canvas.width = bitmap.width; canvas.height = bitmap.height; const ctx = canvas.getContext('2d');
    if (target !== 'png') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.drawImage(bitmap, 0, 0);
    const encoded = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не удалось преобразовать изображение.')), target === 'png' ? 'image/png' : 'image/jpeg', .95));
    if (target !== 'pdf') return encoded;
    const { PDFDocument } = await import('./vendor/pdf-lib.js'), doc = await PDFDocument.create(), image = await doc.embedJpg(await encoded.arrayBuffer());
    const scale = Math.min(1, 14400 / Math.max(canvas.width, canvas.height)), width = canvas.width * scale, height = canvas.height * scale;
    const page = doc.addPage([width, height]); page.drawImage(image, { x: 0, y: 0, width, height });
    return new Blob([await doc.save()], { type: 'application/pdf' });
  } finally { bitmap.close(); canvas.width = canvas.height = 1; }
}
async function convertDocx(file, name) {
  const root = document.createElement('div'), controller = new AbortController(); root.className = 'conversion-render'; document.body.append(root);
  try { const viewer = await openViewer(file, root, { ext: 'docx', signal: controller.signal, viewMode: 'scroll' }); return await printDocumentPdf(await viewer.printHTML(), name); }
  finally { controller.abort(); root.remove(); }
}
async function exportConverted(blob, name) {
  if (blob.size >= MAX_FILE_BYTES) throw new Error('Результат должен быть меньше 500 МБ.');
  const file = new File([blob], name, { type: blob.type }); await validateBlob(file);
  if (isNative) return saveOriginal({ name, blob: file, size: file.size });
  const url = URL.createObjectURL(file), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); return true;
}
export function initConversion({ getRecord, getEditor, notify }) {
  let busy = false;
  const menus = ['edit-file', 'focus-edit'].map(id => {
    const anchor = document.getElementById(id); if (!anchor) return null;
    const wrapper = document.createElement('div'), button = document.createElement('button'), list = document.createElement('div');
    wrapper.className = 'conversion-menu'; button.type = 'button'; button.textContent = 'Конвертировать ▾'; button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
    list.className = 'conversion-options'; list.setAttribute('role', 'menu'); list.hidden = true; list.id = id + '-conversion-options'; button.setAttribute('aria-controls', list.id);
    wrapper.append(button, list); anchor.after(wrapper);
    function close() { list.hidden = true; button.setAttribute('aria-expanded', 'false'); }
    function show() { if (button.disabled || wrapper.hidden) return; list.hidden = false; list.style.transform = ''; button.setAttribute('aria-expanded', 'true'); const r = list.getBoundingClientRect(), width = document.documentElement.clientWidth || innerWidth; const shift = r.left < 8 ? 8 - r.left : r.right > width - 8 ? width - 8 - r.right : 0; list.style.transform = `translateX(${shift}px)`; }
    button.onclick = () => list.hidden ? show() : close();
    wrapper.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') show(); });
    wrapper.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse' && !wrapper.contains(document.activeElement)) close(); });
    wrapper.addEventListener('focusout', event => { if (!wrapper.contains(event.relatedTarget)) close(); });
    wrapper.addEventListener('keydown', event => { if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); event.stopPropagation(); close(); button.focus(); } if (event.key === 'ArrowDown') { event.preventDefault(); show(); list.querySelector('button')?.focus(); } });
    document.addEventListener('pointerdown', event => { if (!wrapper.contains(event.target)) close(); });
    return { wrapper, button, list, close, ext: null };
  }).filter(Boolean);
  async function convert(target) {
    const record = getRecord(), session = getEditor(); if (busy || session?.busy || !record || !conversionTargets(record.ext).includes(target)) return;
    busy = true; sync(); menus.forEach(menu => menu.close()); session?.setBusy(true);
    try {
      const blob = session ? new File([await session.export()], record.name) : record.blob;
      const name = record.name.replace(/\.[^.]+$/, '') + '.' + target;
      notify('Конвертация…');
      const result = record.ext === 'ogg' ? await (await import('./audio-conversion.js')).convertOggToWav(blob) : record.ext === 'docx' ? await convertDocx(blob, name) : await convertImage(blob, target);
      if (result) { const saved = await exportConverted(result, name); notify(saved ? 'Готово: ' + name : 'Сохранение отменено.'); }
      else notify('В окне печати выберите «Сохранить как PDF».');
    } catch (error) { notify(error.message || 'Ошибка конвертации.', true); }
    finally { session?.setBusy(false); busy = false; sync(); }
  }
  function sync() {
    const record = getRecord(), targets = conversionTargets(record?.ext);
    for (const menu of menus) {
      menu.wrapper.hidden = !targets.length; menu.button.disabled = busy || !!getEditor()?.busy;
      if (menu.ext !== record?.ext) { menu.ext = record?.ext; menu.close(); menu.list.replaceChildren(); for (const target of targets) { const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitem'); item.textContent = 'В ' + target.toUpperCase(); item.onclick = () => void convert(target); menu.list.append(item); } }
    }
  }
  return { sync, get busy() { return busy; } };
}

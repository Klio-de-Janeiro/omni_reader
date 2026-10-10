const android = navigator.userAgent.includes('OmniAndroid');
export const isNative = android || !!window.omniDesktop;
/** Native hosts can enter fullscreen for OS-opened files without a browser click. */
export function setNativeFullscreen(value) {
  if (window.omniDesktop?.fullscreen) {
    void window.omniDesktop.fullscreen(value).catch(() => {});
    return true;
  }
  if (android) {
    try { callAndroid({ action: 'fullscreen', enabled: value }); return true; }
    catch { return false; }
  }
  return false;
}
export const hasDocumentWindows = !!window.omniDesktop?.openFile;
/** Transfer a selected file, never a filesystem path, to its own desktop window. */
export async function openDocumentWindow(file, resources = {}) {
  if (!hasDocumentWindows) return false;
  await window.omniDesktop.openFile(file, resources);
  return true;
}
export function setNativeDocument(name) {
  if (window.omniDesktop?.document) void window.omniDesktop.document(name).catch(() => {});
}
/** Invoke the Android-only main-frame prompt channel. */
function callAndroid(payload) {
  const result = prompt('OMNI_NATIVE', JSON.stringify(payload));
  if (result === null || result.startsWith('error:')) throw new Error(result?.slice(6) || 'Действие отменено.');
  return result;
}
/** Export an unchanged original after a system save dialog. */
export async function saveOriginal(record) {
  if (window.omniDesktop) {
    const host = window.omniDesktop;
    if (!host.saveStart) return host.save({ name: record.name, bytes: await record.blob.arrayBuffer() });
    if (!await host.saveStart(record.name)) return false;
    try { for (let at = 0; at < record.blob.size; at += 1048576) await host.saveChunk(await record.blob.slice(at, at + 1048576).arrayBuffer()); await host.saveFinish(false); }
    catch (error) { try { await host.saveFinish(true); } catch {} throw error; }
    return true;
  }
  if (!android) return false;
  callAndroid({ action: 'export-start', name: record.name });
  try {
    for (let offset = 0; offset < record.size; offset += 49152) {
      const bytes = new Uint8Array(await record.blob.slice(offset, offset + 49152).arrayBuffer());
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      callAndroid({ action: 'export-chunk', data: btoa(binary) });
    }
    callAndroid({ action: 'export-finish' });
  } catch (error) { try { callAndroid({ action: 'export-cancel' }); } catch {} throw error; }
  return true;
}
/** Receive files explicitly opened by the OS, never arbitrary path requests. */
export function connectNativeFiles(importFiles, onError) {
  if (window.omniDesktop) return window.omniDesktop.onFiles(async items => {
    for (const item of items) try {
      let blob = item.bytes;
      if (item.url) { const response = await fetch(item.url); if (!response.ok) throw new Error('Не удалось прочитать файл.'); blob = await response.blob(); }
      await importFiles([Object.assign(new File([blob], item.name), { omniNativeUrl: item.url, omniImageSource: item.imageSource, omniImages: item.images || {} })], { local: true });
    } catch (error) { onError(error); }
  });
  if (!android) return;
  let busy = false;
  async function poll() {
    if (busy) return; busy = true;
    let pending;
    try {
      pending = JSON.parse(callAndroid({ action: 'pending' }));
      if (!pending) return;
      if (pending.size >= 500000000) throw new Error('Размер файла должен быть меньше 500 МБ.');
      const response = await fetch(pending.url);
      if (!response.ok) throw new Error('Не удалось прочитать файл из другого приложения.');
      await importFiles([new File([await response.blob()], pending.name)]);
    } catch (error) { onError(error); }
    finally { if (pending) { try { callAndroid({ action: 'import-done' }); } catch {} } busy = false; }
  }
  addEventListener('omni-import', () => void poll()); void poll();
}

/** Native PDF rendering, with the browser print dialog as a web-only fallback. */
export async function printDocumentPdf(html, name) {
  if (window.omniDesktop?.pdf) return new Blob([await window.omniDesktop.pdf(html)], { type: 'application/pdf' });
  if (android) {
    const blob = new Blob([html], { type: 'text/html' });
    if (blob.size >= 500000000) throw new Error('Документ печати слишком большой.');
    callAndroid({ action: 'export-start', name });
    let opened = false;
    try {
      for (let at = 0; at < blob.size; at += 49152) {
        let binary = ''; for (const byte of new Uint8Array(await blob.slice(at, at + 49152).arrayBuffer())) binary += String.fromCharCode(byte);
        callAndroid({ action: 'export-chunk', data: btoa(binary) });
      }
      callAndroid({ action: 'pdf-render', name });
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        const state = JSON.parse(callAndroid({ action: 'pdf-status' }));
        if (state.error) throw new Error(state.error);
        if (state.opened) { opened = true; return null; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error('Время создания PDF истекло.');
    } finally { if (!opened) try { callAndroid({ action: 'pdf-close' }); callAndroid({ action: 'export-cancel' }); } catch {} }
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html'), area = document.createElement('div'); area.id = 'conversion-print';
  const shadow = area.attachShadow({ mode: 'open' }); shadow.append(...parsed.head.querySelectorAll('style'), ...parsed.body.childNodes); document.body.append(area);
  try { await Promise.all([...shadow.querySelectorAll('img')].map(img => img.decode().catch(() => {}))); window.print(); }
  finally { area.remove(); }
  return null;
}

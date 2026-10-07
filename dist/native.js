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
export async function openDocumentWindow(file) {
  if (!hasDocumentWindows) return false;
  await window.omniDesktop.openFile({ name: file.name, bytes: await file.arrayBuffer() });
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
  if (window.omniDesktop) return window.omniDesktop.save({ name: record.name, bytes: await record.blob.arrayBuffer() });
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
    try { await importFiles(items.map(item => new File([item.bytes], item.name)), { local: true }); } catch (error) { onError(error); }
  });
  if (!android) return;
  let busy = false;
  async function poll() {
    if (busy) return; busy = true;
    let pending;
    try {
      pending = JSON.parse(callAndroid({ action: 'pending' }));
      if (!pending) return;
      if (pending.size > 100 * 1024 * 1024) throw new Error('Файл больше 100 МиБ.');
      const response = await fetch(pending.url);
      if (!response.ok) throw new Error('Не удалось прочитать файл из другого приложения.');
      await importFiles([new File([await response.blob()], pending.name)]);
    } catch (error) { onError(error); }
    finally { if (pending) { try { callAndroid({ action: 'import-done' }); } catch {} } busy = false; }
  }
  addEventListener('omni-import', () => void poll()); void poll();
}

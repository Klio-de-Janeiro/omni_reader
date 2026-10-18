const desktop = () => window.omniDesktop;
const android = () => navigator.userAgent.includes('OmniAndroid');
const endpoint = name => new URL(`./api/latex/${name}`, window.location.href);
const handles = new Map();

function bytes(value) { return value instanceof Uint8Array ? value : new Uint8Array(value); }
function base64(value) {
  const data = bytes(value), parts = [];
  for (let at = 0; at < data.length; at += 32768) parts.push(String.fromCharCode(...data.subarray(at, at + 32768)));
  return btoa(parts.join(''));
}
function unbase64(value) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
function aborted(signal) { if (signal?.aborted) throw new DOMException('Отменено', 'AbortError'); }

export async function getLatexStatus() {
  if (desktop()?.latexStatus) return desktop().latexStatus();
  if (android()) return { available: false, engine: 'Tectonic', message: 'Компиляция доступна в Omni для Windows и через START_WEB на компьютере. Исходник можно редактировать и сохранять здесь.' };
  try {
    const response = await fetch(endpoint('status'), { cache: 'no-store' });
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) return response.json();
  } catch {}
  return { available: false, engine: 'Tectonic', message: 'Для компиляции запустите Omni через START_WEB.cmd или приложение Windows. Установка движка: npm run latex:setup.' };
}

export async function compileLatex(input, { signal } = {}) {
  aborted(signal);
  const cancel = () => { void cancelLatex(input.id); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    let result;
    if (desktop()?.latexCompile) result = await desktop().latexCompile(input);
    else {
      const files = await Promise.all((input.files || []).map(async file => ({ path: file.path || file.name, bytes: base64(file.bytes ?? await file.arrayBuffer()) })));
      aborted(signal);
      const body = JSON.stringify({ ...input, files });
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(endpoint('compile'), {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Omni-Latex': '1' }, body, signal
        });
        result = await response.json();
        // HTTP abort finishes before the previous compiler process has exited.
        if (response.status === 409 && attempt === 0) {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            aborted(signal);
            const status = await fetch(endpoint('status'), { cache: 'no-store', signal });
            if (!status.ok || !(await status.json()).busy) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          continue;
        }
        if (!response.ok) throw new Error(result.message || 'Не удалось запустить LaTeX.');
        break;
      }
      if (result.pdf) result.pdf = unbase64(result.pdf);
    }
    aborted(signal);
    if (result.pdf) result.pdf = bytes(result.pdf);
    return result;
  } finally { signal?.removeEventListener('abort', cancel); }
}

export async function cancelLatex(id) {
  if (desktop()?.latexCancel) return desktop().latexCancel(id);
}

/** Overwrite only an OS-selected TeX file or a file handle authorized by the browser. */
export async function saveLatexSource(record, data, expected) {
  if (desktop()?.latexSave) {
    const result = await desktop().latexSave({ url: record.nativeUrl, name: record.name, bytes: bytes(data), expected: bytes(expected) });
    if (result?.saved && result.url) record.nativeUrl = result.url;
    return !!result?.saved;
  }
  const window = globalThis.window;
  if (typeof window.showSaveFilePicker !== 'function') {
    throw new Error('Этот браузер не разрешает сохранение на месте. Используйте Omni для Windows или «Сохранить копию».');
  }
  let handle = handles.get(record.id) || record.fileHandle;
  try {
    if (!handle) handle = await window.showSaveFilePicker({ suggestedName: record.name, types: [{ description: 'LaTeX', accept: { 'text/x-tex': ['.tex'] } }] });
    const permission = await handle.queryPermission?.({ mode: 'readwrite' });
    if (permission && permission !== 'granted' && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') return false;
    // Newly chosen destinations are governed by the browser's overwrite dialog.
    if (handles.has(record.id) || record.fileHandle) {
      const current = new Uint8Array(await (await handle.getFile()).arrayBuffer()), previous = bytes(expected);
      if (current.length !== previous.length || current.some((value, at) => value !== previous[at])) throw new Error('Файл изменён другой программой. Откройте его заново или сохраните копию.');
    }
    const writer = await handle.createWritable();
    try { await writer.write(data); await writer.close(); }
    catch (error) { try { await writer.abort(); } catch {} throw error; }
    handles.set(record.id, handle);
    return true;
  } catch (error) { if (error.name === 'AbortError') return false; throw error; }
}

export async function downloadLatexPdf(data, name) {
  const file = new File([data], name.replace(/\.tex$/i, '.pdf'), { type: 'application/pdf' });
  const { isNative, saveOriginal } = await import('./native.js');
  if (isNative) return saveOriginal({ name: file.name, blob: file, size: file.size });
  const url = URL.createObjectURL(file), link = document.createElement('a');
  link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

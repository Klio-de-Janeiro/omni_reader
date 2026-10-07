import { viewMode as normalizeMode } from './page-modes.js';
import { copyText } from './clipboard.js';
import { isNative, saveOriginal, connectNativeFiles, hasDocumentWindows, openDocumentWindow, setNativeDocument, setNativeFullscreen } from './native.js';
import { isFullscreenShortcut, isThemeShortcut, zoomShortcut } from './shortcuts.js';
import { initThemes } from './themes.js';
import { validateFile, validateBytes, formatSize } from './validation.js';
import { listFiles, saveFile, removeFile } from './storage.js';
import { openViewer } from './viewers.js';
const $ = id => document.getElementById(id);
const files = new Map();
const sourceFormats = ['ipynb','json','yaml','yml','js','env','txt'];
const themes = initThemes(document);
let active, controller, viewer, downloadUrl, page = 1, pages = 1, zoom = 1;
let pendingInstall, importing = false, routingFiles = false;
let editor, editing = false, preparingEditor = false;
let viewMode='scroll',changingViewMode=false,focusMode=false,filesHidden=false,beforeFocus=false;
function setFiles(hidden){filesHidden=hidden;document.body.classList.toggle('files-hidden',hidden);$('files-toggle').setAttribute('aria-pressed',String(hidden));}
function shellShortcut(command){
  if(command==='focus')setFocus(!focusMode);
  else if(command==='theme')themes.cycle();
  else if(command==='escape'){if(focusMode)setFocus(false);else void closeViewer();}
  else if(command.startsWith('zoom-')){
    const delta=command==='zoom-reset'?null:command==='zoom-in'?0.25:-0.25;
    if(editing)void editor?.adjustZoom?.(delta);
    else void setZoom(delta===null?1:zoom+delta);
  }
  else if(command==='previous' || command==='next'){
    if(editing)void editor?.navigate?.(command==='next'?1:-1);
    else void goToPage(page+(command==='next'?1:-1));
  }
}
/** Hide application chrome; request native fullscreen when the host supports it. */
function setFocus(value,requestNative=true){
  if(value===focusMode)return;
  if(value){beforeFocus=filesHidden;setFiles(true);}else setFiles(beforeFocus);
  focusMode=value;document.body.classList.toggle('focus-mode',value);
  $('focus-toggle').setAttribute('aria-pressed',String(value));
  $('focus-exit').hidden=!value;
  syncFocusControls();
  void editor?.setFocus?.(value);
  const nativeFullscreen=requestNative && setNativeFullscreen(value);
  if(value){
    $('focus-exit').focus({preventScroll:true});
    if(requestNative && !nativeFullscreen && !document.fullscreenElement){
      const request=document.documentElement.requestFullscreen?.();
      request?.then(()=>{if(!focusMode)void document.exitFullscreen?.();}).catch(()=>{});
    }
  }else{
    if(requestNative && document.fullscreenElement)void document.exitFullscreen().catch(()=>{});
    $('focus-toggle').focus({preventScroll:true});
  }
}
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement && focusMode)setFocus(false,false);});
const ready = loadSaved();

/** Report errors as text so filenames cannot inject markup. */
function notify(message, error = false) {
  const node = document.createElement('div'); node.className = `toast${error ? ' error' : ''}`;
  node.textContent = message; $('messages').replaceChildren(node);
}
function clearMessage() { $('messages').replaceChildren(); }
function label(ext) { return ({ docx: 'DOC', pptx: 'PPT', jpg: 'JPG', jpeg: 'JPG', png: 'PNG', xlsx: 'XLS', csv: 'CSV', pdf: 'PDF', wav: 'WAV', md: 'MD', tex: 'TEX', ipynb:'IPY', json:'JSON', yaml:'YML', yml:'YML', js:'JS', env:'ENV', txt:'TXT' })[ext]; }

/** Rebuild the file list from the same state used by viewer actions. */
function renderList() {
  $('file-list').replaceChildren(); $('file-count').textContent = files.size; $('no-files').hidden = files.size > 0;
  for (const record of files.values()) {
    const li = document.createElement('li'); if (record.id === active) li.className = 'active';
    const button = document.createElement('button'); button.className = 'file-open'; button.title = record.name;
    button.setAttribute('aria-label', `Открыть ${record.name}`);
    if (record.id === active) button.setAttribute('aria-current', 'true');
    const badge = document.createElement('span'); badge.className = `file-badge ${record.ext}`; badge.textContent = label(record.ext);
    const text = document.createElement('span'); text.className = 'file-text';
    const name = document.createElement('span'); name.className = 'file-title'; name.textContent = record.name;
    const details = document.createElement('span'); details.className = 'file-details'; details.textContent = `${formatSize(record.size)} · ${record.saved ? 'сохранён' : 'в сеансе'}`;
    text.append(name, details); button.append(badge, text); button.onclick = () => void selectFile(record.id);
    const remove = document.createElement('button'); remove.className = 'file-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `Убрать ${record.name}`);
    remove.onclick = () => void discard(record.id);
    li.append(button, remove); $('file-list').append(li);
  }
}
async function loadSaved() {
  try { for (const record of await listFiles()) files.set(record.id, { ...record, saved: true }); renderList(); }
  catch { notify('Локальное хранилище недоступно. Можно открывать файлы без сохранения.'); }
}
/** Import sequentially, validate every file, and isolate per-file failures. */
async function importFiles(input, { local = false } = {}) {
  if (hasDocumentWindows && !local) {
    if (routingFiles) return;
    routingFiles = true; const errors = [];
    try {
      for (const file of Array.from(input).slice(0, 20)) {
        try { validateFile(file); await openDocumentWindow(file); }
        catch (error) { errors.push(`${file.name}: ${error.message}`); }
      }
      if (input.length > 20) errors.push('За один раз можно открыть не более 20 файлов.');
      if (errors.length) notify(errors.join(' '), true);
    } finally { routingFiles = false; $('file-input').value = ''; }
    return;
  }
  if (importing) { notify('Дождитесь добавления выбранных файлов.'); return; }
  if (!await canLeaveEditor()) { $('file-input').value = ''; return; }
  if (importing) return;
  const previousEditor = editor;
  previousEditor?.setBusy(true);
  importing = true; await ready; clearMessage();
  const errors = []; let last;
  for (const file of Array.from(input).slice(0, 20)) {
    try {
      const ext = validateFile(file);
      const bytes = await file.arrayBuffer(); validateBytes(bytes, ext);
      if (files.size >= 30) throw new Error('Открыто 30 файлов. Уберите ненужный из списка.');
      const record = { id: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join(""), name: file.name, size: file.size, ext, blob: file, saved: false, opened: Date.now() };
      if ($('remember').checked) {
        try { await saveFile(record); record.saved = true; }
        catch (error) { errors.push(`${file.name}: не сохранён. ${error.name === 'QuotaExceededError' ? 'Недостаточно места в хранилище приложения.' : error.message}`); }
      }
      files.set(record.id, record); last = record.id;
    } catch (error) { errors.push(`${file.name}: ${error.message}`); }
  }
  if (input.length > 20) errors.push('За один раз можно добавить не более 20 файлов.');
  importing = false; previousEditor?.setBusy(false); renderList();
  if (last) await selectFile(last, true);
  else if (hasDocumentWindows && !active) setNativeDocument(null);
  if (errors.length) notify(errors.join(' '), true);
  $('file-input').value = '';
}
/** Abort pending render work before displaying another document. */
function resetViewer() {
  editor?.dispose(); editor = null; editing = false; preparingEditor = false;
  $('viewer').classList.remove('editor-mode');
  $('edit-file').hidden = false;
  $('download').hidden = false;
  controller?.abort(); controller = new AbortController(); viewer = null;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = null;
  $('viewer').replaceChildren();
}
async function selectFile(id, leaveChecked = false, initialMode='scroll', position={}, autoFocus=true) {
  const record = files.get(id); if (!record) return;
  if (hasDocumentWindows && !leaveChecked && active && active !== id) {
    try { await openDocumentWindow(new File([record.blob],record.name)); }
    catch (error) { notify(error.message,true); }
    return;
  }
  if (!leaveChecked && !await canLeaveEditor()) return;
  resetViewer(); const current = controller;
  active = id; page = 1; pages = 1; zoom = 1; viewMode=normalizeMode(initialMode);changingViewMode=false;clearMessage();
  setNativeDocument(record.name);
  $('welcome').hidden = true; $('reader').hidden = false;
  if(autoFocus)setFocus(true);
  $('reader-name').textContent = record.name;
  $('reader-meta').textContent = `${record.ext.toUpperCase()} · ${formatSize(record.size)} · ${record.saved ? 'Копия на устройстве' : 'Только в этом сеансе'}`;
  $('reader-type').textContent = label(record.ext); $('reader-type').className = `format-icon ${record.ext}`;
  $('edit-file').hidden=record.ext==='tex';
  const office = record.ext === 'docx' || record.ext === 'pptx';
  $('view-mode-control').hidden=!['pdf','docx','pptx'].includes(record.ext);
  $('office-note').hidden = !office; $('pagination').hidden = true;
  $('zoom-controls').hidden = record.ext === 'wav';
  $('text-tools').hidden = !['pdf', 'docx', 'pptx', 'xlsx', 'csv', 'md', 'tex', ...sourceFormats].includes(record.ext);
  $('search-box').hidden = !['pdf', 'docx', 'pptx', 'md', 'tex', ...sourceFormats].includes(record.ext);
  $('text-search').value = ''; $('rotate').hidden = !['jpg', 'jpeg', 'png'].includes(record.ext);
  downloadUrl = URL.createObjectURL(record.blob); $('download').href = downloadUrl; $('download').download = record.name;
  $('viewer').innerHTML = '<div class="loading"><span class="spinner"></span><span>Открываем файл…</span></div>';
  $('viewer').setAttribute('aria-busy', 'true'); syncControls(); renderList();
  try {
    const next = await openViewer(record.blob, $('viewer'), { ext: record.ext, signal: current.signal, viewMode, onShellShortcut:shellShortcut,
      onPage: value => {if(!current.signal.aborted){page=value;syncControls();}},
      onZoom: value => {if(!current.signal.aborted){zoom=value;syncControls();}},
      onPages: count => { if (current.signal.aborted) return; pages = count; $('pagination').hidden = false; syncControls(); },
      onInfo: message => notify(message),
      onWarning: error => { if (!current.signal.aborted) notify(error.message || 'Часть файла не удалось отобразить.', true); },
    });
    if (!current.signal.aborted) {
      viewer = next;
      if(position.zoom)await setZoom(position.zoom);
      if(position.page)await goToPage(position.page);
      $('viewer').setAttribute('aria-busy', 'false'); syncControls();
    }
  } catch (error) {
    if (current.signal.aborted) return;
    setFocus(false);
    current.abort(); viewer = null;
    const box = document.createElement('div'); box.className = 'error-state';
    const title = document.createElement('strong'); title.textContent = 'Не удалось открыть файл';
    const text = document.createElement('span'); text.textContent = error.message || 'Повреждённый или неподдерживаемый файл.';
    box.append(title, text); $('viewer').replaceChildren(box); $('viewer').setAttribute('aria-busy', 'false'); syncControls();
  }
}
function syncFocusControls() {
  const ext=files.get(active)?.ext,source=ext==='md' || sourceFormats.includes(ext),image=['png','jpg','jpeg'].includes(ext),editable=source || image;
  $('focus-actions').hidden=!focusMode;
  $('focus-edit').hidden=!focusMode || !editable;
  $('focus-edit').disabled=preparingEditor || changingViewMode || importing || (editing? !editor || editor.busy : !viewer);
  $('focus-edit').textContent=image?(editing?'Инструменты':'Рисовать'):editing && editor?.sourceMode?'Просмотр':'Редактировать';
  $('focus-edit').setAttribute('aria-pressed',String(editing && !!editor?.sourceMode));
  $('focus-save').hidden=!focusMode || !editable || !editing;
  $('focus-save').disabled=!editor || editor.busy || !editor.dirty;
}
function syncControls() {
  syncFocusControls();
  $('view-mode').value=viewMode;$('view-mode').disabled=!viewer || changingViewMode;
  $('edit-file').disabled = !viewer || editing || preparingEditor || changingViewMode;
  $('page').value = page; $('page').max = pages; $('pages').textContent = `/ ${pages}`;
  $('prev').disabled = !viewer || changingViewMode || page <= 1; $('next').disabled = !viewer || changingViewMode || page >= pages;
  $('page').disabled = !viewer || changingViewMode; $('zoom-label').textContent = `${Math.round(zoom * 100)}%`;
  $('zoom-out').disabled = !viewer || changingViewMode || zoom <= 0.5; $('zoom-in').disabled = !viewer || changingViewMode || zoom >= 3;
  $('fit').disabled = !viewer || changingViewMode; $('rotate').disabled = !viewer;
}
async function goToPage(value) {
  if (!viewer || !Number.isFinite(value)) { syncControls(); return; }
  page = Math.max(1, Math.min(pages, Math.trunc(value))); syncControls();
  try { await viewer.setPage?.(page); } catch (error) { notify(error.message, true); }
}
async function setZoom(value) {
  if (!viewer) return;
  zoom = Math.max(0.5, Math.min(3, value)); syncControls();
  try { await viewer.setZoom?.(zoom); } catch (error) { notify(error.message, true); }
}
async function setViewMode(value){
  if(!viewer?.setViewMode || changingViewMode){syncControls();return;}
  const current=controller,next=normalizeMode(value);changingViewMode=true;syncControls();
  try{await viewer.setViewMode(next);if(!current.signal.aborted)viewMode=next;}catch(error){if(!current.signal.aborted)notify(error.message,true);}finally{if(!current.signal.aborted){changingViewMode=false;syncControls();}}
}
async function closeViewer() { if (!await canLeaveEditor()) return; setFocus(false); resetViewer(); active = null; setNativeDocument(null); $('reader').hidden = true; $('welcome').hidden = false; renderList(); }
async function discard(id) {
  if (active === id && !await canLeaveEditor()) return;
  try { if (files.get(id)?.saved) await removeFile(id); if (active === id) { setFocus(false); resetViewer(); active = null; setNativeDocument(null); $('reader').hidden = true; $('welcome').hidden = false; } files.delete(id); renderList(); }
  catch { notify('Не удалось удалить сохранённую копию. Попробуйте ещё раз.', true); }
}
for (const button of document.querySelectorAll('.open-button')) button.onclick = () => $('file-input').click();
$('file-input').onchange = event => void importFiles(event.target.files);
$('dropzone').onclick = () => $('file-input').click();
$('dropzone').onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('file-input').click(); } };
for (const name of ['dragenter', 'dragover']) document.addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.add('dragging'); });
document.addEventListener('dragleave', event => { if (!event.relatedTarget) $('dropzone').classList.remove('dragging'); });
document.addEventListener('drop', event => { event.preventDefault(); $('dropzone').classList.remove('dragging'); if (event.dataTransfer?.files.length) void importFiles(event.dataTransfer.files); });
$('close').onclick = closeViewer;
document.querySelector('.brand').onclick = event => { event.preventDefault(); closeViewer(); };
$('prev').onclick = () => void goToPage(page - 1); $('next').onclick = () => void goToPage(page + 1);
$('page').onchange = event => void goToPage(Number(event.target.value));
$('view-mode').onchange=event=>void setViewMode(event.target.value);
$('focus-exit').onclick=()=>setFocus(false);
$('focus-toggle').onclick=()=>setFocus(!focusMode);$('files-toggle').onclick=()=>setFiles(!filesHidden);
$('zoom-out').onclick = () => void setZoom(zoom - 0.25); $('zoom-in').onclick = () => void setZoom(zoom + 0.25); $('fit').onclick = () => void setZoom(1);
$('rotate').onclick = () => viewer?.rotate?.();
$('help').onclick = () => $('help-dialog').showModal(); $('help-close').onclick = () => $('help-dialog').close();
document.addEventListener('keydown',event=>{
  if(isThemeShortcut(event)){event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)themes.cycle();return;}
  const scaleCommand=zoomShortcut(event);
  if(scaleCommand && active && !$('help-dialog').open && !$('discard-dialog').open && !$('theme-dialog').open){
    event.preventDefault();event.stopImmediatePropagation();shellShortcut(scaleCommand);return;
  }
  if(isFullscreenShortcut(event) && active && !$('help-dialog').open && !$('discard-dialog').open && !$('theme-dialog').open){
    event.preventDefault();event.stopImmediatePropagation();
    if(!event.repeat)setFocus(!focusMode);
    return;
  }
  if(event.key==='Escape' && !$('help-dialog').open && !$('discard-dialog').open && !$('theme-dialog').open && active){
    if(focusMode){event.preventDefault();setFocus(false);}else closeViewer();
  }
},true);
// Fullscreen has no navigation bar: PgUp/PgDn or Alt+arrows turn pages.
document.addEventListener('keydown',event=>{
  if(!focusMode || event.defaultPrevented || event.ctrlKey || event.metaKey)return;
  const typing=event.target.closest?.('input,textarea,select,[contenteditable="true"]');
  let delta=0;
  if(event.altKey && event.key==='ArrowLeft' || !typing && event.key==='PageUp')delta=-1;
  if(event.altKey && event.key==='ArrowRight' || !typing && event.key==='PageDown')delta=1;
  if(delta){event.preventDefault();shellShortcut(delta>0?'next':'previous');}
});
addEventListener('beforeinstallprompt', event => { event.preventDefault(); pendingInstall = event; $('install').hidden = false; });
$('install').onclick = async () => { if (!pendingInstall) return; await pendingInstall.prompt(); pendingInstall = null; $('install').hidden = true; };
addEventListener('appinstalled', () => { $('install').hidden = true; });
const network = () => { $('network').textContent = navigator.onLine ? 'Локальная обработка' : 'Работа без сети'; };
addEventListener('online', network); addEventListener('offline', network); network();
if (!isNative && 'serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register('./sw.js').then(async registration => {
    await navigator.serviceWorker.ready; $('offline-status').textContent = 'Готово к работе офлайн';
    if (registration.waiting) $('offline-status').textContent = 'Обновление готово: закройте все окна Omni';
    registration.addEventListener('updatefound', () => {
      registration.installing?.addEventListener('statechange', () => { if (registration.waiting) $('offline-status').textContent = 'Обновление готово: закройте все окна Omni'; });
    });
  }).catch(() => { $('offline-status').textContent = 'Не удалось подготовить офлайн-копию'; });
} else $('offline-status').textContent = isNative ? 'Приложение работает локально' : 'Для веб-офлайна нужен HTTPS';

/** Expose file navigation only; file contents stay outside the tool response. */
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  try {
    Promise.resolve(document.modelContext.registerTool({
      name: 'navigate_open_file', title: 'Открыть файл из списка',
      description: 'Показывает уже добавленный в Omni файл по его точному имени; не читает и не возвращает содержимое.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input) {
        if (!input || typeof input.name !== 'string' || Object.keys(input).length !== 1) throw new Error('Нужно точное имя файла.');
        await ready;
        const matches = [...files.values()].filter(file => file.name === input.name);
        if (matches.length !== 1) throw new Error('Файл не найден или имя неоднозначно.');
        await selectFile(matches[0].id);
        if (!viewer) throw new Error('Просмотр файла завершился ошибкой.');
        return { opened: true, name: matches[0].name };
      },
    }, { signal: lifecycle.signal })).catch(() => {});
  } catch { /* An experimental browser API must never block local viewing. */ }
}

$('copy-selection').onmousedown = event => event.preventDefault();
$('copy-selection').onclick = async () => {
  try { await copyText(await viewer?.copyText?.()); notify('Выделение скопировано.'); }
  catch (error) { notify(error.message, true); }
};
$('find-text').onclick = async () => {
  const query = $('text-search').value.trim(), current = controller;
  if (!query || !viewer?.find) return;
  $('find-text').disabled = true;
  try {
    const result = await viewer.find(query);
    if (current !== controller || current.signal.aborted) return;
    if (result) { if (Number.isFinite(result.page)) page = result.page; syncControls(); notify(result.message); }
    else notify('Совпадений не найдено. В сканах PDF нужен OCR.');
  } catch (error) { if (current === controller) notify(error.message, true); }
  finally { $('find-text').disabled = false; }
};
$('text-search').onkeydown = event => { if (event.key === 'Enter') $('find-text').click(); };
$('download').onclick = async event => {
  if (!isNative) return;
  event.preventDefault(); const record = files.get(active); if (!record) return;
  try { await saveOriginal(record); } catch (error) { notify(error.message, true); }
};
connectNativeFiles(importFiles, error => notify(error.message, true));
if (isNative) { $('install').hidden = true; $('remember').checked = true; }

/** Ask only when a navigation would discard a user's unsaved editing session. */
async function canLeaveEditor() {
  if (preparingEditor || editor?.busy) { notify('Дождитесь завершения операции.'); return false; }
  if (!editor?.dirty) return true;
  const dialog = $('discard-dialog');
  if (dialog.open) return false;
  return new Promise(resolve => {
    dialog.returnValue = ''; dialog.showModal();
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'discard'), { once: true });
  });
}
/** Commit to a new app record before asking the OS where to export that copy. */
async function saveEditedCopy(session) {
  if (!session || session !== editor) return;
  session.setBusy(true);
  syncFocusControls();
  try {
    const source = files.get(active), bytes = await session.export();
    const base = (source.name.toLowerCase() === '.env' ? '.env' : source.name.replace(/\.[^.]+$/, '')).replace(/-edited-\d+$/, '');
    let number = 1, name;
    do { name = `${base}-edited-${number++}.${source.ext}`; } while ([...files.values()].some(file => file.name === name));
    const blob = new File([bytes], name); const ext = validateFile(blob); validateBytes(await blob.arrayBuffer(), ext);
    if (files.size >= 30) throw new Error('Открыто 30 файлов. Освободите место в списке перед сохранением копии.');
    const record = { id: crypto.randomUUID(), name, size: blob.size, ext, blob, saved: false, opened: Date.now() };
    if ($('remember').checked) { await saveFile(record); record.saved = true; }
    files.set(record.id, record); session.setBusy(false); editor.dispose(); editor = null;
    await selectFile(record.id, true, viewMode, session.position);
    notify(`Копия ${name} добавлена в приложение${record.saved ? ' и сохранена на устройстве' : ' на время сеанса'}.`);
    if (isNative) await saveOriginal(record);
    else { const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  } catch (error) { session.setBusy(false);syncFocusControls();notify(error.message || 'Не удалось сохранить копию.', true); }
}
$('focus-edit').onclick=()=>{
  if(editing && editor?.toggleView){editor.toggleView();syncFocusControls();}
  else if(editing && editor?.toggleTools){editor.toggleTools();syncFocusControls();}
  else void $('edit-file').onclick();
};
$('focus-save').onclick=()=>void saveEditedCopy(editor);
$('edit-file').onclick = async () => {
  if (editing || preparingEditor || changingViewMode || !active) return;
  const record = files.get(active), initialPage=page, initialZoom=zoom; resetViewer(); editing = true; preparingEditor = true;
  const current = controller;
  $('pagination').hidden = true; $('zoom-controls').hidden = true; $('text-tools').hidden = true; $('office-note').hidden = true; $('rotate').hidden = true; $('edit-file').hidden = true;
  $('download').hidden = true;$('view-mode-control').hidden=true;
  $('viewer').classList.add('editor-mode'); $('viewer').setAttribute('aria-busy', 'true');
  $('viewer').textContent = 'Подготавливаем редактор…';
  syncControls();
  try {
    const { openEditor } = await import('./editors/ui.js');
    const next = await openEditor(record, $('viewer'), { signal: current.signal, viewMode,initialPage,initialZoom,onShellShortcut:shellShortcut,onViewMode:value=>{viewMode=value;}, onDirty:()=>syncFocusControls(), onSave: saveEditedCopy, onClose: () => selectFile(record.id,false,viewMode,editor?.position,false), onError: error => notify(error.message, true) });
    if(current.signal.aborted){next.dispose();return;}editor=next;
    preparingEditor = false; $('viewer').setAttribute('aria-busy', 'false');syncControls();
  } catch (error) { preparingEditor = false; await selectFile(record.id, true); notify(error.message || 'Редактор пока не поддерживает этот файл.', true); }
};
addEventListener('beforeunload', event => {
  if (editor?.dirty || editor?.busy) { event.preventDefault(); event.returnValue = ''; }
});

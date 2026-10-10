import { LARGE_TEXT_BYTES, openLargeText, openLargeCsv } from './large-files.js';
import { extractDocText } from './legacy-doc.js';
import { renderPdfDocument } from './pdf-viewer.js';
import { bindZoomGestures, createVisualZoom } from './gestures.js';
import { openTable } from './tables.js';
import { openMarkup } from './markup.js';
import { openText } from './text-files.js';
import { openNotebook } from './notebooks.js';
import { TEXT_EXTENSIONS } from './validation.js';
import { documentTheme } from './themes.js';
import { getShortcutBindings } from './shortcuts.js';
/** Build a DOM node without interpreting file content as markup. */
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
/** Render one PDF page at a time to bound canvas memory. */
async function openPdf(file, root, context) {
  const pdfjs = await import('./vendor/pdf/pdf.mjs');
  if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf/pdf.worker.mjs', import.meta.url).href;
  class BlobRange extends pdfjs.PDFDataRangeTransport {
    constructor(){super(file.size,new Uint8Array(),false);this.cancelled=false;}
    requestDataRange(begin,end){void file.slice(begin,end).arrayBuffer().then(data=>{if(!this.cancelled)this.onDataRange(begin,new Uint8Array(data));}).catch(error=>context.onWarning?.(error));}
    abort(){this.cancelled=true;}
  }
  const loading = pdfjs.getDocument({ range:new BlobRange(),length:file.size,rangeChunkSize:1024*1024,disableAutoFetch:true,disableStream:true, isEvalSupported: false, cMapUrl: new URL('./vendor/pdf/cmaps/', import.meta.url).href, cMapPacked: true, standardFontDataUrl: new URL('./vendor/pdf/standard_fonts/', import.meta.url).href, wasmUrl: new URL('./vendor/pdf/wasm/', import.meta.url).href });
  const cleanup = () => { void loading.destroy(); };
  context.signal.addEventListener('abort', cleanup, { once: true });
  if (context.signal.aborted) { cleanup(); throw new DOMException('Aborted', 'AbortError'); }
  let doc;
  try { doc = await loading.promise; } catch (error) {
    if (error.name === 'PasswordException') throw new Error('PDF защищён паролем. Снимите защиту в исходном приложении.');
    throw error;
  }
  return renderPdfDocument(doc,pdfjs,root,context);
}
/** Keep Office-generated DOM in a frame with no origin or network access. */
async function openOffice(file, root, context) {
  const markup=await (await fetch(new URL('./office.html',import.meta.url))).text(), buffer=await file.arrayBuffer();
  if(context.signal.aborted)throw new DOMException('Aborted','AbortError');
  const frame=element('iframe');frame.title=context.blocks?'Редактирование документа':'Изолированный просмотр документа';frame.setAttribute('sandbox','allow-scripts');frame.srcdoc=markup;
  const token=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  let selectedText='',requestId=0,initialized=false;const requests=new Map();
  const post=(data,transfer=[])=>frame.contentWindow?.postMessage({...data,token},'*',transfer);
  const theme = () => post({type:'theme',theme:documentTheme(root.ownerDocument)});
  const shortcuts=()=>post({type:'shortcuts',bindings:getShortcutBindings(root.ownerDocument.defaultView)});
  root.ownerDocument.defaultView.addEventListener('omni-theme-change',theme);
  root.ownerDocument.defaultView.addEventListener('omni-shortcuts-change',shortcuts);
  context.signal.addEventListener('abort',()=>{root.ownerDocument.defaultView.removeEventListener('omni-theme-change',theme);root.ownerDocument.defaultView.removeEventListener('omni-shortcuts-change',shortcuts);},{once:true});
  const rpc=data=>new Promise((resolve,reject)=>{
    if(context.signal.aborted){reject(new DOMException('Aborted','AbortError'));return;}
    const id=++requestId,timer=setTimeout(()=>{requests.delete(id);reject(new Error('Документ не ответил. Повторите действие.'));},180000);
    requests.set(id,{resolve,reject,timer});post({...data,requestId:id});
  });
  let listener;
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Документ не удалось обработать за 3 минуты.')),180000);
    listener=event=>{
      if(event.source!==frame.contentWindow || !event.data)return;const data=event.data;
      if(data.type==='ready' && !initialized){initialized=true;post({type:'open',ext:context.ext,buffer,viewMode:context.viewMode,blocks:context.blocks,bindings:getShortcutBindings(root.ownerDocument.defaultView)},[buffer]);return;}
      if(data.token!==token)return;
      if(data.type==='loaded'){clearTimeout(timeout);theme();context.onPages?.(data.pages);resolve();}
      if(data.type==='selection')selectedText=data.text;
      if(data.type==='page-change')context.onPage?.(data.page);
      if(data.type==='zoom-gesture')context.onZoomGesture?.(data);
      if(data.type==='edit' && context.blocks)context.onEdit?.(data);
      if(data.type==='edit-selection' && context.blocks)context.onSelection?.(data);
      if(data.type==='edit-shortcut' && context.blocks)context.onShortcut?.(data.command);
      if(data.type==='shell-shortcut')context.onShellShortcut?.(data.command);
      if(data.type==='reply'){const req=requests.get(data.requestId);if(req){clearTimeout(req.timer);requests.delete(data.requestId);req.resolve(data.result);}}
      if(data.type==='warning')context.onWarning?.(new Error(data.message));
      if(data.type==='error'){
        const error=new Error(data.message),req=requests.get(data.requestId);
        if(req){clearTimeout(req.timer);requests.delete(data.requestId);req.reject(error);}
        else{clearTimeout(timeout);reject(error);context.onWarning?.(error);}
      }
    };
    addEventListener('message',listener);root.replaceChildren(frame);
    context.signal.addEventListener('abort',()=>{clearTimeout(timeout);reject(new DOMException('Aborted','AbortError'));},{once:true});
  });
  context.signal.addEventListener('abort',()=>{removeEventListener('message',listener);for(const r of requests.values()){clearTimeout(r.timer);r.reject(new DOMException('Aborted','AbortError'));}requests.clear();frame.remove();},{once:true});
  return {
    setPage:page=>rpc({type:'page',page}),setZoom:(zoom,anchor)=>rpc({type:'zoom',zoom,anchor}),
    setViewMode:mode=>rpc({type:'view-mode',mode}),find:query=>rpc({type:'find',query}),
    flush:()=>rpc({type:'flush'}),command:data=>post({type:'edit-command',...data}),
    sync:blocks=>post({type:'edit-sync',blocks}),setBusy:busy=>post({type:'edit-busy',busy}),
    copyText:()=>selectedText,printHTML:()=>rpc({type:'print-html'}),
    addHighlight:color=>rpc({type:'highlight-add',color}),setHighlights:records=>rpc({type:'highlight-set',records}),clearHighlights:()=>rpc({type:'highlight-clear'}),
  };
}
/** Show images with fit-to-width scaling and quarter-turn rotation. */
async function openImage(file, root, context) {
  const url = URL.createObjectURL(file);
  context.signal.addEventListener('abort', () => URL.revokeObjectURL(url), { once: true });
  const image = element('img'); image.alt = file.name; image.src = url;
  await image.decode();
  if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('Изображение больше 40 мегапикселей. Уменьшите разрешение.');
  const wrap = element('div', 'image-wrap'); wrap.append(image); root.replaceChildren(wrap);
  let rotation = 0, visual;
  function fit() {
    const sideways = rotation % 180 !== 0;
    const width = sideways ? image.naturalHeight : image.naturalWidth;
    const height = sideways ? image.naturalWidth : image.naturalHeight;
    const gap = document.body.classList.contains('focus-mode') ? 0 : 40;
    const bounds=root.getBoundingClientRect();
    const factor = Math.min(Math.max(1, (bounds.width || root.clientWidth) - gap) / width, Math.max(1, (bounds.height || root.clientHeight) - gap) / height);
    image.style.width = `${image.naturalWidth * factor}px`; image.style.height = `${image.naturalHeight * factor}px`;
    image.style.transform = `rotate(${rotation}deg)`;
    wrap.style.width = `${width * factor}px`; wrap.style.minWidth = '0';
    wrap.style.height = `${height * factor}px`; wrap.style.minHeight = '0';
    visual?.refresh();
  }
  fit(); visual = createVisualZoom(root, wrap, {signal:context.signal,center:true,fixedWidth:false});
  const observer = new ResizeObserver(fit); observer.observe(root);
  context.signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  return { setZoom: visual.setZoom, rotate: () => { rotation = (rotation + 90) % 360; fit(); } };
}
/** Play browser-supported WAV codecs using native accessible media controls. */
async function openAudio(file, root, context) {
  const url = URL.createObjectURL(file);
  let knownDuration;
  const metadata = context.ext === 'ogg' ? import('./audio-conversion.js').then(module => module.readOggInfo(file)).then(info => { knownDuration = info.duration; }).catch(() => {}) : Promise.resolve();
  const duration = () => Number.isFinite(audio.duration) ? audio.duration : knownDuration ?? Infinity;
  const panel = element('div', 'audio-panel');
  const mark = element('div', 'audio-mark', '♫'); mark.setAttribute('aria-hidden', 'true');
  const audio = element('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = url;
  const label = element('label', '', 'Скорость');
  const select = element('select'); select.setAttribute('aria-label', 'Скорость воспроизведения');
  for (const rate of [0.5, 0.75, 1, 1.25, 1.5, 2]) { const option = element('option', '', `${rate}×`); option.value = rate; option.selected = rate === 1; select.append(option); }
  select.addEventListener('change', () => { audio.playbackRate = Number(select.value); });
  label.append(select);
  const seekBar = element('div', 'seek-bar');
  const input = element('input'); input.placeholder = 'мм:сс'; input.setAttribute('aria-label', 'Перейти к времени'); input.inputMode = 'decimal';
  const seek = element('button', '', 'Перейти');
  const backward = element('button', '', '−10 с'), forward = element('button', '', '+10 с');
  seek.onclick = () => {
    const parts = input.value.trim().split(':').map(Number);
    const time = parts.length === 1 ? parts[0] : parts.length === 2 ? parts[0] * 60 + parts[1] : NaN;
    if (!input.value.trim() || !Number.isFinite(time) || time < 0 || time > duration()) { context.onWarning(new Error('Укажите время в секундах или мм:сс в пределах записи.')); return; }
    audio.currentTime = time;
  };
  input.onkeydown = event => { if (event.key === 'Enter') seek.click(); };
  backward.onclick = () => { audio.currentTime = Math.max(0, audio.currentTime - 10); };
  forward.onclick = () => { audio.currentTime = Math.min(duration(), audio.currentTime + 10); };
  seekBar.append(backward, input, seek, forward);
  panel.append(mark, audio, label, seekBar); root.replaceChildren(panel);

  context.signal.addEventListener('abort', () => { audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); }, { once: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Не удалось прочитать аудио за 15 секунд.')), 15000);
    const finish = fn => value => { clearTimeout(timer); fn(value); };
    audio.addEventListener('loadedmetadata', finish(resolve), { once: true });
    audio.addEventListener('error', finish(() => reject(new Error('Не удалось воспроизвести аудио: файл повреждён или кодек не поддерживается. Для OGG обновите браузер или Android System WebView.'))), { once: true });
    context.signal.addEventListener('abort', finish(() => reject(new DOMException('Aborted', 'AbortError'))), { once: true });
  });
  await metadata;
  if (window.omniDesktop?.speechRun) { const { mountSpeech } = await import('./speech-ui.js'); if (!context.signal.aborted) mountSpeech(panel, file, context); }
  return {};
}
export async function openViewer(file, root, context) {
  if(context.ext==='doc'){file=await extractDocText(file,context.signal);context.onInfo?.('DOC: основной текст без оформления, объектов и обработки исправлений.');context={...context,ext:'txt'};}
  if(context.ext==='csv' && file.size>LARGE_TEXT_BYTES)return openLargeCsv(file,root,context);
  if([...TEXT_EXTENSIONS,'md','tex','ipynb'].includes(context.ext) && file.size>LARGE_TEXT_BYTES)return openLargeText(file,root,context);
  let zoom = 1, gestures;
  const renderer = context.ext === 'ipynb' ? openNotebook : TEXT_EXTENSIONS.includes(context.ext) ? openText : ['md','tex'].includes(context.ext) ? openMarkup : ['xlsx','csv'].includes(context.ext) ? openTable : context.ext === 'pdf' ? openPdf : ['docx','pptx'].includes(context.ext) ? openOffice : ['wav','ogg'].includes(context.ext) ? openAudio : openImage;
  const api = await renderer(file, root, {...context, onZoomGesture: data => gestures?.zoomBy(data.delta,data.anchor)});
  if (!api.setZoom) return api;
  const resize = api.setZoom;
  api.setZoom = async (value, anchor) => {
    if (context.signal.aborted) return;
    const next = Math.max(0.5,Math.min(3,value));
    await resize(next,anchor);
    if (!context.signal.aborted) { zoom = next; context.onZoom?.(zoom); }
  };
  gestures = bindZoomGestures(api.zoomRoot || root, {getZoom:()=>zoom,setZoom:api.setZoom,signal:context.signal,onError:context.onWarning});
  return api;
}

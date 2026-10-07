import { openViewer } from '../viewers.js';
import { viewMode } from '../page-modes.js';
import { editingShortcut } from '../shortcuts.js';
const node=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
const button=text=>{const n=node('button',text);n.type='button';return n;};
/** A toolbar and the actual document canvas, sharing one editable OOXML model. */
export async function openOfficeUI(model,record,root,{signal,onSave,onClose,onError,onDirty,viewMode:initialMode,onViewMode,onShellShortcut,initialPage=1,initialZoom=1}) {
  let viewer,frameController,page=initialPage,pages=1,zoom=initialZoom,mode=viewMode(initialMode),busy=false,working=false,disposed=false,selection=null,structural=false,api;
  const panel=node('div');panel.className='editor-panel office-editor';const bar=node('div');bar.className='editor-bar';
  const undo=button('Отменить'),redo=button('Повторить'),save=button('Сохранить копию'),close=button('К просмотру');
  save.className='primary';const status=node('span');status.className='editor-status';status.setAttribute('role','status');
  const before=button('‹'),after=button('›'),at=node('input'),count=node('span');at.type='number';at.min=1;at.setAttribute('aria-label','Номер страницы редактора');
  const layout=node('select');layout.setAttribute('aria-label','Режим просмотра редактора');for(const [value,text] of [['scroll','Прокрутка'],['page','По страницам']]){const o=node('option',text);o.value=value;layout.append(o);}layout.value=mode;
  const smaller=button('−'),larger=button('+'),zoomLabel=node('span','100%');smaller.setAttribute('aria-label','Уменьшить масштаб редактора');larger.setAttribute('aria-label','Увеличить масштаб редактора');
  const styles=new Map();for(const [key,label] of [['bold','B'],['italic','I'],['underline','U'],['strike','S']]){const b=button(label);b.setAttribute('aria-label',({bold:'Жирный',italic:'Курсив',underline:'Подчёркивание',strike:'Зачёркивание'})[key]);b.setAttribute('aria-pressed','false');styles.set(key,b);bar.append(b);}
  const omega=button('Ω');omega.setAttribute('aria-label','Спецсимволы');const palette=node('div');palette.className='symbol-palette';palette.hidden=true;
  for(const c of ['©','®','™','°','±','×','÷','≈','≠','≤','≥','∞','α','β','γ','δ','π','Σ','µ','Ω','→','←','✓','—','…','•']){const b=button(c);b.onmousedown=e=>e.preventDefault();b.onclick=()=>{if(!busy && !working)viewer.command({command:'insert',text:c});palette.hidden=true;};palette.append(b);}
  const insert1=button(record.ext==='docx'?'+ Абзац':'+ Слайд'),insert2=button(record.ext==='docx'?'+ Страница':'+ Раздел');
  bar.prepend(undo,redo);bar.append(omega,insert1,insert2,before,at,count,after,layout,smaller,zoomLabel,larger,save,close,status);
  const note=node('p','Щёлкните текст на странице, чтобы редактировать. Выделите текст для оформления. Копия сохраняет исходный формат.');note.className='editor-note';
  const canvas=node('div');canvas.className='viewer office-edit-canvas';panel.append(bar,palette,note,canvas);root.replaceChildren(panel);
  const update=()=>{
    if(disposed)return;const disabled=busy || working;
    for(const b of [undo,redo,save,close,insert1,insert2,omega,smaller,larger,layout,at,before,after])b.disabled=disabled || !viewer;
    for(const [key,b] of styles){b.disabled=disabled || !selection?.id;b.setAttribute('aria-pressed',String(!!selection?.styles?.[key]));}
    undo.disabled=disabled || !model.history.done.length;redo.disabled=disabled || !model.history.future.length;save.disabled=disabled || !model.history.dirty;
    before.disabled=disabled || page<=1;after.disabled=disabled || page>=pages;
    if(!working){at.value=page;layout.value=mode;}
    at.max=pages;count.textContent='/ '+pages;zoomLabel.textContent=Math.round(zoom*100)+'%';
    status.textContent=disabled?'Подготавливаем…':model.history.dirty?'Есть несохранённые изменения':'Изменений нет';onDirty?.(model.history.dirty);
  };
  const guarded=action=>async()=>{if(busy || working || disposed)return;working=true;update();try{await action();}catch(error){if(!disposed)onError(error);}finally{working=false;update();}};
  async function mount(target=page){
    frameController?.abort();viewer=null;selection=null;const current=new AbortController();frameController=current;let positioned=false;
    const bytes=await model.export();if(disposed)return;
    viewer=await openViewer(new File([bytes],record.name),canvas,{ext:record.ext,signal:current.signal,viewMode:mode,blocks:model.getBlocks(),
      onPages:value=>{pages=value;},
      onPage:value=>{if(positioned){page=value;update();}},
      onZoom:value=>{zoom=value;update();},
      onEdit:data=>{try{model.setParagraph(data.id,data.segments,data.mergeKey);}catch(error){viewer?.sync(model.getBlocks());onError(error);}},
      onSelection:data=>{selection=data;update();},
      onShortcut:command=>{const action=({undo,redo,save,slide:insert1,page:insert2,section:insert2})[command];action?.click();},
      onWarning:onError,onShellShortcut
    });
    if(disposed){current.abort();return;}await viewer.setZoom(zoom);page=Math.max(1,Math.min(pages,target));await viewer.setPage(page);positioned=true;update();
  }
  async function insert(kind){
    await viewer.flush();const result=await model.insert(kind,record.ext==='pptx'?page:selection?.id);
    structural=true;await mount(result.page || page);
    if(result.id)viewer.command({command:'focus',id:result.id});
  }
  for(const [key,b] of styles){b.onmousedown=e=>e.preventDefault();b.onclick=()=>{if(!busy && !working)viewer?.command({command:'format',key});};}
  omega.onmousedown=e=>e.preventDefault();omega.onclick=()=>{palette.hidden=!palette.hidden;};
  insert1.onclick=guarded(()=>insert(record.ext==='docx'?'paragraph':'slide'));insert2.onclick=guarded(()=>insert(record.ext==='docx'?'page':'section'));
  const turn=guarded(async()=>{const next=Number(at.value) || 1;await viewer.flush();page=Math.max(1,Math.min(pages,next));await viewer.setPage(page);});
  at.onchange=turn;before.onclick=guarded(async()=>{await viewer.flush();page=Math.max(1,page-1);await viewer.setPage(page);});after.onclick=guarded(async()=>{await viewer.flush();page=Math.min(pages,page+1);await viewer.setPage(page);});
  const scale=delta=>guarded(async()=>{await viewer.flush();zoom=Math.max(0.5,Math.min(3,zoom+delta));await viewer.setZoom(zoom);});smaller.onclick=scale(-0.25);larger.onclick=scale(0.25);
  layout.onchange=guarded(async()=>{const next=layout.value;await viewer.flush();viewer.setBusy(true);try{await viewer.setViewMode(next);mode=next;onViewMode?.(mode);}finally{viewer.setBusy(false);}});
  undo.onclick=guarded(async()=>{await viewer.flush();model.history.undo();await model.refresh();if(structural)await mount();else viewer.sync(model.getBlocks());});
  redo.onclick=guarded(async()=>{await viewer.flush();model.history.redo();await model.refresh();if(structural)await mount();else viewer.sync(model.getBlocks());});
  save.onclick=guarded(()=>onSave(api));close.onclick=async()=>{if(busy || working)return;try{await onClose();}catch(error){onError(error);}};
  model.history.onChange=update;
  api={
    get position(){return {page,zoom};},
    navigate:delta=>guarded(async()=>{await viewer.flush();page=Math.max(1,Math.min(pages,page+delta));await viewer.setPage(page);})(),
    adjustZoom:delta=>scale(delta===null?1-zoom:delta)(),
    get dirty(){return model.history.dirty;},get busy(){return busy || working;},
    async export(){await viewer?.flush();return model.export();},
    setBusy(value){busy=!!value;viewer?.setBusy(busy);update();},
    dispose(){disposed=true;frameController?.abort();}
  };
  const shortcut=e=>{const action=editingShortcut(e);if(action){e.preventDefault();({save,undo,redo})[action].click();}};
  panel.addEventListener('keydown',shortcut);signal.addEventListener('abort',()=>api.dispose(),{once:true});await mount(initialPage);update();return api;
}

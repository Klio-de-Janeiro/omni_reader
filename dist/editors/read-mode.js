import { openViewer } from '../viewers.js';

/** Preview the unsaved model while keeping its editor mounted and reversible. */
export function withReadMode(api,record,root,options) {
  if(api.toggleView)return api;
  let sourceMode=true,changing=false,disposed=false,controller,readViewer,preview,originalFocus,hidden=[],previewZoom=options.initialZoom||1,previewPage=options.initialPage||1,previewPages=1;
  const baseDispose=api.dispose.bind(api),baseBusy=Object.getOwnPropertyDescriptor(api,'busy'),basePosition=Object.getOwnPropertyDescriptor(api,'position');
  const originalZoom=api.adjustZoom,originalNavigate=api.navigate;
  Object.defineProperties(api,{
    sourceMode:{get:()=>sourceMode},
    readingViewer:{get:()=>readViewer},
    busy:{get:()=>changing || !!baseBusy?.get?.call(api)},
    position:{get:()=>sourceMode?basePosition?.get?.call(api):{page:previewPage,zoom:previewZoom}}
  });
  const button=root.ownerDocument.createElement('button');button.type='button';button.textContent='Просмотр';root.querySelector('.editor-bar')?.append(button);
  api.toggleView=async()=>{
    if(disposed || api.busy)return;
    changing=true;api.setBusy(true);options.onDirty?.(api.dirty);
    try{
      if(sourceMode){
        const focused=root.ownerDocument.activeElement;
        originalFocus=root.contains(focused) && focused.matches('iframe,textarea,input,[contenteditable="true"]')?focused:root.querySelector('iframe') || root.querySelector('textarea,[contenteditable="true"]') || root.querySelector('.editor-body input') || root.querySelector('input');
        const data=await api.export();if(disposed || options.signal.aborted)return;
        const position=basePosition?.get?.call(api)||{};previewZoom=position.zoom||options.initialZoom||1;previewPage=position.page||options.initialPage||1;
        hidden=[...root.children];for(const el of hidden)el.hidden=true;
        const document=root.ownerDocument;preview=document.createElement('div');preview.className='editor-panel draft-read-panel';root.append(preview);
        const bar=document.createElement('div');bar.className='editor-bar';
        const back=document.createElement('button');back.type='button';back.textContent='Редактировать';back.onclick=()=>api.toggleView().catch(options.onError);
        const save=document.createElement('button');save.type='button';save.textContent='Сохранить копию';save.onclick=()=>options.onSave?.(api);bar.append(back,save);
        const view=document.createElement('div');view.className='viewer draft-read-viewer';preview.append(bar,view);
        controller=new AbortController();
        readViewer=await openViewer(new File([data],record.name),view,{ext:record.ext,signal:controller.signal,viewMode:options.getViewMode?.()||options.viewMode,onShellShortcut:options.onShellShortcut,onWarning:options.onError,onZoom:value=>{previewZoom=value;},onPage:value=>{previewPage=value;},onPages:value=>{previewPages=value;}});
        if(disposed)return;
        await readViewer.setZoom?.(previewZoom);await readViewer.setPage?.(previewPage);
        sourceMode=false;button.textContent='Редактировать';
      }else{
        controller?.abort();readViewer=null;preview?.remove();preview=null;for(const el of hidden)el.hidden=false;hidden=[];sourceMode=true;button.textContent='Просмотр';originalFocus?.focus({preventScroll:true});
      }
    }catch(error){controller?.abort();readViewer=null;preview?.remove();preview=null;for(const el of hidden)el.hidden=false;hidden=[];throw error;}
    finally{changing=false;api.setBusy(false);options.onDirty?.(api.dirty);}
  };
  button.onclick=()=>api.toggleView().catch(options.onError);
  api.adjustZoom=async delta=>{if(sourceMode)return originalZoom?.(delta);previewZoom=delta===null?1:Math.max(.5,Math.min(3,previewZoom+delta));await readViewer?.setZoom?.(previewZoom);};
  api.navigate=async delta=>{if(sourceMode)return originalNavigate?.(delta);previewPage=Math.max(1,Math.min(previewPages,previewPage+delta));await readViewer?.setPage?.(previewPage);};
  api.dispose=()=>{if(disposed)return;disposed=true;controller?.abort();baseDispose();};
  return api;
}

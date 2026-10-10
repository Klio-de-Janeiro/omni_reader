import { viewMode, trackPages } from './page-modes.js';
import { captureZoomAnchor, createVisualZoom } from './gestures.js';
/** Keep page placeholders in scroll mode, but rasterize only nearby pages. */
export async function renderPdfDocument(doc,pdfjs,root,context) {
  let mode=viewMode(context.viewMode),page=1,zoom=1,revision=0,navigating=false,closed=false,queue=Promise.resolve(),paintQueue=Promise.resolve(),lastQuery='',foundPage=0,rasterTimer=0,rasterRevision=0;
  const cache=new Map(),live=new Map(),dimensions=new Map(),papers=[];
  const first=await doc.getPage(1),base=first.getViewport({scale:1});first.cleanup?.();
  root.classList.add('pdf-document');root.dataset.viewMode=mode;root.replaceChildren();
  const layoutWidth=()=>root.getBoundingClientRect().width || root.clientWidth;
  const layoutHeight=()=>root.getBoundingClientRect().height || root.clientHeight;
  const stack=document.createElement('div');stack.className='pdf-pages';stack.style.width=Math.max(1,layoutWidth()-40)+'px';root.append(stack);
  const visual=createVisualZoom(root,stack,{signal:context.signal,fixedWidth:false});
  const factor=()=>Math.max(0.1,Math.min((layoutWidth()-40)/base.width,1.6));
  function size(paper,viewport){paper.style.width=viewport.width+'px';paper.style.height=viewport.height+'px';}
  for(let i=1;i<=doc.numPages;i++){
    const paper=document.createElement('div');paper.className='pdf-paper';paper.dataset.page=i;paper.setAttribute('aria-label','Страница PDF '+i);paper.setAttribute('aria-busy','true');size(paper,{width:base.width*factor(),height:base.height*factor()});papers.push(paper);stack.append(paper);
  }
  function display(){root.dataset.viewMode=mode;for(const paper of papers)paper.hidden=mode==='page' && Number(paper.dataset.page)!==page;}
  function release(number){
    const item=live.get(number);if(!item)return;item.cancelled=true;item.task?.cancel();item.rasterTask?.cancel();item.textLayer?.cancel();
    item.canvas.width=0;item.canvas.height=0;item.paper.replaceChildren();item.paper.setAttribute('aria-busy','true');item.proxy?.cleanup?.();live.delete(number);
  }
  async function draw(number,current){
    const paper=papers[number-1];if(live.has(number) || closed)return;
    const canvas=document.createElement('canvas'),layer=document.createElement('div');layer.className='textLayer';
    const item={paper,canvas,layer};live.set(number,item);
    try{
      const proxy=await doc.getPage(number);item.proxy=proxy;
      if(item.cancelled || current!==revision || closed){proxy.cleanup?.();return;}
      const intrinsic=proxy.getViewport({scale:1}),fit=Math.max(0.1,Math.min((layoutWidth()-40)/intrinsic.width,1.6)),viewport=proxy.getViewport({scale:fit});
      dimensions.set(number,intrinsic);
      const restore=captureZoomAnchor(()=>papers,root,{x:root.clientWidth/2,y:root.clientHeight/2});
      size(paper,viewport);
      visual.refresh();
      if(!navigating)restore();
      const density=rasterDensity(viewport);item.viewport=viewport;item.density=density;
      canvas.width=Math.max(1,Math.floor(viewport.width*density));canvas.height=Math.max(1,Math.floor(viewport.height*density));canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
      layer.style.setProperty('--scale-factor',String(viewport.scale));layer.style.setProperty('--total-scale-factor',String(viewport.scale));paper.append(canvas,layer);
      item.task=proxy.render({canvasContext:canvas.getContext('2d'),canvas,viewport,transform:[density,0,0,density,0,0]});await item.task.promise;
      if(item.cancelled || current!==revision || closed)return;
      const content=await proxy.getTextContent();cache.set(number,content.items.map(n=>n.str || '').join(' '));
      if(item.cancelled || current!==revision || closed)return;
      item.textLayer=new pdfjs.TextLayer({textContentSource:content,container:layer,viewport});await item.textLayer.render();
      if(!item.cancelled)paper.setAttribute('aria-busy','false');
    }catch(error){if(!['RenderingCancelledException','AbortException'].includes(error.name) && !closed){release(number);throw error;}}
  }
  function rasterDensity(viewport){
    const cap=mode==='scroll'?4_000_000:12_000_000;
    return Math.min((globalThis.devicePixelRatio || 1)*zoom,6,Math.sqrt(cap/(viewport.width*viewport.height)));
  }
  /** Keep the old bitmap visible until a sharper one is ready; layout never changes. */
  async function sharpen(current){
    for(const item of [...live.values()]){
      if(closed || current!==rasterRevision)return;
      if(item.cancelled || !item.viewport || item.paper.getAttribute('aria-busy')==='true')continue;
      const density=rasterDensity(item.viewport);
      if(Math.abs(density-item.density)<0.01)continue;
      const canvas=document.createElement('canvas'),viewport=item.viewport;
      canvas.width=Math.max(1,Math.floor(viewport.width*density));canvas.height=Math.max(1,Math.floor(viewport.height*density));
      canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
      try{
        const task=item.proxy.render({canvasContext:canvas.getContext('2d'),canvas,viewport,transform:[density,0,0,density,0,0]});item.rasterTask=task;
        await task.promise;
        if(!closed && !item.cancelled && item.rasterTask===task){
          const old=item.canvas;old.replaceWith(canvas);old.width=old.height=0;item.canvas=canvas;item.density=density;
        }
      }catch(error){if(!['RenderingCancelledException','AbortException'].includes(error.name) && !closed)context.onWarning?.(error);}
      finally{if(item.canvas!==canvas)canvas.width=canvas.height=0;item.rasterTask=null;}
    }
  }
  function queueSharpen(){
    clearTimeout(rasterTimer);const current=++rasterRevision;
    for(const item of live.values())item.rasterTask?.cancel();
    rasterTimer=setTimeout(()=>{paintQueue=paintQueue.catch(()=>{}).then(()=>sharpen(current));},180);
  }
  function schedule(){
    const current=revision;
    paintQueue=paintQueue.catch(()=>{}).then(async()=>{
      if(closed || current!==revision)return;
      const wanted=mode==='page'?[page]:[page,page+1,page-1,page+2].filter(n=>n>0 && n<=doc.numPages);
      for(const n of [...live.keys()])if(!wanted.includes(n))release(n);
      for(const n of wanted){if(current!==revision || closed)return;await draw(n,current);}
    });return paintQueue;
  }
  function position(){
    const paper=papers[page-1],rect=paper.getBoundingClientRect(),frame=root.getBoundingClientRect();root.scrollTop+=rect.top-frame.top-16;root.scrollLeft=0;
  }
  const tracker=trackPages(()=>mode==='page'?[papers[page-1]]:papers,value=>{
    if(navigating || closed || mode!=='scroll')return;page=value;context.onPage?.(page);void schedule().catch(error=>context.onWarning?.(error));
  },{root,signal:context.signal});
  function reset(){revision++;for(const n of [...live.keys()])release(n);for(const paper of papers){const dim=dimensions.get(Number(paper.dataset.page)) || base,fit=Math.max(.1,Math.min((layoutWidth()-40)/dim.width,1.6));size(paper,{width:dim.width*fit,height:dim.height*fit});}}
  async function go(value){
    page=Math.max(1,Math.min(doc.numPages,Math.trunc(value) || 1));navigating=true;
    try{display();position();await schedule();position();context.onPage?.(page);}
    finally{navigating=false;tracker.refresh();}
  }
  const serial=action=>{const result=queue.catch(()=>{}).then(()=>{if(closed)throw new DOMException('Aborted','AbortError');return action();});queue=result;return result;};
  const stop=()=>{closed=true;clearTimeout(rasterTimer);revision++;tracker.dispose();for(const n of [...live.keys()])release(n);observer.disconnect();root.classList.remove('pdf-document');};
  let width=layoutWidth(),height=layoutHeight();
  const observer=new ResizeObserver(()=>{
    const newWidth=layoutWidth(),newHeight=layoutHeight();if(newWidth===width && newHeight===height)return;
    const changed=newWidth!==width;width=newWidth;height=newHeight;stack.style.width=Math.max(1,width-40)+'px';visual.refresh();
    if(changed)void serial(async()=>{reset();await go(page);}).catch(error=>{if(!closed)context.onWarning?.(error);});else tracker.refresh();
  });observer.observe(root);context.signal.addEventListener('abort',stop,{once:true});
  if(context.signal.aborted){stop();throw new DOMException('Aborted','AbortError');}
  display();await go(1);context.onPages?.(doc.numPages);
  return {
    setPage:value=>serial(()=>go(value)),
    setZoom:(value,anchor)=>{
      if(closed)return;
      zoom=Math.max(.5,Math.min(3,value));
      visual.setZoom(zoom,anchor);tracker.refresh();queueSharpen();
    },
    setViewMode:value=>serial(async()=>{const next=viewMode(value);if(next!==mode){mode=next;reset();await go(page);}return mode;}),
    copyText:()=>getSelection()?.toString() || '',
    find:query=>serial(async()=>{
      if(query!==lastQuery){lastQuery=query;foundPage=0;}
      for(let i=1;i<=doc.numPages;i++){
        if(closed)return null;const candidate=(foundPage+i-1)%doc.numPages+1;
        if(!cache.has(candidate)){const proxy=await doc.getPage(candidate),content=await proxy.getTextContent();cache.set(candidate,content.items.map(n=>n.str || '').join(' '));if(!live.has(candidate))proxy.cleanup?.();}
        if(cache.get(candidate).toLocaleLowerCase().includes(query.toLocaleLowerCase())){
          foundPage=candidate;await go(candidate);for(const span of papers[candidate-1].querySelectorAll('.textLayer span'))if(span.textContent.toLocaleLowerCase().includes(query.toLocaleLowerCase()))span.classList.add('search-hit');
          return {page:candidate,message:'Совпадение на странице '+candidate};
        }
      }
      return null;
    })
  };
}

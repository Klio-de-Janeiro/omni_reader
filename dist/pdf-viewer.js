import { viewMode, trackPages } from './page-modes.js';
import { captureZoomAnchor } from './gestures.js';
/** Keep page placeholders in scroll mode, but rasterize only nearby pages. */
export async function renderPdfDocument(doc,pdfjs,root,context) {
  let mode=viewMode(context.viewMode),page=1,zoom=1,revision=0,navigating=false,closed=false,queue=Promise.resolve(),paintQueue=Promise.resolve(),lastQuery='',foundPage=0;
  const cache=new Map(),live=new Map(),papers=[];
  const first=await doc.getPage(1),base=first.getViewport({scale:1});first.cleanup?.();
  root.classList.add('pdf-document');root.dataset.viewMode=mode;root.replaceChildren();
  const factor=()=>Math.max(0.1,Math.min((root.clientWidth-40)/base.width,1.6))*zoom;
  function size(paper,viewport){paper.style.width=viewport.width+'px';paper.style.height=viewport.height+'px';}
  for(let i=1;i<=doc.numPages;i++){
    const paper=document.createElement('div');paper.className='pdf-paper';paper.dataset.page=i;paper.setAttribute('aria-label','Страница PDF '+i);paper.setAttribute('aria-busy','true');size(paper,{width:base.width*factor(),height:base.height*factor()});papers.push(paper);root.append(paper);
  }
  function display(){root.dataset.viewMode=mode;for(const paper of papers)paper.hidden=mode==='page' && Number(paper.dataset.page)!==page;}
  function release(number){
    const item=live.get(number);if(!item)return;item.cancelled=true;item.task?.cancel();item.textLayer?.cancel();
    item.canvas.width=0;item.canvas.height=0;item.paper.replaceChildren();item.paper.setAttribute('aria-busy','true');item.proxy?.cleanup?.();live.delete(number);
  }
  async function draw(number,current){
    const paper=papers[number-1];if(live.has(number) || closed)return;
    const canvas=document.createElement('canvas'),layer=document.createElement('div');layer.className='textLayer';
    const item={paper,canvas,layer};live.set(number,item);
    try{
      const proxy=await doc.getPage(number);item.proxy=proxy;
      if(item.cancelled || current!==revision || closed){proxy.cleanup?.();return;}
      const intrinsic=proxy.getViewport({scale:1}),fit=Math.max(0.1,Math.min((root.clientWidth-40)/intrinsic.width,1.6))*zoom,viewport=proxy.getViewport({scale:fit});
      const oldHeight=parseFloat(paper.style.height),oldTop=paper.getBoundingClientRect().top;
      size(paper,viewport);
      if(mode==='scroll' && number<page && oldTop<root.getBoundingClientRect().top)root.scrollTop+=viewport.height-oldHeight;
      const cap=mode==='scroll'?4_000_000:12_000_000,density=Math.min(globalThis.devicePixelRatio || 1,2,Math.sqrt(cap/(viewport.width*viewport.height)));
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
  function reset(){revision++;for(const n of [...live.keys()])release(n);for(const paper of papers)size(paper,{width:base.width*factor(),height:base.height*factor()});}
  async function go(value){
    page=Math.max(1,Math.min(doc.numPages,Math.trunc(value) || 1));navigating=true;
    try{display();position();await schedule();position();context.onPage?.(page);}
    finally{navigating=false;tracker.refresh();}
  }
  const serial=action=>{const result=queue.catch(()=>{}).then(()=>{if(closed)throw new DOMException('Aborted','AbortError');return action();});queue=result;return result;};
  const stop=()=>{closed=true;revision++;tracker.dispose();for(const n of [...live.keys()])release(n);observer.disconnect();root.classList.remove('pdf-document');};
  let width=root.clientWidth,height=root.clientHeight;
  const observer=new ResizeObserver(()=>{
    const newWidth=root.clientWidth,newHeight=root.clientHeight;if(newWidth===width && newHeight===height)return;
    const changed=newWidth!==width;width=newWidth;height=newHeight;
    if(changed)void serial(async()=>{reset();await go(page);}).catch(error=>{if(!closed)context.onWarning?.(error);});else tracker.refresh();
  });observer.observe(root);context.signal.addEventListener('abort',stop,{once:true});
  if(context.signal.aborted){stop();throw new DOMException('Aborted','AbortError');}
  display();await go(1);context.onPages?.(doc.numPages);
  return {
    setPage:value=>serial(()=>go(value)),
    setZoom:(value,anchor)=>serial(async()=>{
      const restore=captureZoomAnchor(()=>papers,root,anchor);
      zoom=value;reset();await go(page);restore();tracker.refresh();
    }),
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

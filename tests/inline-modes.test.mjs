import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {parseAsync,renderDocument} from 'docx-preview';
import {openOfficeEditor} from '../dist/vendor/editors.js';
import {createInlineEditor} from '../scripts/office-inline.js';
import {officeModes} from '../scripts/office-modes.js';
import {renderPdfDocument} from '../dist/pdf-viewer.js';
const array=b=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
function setup(){
  const w=new JSDOM('<!doctype html><div id="office"></div>',{pretendToBeVisual:true}).window;
  for(const n of ['window','document','Node','NodeFilter','Element','HTMLElement','SVGElement','DOMParser','XMLSerializer','FileReader','DocumentFragment','Image','Event','CustomEvent','EventTarget'])globalThis[n]=n==='window'?w:w[n];
  globalThis.getComputedStyle=w.getComputedStyle.bind(w);globalThis.getSelection=w.getSelection.bind(w);globalThis.requestAnimationFrame=w.requestAnimationFrame.bind(w);globalThis.cancelAnimationFrame=w.cancelAnimationFrame.bind(w);globalThis.innerHeight=650;
  globalThis.ResizeObserver=class{observe(){}disconnect(){}};w.ResizeObserver=globalThis.ResizeObserver;w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.HTMLCanvasElement.prototype.getContext=()=>({measureText:t=>({width:t.length*10,actualBoundingBoxAscent:10,actualBoundingBoxDescent:3})});return w;
}
function select(w,el,start=0,end=el.textContent.length){
  el.focus();const r=document.createRange();if(start===0 && end===el.textContent.length)r.selectNodeContents(el);else{const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),n=walker.nextNode();r.setStart(n,start);r.setEnd(n,end);}const s=w.getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new w.Event('selectionchange'));
}
const bridgeFor=model=>createInlineEditor(model.getBlocks(),data=>{if(data.type==='edit')model.setParagraph(data.id,data.segments,data.mergeKey);});
test('Real DOCX inline editing and both layouts preserve page, caret, symbols, undo and export',async()=>{
  const w=setup(),root=document.querySelector('#office'),bytes=array(await readFile(new URL('./fixtures/sample.docx',import.meta.url))),model=await openOfficeEditor(bytes,'docx'),bridge=bridgeFor(model);
  const options={useBase64URL:true,ignoreFonts:true},doc=await parseAsync(bytes,options);bridge.annotateDocx(doc);root.replaceChildren(...await renderDocument(doc,options));bridge.mountDocx(root);
  const modes=officeModes({container:root,getViewer:()=>null,editor:bridge,onPage:()=>{},fitDocument:()=>{}});
  try{
    const pages=modes.bindDocx();assert.ok(pages>=2);assert.equal(modes.mode,'scroll');
    const content=root.querySelector('.omni-edit-content');assert.ok(content);
    select(w,content);bridge.message({type:'edit-command',command:'insert',text:'Документ ✓'});select(w,content);
    for(const key of ['bold','italic','underline','strike'])bridge.message({type:'edit-command',command:'format',key});
    const id=content.dataset.block;assert.equal(model.getBlock(id).text,'Документ ✓');assert.deepEqual(model.getBlock(id).segments[0].style,{bold:true,italic:true,underline:true,strike:true});
    const count=model.history.done.length,book=bridge.bookmark();await modes.go(2);await modes.setMode('page');assert.equal(modes.page,2);assert.equal([...root.querySelectorAll('section.docx')].filter(n=>!n.hidden).length,1);
    await modes.setMode('scroll');assert.equal(model.history.done.length,count);bridge.restore(book);assert.ok(w.getSelection().rangeCount);
    await mkdir('test-results/modes',{recursive:true});await writeFile('test-results/modes/layout.docx',await model.export());
    model.history.undo();bridge.message({type:'edit-sync',blocks:model.getBlocks()});assert.equal(content.textContent,'Документ ✓');
  }finally{modes.dispose();w.close();}
});
test('Real PPTX list and page rendering retain edited text and styles after zoom and DOM rebuild',async()=>{
  const w=setup(),root=document.querySelector('#office');Object.defineProperty(root,'clientWidth',{value:1000});
  const bytes=array(await readFile(new URL('./fixtures/sample.pptx',import.meta.url))),model=await openOfficeEditor(bytes,'pptx'),bridge=bridgeFor(model);let viewer;
  const modes=officeModes({container:root,getViewer:()=>viewer,editor:bridge,onPage:()=>{},fitDocument:()=>{}});
  const {PptxViewer}=await import('@aiden0z/pptx-renderer');
  try{
    viewer=new PptxViewer(root,{pdfjs:false,onSlideChange:i=>modes.slideChanged(i),onSlideRendered:(i,el)=>bridge.mountPptx(i,el),onSlideUnmounted:i=>bridge.releasePptx(i)});
    await viewer.open(bytes,{renderMode:'list',listOptions:modes.listOptions});const parsed=viewer.presentationData;
    assert.equal(root.querySelectorAll('[data-slide-index]').length,2);await modes.go(2);
    const content=root.querySelector('[data-slide-index="1"] .omni-edit-content');assert.ok(content);select(w,content);bridge.message({type:'edit-command',command:'insert',text:'Презентация ✓'});select(w,content);
    for(const key of ['bold','italic','underline','strike'])bridge.message({type:'edit-command',command:'format',key});
    const id=content.dataset.block,count=model.history.done.length;await modes.setMode('page');assert.deepEqual(viewer.getMountedSlides(),[1]);assert.equal(root.querySelector('.omni-edit-content').textContent,'Презентация ✓');
    await modes.zoom(1.25,v=>viewer.setZoom(v*100));await modes.setMode('scroll');assert.equal(viewer.zoomPercent,125);assert.equal(modes.page,2);assert.equal(viewer.presentationData,parsed);assert.equal(model.history.done.length,count);
    assert.deepEqual(model.getBlock(id).segments[0].style,{bold:true,italic:true,underline:true,strike:true});await mkdir('test-results/modes',{recursive:true});await writeFile('test-results/modes/layout.pptx',await model.export());
  }finally{modes.dispose();w.close();}
});
test('Unmounting a slide commits pending composition and restores it when the slide returns',async()=>{
  const w=setup(),root=document.querySelector('#office'),observers=[];Object.defineProperty(root,'clientWidth',{value:1000});
  w.IntersectionObserver=class{constructor(callback,options){this.callback=callback;this.options=options;observers.push(this);}observe(){}disconnect(){}};
  const bytes=array(await readFile(new URL('./fixtures/sample.pptx',import.meta.url))),model=await openOfficeEditor(bytes,'pptx'),bridge=bridgeFor(model),{PptxViewer}=await import('@aiden0z/pptx-renderer');
  const viewer=new PptxViewer(root,{pdfjs:false,onSlideRendered:(i,el)=>bridge.mountPptx(i,el),onSlideUnmounted:i=>bridge.releasePptx(i)});
  try{
    await viewer.open(bytes,{renderMode:'list',listOptions:{windowed:true,initialSlides:2}});
    const slide=root.querySelector('[data-slide-index="1"]'),el=slide.querySelector('.omni-edit-content'),id=el.dataset.block;select(w,el);el.dispatchEvent(new w.Event('compositionstart'));el.querySelector('span').firstChild.data='Отложенный ввод ✓';el.dispatchEvent(new w.Event('input'));
    const observer=observers.find(o=>o.options.rootMargin);observer.callback([{target:slide.firstElementChild,isIntersecting:false}]);assert.equal(model.getBlock(id).text,'Отложенный ввод ✓');
    observer.callback([{target:slide.firstElementChild,isIntersecting:true}]);assert.equal(slide.querySelector('.omni-edit-content').textContent,'Отложенный ввод ✓');
  }finally{viewer.destroy();bridge.dispose();w.close();}
});
function pdfFixture(w,delayed=false){
  const root=document.querySelector('#office'),reported=[];Object.defineProperties(root,{clientWidth:{value:900},clientHeight:{value:600}});root.getBoundingClientRect=()=>({left:0,right:900,top:0,bottom:600,height:600,width:900});
  const rect=w.HTMLElement.prototype.getBoundingClientRect;w.HTMLElement.prototype.getBoundingClientRect=function(){
    if(this.classList.contains('pdf-pages')){
      const width=parseFloat(this.style.width),height=[...this.children].filter(el=>!el.hidden).reduce((sum,el)=>sum+parseFloat(el.style.height)+20,0);
      const left=(parseFloat(this.style.left) || 0)-root.scrollLeft,top=(parseFloat(this.style.top) || 0)-root.scrollTop;
      return {left,top,width,height,right:left+width,bottom:top+height};
    }
    if(!this.classList.contains('pdf-paper'))return rect.call(this);if(this.hidden)return {top:0,height:0,bottom:0};
    const stack=this.parentElement,frame=stack.getBoundingClientRect(),width=parseFloat(this.style.width),left=frame.left+Math.max(0,(frame.width-width)/2);
    let top=20+frame.top;for(const el of stack.children){if(el===this)break;if(!el.hidden)top+=parseFloat(el.style.height)+20;}const height=parseFloat(this.style.height);return {left,right:left+width,top,height,bottom:top+height,width};
  };
  let cancelled=false;const doc={numPages:80,async getPage(n){return {getViewport:({scale})=>({width:600*scale,height:800*scale,scale}),async getTextContent(){return {items:[{str:'marker-'+n}]};},cleanup(){},render(){let cancel;const promise=delayed && n===42?new Promise((resolve,reject)=>{const timer=setTimeout(resolve,1000);cancel=()=>{cancelled=true;clearTimeout(timer);reject(Object.assign(new Error('Cancelled'),{name:'RenderingCancelledException'}));};}):Promise.resolve();return {promise,cancel(){cancel?.();}};}};}};
  class TextLayer{constructor(o){this.options=o;}async render(){const s=document.createElement('span');s.textContent=this.options.textContentSource.items[0].str;this.options.container.append(s);}cancel(){}}
  const controller=new AbortController(),context={signal:controller.signal,onPage:p=>reported.push(p),onPages:()=>{},onWarning:e=>{throw e;}};
  return {root,doc,pdfjs:{TextLayer},controller,context,reported,get cancelled(){return cancelled;}};
}
test('PDF scroll is default; at most four canvases, page/zoom and search survive changing layouts',async()=>{
  const w=setup(),f=pdfFixture(w);
  try{
    const viewer=await renderPdfDocument(f.doc,f.pdfjs,f.root,f.context);assert.equal(f.root.dataset.viewMode,'scroll');assert.equal(f.root.querySelectorAll('.pdf-paper').length,80);assert.ok(f.root.querySelectorAll('canvas').length<=4);
    await viewer.setPage(42);await viewer.setZoom(1.25);const width=f.root.querySelector('[data-page="42"]').style.width;await viewer.setViewMode('page');assert.equal(f.root.querySelectorAll('.pdf-paper:not([hidden])').length,1);assert.equal(f.root.querySelector('.pdf-paper:not([hidden])').dataset.page,'42');assert.equal(f.root.querySelector('[data-page="42"]').style.width,width);
    await viewer.setViewMode('scroll');assert.equal(f.reported.at(-1),42);const found=await viewer.find('marker-72');assert.equal(found.page,72);assert.ok(f.root.querySelector('.search-hit'));
    const target=f.root.querySelector('[data-page="73"]');f.root.scrollTop+=target.getBoundingClientRect().top-20;f.root.dispatchEvent(new w.Event('scroll'));await new Promise(resolve=>setTimeout(resolve,35));assert.equal(f.reported.at(-1),73);
  }finally{f.controller.abort();assert.equal(f.root.querySelectorAll('canvas').length,0);w.close();}
});
test('Closing a PDF cancels active rendering and releases its canvases',async()=>{
  const w=setup(),f=pdfFixture(w,true);
  try{
    const viewer=await renderPdfDocument(f.doc,f.pdfjs,f.root,f.context),pending=viewer.setPage(42);await new Promise(resolve=>setTimeout(resolve,10));f.controller.abort();await pending.catch(()=>{});assert.ok(f.cancelled);assert.equal(f.root.querySelectorAll('canvas').length,0);
  }finally{f.controller.abort();w.close();}
});

test('PDF pinch retains the exact point inside a scrolled page in both viewing modes',async()=>{
  const w=setup(),f=pdfFixture(w);
  try{
    const viewer=await renderPdfDocument(f.doc,f.pdfjs,f.root,f.context);await viewer.setPage(42);f.root.scrollTop+=280;
    for(const mode of ['scroll','page']){
      await viewer.setViewMode(mode);const paper=f.root.querySelector('[data-page="42"]'),point={x:130,y:260},before=paper.getBoundingClientRect();
      const rx=(point.x-before.left)/before.width,ry=(point.y-before.top)/before.height;
      await viewer.setZoom(mode==='scroll'?2:1.25,point);const after=paper.getBoundingClientRect();
      assert.ok(Math.abs(after.left+rx*after.width-point.x)<1e-8);assert.ok(Math.abs(after.top+ry*after.height-point.y)<1e-8);
      assert.ok(f.root.querySelectorAll('canvas').length<=4);
    }
  }finally{f.controller.abort();w.close();}
});

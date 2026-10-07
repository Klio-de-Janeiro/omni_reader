import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {openOfficeEditor} from '../dist/vendor/editors.js';
import {openOfficeUI} from '../dist/editors/office-ui.js';
const NativeFile=globalThis.File;
const array=b=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
const wait=()=>new Promise(resolve=>setTimeout(resolve,30));
test('Office toolbar applies page/layout choices and waits for pending edits before export',async()=>{
  const w=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true}).window;
  globalThis.window=w;globalThis.document=w.document;globalThis.addEventListener=w.addEventListener.bind(w);globalThis.removeEventListener=w.removeEventListener.bind(w);
  globalThis.requestAnimationFrame=w.requestAnimationFrame.bind(w);globalThis.cancelAnimationFrame=w.cancelAnimationFrame.bind(w);
  const oldFetch=globalThis.fetch;globalThis.fetch=async()=>({text:async()=>'<html></html>'});
  const requests=[],errors=[],frames=[];let deferredEdit=null,saved=null,closed=false;
  const model=await openOfficeEditor(array(await readFile(new URL('./fixtures/sample.pptx',import.meta.url))),'pptx'),block=model.getBlocks()[0];
  const root=document.querySelector('#root'),controller=new AbortController();
  const observer=new w.MutationObserver(()=>{
    for(const frame of root.querySelectorAll('iframe')){
      if(frames.includes(frame))continue;frames.push(frame);const child=frame.contentWindow;
      const emit=data=>w.dispatchEvent(new w.MessageEvent('message',{source:child,data}));
      child.postMessage=data=>{
        requests.push(data);
        if(data.type==='open'){child.omniToken=data.token;emit({type:'loaded',token:data.token,pages:Math.max(...data.blocks.map(b=>b.partIndex))+1});}
        else if(data.requestId)setTimeout(()=>{
          if(data.type==='flush' && deferredEdit){emit({type:'edit',token:data.token,id:block.id,segments:[{text:deferredEdit,style:{bold:true},template:0}]});deferredEdit=null;}
          if(data.type==='page')emit({type:'page-change',token:data.token,page:data.page});
          emit({type:'reply',token:data.token,requestId:data.requestId,result:data.mode || data.page || data.zoom || true});
        },5);
      };
      queueMicrotask(()=>emit({type:'ready'}));
    }
  });observer.observe(root,{childList:true,subtree:true});
  let api;
  try{
    api=await openOfficeUI(model,{name:'sample.pptx',ext:'pptx'},root,{signal:controller.signal,onError:e=>errors.push(e.message),onSave:async session=>{saved=await session.export();},onClose:()=>{closed=true;}});
    assert.equal(requests.find(r=>r.type==='open').viewMode,'scroll');assert.equal(api.dirty,false);
    const layout=root.querySelector('select');layout.value='page';layout.dispatchEvent(new w.Event('change'));await wait();assert.equal(requests.filter(r=>r.type==='view-mode').at(-1).mode,'page');assert.equal(layout.value,'page');assert.equal(api.dirty,false);
    const at=root.querySelector('input');at.value=2;at.dispatchEvent(new w.Event('change'));await wait();assert.equal(requests.filter(r=>r.type==='page').at(-1).page,2);assert.equal(at.value,'2');
    const button=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);
    button('+ Слайд').click();await new Promise(resolve=>setTimeout(resolve,80));assert.equal(model.pageCount,3);assert.equal(requests.filter(r=>r.type==='open').at(-1).viewMode,'page');assert.equal(api.dirty,true);
    deferredEdit='Последний ввод ✓';button('Сохранить копию').click();await wait();assert.ok(saved);const reopened=await openOfficeEditor(array(saved),'pptx');assert.equal(reopened.getBlocks()[0].text,'Последний ввод ✓');
    button('К просмотру').click();await wait();assert.ok(closed);assert.deepEqual(errors,[]);
  }finally{api?.dispose();controller.abort();observer.disconnect();globalThis.fetch=oldFetch;w.close();}
});

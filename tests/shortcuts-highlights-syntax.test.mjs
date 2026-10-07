import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { SHORTCUT_STORAGE, getShortcutBindings, applyShortcutBindings, shortcutCommand, shortcutLabel, editingShortcut, formattingShortcut } from '../dist/shortcuts.js';
import { initShortcutSettings } from '../dist/shortcut-settings.js';
import { createReadHighlights } from '../dist/read-highlights.js';
import { colorCode } from '../dist/syntax.js';
import { openViewer } from '../dist/viewers.js';
import { openEditor } from '../dist/editors/ui.js';
import { renderMarkup } from '../dist/vendor/markdown.js';
import { renderNotebook } from '../dist/notebooks.js';
import { textNavigation } from '../dist/text-files.js';
import { validateFile, validateBytes } from '../dist/validation.js';
import { initThemes } from '../dist/themes.js';

function fixture(html='<!doctype html><div id="root"></div>') {
  const w=new JSDOM(html,{url:'https://omni.test/',pretendToBeVisual:true,runScripts:'outside-only'}).window;
  const values={window:w,document:w.document,getSelection:w.getSelection.bind(w),NodeFilter:w.NodeFilter,requestAnimationFrame:w.requestAnimationFrame.bind(w),cancelAnimationFrame:w.cancelAnimationFrame.bind(w),addEventListener:w.addEventListener.bind(w),removeEventListener:w.removeEventListener.bind(w)};
  const old=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));Object.assign(globalThis,values);
  w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  w.HTMLDialogElement.prototype.close=function(value=''){this.returnValue=value;this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
  return {w,root:w.document.querySelector('#root'),close(){w.close();for(const [key,value] of old){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}}};
}
const until=async predicate=>{for(let i=0;i<160;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('UI timed out');};
const key=(w,target,code,options={})=>{const event=new w.KeyboardEvent('keydown',{code,key:code.replace('Key','').toLowerCase(),bubbles:true,cancelable:true,...options});target.dispatchEvent(event);return event;};
function select(w,root,start,end) {
  const walker=w.document.createTreeWalker(root,w.NodeFilter.SHOW_TEXT),nodes=[];let node,offset=0;
  while(node=walker.nextNode()){nodes.push({node,start:offset,end:offset+node.length});offset+=node.length;}
  const first=nodes.find(item=>start>=item.start && start<item.end),last=nodes.find(item=>end>item.start && end<=item.end);
  const range=w.document.createRange();range.setStart(first.node,start-first.start);range.setEnd(last.node,end-last.start);
  w.getSelection().removeAllRanges();w.getSelection().addRange(range);w.document.dispatchEvent(new w.Event('selectionchange'));
}

test('Shortcut settings record physical keys, persist changes, disable aliases and reject conflicts',async()=>{
  const f=fixture(await readFile(new URL('../dist/index.html',import.meta.url),'utf8')),w=f.w;
  try {
    const settings=initShortcutSettings(w.document);settings.open();assert.equal(w.document.querySelector('#shortcuts-dialog').open,true);
    const field=w.document.querySelector('#shortcut-toggle-edit');field.focus();key(w,field,'KeyK',{ctrlKey:true,altKey:true,key:'л'});
    assert.deepEqual(getShortcutBindings(w)['toggle-edit'],['Ctrl+Alt+KeyK']);
    assert.equal(shortcutCommand({code:'KeyK',key:'л',ctrlKey:true,altKey:true,target:field}),'toggle-edit');
    assert.equal(shortcutCommand({code:'KeyD',ctrlKey:true,target:field}),null);
    assert.deepEqual(JSON.parse(w.localStorage.getItem(SHORTCUT_STORAGE))['toggle-edit'],['Ctrl+Alt+KeyK']);
    const marker=w.document.querySelector('#shortcut-highlight');key(w,marker,'KeyK',{ctrlKey:true,altKey:true});
    assert.match(w.document.querySelector('#shortcut-status').textContent,/уже используется/);assert.equal(getShortcutBindings(w).highlight[0],'Ctrl+KeyE');
    marker.parentElement.querySelector('button').click();assert.deepEqual(getShortcutBindings(w).highlight,[]);
    w.document.querySelector('#shortcuts-reset').click();assert.equal(getShortcutBindings(w)['toggle-edit'][0],'Ctrl+KeyD');
    const saved=getShortcutBindings(w);applyShortcutBindings({...saved,save:['Alt+KeyS'],bold:['Ctrl+Alt+KeyB']},w);
    assert.equal(editingShortcut({code:'KeyS',altKey:true,target:field}),'save');assert.equal(formattingShortcut({code:'KeyB',ctrlKey:true,altKey:true,target:field}),'bold');
    w.dispatchEvent(new w.StorageEvent('storage',{key:SHORTCUT_STORAGE,newValue:JSON.stringify({...saved,'toggle-edit':['Ctrl+Alt+KeyL']})}));assert.equal(shortcutCommand({code:'KeyL',ctrlKey:true,altKey:true,target:field}),'toggle-edit');
    assert.equal(shortcutCommand({code:'KeyD',ctrlKey:true,isComposing:true,target:field}),null);
    const next=fixture();try{next.w.localStorage.setItem(SHORTCUT_STORAGE,JSON.stringify({...saved,'toggle-edit':['Alt+KeyK']}));assert.deepEqual(getShortcutBindings(next.w)['toggle-edit'],['Alt+KeyK']);}finally{next.close();}
  } finally {f.close();}
});

test('Code highlighting colors JS, JSON, YAML, ENV, Markdown fences and notebook kernels without executing source',()=>{
  const f=fixture(),w=f.w;
  try {
    const examples={js:'// comment\nconst count = 42; const text = "<img onerror=alert(1)>";',json:'{"value":42,"text":"hello"}',yaml:'# comment\nkey: true\ncount: 42',env:'# comment\nPORT=3000\nTOKEN="secret"'};
    for(const [language,source] of Object.entries(examples)){
      const code=w.document.createElement('code');colorCode(code,source,language);assert.equal(code.textContent,source);assert.ok(code.querySelectorAll('[class^="hljs-"]').length>=2,language);assert.equal(code.querySelector('img'),null);
    }
    const md=renderMarkup('```python\ndef greet(name):\n    return "hello " + name\n```','md',w);assert.ok(md.querySelector('.hljs-keyword'));assert.ok(md.querySelector('.hljs-string'));
    const notebook={nbformat:4,nbformat_minor:5,metadata:{language_info:{name:'python'}},cells:[{id:'sample',cell_type:'code',source:['def run():\n','    return 12\n'],metadata:{},execution_count:null,outputs:[]}]};
    const rendered=renderNotebook(notebook,w.document,renderMarkup);assert.ok(rendered.querySelector('.hljs-keyword'));assert.equal(rendered.querySelector('.notebook-cell').dataset.cellId,'sample');
    const large='const value = "<script>";\n'.repeat(22000),code=w.document.createElement('code');colorCode(code,large,'js');assert.equal(code.textContent,large);assert.equal(code.querySelector('script'),null);
  }finally{f.close();}
});

test('Live syntax layer preserves edits, undo, IME text, scroll and exported source bytes',async()=>{
  const f=fixture(),w=f.w,controller=new AbortController();let api;
  try {
    const original='// комментарий\r\nconst value = "before";\r\n';
    api=await openEditor({ext:'js',name:'sample.js',blob:new File([original],'sample.js')},f.root,{signal:controller.signal,onError:error=>{throw error;}});
    const input=f.root.querySelector('textarea'),mirror=f.root.querySelector('.syntax-mirror code');assert.ok(mirror.querySelector('.hljs-keyword'));
    input.value='// комментарий\nconst value = "日本語";\n';input.dispatchEvent(new w.Event('input'));assert.match(mirror.textContent,/日本語/);
    const expected=input.value.replace(/\n/g,'\r\n');assert.equal(new TextDecoder().decode(await api.export()),expected);
    input.scrollTop=35;input.scrollLeft=11;input.dispatchEvent(new w.Event('scroll'));assert.equal(f.root.querySelector('.syntax-mirror').scrollTop,35);assert.equal(f.root.querySelector('.syntax-mirror').scrollLeft,11);
    key(w,input,'KeyZ',{ctrlKey:true,altKey:true});assert.match(input.value,/before/);assert.match(mirror.textContent,/before/);
    key(w,input,'KeyY',{ctrlKey:true});assert.match(input.value,/日本語/);assert.match(mirror.textContent,/日本語/);
    api.toggleView();assert.equal(api.sourceMode,false);assert.ok(f.root.querySelector('.source-document .hljs-string'));assert.equal(input.closest('.code-input').hidden,true);
    api.toggleView();assert.equal(api.sourceMode,true);assert.match(input.value,/日本語/);assert.equal(input.closest('.code-input').hidden,false);
  }finally{api?.dispose();controller.abort();f.close();}
});

test('Search spans multiple colored tokens and cycles matches after transient marks',()=>{
  const f=fixture(),w=f.w;
  try {
    const code=w.document.createElement('code');colorCode(code,'const value = 42;\nconst value = 99;','js');f.root.append(code);
    const navigation=textNavigation(f.root);assert.ok(navigation.find('const value ='));assert.equal(w.getSelection().toString(),'const value =');
    const marks=createReadHighlights(f.root);marks.add('#ffe066');assert.ok(f.root.querySelector('mark'));
    assert.ok(navigation.find('const value ='));assert.equal(w.getSelection().anchorNode.parentElement.closest('mark'),null);
    assert.ok(navigation.find('const value ='));assert.equal(w.getSelection().toString(),'const value =');marks.dispose();
  }finally{f.close();}
});

test('Reading marks retain different colors across tokens, handle overlaps and never change source text',()=>{
  const f=fixture(),w=f.w,controller=new AbortController();let allowed=true;
  const marks=createReadHighlights(f.root,{signal:controller.signal,canHighlight:()=>allowed});
  try {
    const code=w.document.createElement('code');colorCode(code,'const value = "hello";','js');f.root.append(code);
    const text=code.textContent;select(w,code,0,11);marks.add('#ffe066');assert.equal(code.textContent,text);assert.ok(f.root.querySelector('mark'));
    select(w,code,6,16);marks.add('#64caff');assert.equal(code.textContent,text);
    const overlap=[...f.root.querySelectorAll('mark')].find(node=>node.textContent.includes('value'));assert.match(overlap.style.backgroundColor,/100, 202, 255/);
    select(w,code,17,20);marks.add('#ff8eb8');assert.equal(marks.records.length,3);assert.equal(code.textContent,text);
    allowed=false;marks.suspend(true);assert.equal(f.root.querySelector('mark'),null);assert.throws(()=>marks.add('#ffe066'),/только в режиме просмотра/);
    allowed=true;marks.suspend(false);assert.ok(f.root.querySelector('mark'));controller.abort();assert.equal(f.root.querySelector('mark'),null);assert.equal(marks.records.length,0);assert.equal(code.textContent,text);
  }finally{marks.dispose();f.close();}
});

test('Page annotations reattach after virtualization and disappear on clear or disposal',async()=>{
  const f=fixture(),w=f.w,marks=createReadHighlights(f.root);
  const page=(number,text)=>{const el=w.document.createElement('div');el.className='pdf-paper';el.dataset.page=number;el.textContent=text;return el;};
  try {
    f.root.append(page('1','Первый лист'),page('2','Второй лист'));
    select(w,f.root.children[1],0,6);marks.add('#69efb3');assert.equal(f.root.children[1].querySelector('mark').textContent,'Второй');
    f.root.replaceChildren(page('1','Первый лист'));await new Promise(resolve=>w.requestAnimationFrame(()=>w.requestAnimationFrame(resolve)));assert.equal(f.root.querySelector('mark'),null);assert.equal(marks.records.length,1);
    f.root.append(page('2','Второй лист'));await until(()=>f.root.children[1].querySelector('mark'));assert.equal(f.root.children[0].querySelector('mark'),null);
    marks.clear();assert.equal(f.root.querySelector('mark'),null);assert.equal(marks.records.length,0);
  }finally{marks.dispose();f.close();}
});

test('CSS Highlight API paints ranges without inserting markup and removes only its own entries',()=>{
  const f=fixture(),w=f.w,registry=new Map([['other-feature',{keep:true}]]);
  Object.defineProperty(w,'CSS',{value:{highlights:registry}});w.Highlight=class{constructor(...ranges){this.ranges=ranges;}};
  const marks=createReadHighlights(f.root);
  try {
    f.root.textContent='Read this text';const original=f.root.innerHTML;select(w,f.root,0,4);marks.add('#cda5ff');
    assert.equal(f.root.innerHTML,original);assert.equal(registry.size,2);assert.match(w.document.head.lastElementChild.textContent,/text-shadow/);
    const entry=[...registry.entries()].find(([name])=>name!=='other-feature');assert.equal(entry[1].ranges[0].toString(),'Read');
    marks.dispose();assert.equal(registry.size,1);assert.ok(registry.has('other-feature'));
  }finally{marks.dispose();f.close();}
});

test('Actual fullscreen host switches Ctrl+D, applies Ctrl+E, preserves draft, rebinds keys and clears marks on file close',async()=>{
  const f=fixture(await readFile(new URL('../dist/index.html',import.meta.url),'utf8')),w=f.w;
  const source='// comment\nconst value = "before";',record={id:'code',name:'sample.js',ext:'js',blob:new File([source],'sample.js'),size:source.length,saved:true};
  let exported;
  Object.assign(w,{File,TextEncoder,normalizeMode:value=>value==='page'?'page':'scroll',shortcutCommand,getShortcutBindings,shortcutLabel,initShortcutSettings,createReadHighlights,initThemes,copyText:async()=>{},isNative:true,hasDocumentWindows:false,saveOriginal:async record=>{exported=record;},setNativeFullscreen:()=>true,setNativeDocument(){},connectNativeFiles(){},listFiles:async()=>[record],saveFile:async()=>{},removeFile:async()=>{},formatSize:()=> '1 B',validateFile,validateBytes,openViewer,openEditor});
  w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};
  try {
    let app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');app=app.replace(/^import .*;\n/gm,'').replace("const { openEditor } = await import('./editors/ui.js');",'const { openEditor } = window;');w.eval(app);
    await until(()=>w.document.querySelector('.file-open'));await w.selectFile('code');assert.ok(w.document.body.classList.contains('focus-mode'));
    const root=w.document.querySelector('#viewer'),code=root.querySelector('code');select(w,code,11,16);
    assert.ok(key(w,code,'KeyE',{ctrlKey:true,key:'у'}).defaultPrevented);assert.ok(root.querySelector('mark'));assert.equal(w.document.querySelector('#focus-highlight').hidden,false);
    key(w,w.document,'KeyD',{ctrlKey:true,key:'в'});await until(()=>root.querySelector('textarea') && !w.document.querySelector('#focus-edit').disabled);
    const input=root.querySelector('textarea');assert.equal(root.querySelector('mark'),null);assert.equal(w.document.querySelector('#focus-highlight').hidden,true);
    input.value=source+'\nconst draft = 123;';input.dispatchEvent(new w.Event('input'));
    key(w,input,'KeyE',{ctrlKey:true});assert.equal(root.querySelector('mark'),null);assert.match(input.value,/draft/);
    key(w,input,'KeyD',{ctrlKey:true});await until(()=>input.hidden);assert.match(root.querySelector('.source-document').textContent,/draft/);assert.equal(w.document.querySelector('#discard-dialog').open,false);assert.ok(root.querySelector('mark'));
    const settings=w.document.querySelector('#hotkeys-settings');settings.click();const field=w.document.querySelector('#shortcut-toggle-edit');field.focus();key(w,field,'KeyK',{ctrlKey:true,altKey:true});assert.equal(w.document.querySelector('#shortcuts-dialog').open,true);
    w.document.querySelector('#shortcuts-close').click();assert.equal(key(w,root,'KeyD',{ctrlKey:true}).defaultPrevented,false);assert.equal(input.hidden,true);
    key(w,root,'KeyK',{ctrlKey:true,altKey:true});await until(()=>!input.hidden);assert.match(input.value,/draft/);assert.equal(root.querySelector('mark'),null);
    key(w,input,'KeyK',{ctrlKey:true,altKey:true});await until(()=>input.hidden);
    key(w,root,'KeyS',{ctrlKey:true});await until(()=>exported);assert.match(await exported.blob.text(),/const draft = 123;/);assert.equal((await exported.blob.text()).includes('omni-read-mark'),false);
    await w.selectFile('code',true);assert.equal(root.querySelector('mark'),null);select(w,root.querySelector('code'),0,10);key(w,root,'KeyE',{ctrlKey:true});assert.ok(root.querySelector('mark'));
    await w.closeViewer();assert.equal(root.querySelector('mark'),null);await w.selectFile('code');assert.equal(root.querySelector('mark'),null);assert.equal(await record.blob.text(),source);
  }finally{f.close();}
});

test('Office draft preview keeps model, position, settings and highlighting separate from OOXML export',async()=>{
  const f=fixture(),w=f.w,controller=new AbortController(),oldFetch=globalThis.fetch;
  globalThis.fetch=async()=>({text:async()=>'<html></html>'});const frames=[],requests=[];let model,api;
  const observer=new w.MutationObserver(()=>{
    for(const frame of f.root.querySelectorAll('iframe')){
      if(frames.includes(frame))continue;frames.push(frame);const child=frame.contentWindow,emit=data=>w.dispatchEvent(new w.MessageEvent('message',{source:child,data}));
      child.postMessage=data=>{requests.push(data);if(data.type==='open')emit({type:'loaded',token:data.token,pages:3});else if(data.requestId)queueMicrotask(()=>emit({type:'reply',token:data.token,requestId:data.requestId,result:data.type==='highlight-add'?[{key:'page:1',quote:'Omni',start:0,end:4,color:data.color}]:data.page||data.zoom||data.mode||true}));};
      queueMicrotask(()=>emit({type:'ready'}));
    }
  });observer.observe(f.root,{childList:true,subtree:true});
  try {
    const file=new File([await readFile(new URL('./fixtures/sample.docx',import.meta.url))],'sample.docx');
    api=await openEditor({ext:'docx',name:file.name,blob:file},f.root,{signal:controller.signal,viewMode:'scroll',initialZoom:1.5,initialPage:2,onError:error=>{throw error;}});
    assert.equal(api.sourceMode,true);assert.equal(requests[0].bindings['toggle-edit'][0],'Ctrl+KeyD');
    const original=await api.export();await api.toggleView();assert.equal(api.sourceMode,false);assert.ok(f.root.querySelector('.office-editor').hidden);assert.equal(api.position.page,2);assert.equal(api.position.zoom,1.5);
    assert.deepEqual(await api.readingViewer.addHighlight('#ffe066'),[{key:'page:1',quote:'Omni',start:0,end:4,color:'#ffe066'}]);
    const bindings=getShortcutBindings(w);bindings.highlight=['Ctrl+Alt+KeyH'];applyShortcutBindings(bindings,w);assert.equal(requests.filter(data=>data.type==='shortcuts').length,2);assert.ok(requests.filter(data=>data.type==='shortcuts').every(data=>data.bindings.highlight[0]==='Ctrl+Alt+KeyH'));
    await api.adjustZoom(.25);await api.adjustZoom(.25);assert.equal(api.position.zoom,2);await api.navigate(1);assert.equal(api.position.page,3);
    assert.deepEqual(new Uint8Array(await api.export()),new Uint8Array(original));
    const editFrame=f.root.querySelector('.office-editor iframe');await api.toggleView();assert.equal(api.sourceMode,true);assert.equal(f.root.querySelector('.office-editor iframe'),editFrame);assert.equal(editFrame.closest('.office-editor').hidden,false);assert.equal(frames[1].isConnected,false);assert.equal(w.document.activeElement,editFrame);
  }finally{api?.dispose();controller.abort();observer.disconnect();globalThis.fetch=oldFetch;f.close();}
});

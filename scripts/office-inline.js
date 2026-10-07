import { editingShortcut, formattingShortcut, shortcutCommand } from '../dist/shortcuts.js';
const keys = ['bold','italic','underline','strike'];
const copy = value => structuredClone(value);
const length = n => n.nodeType === 3 ? n.data.length : n.nodeName === 'BR' ? 1 : [...n.childNodes].reduce((sum,c)=>sum+length(c),0);
const text = n => n.nodeType === 3 ? n.data : n.nodeName === 'BR' ? '\n' : [...n.childNodes].map(text).join('');
function point(root, offset) {
  let remaining = offset;
  function visit(n) {
    if(n.nodeType===3){if(remaining<=n.data.length)return [n,remaining];remaining-=n.data.length;return null;}
    for(const child of n.childNodes){
      if(child.nodeName==='BR'){if(remaining<=1)return [n,[...n.childNodes].indexOf(child)+(remaining===1?1:0)];remaining--;continue;}
      const found=visit(child);if(found)return found;
    }
    return null;
  }
  return visit(root) || [root,root.childNodes.length];
}
function offsets(root, range) {
  const before = document.createRange();before.selectNodeContents(root);before.setEnd(range.startContainer,range.startOffset);
  const through = document.createRange();through.selectNodeContents(root);through.setEnd(range.endContainer,range.endOffset);
  return {start:length(before.cloneContents()),end:length(through.cloneContents())};
}
function css(span, style) {
  if(typeof style.bold==='boolean')span.style.fontWeight=style.bold?'bold':'normal';
  if(typeof style.italic==='boolean')span.style.fontStyle=style.italic?'italic':'normal';
  if(typeof style.underline==='boolean' || typeof style.strike==='boolean')span.style.textDecorationLine=[style.underline?'underline':'',style.strike?'line-through':''].filter(Boolean).join(' ') || 'none';
  for(const key of keys)if(typeof style[key]==='boolean')span.dataset[key]=String(style[key]);
}
/** Bind editable text to OOXML paragraph IDs, never treating file text as HTML. */
export function createInlineEditor(blocks, send) {
  const state = new Map(blocks.map(b=>[b.id,copy(b)])), mounted = new Map(), templates = new Map();
  const originalText = new Map(blocks.map(b=>[b.id,b.text]));
  let active = null, saved = null, pendingStyle = {}, busy = false, composing = false, pendingBookmark = null;
  function paint(el,b) {
    el.replaceChildren();
    for(const s of b.segments){
      const span=document.createElement('span');span.dataset.template=s.template;span.style.cssText=templates.get(b.id)?.[s.template] || templates.get(b.id)?.[0] || '';
      css(span,s.style);const chunks=s.text.split('\n');
      chunks.forEach((t,i)=>{if(i)span.append(document.createElement('br'));span.append(document.createTextNode(t));});el.append(span);
    }
    if(!el.firstChild)el.append(document.createElement('span'));
  }
  function read(el) {
    const output=[];
    function visit(n, inherited = {}) {
      if(n.nodeType===3 || n.nodeName==='BR'){
        const owner=n.nodeType===3?n.parentElement:n, templ=owner.closest('[data-template]');
        const style={...inherited};
        output.push({text:n.nodeName==='BR'?'\n':n.data,style,template:Number(templ?.dataset.template || 0)});return;
      }
      const style={...inherited};
      for(const key of keys)if(n.dataset?.[key]!=null)style[key]=n.dataset[key]==='true';
      if(['B','STRONG'].includes(n.nodeName))style.bold=true;
      if(['I','EM'].includes(n.nodeName))style.italic=true;
      if(n.nodeName==='U')style.underline=true;
      if(['S','STRIKE','DEL'].includes(n.nodeName))style.strike=true;
      [...n.childNodes].forEach(c=>visit(c,style));
    }
    visit(el);const result=output.filter(s=>s.text.length);return result.length?result:[{text:'',style:{},template:0}];
  }
  function report() {
    const b=active && state.get(active), pos=saved?.id===active?saved:null;
    let offset=0;const segment=b?.segments.find(s=>{const match=(pos?.start || 0)<offset+s.text.length;offset+=s.text.length;return match;}) || b?.segments.at(-1);
    send({type:'edit-selection',id:active,page:b?.partIndex+1,styles:{...segment?.style,...pendingStyle},selected:!!pos && pos.end>pos.start});
  }
  function capture() {
    const selection=getSelection();if(!selection?.rangeCount)return;
    const range=selection.getRangeAt(0), el=range.startContainer.nodeType===3?range.startContainer.parentElement:range.startContainer;
    const content=el?.closest('.omni-edit-content');
    if(!content)return;
    if(!content.contains(range.endContainer)){active=null;saved=null;pendingStyle={};report();return;}
    active=content.dataset.block;saved={id:active,...offsets(content,range)};report();
  }
  function commit(el, merge = true) {
    if(!el || composing)return;
    const b=state.get(el.dataset.block), segments=read(el);
    if(JSON.stringify(segments)===JSON.stringify(b.segments))return;
    b.segments=segments;b.text=segments.map(s=>s.text).join('');
    send({type:'edit',id:b.id,segments:copy(segments),mergeKey:merge?'type:'+b.id:null});
  }
  function restore(book) {
    if(!book)return;if(busy){pendingBookmark=book;return;}
    const el=mounted.get(book.id);if(!el?.isConnected)return;
    if(el.closest('section.docx')?.hidden){active=null;saved=null;pendingStyle={};report();return;}
    active=book.id;saved={...book};pendingStyle={...(book.pendingStyle || {})};
    const start=point(el,book.start),end=point(el,book.end),r=document.createRange();r.setStart(...start);r.setEnd(...end);
    el.focus({preventScroll:true});const selection=getSelection();selection.removeAllRanges();selection.addRange(r);report();
  }
  function insert(value) {
    const el=mounted.get(active);if(!el || busy || composing)return;
    const pos=saved || {id:active,start:text(el).length,end:text(el).length};
    restore(pos);const r=getSelection()?.getRangeAt(0);if(!r)return;
    const source=state.get(active).segments.find(s=>s.text) || {template:0,style:{}};
    const span=document.createElement('span');span.dataset.template=source.template;span.style.cssText=templates.get(active)?.[source.template] || '';
    css(span,{...source.style,...pendingStyle});value.split('\n').forEach((part,i)=>{if(i)span.append(document.createElement('br'));span.append(document.createTextNode(part));});
    r.deleteContents();r.insertNode(span);commit(el,false);restore({id:active,start:pos.start+value.length,end:pos.start+value.length});
  }
  function format(key) {
    const el=mounted.get(active);if(!el || busy || composing || !keys.includes(key))return;
    const pos=saved || {id:active,start:0,end:0}, b=state.get(active);
    let offset=0;const at=b.segments.find(s=>{const fits=pos.start<offset+s.text.length;offset+=s.text.length;return fits;}) || b.segments.at(-1);
    const value=!((pendingStyle[key] ?? at?.style[key]) || false);
    if(pos.start===pos.end){pendingStyle[key]=value;report();return;}
    const result=[];offset=0;
    for(const s of b.segments){const start=Math.max(0,pos.start-offset),end=Math.min(s.text.length,pos.end-offset);
      if(end>start){if(start)result.push({...s,text:s.text.slice(0,start)});result.push({...s,text:s.text.slice(start,end),style:{...s.style,[key]:value}});if(end<s.text.length)result.push({...s,text:s.text.slice(end)});}
      else result.push(copy(s));offset+=s.text.length;
    }
    b.segments=result;b.text=result.map(s=>s.text).join('');paint(el,b);
    send({type:'edit',id:active,segments:copy(result),mergeKey:null});restore(pos);
  }
  function mount(paragraph,b, runElements = null) {
    if(!b.editable || paragraph.querySelector('.omni-edit-content'))return;
    const original=runElements || [...paragraph.children].filter(n=>n.nodeName==='SPAN');
    if(!templates.has(b.id))templates.set(b.id,original.map(n=>n.style.cssText));
    const el=document.createElement('span');el.className='omni-edit-content';el.dataset.block=b.id;el.contentEditable=busy?'false':'true';el.setAttribute('role','textbox');el.setAttribute('aria-label','Текст документа');el.setAttribute('aria-multiline','true');el.spellcheck=true;
    if(runElements){for(const n of original)n.remove();for(const n of [...paragraph.childNodes])if(n.nodeName==='BR')n.remove();paragraph.append(el);}
    else paragraph.replaceChildren(el);
    paint(el,b);mounted.set(b.id,el);
    el.addEventListener('focus',()=>{active=b.id;report();});
    el.addEventListener('input',()=>{commit(el);capture();});
    el.addEventListener('compositionstart',()=>{composing=true;});
    el.addEventListener('compositionend',()=>{composing=false;commit(el);capture();});
    el.addEventListener('beforeinput',event=>{
      if(busy){event.preventDefault();return;}
      const selection=getSelection(),range=selection?.rangeCount?selection.getRangeAt(0):null;
      if(range && (!el.contains(range.startContainer) || !el.contains(range.endContainer))){event.preventDefault();return;}
      if(event.inputType==='insertParagraph' || event.inputType==='insertLineBreak'){event.preventDefault();capture();insert('\n');}
      else if(event.inputType==='insertText' && Object.keys(pendingStyle).length && !composing){event.preventDefault();capture();insert(event.data || '');}
    });
    el.addEventListener('paste',event=>{event.preventDefault();capture();insert(event.clipboardData?.getData('text/plain') || '');});
    el.addEventListener('keydown',event=>{
      const action=editingShortcut(event);
      if(action){event.preventDefault();send({type:'edit-shortcut',command:action});return;}
      const style=formattingShortcut(event);if(style){event.preventDefault();capture();format(style);return;}
      const command=shortcutCommand(event),ppt=b.path.startsWith('ppt/');
      const insert=({'insert-page':ppt?'slide':'page','insert-section':ppt?'section':'page','insert-slide':ppt?'slide':null})[command];
      if(insert){event.preventDefault();send({type:'edit-shortcut',command:insert});}
    });
    if(pendingBookmark?.id===b.id && !busy){const book=pendingBookmark;pendingBookmark=null;restore(book);}
    else if(saved?.id===b.id && !busy)restore(saved);
  }
  const selectionHandler=()=>capture();document.addEventListener('selectionchange',selectionHandler);
  return {
    annotateDocx(doc){
      let index=0;const blocks=[...state.values()].filter(b=>b.path==='word/document.xml');
      function visit(n){if(n.type==='paragraph'){const b=blocks[index++];if(b)n.className=((n.className || '')+' omni-paragraph-'+b.paragraphIndex).trim();}for(const c of n.children || [])visit(c);}
      visit(doc.documentPart.body);
    },
    mountDocx(root){
      for(const b of state.values()){
        if(b.path!=='word/document.xml')continue;
        const paragraphs=root.querySelectorAll('.omni-paragraph-'+b.paragraphIndex);
        // A split paragraph cannot be edited as separate halves without losing its contents.
        if(paragraphs.length===1)mount(paragraphs[0],b);
      }
    },
    mountPptx(index,root){
      const candidates=[...root.querySelectorAll('div')].filter(p=>[...p.children].some(n=>n.nodeName==='SPAN') && !p.querySelector('.omni-edit-content'));
      const used=new Set();
      for(const b of state.values()){
        if(b.partIndex!==index)continue;
        const source=originalText.get(b.id);
        const target=candidates.find(p=>!used.has(p) && (p.textContent===b.text || p.textContent===source || (source && p.textContent.endsWith(source))));
        if(!target)continue;used.add(target);
        const runs=[...target.children].filter(n=>n.nodeName==='SPAN').slice(-Math.max(1,b.segments.length));
        mount(target,b,runs);
      }
    },
    releasePptx(index){for(const [id,el] of mounted)if(state.get(id)?.partIndex===index){if(id===active){composing=false;commit(el);active=null;saved=null;pendingStyle={};}mounted.delete(id);}},
    bookmark(page=null){
      capture();if(!saved)return null;
      if(page!=null){const el=mounted.get(saved.id),section=el?.closest('section.docx'),actual=section?Number(section.dataset.page):state.get(saved.id)?.partIndex+1;if(actual!==page)return null;}
      return {...saved,pendingStyle:{...pendingStyle}};
    },
    navigate(page){
      const el=mounted.get(active),section=el?.closest('section.docx'),actual=section?Number(section.dataset.page):state.get(active)?.partIndex+1;
      if(el && actual!==page){el.blur();active=null;saved=null;pendingStyle={};report();}
    },
    restore,
    get composing(){return composing;},
    flush(){if(composing)throw new Error('Завершите ввод текста и повторите действие.');for(const el of mounted.values())if(el.isConnected)commit(el);},
    message(data){
      if(data.type==='edit-busy'){busy=!!data.busy;for(const el of mounted.values())el.contentEditable=busy?'false':'true';if(!busy && pendingBookmark){const book=pendingBookmark;pendingBookmark=null;restore(book);}}
      else if(data.type==='edit-command'){if(data.command==='format')format(data.key);if(data.command==='insert')insert(data.text);if(data.command==='focus'){active=data.id;const b=state.get(active);restore({id:active,start:b?.text.length || 0,end:b?.text.length || 0});}}
      else if(data.type==='edit-sync'){
        const book=this.bookmark();for(const b of data.blocks)state.set(b.id,copy(b));for(const [id,el] of mounted)if(el.isConnected && state.has(id))paint(el,state.get(id));restore(book);
      }
    },
    dispose(){document.removeEventListener('selectionchange',selectionHandler);mounted.clear();}
  };
}

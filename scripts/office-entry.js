import { parseAsync, renderDocument } from 'docx-preview';
import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from '@aiden0z/pptx-renderer';
import { createInlineEditor } from './office-inline.js';
import { applyShortcutBindings, shortcutCommand } from '../dist/shortcuts.js';
import { createReadHighlights } from '../dist/read-highlights.js';
import { officeModes } from './office-modes.js';
import { wheelZoomDelta, captureZoomAnchor, bindTouchPinch, createZoomSpace } from '../dist/gestures.js';
let viewer, token, zoom=1,docWidth=800,docScale,modes,editor,renderBookmark,highlights,space;
let queryState='',hitIndex=-1, action=Promise.resolve();
const container=document.querySelector('#office');
const send=data=>parent.postMessage({...data,token},'*');
function fitDocument(){
  if(!docScale)return;
  const viewportWidth=document.documentElement.clientWidth || innerWidth;
  const factor=Math.max(0.1,(viewportWidth-32)/docWidth)*zoom;
  docScale.style.transform='scale('+factor+')';docScale.parentElement.style.height=(docScale.scrollHeight*factor)+'px';docScale.parentElement.style.width=(docWidth*factor)+'px';
}
async function openDocument(data){
  token=data.token;
  container.style.width=(document.documentElement.clientWidth || innerWidth)+'px';
  space=createZoomSpace(window,container);
  applyShortcutBindings(data.bindings || {},window);
  if(data.blocks)editor=createInlineEditor(data.blocks,message=>{
    if(message.type==='edit-selection' && message.id){
      const el=[...container.querySelectorAll('.omni-edit-content')].find(n=>n.dataset.block===message.id),section=el?.closest('section.docx');
      if(section)message.page=Number(section.dataset.page);
      modes?.selected(message.page);
    }
    send(message);
  });
  modes=officeModes({container,getViewer:()=>viewer,editor,initialMode:data.viewMode,onPage:page=>send({type:'page-change',page}),fitDocument});
  if(data.ext==='pptx'){
    container.className='pptx';
    viewer=new PptxViewer(container,{
      fitMode:'contain',lazySlides:true,lazyMedia:true,pdfjs:false,
      zipLimits:{...RECOMMENDED_ZIP_LIMITS,maxEntries:65534,maxEntryUncompressedBytes:512*1024*1024,maxTotalUncompressedBytes:2048*1024*1024,maxMediaBytes:1024*1024*1024,maxConcurrency:2},
      onSlideChange:index=>modes.slideChanged(index),
      onSlideRendered:(index,el)=>editor?.mountPptx(index,el),
      onSlideUnmounted:index=>editor?.releasePptx(index),
      onRenderStart:()=>{renderBookmark=editor?.bookmark();},
      onRenderComplete:()=>{editor?.restore(renderBookmark);},
      onSlideError:()=>send({type:'warning',message:'Не удалось отобразить слайд.'}),
      onNodeError:()=>send({type:'warning',message:'Некоторые объекты не удалось отобразить.'})
    });
    await viewer.open(data.buffer,{renderMode:modes.mode==='scroll'?'list':'slide',listOptions:modes.listOptions});
    if(!viewer.slideCount)throw new Error('В презентации нет слайдов.');
    send({type:'loaded',pages:viewer.slideCount});
  }else{
    const outer=document.createElement('div');outer.className='doc-page-stack';docScale=document.createElement('div');docScale.id='doc-scale';outer.append(docScale);container.append(outer);
    const options={breakPages:true,ignoreLastRenderedPageBreak:false,renderAltChunks:false,renderComments:false,renderChanges:false,useBase64URL:true,ignoreFonts:true};
    const doc=await parseAsync(data.buffer,options);editor?.annotateDocx(doc);docScale.replaceChildren(...await renderDocument(doc,options));editor?.mountDocx(docScale);
    for(const link of container.querySelectorAll('a'))link.removeAttribute('href');
    const sections=[...container.querySelectorAll('section.docx')];if(!sections.length)throw new Error('В документе нет страниц.');
    docWidth=Math.max(...sections.map(s=>s.getBoundingClientRect().width || 800));docScale.style.width=docWidth+'px';modes.bindDocx();
    send({type:'loaded',pages:sections.length});
  }
  highlights=createReadHighlights(container,{canHighlight:()=>!editor});
  space.refresh();
}
async function message(data){
  if(data.type==='open' && !token){await openDocument(data);return;}
  if(!token || data.token!==token)return;
  if(data.type==='print-html'){
    if(!docScale)throw new Error('Печать поддерживается для DOCX.');
    const copy=docScale.cloneNode(true);copy.removeAttribute('style');
    for(const el of copy.querySelectorAll('[hidden]'))el.removeAttribute('hidden');
    for(const el of copy.querySelectorAll('script,iframe,object,embed,link,base'))el.remove();
    for(const el of copy.querySelectorAll('*'))for(const attr of [...el.attributes]){
      if(/^on/i.test(attr.name) || ['contenteditable','href','srcdoc'].includes(attr.name) || attr.name==='src' && !attr.value.startsWith('data:image/'))el.removeAttribute(attr.name);
    }
    let pages='';const length=/^\d+(?:\.\d+)?(?:pt|px|mm|cm|in)$/;
    [...copy.querySelectorAll('section.docx')].forEach((section,i)=>{
      section.style.display='block';const width=section.style.width,height=section.style.minHeight || section.style.height;
      if(length.test(width) && length.test(height)){section.style.page='omniPage'+i;pages+='@page omniPage'+i+'{size:'+width+' '+height+';margin:0}';}
    });
    const css='@page{size:A4;margin:0}html,body{margin:0;background:white;color:black}#doc-scale,.docx-wrapper{display:block!important;width:auto!important;height:auto!important;transform:none!important;padding:0!important;background:white!important}.docx-wrapper>section.docx{display:block!important;margin:0!important;box-shadow:none!important;break-after:page}.docx-wrapper>section.docx:last-child{break-after:auto}img{max-width:100%}*{print-color-adjust:exact;-webkit-print-color-adjust:exact}';
    send({type:'reply',requestId:data.requestId,result:'<!doctype html><html><head><meta charset="utf-8"><style>'+css+pages+'</style></head><body>'+copy.outerHTML+'</body></html>'});
  }
  if(data.type==='shortcuts')applyShortcutBindings(data.bindings,window);
  if(data.type==='highlight-add')send({type:'reply',requestId:data.requestId,result:highlights.add(data.color)});
  if(data.type==='highlight-set'){highlights.set(data.records);send({type:'reply',requestId:data.requestId,result:true});}
  if(data.type==='highlight-clear'){highlights.clear();send({type:'reply',requestId:data.requestId,result:[]});}
  if(data.type==='theme' && /^#[\da-f]{6}$/i.test(data.theme?.background)){
    document.documentElement.style.background=data.theme.background;document.body.style.background=data.theme.background;
    document.documentElement.style.colorScheme=data.theme.dark?'dark':'light';
  }
  if(data.type==='page'){await modes.go(data.page);send({type:'reply',requestId:data.requestId,result:modes.page});}
  if(data.type==='view-mode'){await modes.setMode(data.mode);send({type:'reply',requestId:data.requestId,result:modes.mode});}
  if(data.type==='zoom'){
    const restore=captureZoomAnchor(()=>[...container.querySelectorAll('section.docx,[data-slide-index]')],window,data.anchor || {x:innerWidth/2,y:innerHeight/2});
    await modes.zoom(data.zoom,async value=>{
      zoom=value;
      if(viewer){container.style.transformOrigin='0 0';container.style.transform=`scale(${value})`;}
      else fitDocument();
      space.refresh();
    },true);
    restore();send({type:'reply',requestId:data.requestId,result:zoom});
  }
  if(data.type==='flush'){editor?.flush();send({type:'reply',requestId:data.requestId,result:true});}
  if(data.type.startsWith('edit-')){
    if(data.type==='edit-command' && data.command==='focus'){
      const el=[...container.querySelectorAll('.omni-edit-content')].find(n=>n.dataset.block===data.id),section=el?.closest('section.docx');
      if(section)await modes.go(Number(section.dataset.page));
    }
    editor?.message(data);
  }
  if(data.type==='find'){
    if(typeof data.query!=='string' || !data.query){send({type:'reply',requestId:data.requestId,result:null});return;}
    if(queryState!==data.query){queryState=data.query;hitIndex=-1;}
    let result=null;
    if(viewer){
      const hits=viewer.searchText(data.query);if(hits.length){const hit=hits[(++hitIndex)%hits.length];await modes.go(hit.slideIndex+1);result={page:hit.slideIndex+1,message:'Совпадение '+((hitIndex%hits.length)+1)+' / '+hits.length};}
    }else{
      const hits=[],query=data.query.toLocaleLowerCase();
      for(const section of container.querySelectorAll('section.docx')){
        const walker=document.createTreeWalker(section,NodeFilter.SHOW_TEXT),nodes=[];let n,text='';
        while(n=walker.nextNode()){if(n.parentElement.closest('style,script'))continue;nodes.push({node:n,start:text.length,end:text.length+n.length});text+=n.textContent;}
        let at=text.toLocaleLowerCase().indexOf(query);
        while(at>=0){const first=nodes.find(part=>at>=part.start && at<part.end),last=nodes.find(part=>at+data.query.length>part.start && at+data.query.length<=part.end);if(first && last)hits.push({first,last,at,page:Number(section.dataset.page || 1)});at=text.toLocaleLowerCase().indexOf(query,at+query.length);}
      }
      if(hits.length){const hit=hits[(++hitIndex)%hits.length];await modes.go(hit.page);const r=document.createRange();r.setStart(hit.first.node,hit.at-hit.first.start);r.setEnd(hit.last.node,hit.at+data.query.length-hit.last.start);getSelection().removeAllRanges();getSelection().addRange(r);hit.first.node.parentElement.scrollIntoView({block:'center'});result={page:hit.page,message:'Совпадение '+((hitIndex%hits.length)+1)+' / '+hits.length};}
    }
    send({type:'reply',requestId:data.requestId,result});
  }
}
addEventListener('message',event=>{
  if(event.source!==parent || !event.data || typeof event.data!=='object')return;
  const data=event.data;action=action.then(()=>message(data)).catch(error=>send({type:'error',requestId:data.requestId,message:error.message || 'Ошибка документа.'}));
});
addEventListener('resize',()=>{container.style.width=(document.documentElement.clientWidth || innerWidth)+'px';fitDocument();space?.refresh();});
addEventListener('wheel',event=>{
  const delta=wheelZoomDelta(event);
  if(delta===null || !token)return;
  event.preventDefault();event.stopPropagation();
  send({type:'zoom-gesture',delta,anchor:{x:event.clientX,y:event.clientY}});
},{passive:false,capture:true});
const disposeTouch=bindTouchPinch(window,(delta,anchor)=>{
  if(token)send({type:'zoom-gesture',delta,anchor});
});
addEventListener('pagehide',()=>{disposeTouch();modes?.dispose();highlights?.dispose();},{once:true});
document.addEventListener('selectionchange',()=>{const text=getSelection()?.toString() || '';if(text)send({type:'selection',text});});
document.addEventListener('keydown',event=>{
  const command=shortcutCommand(event);if(!command)return;
  const typing=event.target.closest?.('input,textarea,select,[contenteditable="true"]');
  if(['next','previous'].includes(command) && typing && !event.ctrlKey && !event.altKey && !event.metaKey)return;
  if(['theme','focus','escape','toggle-edit','highlight','shortcut-settings','next','previous'].includes(command) || command.startsWith('zoom-') || command==='save' && !editor){
    event.preventDefault();event.stopImmediatePropagation();
    if(!event.repeat || command.startsWith('zoom-') || ['next','previous'].includes(command))send({type:'shell-shortcut',command});
  }
},true);
addEventListener('click',event=>{if(event.target.closest('a'))event.preventDefault();},true);
send({type:'ready'});

let sequence=0;
const colorValue=value=>/^#[0-9a-f]{6}$/i.test(value||'')?value.toLowerCase():'#ffe066';
const skip='script,style,button,input,textarea,select,[hidden],[aria-hidden="true"],.katex-mathml,annotation,.editor-bar,.notebook-cell-heading,.notebook-caption,.source-notice,.table-tools,.table-nav,.cell-detail,.table-note';

/** Transient reading annotations, anchored to page/cell text instead of exported file data. */
export function createReadHighlights(root,{canHighlight=()=>true,signal,onChange}={}) {
  const document=root.ownerDocument,window=document.defaultView,prefix=`omni-mark-${sequence++}`;
  const cssAPI=!!(window.CSS?.highlights && window.Highlight),style=document.createElement('style');document.head.append(style);
  const registryNames=new Set();let records=[],selection=[],disposed=false,frame=0,suspended=false;
  const blocks=()=>{
    const pages=[...root.querySelectorAll('.pdf-paper[data-page],section.docx[data-page],[data-slide-index],.notebook-cell')].filter(el=>!el.closest('[hidden]'));
    return pages.length?pages:[root];
  };
  function key(block){
    if(block.dataset.page)return 'page:'+block.dataset.page;
    if(block.hasAttribute('data-slide-index'))return 'slide:'+block.dataset.slideIndex;
    if(block.classList.contains('notebook-cell'))return 'cell:'+(block.dataset.cellId||[...block.parentElement.children].indexOf(block));
    return 'document';
  }
  function textNodes(block){
    const walker=document.createTreeWalker(block,window.NodeFilter.SHOW_TEXT),nodes=[];let text='',node;
    while(node=walker.nextNode()){
      if(!node.textContent || node.parentElement.closest(skip))continue;
      nodes.push({node,start:text.length,end:text.length+node.textContent.length});text+=node.textContent;
    }
    return {nodes,text};
  }
  function capture(event){
    if(disposed || suspended || !canHighlight())return;
    const current=window.getSelection();if(!current?.rangeCount || current.isCollapsed){if(['mouseup','touchend'].includes(event?.type))selection=[];return;}
    const range=current.getRangeAt(0),found=[];
    if(!root.contains(range.startContainer) || !root.contains(range.endContainer))return;
    for(const block of blocks()){
      const {nodes,text}=textNodes(block);let start=Infinity,end=-1;
      for(const item of nodes){
        if(!range.intersectsNode(item.node))continue;
        const from=range.startContainer===item.node?range.startOffset:0,to=range.endContainer===item.node?range.endOffset:item.node.length;
        if(to>from){start=Math.min(start,item.start+from);end=Math.max(end,item.start+to);}
      }
      if(end>start)found.push({key:key(block),start,end,quote:text.slice(start,end),before:text.slice(Math.max(0,start-32),start),after:text.slice(end,end+32)});
    }
    if(found.length)selection=found;
  }
  function clearPaint(){
    for(const name of registryNames)window.CSS?.highlights?.delete(name);registryNames.clear();
    for(const mark of root.querySelectorAll('mark[data-omni-read-mark]')){
      const parent=mark.parentNode;mark.replaceWith(...mark.childNodes);parent?.normalize();
    }
    style.textContent='';
  }
  function position(item,text){
    if(text.slice(item.start,item.end)===item.quote)return {start:item.start,end:item.end};
    let at=-1,best=-1,score=-Infinity;
    while((at=text.indexOf(item.quote,at+1))>=0){
      const current=(item.before && text.slice(Math.max(0,at-item.before.length),at)===item.before?1000000:0)+(item.after && text.slice(at+item.quote.length,at+item.quote.length+item.after.length)===item.after?1000000:0)-Math.abs(at-item.start);
      if(current>score){score=current;best=at;}
    }
    return best>=0?{start:best,end:best+item.quote.length}:null;
  }
  function paint(){
    if(disposed)return;observer.disconnect();clearPaint();
    if(!suspended && canHighlight()){
      const css=[],allRanges=[];
      for(const block of blocks()){
        const {nodes,text}=textNodes(block);if(!text)continue;
        for(const [index,item] of records.entries()){
          if(item.key!==key(block))continue;const pos=position(item,text);if(!pos)continue;
          for(const part of nodes){
            const start=Math.max(pos.start,part.start)-part.start,end=Math.min(pos.end,part.end)-part.start;
            if(end<=start)continue;
            allRanges.push({part,start,end,index,color:item.color});
          }
        }
      }
      if(cssAPI){
        const groups=new Map();
        for(const item of allRanges){const range=document.createRange();range.setStart(item.part.node,item.start);range.setEnd(item.part.node,item.end);if(!groups.has(item.index))groups.set(item.index,[]);groups.get(item.index).push(range);}
        for(const [index,ranges] of groups){const name=prefix+'-'+index,color=records[index].color;window.CSS.highlights.set(name,new window.Highlight(...ranges));registryNames.add(name);css.push(`::highlight(${name}){background-color:${color}66;text-shadow:0 0 7px ${color};}`);}
      }else{
        // Split each text node once per interval; the newest overlapping color wins.
        const groups=new Map(),intervals=[];
        for(const item of allRanges){if(!groups.has(item.part.node))groups.set(item.part.node,[]);groups.get(item.part.node).push(item);}
        for(const items of groups.values()){
          const edges=[...new Set(items.flatMap(item=>[item.start,item.end]))].sort((a,b)=>a-b);
          for(let i=0;i<edges.length-1;i++){
            const start=edges[i],end=edges[i+1],item=items.filter(part=>part.start<=start && part.end>=end).at(-1);
            if(item)intervals.push({...item,start,end});
          }
        }
        for(const item of intervals.reverse()){
          const node=item.part.node;if(item.start>=node.length)continue;const end=Math.min(item.end,node.length);if(end<=item.start)continue;
          if(end<node.length)node.splitText(end);const selected=item.start?node.splitText(item.start):node;
          const mark=document.createElement('mark');mark.dataset.omniReadMark='';mark.className='read-mark';
          mark.style.setProperty('--read-mark-color',item.color);mark.style.backgroundColor=item.color+'66';mark.style.color='inherit';mark.style.textShadow='0 0 7px '+item.color;
          selected.replaceWith(mark);mark.append(selected);
        }
      }
      style.textContent=css.join('\n');
    }
    observer.observe(root,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['hidden','class']});
  }
  const schedule=()=>{if(!frame && !disposed)frame=window.requestAnimationFrame(()=>{frame=0;paint();});};
  const observer=new window.MutationObserver(schedule);
  document.addEventListener('selectionchange',capture);root.addEventListener('mouseup',capture);root.addEventListener('touchend',capture);
  paint();
  const api={
    capture,
    add(color){
      capture();if(suspended || !canHighlight())throw new Error('Маркер работает только в режиме просмотра. Переключите режим редактирования.');
      if(!selection.length)throw new Error('Сначала выделите текст или код в файле.');
      if(records.length+selection.length>500 || selection.reduce((sum,item)=>sum+item.quote.length,0)>200000)throw new Error('Выделите меньший фрагмент текста.');
      records.push(...selection.map(item=>({...item,color:colorValue(color)})));paint();onChange?.(api.records);return api.records;
    },
    set(value){records=Array.isArray(value)?value.slice(0,500).filter(item=>item && typeof item.key==='string' && typeof item.quote==='string' && item.quote.length && item.quote.length<=200000 && Number.isInteger(item.start) && Number.isInteger(item.end) && item.start>=0 && item.end>item.start).map(item=>({...item,color:colorValue(item.color),before:String(item.before||'').slice(-32),after:String(item.after||'').slice(0,32)})):[];selection=[];paint();},
    get records(){return records.map(item=>({...item}));},
    clear(){records=[];selection=[];paint();onChange?.([]);},
    suspend(value){suspended=!!value;selection=[];paint();},
    dispose(){if(disposed)return;disposed=true;observer.disconnect();window.cancelAnimationFrame(frame);clearPaint();style.remove();records=[];selection=[];document.removeEventListener('selectionchange',capture);root.removeEventListener('mouseup',capture);root.removeEventListener('touchend',capture);signal?.removeEventListener('abort',api.dispose);}
  };
  signal?.addEventListener('abort',api.dispose,{once:true});if(signal?.aborted)api.dispose();return api;
}

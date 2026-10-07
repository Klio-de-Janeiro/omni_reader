import { viewMode, trackPages } from '../dist/page-modes.js';
/** Switch layouts on the existing parsed document, retaining the active page and caret. */
export function officeModes({container,getViewer,editor,initialMode,onPage,fitDocument}) {
  let mode=viewMode(initialMode),page=1,navigating=false;
  container.dataset.viewMode=mode;
  const tracker=trackPages(()=>[...container.querySelectorAll('section.docx,[data-slide-index]')],value=>{if(mode==='scroll' && !navigating){page=value;onPage(value);}});
  const sections=()=>[...container.querySelectorAll('section.docx')];
  const listOptions={windowed:true,initialSlides:2,batchSize:6,overscanViewport:1.5};
  function showDocx(){sections().forEach((el,i)=>{el.dataset.page=i+1;el.hidden=mode==='page' && i+1!==page;});fitDocument?.();}
  async function go(value){
    const viewer=getViewer(),total=viewer?.slideCount || sections().length;page=Math.max(1,Math.min(total,Math.trunc(value) || 1));navigating=true;
    try{editor?.navigate(page);if(viewer)await viewer.goToSlide(page-1,{behavior:'auto',block:'start'});else{showDocx();sections()[page-1]?.scrollIntoView({block:'start',behavior:'auto'});}onPage(page);}
    finally{navigating=false;tracker.refresh();}
  }
  return {
    get mode(){return mode;},get page(){return page;},listOptions,
    bindDocx(){showDocx();tracker.refresh();return sections().length;},
    go,
    async setMode(value){
      const next=viewMode(value);if(next===mode)return mode;
      const keep=page;editor?.flush();navigating=true;const book=editor?.bookmark(keep);page=keep;mode=next;container.dataset.viewMode=mode;
      const viewer=getViewer();navigating=true;
      try{if(viewer){if(mode==='scroll')await viewer.renderList(listOptions);else await viewer.renderSlide(keep-1);}else showDocx();await go(keep);navigating=true;editor?.restore(book);page=keep;onPage(page);}
      finally{navigating=false;tracker.refresh();}
      return mode;
    },
    async zoom(value,action){
      const keep=page;editor?.flush();navigating=true;const book=editor?.bookmark(keep);page=keep;
      try{await action(value);await go(keep);navigating=true;editor?.restore(book);page=keep;onPage(page);}
      finally{navigating=false;tracker.refresh();}
    },
    slideChanged(index){if(!navigating){page=index+1;onPage(page);}},
    selected(value){if(value>0 && !navigating){page=value;onPage(page);}},
    dispose(){tracker.dispose();getViewer()?.destroy();editor?.dispose();}
  };
}

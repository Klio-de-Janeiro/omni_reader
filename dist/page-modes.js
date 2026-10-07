export const viewMode = value => value === 'page' ? 'page' : 'scroll';
/** Track the page near the top of the viewport, with one measurement per animation frame. */
export function trackPages(getPages, report, {root = null, signal} = {}) {
  let raf=0,previous=0,disposed=false;
  const refresh=()=>{
    if(disposed || raf)return;
    raf=requestAnimationFrame(()=>{
      raf=0;const top=(root?.getBoundingClientRect().top || 0)+Math.min(160,(root?.clientHeight || innerHeight)*0.25);
      const pages=getPages().filter(el=>!el.hidden);let low=0,high=pages.length-1,index=0;
      while(low<=high){const middle=(low+high)>>1;if(pages[middle].getBoundingClientRect().top<=top){index=middle;low=middle+1;}else high=middle-1;}
      const el=pages[index],page=el?.getBoundingClientRect().height?Number(el.dataset.page || Number(el.dataset.slideIndex)+1):0;
      if(page && page!==previous){previous=page;report(page);}
    });
  };
  const target=root || window;target.addEventListener('scroll',refresh,{passive:true,capture:true});window.addEventListener('resize',refresh);refresh();
  const dispose=()=>{disposed=true;cancelAnimationFrame(raf);target.removeEventListener('scroll',refresh,true);window.removeEventListener('resize',refresh);};
  signal?.addEventListener('abort',dispose,{once:true});
  return {refresh,dispose};
}

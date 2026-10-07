import { syntaxHtml } from './vendor/syntax-engine.js';

/** Only the highlighter's escaped text and generated spans enter the DOM. */
export function colorCode(node,source,language) {
  node.classList.add('syntax-code');node.dataset.codeLanguage=language||'text';
  node.innerHTML=syntaxHtml(String(source),language||'text');return node;
}

/** Keep a real textarea for IME/caret/history while a synchronized layer supplies colors. */
export function colorInput(input,language,{signal}={}) {
  const document=input.ownerDocument,window=document.defaultView,wrap=document.createElement('div');wrap.className='code-input';
  const mirror=document.createElement('pre');mirror.className='syntax-mirror';mirror.setAttribute('aria-hidden','true');
  const code=document.createElement('code');mirror.append(code);
  input.replaceWith(wrap);wrap.append(mirror,input);input.classList.add('syntax-input');
  let previous=null,disposed=false,timer=0;
  function syncScroll(){mirror.scrollTop=input.scrollTop;mirror.scrollLeft=input.scrollLeft;}
  function refresh(){
    if(disposed)return;
    const style=window.getComputedStyle(input);
    for(const key of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','tabSize','paddingTop','paddingRight','paddingBottom','paddingLeft','wordBreak','overflowWrap'])mirror.style[key]=style[key];
    if(input.value!==previous){previous=input.value;clearTimeout(timer);const source=input.value;
      if(source.length>60000){code.textContent=source+(source.endsWith('\n')?' ':'');timer=setTimeout(()=>{if(!disposed)colorCode(code,source+(source.endsWith('\n')?' ':''),language);},100);}
      else colorCode(code,source+(source.endsWith('\n')?' ':''),language);
    }
    syncScroll();
  }
  input.addEventListener('input',refresh);input.addEventListener('scroll',syncScroll);
  window.addEventListener('omni-layout-change',refresh);
  const resize=typeof window.ResizeObserver==='function'?new window.ResizeObserver(refresh):null;resize?.observe(input);
  function dispose(){if(disposed)return;disposed=true;clearTimeout(timer);resize?.disconnect();input.removeEventListener('input',refresh);input.removeEventListener('scroll',syncScroll);window.removeEventListener('omni-layout-change',refresh);signal?.removeEventListener('abort',dispose);}
  signal?.addEventListener('abort',dispose,{once:true});refresh();return {refresh,dispose,wrap};
}

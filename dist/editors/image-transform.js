import { imageGeometry, imagePoint, imagePreviewPoint } from './image.js';

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
export const normalizedAngle=value=>((value+180)%360+360)%360-180;
const canonical=state=>JSON.stringify([state.x,state.y,state.w,state.h,state.turns,state.angle || 0,!!state.flipX,!!state.flipY]);

/** Resize or move a crop in original pixels, keeping opposite edges and image bounds. */
export function dragImageCrop(state,bounds,handle,delta,ratio=null) {
  if(handle==='move')return {...state,x:Math.round(clamp(state.x+delta.x,0,bounds.width-state.w)),y:Math.round(clamp(state.y+delta.y,0,bounds.height-state.h))};
  const west=handle.includes('w'),east=handle.includes('e'),north=handle.includes('n'),south=handle.includes('s');
  let left=state.x,right=state.x+state.w,top=state.y,bottom=state.y+state.h;
  if(west)left=clamp(left+delta.x,0,right-1);if(east)right=clamp(right+delta.x,left+1,bounds.width);
  if(north)top=clamp(top+delta.y,0,bottom-1);if(south)bottom=clamp(bottom+delta.y,top+1,bounds.height);
  if(ratio){
    let w=right-left,h=bottom-top;
    if((west || east) && (north || south)){
      if(Math.abs(delta.x)/state.w>=Math.abs(delta.y)/state.h)h=w/ratio;else w=h*ratio;
    }else if(west || east)h=w/ratio;else w=h*ratio;
    const cx=state.x+state.w/2,cy=state.y+state.h/2;
    const maxW=west?state.x+state.w:east?bounds.width-state.x:2*Math.min(cx,bounds.width-cx);
    const maxH=north?state.y+state.h:south?bounds.height-state.y:2*Math.min(cy,bounds.height-cy);
    const factor=Math.min(1,maxW/w,maxH/h);w=Math.max(1,Math.round(w*factor));h=Math.max(1,Math.round(h*factor));
    left=west?state.x+state.w-w:east?state.x:Math.round(cx-w/2);
    top=north?state.y+state.h-h:south?state.y:Math.round(cy-h/2);
    return {...state,x:clamp(left,0,bounds.width-w),y:clamp(top,0,bounds.height-h),w,h};
  }
  left=Math.round(left);top=Math.round(top);
  return {...state,x:left,y:top,w:Math.max(1,Math.round(right)-left),h:Math.max(1,Math.round(bottom)-top)};
}

/** Fit a requested aspect ratio inside the selected area without expanding it. */
export function cropImageRatio(state,ratio) {
  if(!ratio)return {...state};
  const w=Math.max(1,Math.round(Math.min(state.w,state.h*ratio))),h=Math.max(1,Math.round(Math.min(state.h,state.w/ratio)));
  return {...state,x:state.x+Math.round((state.w-w)/2),y:state.y+Math.round((state.h-h)/2),w,h};
}

const svgNode=(document,tag)=>document.createElementNS('http://www.w3.org/2000/svg',tag);

/** Keep a live transform draft on the image; apply all changes as one undo step. */
export function createImageTransform(model,{viewport,surface,canvas,signal,getZoom,onChange,onError,isBusy}) {
  const document=viewport.ownerDocument,window=document.defaultView,bounds={width:model.width,height:model.height};
  let active=false,disposed=false,draft=model.state,drag=null,ratio=null,keepCenter=false;
  const pointers=new Set(),handles=new Map();
  const node=(tag,className,text)=>{const el=document.createElement(tag);if(className)el.className=className;if(text)el.textContent=text;return el;};
  const button=(text,action)=>{const el=node('button','',text);el.type='button';el.onclick=()=>{if(!isBusy() && !disposed){try{action();}catch(error){onError(error);}}};return el;};
  const field=(text,input)=>{const el=node('label','',text);input.setAttribute('aria-label',text);el.append(input);return el;};
  const controls=node('div','paint-transform-controls');controls.hidden=true;
  const actions=node('div','paint-transform-actions');
  const apply=button('Применить',()=>finish(true)),cancel=button('Отмена',()=>finish(false));apply.className='primary';
  const quarter=button('↻ 90°',()=>change({...draft,turns:(draft.turns+1)%4}));quarter.setAttribute('aria-label','Повернуть на 90°');
  const flipX=button('↔',()=>change({...draft,flipX:!draft.flipX})),flipY=button('↕',()=>change({...draft,flipY:!draft.flipY}));
  flipX.setAttribute('aria-label','Отразить по горизонтали');flipY.setAttribute('aria-label','Отразить по вертикали');
  const reset=button('Сбросить рамку',()=>{ratio=null;aspect.value='';change({x:0,y:0,w:model.width,h:model.height,turns:0});});reset.title='Вернуть обрезку, поворот и отражение; сохранить рисунки';
  actions.append(apply,cancel,quarter,flipX,flipY,reset);
  const angle=node('input');angle.type='range';angle.min=-180;angle.max=180;angle.step=.1;
  const angleField=field('Поворот, °',angle),angleOutput=node('output');angleField.append(angleOutput);
  angle.oninput=()=>change({...draft,turns:0,angle:Number(angle.value)});
  const aspect=node('select');
  for(const [value,text]of [['','Свободно'],['original','Исходные'],['1','1:1'],[String(4/3),'4:3'],[String(3/4),'3:4'],[String(16/9),'16:9'],[String(9/16),'9:16']]){
    const option=node('option','',text);option.value=value;aspect.append(option);
  }
  aspect.onchange=()=>{ratio=aspect.value==='original'?model.width/model.height:Number(aspect.value) || null;change(cropImageRatio(draft,ratio));};
  const exact=node('details','paint-transform-exact');exact.append(node('summary','','Размеры, px'));
  const numbers=node('div','paint-transform-numbers'),values={};
  for(const [key,title]of [['x','Слева, px'],['y','Сверху, px'],['w','Ширина, px'],['h','Высота, px']]){
    const input=node('input');input.type='number';input.min=['w','h'].includes(key)?1:0;input.step=1;values[key]=input;numbers.append(field(title,input));
    input.onchange=()=>{try{change({...draft,...Object.fromEntries(Object.entries(values).map(([name,control])=>[name,control.value===''?NaN:Number(control.value)]))});}catch(error){onError(error);refresh();}};
  }
  const dimensions=node('output','paint-transform-size');dimensions.setAttribute('aria-label','Размер области обрезки');
  exact.append(numbers);controls.append(actions,angleField,field('Пропорции',aspect),exact,dimensions);
  const overlay=node('div','paint-transform-overlay');overlay.hidden=true;surface.append(overlay);
  const svg=svgNode(document,'svg');svg.classList.add('paint-transform-svg');
  const shade=svgNode(document,'path'),grid=svgNode(document,'path'),frame=svgNode(document,'polygon');
  shade.classList.add('paint-transform-shade');shade.setAttribute('fill-rule','evenodd');
  grid.classList.add('paint-transform-grid');frame.classList.add('paint-transform-frame');
  frame.dataset.handle='move';frame.setAttribute('tabindex','0');frame.setAttribute('role','button');frame.setAttribute('aria-label','Переместить область обрезки');
  svg.append(shade,grid,frame);overlay.append(svg);
  for(const [key,title]of [['nw','Верхний левый угол'],['n','Верхняя граница'],['ne','Верхний правый угол'],['e','Правая граница'],['se','Нижний правый угол'],['s','Нижняя граница'],['sw','Нижний левый угол'],['w','Левая граница'],['rotate','Повернуть изображение']]){
    const el=node('button','paint-transform-handle');el.type='button';el.dataset.handle=key;el.dataset.direction=key;el.title=title;el.setAttribute('aria-label',title);handles.set(key,el);overlay.append(el);
    if(key==='rotate')el.textContent='↻';
  }
  function preview(){return active?{...draft,x:0,y:0,w:model.width,h:model.height}:model.state;}
  function pending(){return active && canonical(draft)!==canonical(model.state);}
  function refresh(){
    controls.hidden=overlay.hidden=!active;controls.inert=isBusy();overlay.inert=isBusy();
    for(const [key,input]of Object.entries(values))input.value=draft[key];
    dimensions.value=`${draft.w} × ${draft.h} px`;
    const degrees=normalizedAngle(draft.turns*90+(draft.angle || 0));angle.value=degrees;angleOutput.value=degrees.toFixed(1);
    flipX.setAttribute('aria-pressed',String(!!draft.flipX));flipY.setAttribute('aria-pressed',String(!!draft.flipY));
    if(!active)return;
    const state=preview(),size=imageGeometry(model.width,model.height,state),rect=canvas.getBoundingClientRect();
    overlay.style.left=canvas.offsetLeft+'px';overlay.style.top=canvas.offsetTop+'px';overlay.style.width=canvas.style.width;overlay.style.height=canvas.style.height;
    svg.setAttribute('viewBox',`0 0 ${size.width} ${size.height}`);
    const original={nw:{x:draft.x,y:draft.y},ne:{x:draft.x+draft.w,y:draft.y},se:{x:draft.x+draft.w,y:draft.y+draft.h},sw:{x:draft.x,y:draft.y+draft.h}};
    const points=Object.fromEntries(Object.entries(original).map(([key,point])=>[key,imagePreviewPoint(point,state)]));
    for(const [key,a,b]of [['n','nw','ne'],['e','ne','se'],['s','se','sw'],['w','sw','nw']])points[key]={x:(points[a].x+points[b].x)/2,y:(points[a].y+points[b].y)/2};
    const corners=['nw','ne','se','sw'].map(key=>points[key]);frame.setAttribute('points',corners.map(p=>`${p.x},${p.y}`).join(' '));
    shade.setAttribute('d',`M0,0H${size.width}V${size.height}H0Z M${corners.map(p=>`${p.x},${p.y}`).join('L')}Z`);
    let lines='';for(const t of [1/3,2/3])for(const [a,b,c,d]of [['nw','ne','sw','se'],['nw','sw','ne','se']]){
      const start={x:points[a].x+(points[b].x-points[a].x)*t,y:points[a].y+(points[b].y-points[a].y)*t};
      const end={x:points[c].x+(points[d].x-points[c].x)*t,y:points[c].y+(points[d].y-points[c].y)*t};lines+=`M${start.x},${start.y}L${end.x},${end.y}`;
    }grid.setAttribute('d',lines);
    const center={x:(points.nw.x+points.se.x)/2,y:(points.nw.y+points.se.y)/2},dx=points.n.x-center.x,dy=points.n.y-center.y,length=Math.hypot(dx,dy) || 1;
    const distance=40*size.width/(rect.width || parseFloat(canvas.style.width) || size.width);
    points.rotate={x:points.n.x+dx/length*distance,y:points.n.y+dy/length*distance};
    for(const [key,el]of handles){
      const point=points[key];el.style.left=point.x/size.width*100+'%';el.style.top=point.y/size.height*100+'%';el.style.setProperty('--handle-scale',String(1/getZoom()));
      if(key!=='rotate'){const direction=Math.round(Math.atan2(point.y-center.y,point.x-center.x)/(Math.PI/4));el.style.cursor=['ew-resize','nwse-resize','ns-resize','nesw-resize'][((direction%4)+4)%4];}
    }
  }
  function change(next){imageGeometry(model.width,model.height,next);if(active && normalizedAngle(draft.turns*90+(draft.angle || 0))!==normalizedAngle(next.turns*90+(next.angle || 0)))keepCenter=true;draft={...next};refresh();onChange();}
  function start(){if(disposed || isBusy())return;pointers.clear();keepCenter=false;draft=model.state;active=true;aspect.value='';ratio=null;refresh();onChange();}
  function finish(commit,force=false){
    if(disposed || (isBusy() && !force))return;cancelDrag();
    if(commit && pending()){imageGeometry(model.width,model.height,draft);model.set(draft);}
    active=false;keepCenter=false;pointers.clear();draft=model.state;refresh();onChange();
  }
  function cancelDrag(){if(drag){draft=drag.state;drag=null;refresh();onChange();}}
  function sourcePoint(event,state=preview(),rect=canvas.getBoundingClientRect()){
    const size=imageGeometry(model.width,model.height,state);
    return imagePoint({x:(event.clientX-rect.left)/rect.width*size.width,y:(event.clientY-rect.top)/rect.height*size.height},state,false);
  }
  function begin(event){
    const handle=event.target.closest('[data-handle]')?.dataset.handle;
    if(!handle || !active || disposed || isBusy() || event.button>0 || pointers.size>1)return;
    event.preventDefault();event.stopPropagation();const rect=canvas.getBoundingClientRect();if(!rect.width || !rect.height)return;
    const center={x:rect.left+rect.width/2,y:rect.top+rect.height/2};
    drag={id:event.pointerId,handle,state:{...draft},point:sourcePoint(event),preview:preview(),rect,center,angle:Math.atan2(event.clientY-center.y,event.clientX-center.x)};
    event.target.setPointerCapture?.(event.pointerId);event.target.focus?.({preventScroll:true});
  }
  function move(event){
    if(!drag || drag.id!==event.pointerId || disposed || isBusy())return;event.preventDefault();
    if(drag.handle==='rotate'){
      const difference=normalizedAngle((Math.atan2(event.clientY-drag.center.y,event.clientX-drag.center.x)-drag.angle)*180/Math.PI);
      const angle=normalizedAngle(drag.state.turns*90+(drag.state.angle || 0)+difference),step=event.shiftKey?15:.1;
      change({...drag.state,turns:0,angle:normalizedAngle(Math.round(angle/step)*step)});
    }else{
      const point=sourcePoint(event,drag.preview,drag.rect);
      change(dragImageCrop(drag.state,bounds,drag.handle,{x:point.x-drag.point.x,y:point.y-drag.point.y},ratio));
    }
  }
  const finishDrag=event=>{pointers.delete(event.pointerId);if(drag?.id===event.pointerId){if(event.type==='pointercancel')cancelDrag();else{move(event);drag=null;refresh();onChange();}}};
  const track=event=>{if(!active)return;pointers.add(event.pointerId);if(pointers.size>1)cancelDrag();};
  const lostCapture=event=>{if(drag?.id===event.pointerId)cancelDrag();};
  const keys=event=>{
    if(!active || disposed || isBusy() || event.ctrlKey || event.metaKey || event.altKey)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();finish(false);return;}
    const handle=event.target.closest('[data-handle]')?.dataset.handle;if(!handle)return;
    if(event.key==='Enter'){event.preventDefault();event.stopPropagation();finish(true);return;}
    const delta={ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0},ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1}}[event.key];if(!delta)return;
    event.preventDefault();event.stopPropagation();const step=event.shiftKey?10:1;
    if(handle==='rotate')change({...draft,turns:0,angle:normalizedAngle(draft.turns*90+(draft.angle || 0)+(delta.x || -delta.y)*(event.shiftKey?15:1))});
    else change(dragImageCrop(draft,bounds,handle,{x:delta.x*step,y:delta.y*step},ratio));
  };
  viewport.addEventListener('pointerdown',track,true);overlay.addEventListener('pointerdown',begin);
  overlay.addEventListener('lostpointercapture',lostCapture);
  viewport.addEventListener('keydown',keys);controls.addEventListener('keydown',keys);
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',finishDrag);window.addEventListener('pointercancel',finishDrag);
  const api={controls,start,cancel:()=>finish(false),apply:()=>finish(true),flush:()=>finish(true,true),cancelDrag,refresh,rendered:()=>{keepCenter=false;},get active(){return active;},get pending(){return pending();},get preview(){return preview();},get rotating(){return drag?.handle==='rotate' || keepCenter;},
    sync(){if(!active)draft=model.state;refresh();},
    dispose(){if(disposed)return;disposed=true;drag=null;pointers.clear();viewport.removeEventListener('pointerdown',track,true);overlay.removeEventListener('pointerdown',begin);overlay.removeEventListener('lostpointercapture',lostCapture);viewport.removeEventListener('keydown',keys);controls.removeEventListener('keydown',keys);window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finishDrag);window.removeEventListener('pointercancel',finishDrag);}
  };
  signal?.addEventListener('abort',()=>api.dispose(),{once:true});refresh();return api;
}

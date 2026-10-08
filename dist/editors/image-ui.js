import { bindZoomGestures, createVisualZoom, captureZoomAnchor } from '../gestures.js';
import { editingShortcut, shortcutCommand } from '../shortcuts.js';
import { hsvToHex, hexToHsv } from '../colors.js';
import { imageGeometry, imagePoint } from './image.js';
import { createImageTransform } from './image-transform.js';

const node = (tag, text, className) => { const el=document.createElement(tag);if(text!=null)el.textContent=text;if(className)el.className=className;return el; };
const button = text => { const el=node('button',text);el.type='button';return el; };
const label = (text, input) => { const el=node('label',text);input.setAttribute('aria-label',text);el.append(input);return el; };

/** Draw on the actual image with a vector annotation history and an HSV color picker. */
export function openImageUI(model, record, root, { signal, onSave, onClose, onError, onDirty, initialZoom=1 }) {
  let zoom=initialZoom,busy=false,disposed=false,tool='brush',paintOpacity=100,draft=null,activePointer=null,palettePointer=null,frame=0,api,transforms;
  let color={hue:200,saturation:90,brightness:100};const pointers=new Set();
  const panel=node('div',null,'editor-panel image-editor'),bar=node('div',null,'editor-bar');
  const undo=button('Отменить'),redo=button('Повторить'),save=button('Сохранить копию'),close=button('К просмотру'),status=node('span','','editor-status');
  status.setAttribute('role','status');save.className='primary';bar.append(undo,redo,save,close,status);
  const tools=node('div',null,'paint-tools'),main=node('div',null,'paint-main-tools'),choices=new Map();
  tools.setAttribute('aria-label','Инструменты рисования');
  for(const [control,title,symbol] of [[undo,'Отменить','↶'],[redo,'Повторить','↷']]){control.textContent=symbol;control.title=title;control.setAttribute('aria-label',title);control.className='paint-history';}
  for(const [key,title] of [['brush','Кисть'],['eraser','Ластик'],['rectangle','Выделение']]){
    const b=button(title);b.dataset.tool=key;b.setAttribute('aria-pressed',String(key===tool));
    b.title=key==='eraser'?'Стереть рисунок, сохранив исходное изображение':key==='rectangle'?'Закрашенный прямоугольник со скруглёнными углами':'Рисовать кистью';
    b.onclick=()=>{if(busy)return;
      if(transforms?.active)transforms.flush();
      if(tool!=='eraser')paintOpacity=Number(opacity.input.value);
      tool=key;cancelStroke();opacity.input.disabled=tool==='eraser';
      opacity.input.value=tool==='eraser'?100:paintOpacity;opacity.output.value=opacity.input.value;
      opacity.field.title=tool==='eraser'?'Ластик полностью удаляет кисть и выделения':'';
      for(const [name,choice]of choices)choice.setAttribute('aria-pressed',String(name===tool));
    };choices.set(key,b);main.append(b);
  }
  function slider(title,min,max,value){const input=node('input');input.type='range';input.min=min;input.max=max;input.value=value;const output=node('output',value);const field=label(title,input);field.append(output);input.addEventListener('input',()=>{output.value=input.value;});return {input,field,output};}
  main.append(undo,redo);
  const size=slider('Размер, px',1,400,24),opacity=slider('Непрозрачность, %',0,100,100);main.append(size.field,opacity.field);
  const options=node('details',null,'paint-options');
  const summary=node('summary','Цвет'),colorChip=node('span',null,'paint-color-chip');summary.append(colorChip);options.append(summary);
  const settings=node('div',null,'paint-settings'),picker=node('div',null,'paint-picker'),palette=node('canvas',null,'paint-palette');palette.width=220;palette.height=128;
  palette.tabIndex=0;palette.setAttribute('role','slider');palette.setAttribute('aria-label','Палитра: насыщенность и яркость');palette.setAttribute('aria-valuemin','0');palette.setAttribute('aria-valuemax','100');
  const hue=slider('Оттенок',0,360,200),saturation=slider('Насыщенность, %',0,100,90),brightness=slider('Яркость, %',0,100,100);
  hue.input.className='paint-hue';const hex=node('input');hex.type='text';hex.maxLength=7;hex.value=hsvToHex(color.hue,color.saturation,color.brightness);
  const hexField=label('Цвет HEX',hex),swatches=node('div',null,'paint-swatches');
  for(const value of ['#ffffff','#000000','#ff3030','#ff8000','#ffff00','#80ff00','#00d080','#00ffff','#008cff','#3030ff','#8000ff','#ff00ff','#ff4090','#805030','#808080','#d0d0d0']){
    const b=button('');b.className='paint-swatch';b.style.background=value;b.title=value;b.setAttribute('aria-label','Цвет '+value);b.onclick=()=>{color=hexToHsv(value);updateColor();};swatches.append(b);
  }
  swatches.setAttribute('aria-label','Таблица цветов');
  picker.append(palette,hue.field);const parameters=node('div',null,'paint-parameters');
  const radius=slider('Скругление, px',0,200,16);parameters.append(saturation.field,brightness.field,hexField,radius.field);settings.append(picker,parameters);options.append(settings);
  const crop=button('Обрезать / повернуть');crop.className='paint-transform-toggle';crop.setAttribute('aria-pressed','false');
  const colorRow=node('div',null,'paint-color-row');colorRow.append(swatches,options,crop);tools.append(main,colorRow);
  const viewport=node('div',null,'paint-viewport'),surface=node('div',null,'paint-image-surface'),canvas=node('canvas',null,'paint-canvas');
  canvas.tabIndex=0;canvas.setAttribute('aria-label','Изображение: рисование кистью, ластиком или выделением');surface.append(canvas);viewport.append(surface);panel.append(bar,tools,viewport);root.replaceChildren(panel);
  const visual=createVisualZoom(viewport,surface,{signal,center:true,fixedWidth:false});visual.refresh();
  transforms=createImageTransform(model,{viewport,surface,canvas,signal,getZoom:()=>zoom,isBusy:()=>busy,onError,onChange:()=>{schedule();update();}});
  tools.append(transforms.controls);
  const pending=()=>transforms.pending;
  const flush=()=>{if(transforms.active)transforms.flush();};
  const run=action=>async()=>{if(busy || disposed)return;try{await action();}catch(error){onError(error);}};
  function update(){if(disposed)return;undo.disabled=busy || !(model.history.done.length || pending());redo.disabled=busy || !model.history.future.length || pending();save.disabled=busy || !(model.history.dirty || pending());close.disabled=busy;
    main.hidden=colorRow.hidden=transforms.active;tools.classList.toggle('transform-active',transforms.active);crop.setAttribute('aria-pressed',String(transforms.active));canvas.style.touchAction=transforms.active?'pan-x pan-y':'none';transforms.refresh();
    tools.inert=busy;status.textContent=busy?'Подготавливаем…':model.history.dirty || pending()?'Есть несохранённые изменения':'Изменений нет';onDirty?.(model.history.dirty || pending());}
  function updateColor(){
    const value=hsvToHex(color.hue,color.saturation,color.brightness);hex.value=value;colorChip.style.background=value;
    for(const [control,name]of [[hue,'hue'],[saturation,'saturation'],[brightness,'brightness']]){control.input.value=Math.round(color[name]);control.output.value=control.input.value;}
    palette.setAttribute('aria-valuenow',String(Math.round(color.saturation)));palette.setAttribute('aria-valuetext',`Насыщенность ${Math.round(color.saturation)}%, яркость ${Math.round(color.brightness)}%`);
    const context=palette.getContext('2d');if(!context)throw new Error('Цветовая палитра недоступна.');
    const horizontal=context.createLinearGradient(0,0,palette.width,0);horizontal.addColorStop(0,'#ffffff');horizontal.addColorStop(1,hsvToHex(color.hue,100,100));context.fillStyle=horizontal;context.fillRect(0,0,palette.width,palette.height);
    const vertical=context.createLinearGradient(0,0,0,palette.height);vertical.addColorStop(0,'#00000000');vertical.addColorStop(1,'#000000');context.fillStyle=vertical;context.fillRect(0,0,palette.width,palette.height);
    const x=color.saturation/100*palette.width,y=(1-color.brightness/100)*palette.height;context.beginPath();context.arc(x,y,5,0,Math.PI*2);context.lineWidth=3;context.strokeStyle='#000000';context.stroke();context.lineWidth=1.5;context.strokeStyle='#ffffff';context.stroke();
  }
  for(const [control,name]of [[hue,'hue'],[saturation,'saturation'],[brightness,'brightness']])control.input.addEventListener('input',()=>{color[name]=Number(control.input.value);updateColor();});
  hex.onchange=()=>{try{color=hexToHsv(hex.value);updateColor();}catch(error){onError(error);}};
  const pick=event=>{if(busy)return;const rect=palette.getBoundingClientRect();if(!rect.width || !rect.height)return;color.saturation=Math.max(0,Math.min(100,(event.clientX-rect.left)/rect.width*100));color.brightness=Math.max(0,Math.min(100,100-(event.clientY-rect.top)/rect.height*100));updateColor();};
  palette.addEventListener('pointerdown',event=>{if(busy || event.button>0)return;event.preventDefault();palettePointer=event.pointerId;palette.setPointerCapture?.(event.pointerId);pick(event);});
  palette.addEventListener('pointermove',event=>{if(palettePointer===event.pointerId)pick(event);});
  for(const type of ['pointerup','pointercancel'])palette.addEventListener(type,()=>{palettePointer=null;});
  palette.onkeydown=event=>{if(busy)return;const delta=event.shiftKey?10:1;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();color.saturation=Math.max(0,Math.min(100,color.saturation+(event.key==='ArrowRight'?delta:event.key==='ArrowLeft'?-delta:0)));color.brightness=Math.max(0,Math.min(100,color.brightness+(event.key==='ArrowUp'?delta:event.key==='ArrowDown'?-delta:0)));updateColor();}};
  function render(){
    frame=0;if(disposed)return;const preview=transforms.preview,dims=imageGeometry(model.width,model.height,preview);
    const before=canvas.getBoundingClientRect(),origin=viewport.getBoundingClientRect();
    const keepCenter=transforms.rotating?captureZoomAnchor(()=>[canvas],viewport,{x:before.left+before.width/2-origin.left,y:before.top+before.height/2-origin.top}):()=>{};
    panel.style.setProperty('--paint-bar-height',`${bar.offsetHeight || 56}px`);
    const bounds=viewport.getBoundingClientRect();
    const availableWidth=Math.max(1,bounds.width || viewport.clientWidth || root.clientWidth || innerWidth),availableHeight=Math.max(1,bounds.height || viewport.clientHeight || root.clientHeight || innerHeight);
    const insetX=transforms.active?64:0,insetTop=transforms.active?(bar.offsetHeight || 56)+(tools.offsetHeight || 110)+24:0,insetBottom=transforms.active?64:0;
    const fit=Math.min(Math.max(1,availableWidth-insetX*2)/dims.width,Math.max(1,availableHeight-insetTop-insetBottom)/dims.height);
    const maxSide=Math.min(2400,Math.max(dims.width,dims.height)*fit*zoom*(devicePixelRatio || 1));
    model.draw(canvas,maxSide,draft,preview);canvas.style.width=dims.width*fit+'px';canvas.style.height=dims.height*fit+'px';
    canvas.style.left=insetX+'px';canvas.style.top=insetTop+'px';surface.style.width=dims.width*fit+insetX*2+'px';surface.style.height=dims.height*fit+insetTop+insetBottom+'px';
    visual.refresh();keepCenter();transforms.refresh();transforms.rendered();
  }
  function schedule(){if(!frame && !disposed)frame=requestAnimationFrame(render);}
  function cancelStroke(){draft=null;activePointer=null;schedule();}
  function point(event,clamp=true){const rect=canvas.getBoundingClientRect(),dims=imageGeometry(model.width,model.height,model.state);return imagePoint({x:(event.clientX-rect.left)/rect.width*dims.width,y:(event.clientY-rect.top)/rect.height*dims.height},model.state,clamp);}
  function start(event){
    if(disposed || busy || transforms.active || event.button>0)return;pointers.add(event.pointerId);if(pointers.size>1){canvas.setPointerCapture?.(event.pointerId);cancelStroke();return;}
    options.open=false;
    try{if(pending()){flush();render();}const raw=point(event,false),state=model.state;
      if(raw.x<state.x-1e-6 || raw.y<state.y-1e-6 || raw.x>state.x+state.w+1e-6 || raw.y>state.y+state.h+1e-6)return;
      const p=point(event);activePointer=event.pointerId;
      const common={type:tool,color:hsvToHex(color.hue,color.saturation,color.brightness),opacity:tool==='eraser'?1:Number(opacity.input.value)/100};
      draft=tool==='rectangle'?{...common,x:p.x,y:p.y,w:0,h:0,radius:Number(radius.input.value),origin:p}:{...common,width:Number(size.input.value),points:[p]};
      canvas.setPointerCapture?.(event.pointerId);canvas.focus({preventScroll:true});event.preventDefault();schedule();
    }catch(error){cancelStroke();onError(error);}
  }
  function move(event){
    if(disposed || busy || activePointer!==event.pointerId || !draft || pointers.size!==1)return;event.preventDefault();
    const p=point(event);
    if(draft.type==='rectangle'){draft.x=Math.min(p.x,draft.origin.x);draft.y=Math.min(p.y,draft.origin.y);draft.w=Math.abs(p.x-draft.origin.x);draft.h=Math.abs(p.y-draft.origin.y);}
    else{const previous=draft.points.at(-1);if(Math.hypot(p.x-previous.x,p.y-previous.y)<.5)return;if(draft.points.length>=20000)draft.points=draft.points.filter((_,i)=>i%2===0);draft.points.push(p);}schedule();
  }
  function end(event){
    if(disposed)return;
    if(activePointer===event.pointerId && draft){move(event);const mark=draft;draft=null;activePointer=null;
      if(!busy && (mark.type!=='rectangle' || mark.w>=1 && mark.h>=1)){delete mark.origin;try{model.addMark(mark);}catch(error){onError(error);}}
      schedule();
    }
    pointers.delete(event.pointerId);
  }
  canvas.addEventListener('pointerdown',start);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',end);
  canvas.addEventListener('pointercancel',event=>{pointers.delete(event.pointerId);cancelStroke();});
  canvas.addEventListener('lostpointercapture',event=>{pointers.delete(event.pointerId);if(activePointer===event.pointerId)cancelStroke();});
  const cancelPointer=event=>{pointers.delete(event.pointerId);if(activePointer===event.pointerId)cancelStroke();};
  const window=root.ownerDocument.defaultView;
  window.addEventListener('pointerup',end);window.addEventListener('pointercancel',cancelPointer);
  function setZoom(value,anchor){cancelStroke();transforms.cancelDrag();zoom=Math.max(.5,Math.min(3,value));visual.setZoom(zoom,anchor);render();}
  const gestures=bindZoomGestures(viewport,{signal,getZoom:()=>zoom,setZoom,onError});
  const observer=new ResizeObserver(schedule);observer.observe(viewport);observer.observe(bar);
  window.addEventListener('omni-layout-change',schedule);
  model.history.onChange=()=>{transforms.sync();schedule();update();};
  undo.onclick=run(()=>{cancelStroke();const wasPending=pending();if(transforms.active)transforms.cancel();if(!wasPending)model.history.undo();});redo.onclick=run(()=>{cancelStroke();if(transforms.active)transforms.cancel();model.history.redo();});
  crop.onclick=run(()=>{cancelStroke();options.open=false;if(transforms.active)transforms.cancel();else transforms.start();});
  save.onclick=run(()=>onSave(api));close.onclick=run(onClose);
  panel.addEventListener('keydown',event=>{
    const action=editingShortcut(event);if(action){event.preventDefault();({save,undo,redo})[action].click();return;}
    if(event.target.closest('input,textarea,select'))return;
    const selected=shortcutCommand(event);if(choices.has(selected)){event.preventDefault();choices.get(selected).click();}
  });
  api={get position(){return {zoom};},get dirty(){return model.history.dirty || pending() || !!draft;},get busy(){return busy;},
    async export(){if(draft)throw new Error('Завершите штрих перед сохранением.');flush();return model.export();},
    setBusy(value){busy=!!value;if(busy){cancelStroke();transforms.cancelDrag();}update();},adjustZoom:delta=>setZoom(delta===null?1:zoom+delta),
    toggleTools(){tools.hidden=!tools.hidden;schedule();},
    dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(frame);gestures.dispose();transforms.dispose();observer.disconnect();window.removeEventListener('omni-layout-change',schedule);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',cancelPointer);canvas.width=canvas.height=palette.width=palette.height=0;model.dispose();}
  };
  signal.addEventListener('abort',()=>api.dispose(),{once:true});if(signal.aborted){api.dispose();throw new DOMException('Aborted','AbortError');}
  updateColor();render();visual.setZoom(zoom);update();return api;
}

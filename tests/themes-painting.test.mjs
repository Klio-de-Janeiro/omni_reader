import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import {hsvToHex,hexToHsv} from '../dist/colors.js';
import {initThemes,themeSettings,documentTheme} from '../dist/themes.js';
import {isFullscreenShortcut,isThemeShortcut,editingShortcut} from '../dist/shortcuts.js';
import {createImageModel,imagePoint,imageGeometry,imagePreviewPoint} from '../dist/editors/image.js';
import {dragImageCrop,cropImageRatio} from '../dist/editors/image-transform.js';
import {openImageUI} from '../dist/editors/image-ui.js';
let backend;
try{backend=await import('@napi-rs/canvas');}catch{
  if(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES)try{backend=await import(pathToFileURL(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/@napi-rs/canvas/index.js').href);}catch{}
}

test('Three themes cycle, follow OS changes and preserve validated neon preferences',async()=>{
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  const w=new JSDOM(html,{url:'https://omni.test'}).window,media={matches:true,addEventListener(type,callback){this.changed=callback;}};w.matchMedia=()=>media;
  try{
    const theme=initThemes(w.document);assert.equal(theme.settings.mode,'neon');
    theme.cycle();assert.equal(theme.settings.mode,'normal');assert.equal(w.document.documentElement.style.colorScheme,'light');
    theme.cycle();assert.equal(theme.settings.mode,'system');assert.equal(documentTheme(w.document).dark,true);
    media.matches=false;media.changed();assert.equal(documentTheme(w.document).dark,false);
    theme.cycle();const hue=w.document.querySelector('#theme-hue');hue.value=285;hue.dispatchEvent(new w.Event('input'));
    const glow=w.document.querySelector('#theme-glow');glow.checked=false;glow.dispatchEvent(new w.Event('change'));
    assert.equal(w.document.documentElement.style.getPropertyValue('--theme-glow'),'none');
    assert.equal(theme.settings.hue,285);assert.equal(JSON.parse(w.localStorage.getItem('omni.theme.v1')).glow,false);
    assert.equal(initThemes(w.document).settings.hue,285);
    assert.equal(themeSettings({mode:'injected',hue:1000,radius:-8,brightness:NaN}).hue,360);
    assert.equal(themeSettings({radius:-8}).radius,0);
  }finally{w.close();}
});
test('Ctrl+X changes theme, Ctrl+Z changes fullscreen and Ctrl+Alt+Z remains undo in any layout',()=>{
  assert.equal(isThemeShortcut({ctrlKey:true,code:'KeyX',key:'ч'}),true);
  assert.equal(isFullscreenShortcut({ctrlKey:true,code:'KeyX',key:'x'}),false);
  assert.equal(isFullscreenShortcut({ctrlKey:true,code:'KeyZ',key:'я'}),true);
  assert.equal(isFullscreenShortcut({ctrlKey:true,altKey:true,code:'KeyZ'}),false);
  assert.equal(editingShortcut({ctrlKey:true,altKey:true,code:'KeyZ',key:'я'}),'undo');
  assert.equal(editingShortcut({ctrlKey:true,code:'KeyZ'}),null);
  assert.equal(editingShortcut({ctrlKey:true,shiftKey:true,code:'KeyZ'}),'redo');
  assert.equal(editingShortcut({ctrlKey:true,code:'KeyY'}),'redo');
});
test('Android system theme reads the OS setting without recreating the document',()=>{
  const w=new JSDOM('',{url:'https://omni.test'}).window;let dark=false;
  Object.defineProperty(w.navigator,'userAgent',{value:'OmniAndroid/0.3.0'});
  w.matchMedia=()=>({matches:true});w.prompt=(message,data)=>{assert.equal(message,'OMNI_NATIVE');assert.equal(JSON.parse(data).action,'system-theme');return JSON.stringify({dark});};
  w.localStorage.setItem('omni.theme.v1',JSON.stringify({mode:'system'}));
  try{initThemes(w.document);assert.equal(documentTheme(w.document).dark,false);dark=true;w.dispatchEvent(new w.Event('omni-system-theme'));assert.equal(documentTheme(w.document).dark,true);}finally{w.close();}
});
test('HSV picker includes hue, saturation, brightness and exact RGB round trips',()=>{
  assert.equal(hsvToHex(0,100,100),'#ff0000');assert.equal(hsvToHex(120,100,100),'#00ff00');assert.equal(hsvToHex(240,100,100),'#0000ff');
  assert.equal(hsvToHex(360,0,100),'#ffffff');assert.equal(hsvToHex(60,100,0),'#000000');
  for(const hex of ['#4c8df2','#c724b0','#808080','#ffffff','#000000']){const hsv=hexToHsv(hex);assert.equal(hsvToHex(hsv.hue,hsv.saturation,hsv.brightness),hex);}
  assert.throws(()=>hexToHsv('red'),/RRGGBB/);
});
test('Rotated/cropped preview points map to the same original image pixels',()=>{
  const state={x:20,y:30,w:300,h:200,turns:0};
  assert.deepEqual(imagePoint({x:30,y:40},state),{x:50,y:70});
  for(const turns of [1,2,3]){
    const p=imagePoint({x:turns%2?100:150,y:turns%2?150:100},{...state,turns});
    assert.ok(Math.abs(p.x-170)<1e-9 && Math.abs(p.y-130)<1e-9);
  }
});

test('Moving and all eight crop handles preserve pixel bounds, opposite edges and aspect ratios',()=>{
  const state={x:20,y:30,w:160,h:100,turns:0},bounds={width:240,height:180};
  assert.deepEqual(dragImageCrop(state,bounds,'nw',{x:10,y:20}),{...state,x:30,y:50,w:150,h:80});
  assert.deepEqual(dragImageCrop(state,bounds,'move',{x:-1000,y:1000}),{...state,x:0,y:80});
  assert.deepEqual(dragImageCrop(state,bounds,'e',{x:1000,y:0}),{...state,w:220});
  assert.deepEqual(cropImageRatio(state,1),{...state,x:50,w:100});
  for(const handle of ['n','ne','e','se','s','sw','w','nw'])for(const ratio of [null,1,16/9,9/16])for(const delta of [{x:40,y:20},{x:-1000,y:1000},{x:1000,y:-1000}]){
    const next=dragImageCrop(state,bounds,handle,delta,ratio);assert.doesNotThrow(()=>imageGeometry(bounds.width,bounds.height,next));
    if(ratio)assert.ok(Math.abs(next.w-next.h*ratio)<=1+ratio);
    if(!ratio){if(handle.includes('w'))assert.equal(next.x+next.w,state.x+state.w);if(handle.includes('n'))assert.equal(next.y+next.h,state.y+state.h);}
  }
});

test('Arbitrary rotations and mirrors map drawing and crop handles back to the same original pixels',()=>{
  for(const turns of [0,1,2,3])for(const angle of [-180,-135,-22.5,0,17,90,180])for(const flipX of [false,true])for(const flipY of [false,true]){
    const state={x:3,y:5,w:40,h:30,turns,angle,flipX,flipY};
    for(const point of [{x:3,y:5},{x:22.5,y:19},{x:43,y:35}]){
      const original=imagePoint(imagePreviewPoint(point,state),state,false);assert.ok(Math.abs(original.x-point.x)<1e-8);assert.ok(Math.abs(original.y-point.y)<1e-8);
    }
  }
  assert.throws(()=>imageGeometry(40,30,{x:0,y:0,w:40,h:30,turns:0,angle:NaN}));
  assert.throws(()=>imageGeometry(40,30,{x:0,y:0,w:40,h:30,turns:0,flipX:'true'}));
});
const raster=()=>{const c=backend.createCanvas(40,30),ctx=c.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,40,30);return c;};
const pixel=(canvas,x,y)=>Array.from(canvas.getContext('2d').getImageData(x,y,1,1).data);
test('Actual brush opacity and eraser pixels preserve the photo, with undo and redo',{skip:!backend},()=>{
  const model=createImageModel(raster(),'drawing.png',()=>backend.createCanvas(1,1)),out=backend.createCanvas(1,1);
  model.addMark({type:'brush',color:'#ff0000',opacity:.5,width:8,points:[{x:5,y:15},{x:35,y:15}]});model.draw(out);
  assert.deepEqual(pixel(out,20,15),[255,128,128,255]);
  model.addMark({type:'eraser',color:'#000000',opacity:1,width:8,points:[{x:20,y:15}]});model.draw(out);assert.deepEqual(pixel(out,20,15),[255,255,255,255]);
  model.history.undo();model.draw(out);assert.deepEqual(pixel(out,20,15),[255,128,128,255]);
  model.history.redo();model.draw(out);assert.deepEqual(pixel(out,20,15),[255,255,255,255]);
});
test('One eraser stroke removes overlapping brush and fills at every opacity, including zero, in preview and PNG export',{skip:!backend},async()=>{
  for(const opacity of [.01,.29,.5,1])for(const eraserOpacity of [0,.01,.29,1]){
    const model=createImageModel(raster(),'drawing.png',()=>backend.createCanvas(1,1)),out=backend.createCanvas(1,1);
    model.addMark({type:'rectangle',color:'#0000ff',opacity,x:4,y:4,w:30,h:22,radius:3});
    model.addMark({type:'brush',color:'#ff0000',opacity,width:10,points:[{x:6,y:15},{x:34,y:15}]});
    model.draw(out);const painted=pixel(out,20,15);assert.notDeepEqual(painted,[255,255,255,255]);
    model.addMark({type:'eraser',color:'#000000',opacity:eraserOpacity,width:10,points:[{x:20,y:15}]});
    assert.equal(model.markCount,3);model.draw(out);assert.deepEqual(pixel(out,20,15),[255,255,255,255]);
    assert.notDeepEqual(pixel(out,8,15),[255,255,255,255]);
    model.history.undo();model.draw(out);assert.deepEqual(pixel(out,20,15),painted);
    model.history.redo();const encoded=await model.export(),decoded=await backend.loadImage(Buffer.from(encoded));
    const saved=backend.createCanvas(40,30);saved.getContext('2d').drawImage(decoded,0,0);assert.deepEqual(pixel(saved,20,15),[255,255,255,255]);model.dispose();
  }
});
test('Rounded fill, crop and rotation survive real PNG and JPEG encoding',{skip:!backend},async()=>{
  for(const ext of ['png','jpg']){
    const model=createImageModel(raster(),'drawing.'+ext,()=>backend.createCanvas(1,1));
    model.addMark({type:'rectangle',color:'#0000ff',opacity:1,x:4,y:4,w:24,h:18,radius:6});
    const before=backend.createCanvas(1,1);model.draw(before);assert.deepEqual(pixel(before,4,4),[255,255,255,255]);assert.deepEqual(pixel(before,12,12),[0,0,255,255]);
    model.set({x:4,y:4,w:24,h:18,turns:1});
    const data=await model.export(),image=await backend.loadImage(Buffer.from(data));assert.equal(image.width,18);assert.equal(image.height,24);
    const decoded=backend.createCanvas(image.width,image.height);decoded.getContext('2d').drawImage(image,0,0);const color=pixel(decoded,9,12);
    assert.ok(color[2]>235 && color[0]<20 && color[1]<20);assert.equal(model.markCount,1);
    model.history.undo();assert.equal(model.state.turns,0);
  }
});

test('Free rotation, mirror and crop export actual pixels with transparent PNG or white JPEG corners',{skip:!backend},async()=>{
  const source=backend.createCanvas(6,4),ctx=source.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,3,4);ctx.fillStyle='#0000ff';ctx.fillRect(3,0,3,4);
  for(const ext of ['png','jpg']){
    const model=createImageModel(source,'image.'+ext,()=>backend.createCanvas(1,1));
    model.addMark({type:'rectangle',color:'#00ff00',opacity:1,x:0,y:1,w:2,h:2,radius:0});
    const state={x:1,y:0,w:4,h:4,turns:0,angle:90,flipX:true};model.set(state);
    const out=backend.createCanvas(1,1);model.draw(out);assert.deepEqual(pixel(out,2,3),[0,255,0,255]);
    const count=model.history.done.length;model.draw(out,Infinity,null,{...state,x:0,y:0,w:6,h:4,angle:33});
    assert.equal(model.history.done.length,count);assert.deepEqual(model.state,state);
    model.set({x:0,y:0,w:6,h:4,turns:0,angle:33});
    model.draw(out);if(ext==='jpg')assert.deepEqual(pixel(out,0,0),[255,255,255,255]);
    const data=await model.export(),image=await backend.loadImage(Buffer.from(data)),size=imageGeometry(6,4,model.state);
    assert.equal(image.width,size.width);assert.equal(image.height,size.height);
    const decoded=backend.createCanvas(size.width,size.height);decoded.getContext('2d').drawImage(image,0,0);
    if(ext==='png')assert.equal(pixel(decoded,0,0)[3],0);else assert.ok(pixel(decoded,0,0).slice(0,3).every(value=>value>235));
    model.history.undo();assert.deepEqual(model.state,state);model.history.redo();assert.equal(model.state.angle,33);model.dispose();
  }
});

test('Annotations outside a rotated crop cannot leak into its transparent corners',{skip:!backend},async()=>{
  const model=createImageModel(raster(),'image.png',()=>backend.createCanvas(1,1));
  model.addMark({type:'rectangle',color:'#00ff00',opacity:1,x:0,y:0,w:40,h:30,radius:0});
  model.set({x:5,y:5,w:20,h:10,turns:0,angle:33});
  const out=backend.createCanvas(1,1);model.draw(out);assert.equal(pixel(out,0,0)[3],0);
  const image=await backend.loadImage(Buffer.from(await model.export())),decoded=backend.createCanvas(image.width,image.height);decoded.getContext('2d').drawImage(image,0,0);
  assert.equal(pixel(decoded,0,0)[3],0);assert.deepEqual(pixel(decoded,Math.floor(image.width/2),Math.floor(image.height/2)),[0,255,0,255]);
});

function transformUIFixture(){
  const w=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true}).window,old=new Map();
  for(const [key,value]of Object.entries({window:w,document:w.document,innerWidth:800,innerHeight:600,devicePixelRatio:1,requestAnimationFrame:w.requestAnimationFrame.bind(w),cancelAnimationFrame:w.cancelAnimationFrame.bind(w),ResizeObserver:class{observe(){}disconnect(){}}})){
    old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const rasters=new WeakMap(),proto=w.HTMLCanvasElement.prototype;
  for(const name of ['width','height']){const descriptor=Object.getOwnPropertyDescriptor(proto,name);Object.defineProperty(proto,name,{...descriptor,set(value){descriptor.set.call(this,value);if(rasters.has(this))rasters.get(this)[name]=descriptor.get.call(this);}});}
  const actual=node=>{if(!rasters.has(node))rasters.set(node,backend.createCanvas(node.width,node.height));return rasters.get(node);};
  proto.getContext=function(){const ctx=actual(this).getContext('2d');return new Proxy(ctx,{get(target,key){if(key==='drawImage')return (source,...args)=>target.drawImage(source instanceof w.HTMLCanvasElement?actual(source):source,...args);const value=target[key];return typeof value==='function'?value.bind(target):value;},set(target,key,value){target[key]=value;return true;}});};
  const root=w.document.querySelector('#root');Object.defineProperties(root,{clientWidth:{value:800},clientHeight:{value:600}});
  const model=createImageModel(raster(),'image.png',()=>backend.createCanvas(1,1)),controller=new AbortController();
  model.addMark({type:'brush',color:'#ff0000',opacity:.5,width:3,points:[{x:20,y:15}]});
  const api=openImageUI(model,{name:'image.png'},root,{signal:controller.signal,onSave(){},onClose(){},onError:assert.fail});
  const viewport=root.querySelector('.paint-viewport'),surface=root.querySelector('.paint-image-surface'),canvas=root.querySelector('.paint-canvas');
  Object.defineProperties(viewport,{clientWidth:{value:800},clientHeight:{value:600}});viewport.getBoundingClientRect=()=>({left:0,top:0,width:800,height:600});
  const zoom=()=>api.position.zoom;
  Object.defineProperties(surface,{offsetWidth:{get:()=>parseFloat(surface.style.width)},offsetHeight:{get:()=>parseFloat(surface.style.height)}});
  surface.getBoundingClientRect=()=>{const left=(parseFloat(surface.style.left) || 0)-viewport.scrollLeft,top=(parseFloat(surface.style.top) || 0)-viewport.scrollTop,width=parseFloat(surface.style.width)*zoom(),height=parseFloat(surface.style.height)*zoom();return {left,top,width,height,right:left+width,bottom:top+height};};
  Object.defineProperties(canvas,{offsetLeft:{get:()=>parseFloat(canvas.style.left) || 0},offsetTop:{get:()=>parseFloat(canvas.style.top) || 0}});
  canvas.getBoundingClientRect=()=>{const surfaceRect=surface.getBoundingClientRect(),left=surfaceRect.left+canvas.offsetLeft*zoom(),top=surfaceRect.top+canvas.offsetTop*zoom(),width=parseFloat(canvas.style.width)*zoom(),height=parseFloat(canvas.style.height)*zoom();return {left,top,width,height,right:left+width,bottom:top+height};};
  const fire=(target,type,x,y,id=1)=>{const event=new w.MouseEvent(type,{clientX:x,clientY:y,button:0,bubbles:true,cancelable:true});Object.defineProperty(event,'pointerId',{value:id});target.dispatchEvent(event);};
  const frame=()=>new Promise(resolve=>w.requestAnimationFrame(resolve));
  const value=label=>Number(root.querySelector(`[aria-label="${label}"]`).value);
  return {w,root,model,api,viewport,canvas,fire,frame,value,close(){controller.abort();w.close();for(const [key,descriptor]of old)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}};
}

test('Interactive crop, move and rotation at 200% save once, retain annotations and support undo/redo',{skip:!backend},async()=>{
  const f=transformUIFixture();
  try{
    f.api.adjustZoom(1);f.root.querySelector('.paint-transform-toggle').click();await f.frame();
    let rect=f.canvas.getBoundingClientRect();const corner=f.root.querySelector('[data-handle="nw"]');
    f.fire(corner,'pointerdown',rect.left,rect.top);f.fire(f.w,'pointermove',rect.left+rect.width*.2,rect.top+rect.height*.2);f.fire(f.w,'pointerup',rect.left+rect.width*.2,rect.top+rect.height*.2);
    assert.equal(f.value('Слева, px'),8);assert.equal(f.value('Сверху, px'),6);assert.equal(f.value('Ширина, px'),32);assert.equal(f.value('Высота, px'),24);
    assert.deepEqual(f.model.state,{x:0,y:0,w:40,h:30,turns:0});assert.equal(f.model.history.done.length,1);
    const move=f.root.querySelector('[data-handle="move"]');rect=f.canvas.getBoundingClientRect();const x=rect.left+rect.width*.6,y=rect.top+rect.height*.6;
    f.fire(move,'pointerdown',x,y);f.fire(f.w,'pointermove',x-rect.width*.1,y-rect.height*.1);f.fire(f.w,'pointerup',x-rect.width*.1,y-rect.height*.1);
    assert.equal(f.value('Слева, px'),4);assert.equal(f.value('Сверху, px'),3);
    const rotate=f.root.querySelector('[data-handle="rotate"]'),cx=rect.left+rect.width/2,cy=rect.top+rect.height/2;
    f.fire(rotate,'pointerdown',cx,cy-100);f.fire(f.w,'pointermove',cx+100,cy);f.fire(f.w,'pointerup',cx+100,cy);
    assert.equal(f.value('Поворот, °'),90);assert.equal(f.model.state.turns,0);assert.equal(f.model.markCount,1);
    f.api.setBusy(true);const exported=await f.api.export();f.api.setBusy(false);
    assert.equal(f.model.history.done.length,2);assert.equal(f.model.state.angle,90);
    const decoded=await backend.loadImage(Buffer.from(exported));assert.equal(decoded.width,24);assert.equal(decoded.height,32);
    f.root.querySelector('[aria-label="Отменить"]').click();assert.deepEqual(f.model.state,{x:0,y:0,w:40,h:30,turns:0});assert.equal(f.model.markCount,1);
    f.root.querySelector('[aria-label="Повторить"]').click();assert.equal(f.model.state.angle,90);assert.equal(f.model.state.x,4);
  }finally{f.close();}
});

test('Cancel, pointer cancellation and two fingers discard incomplete frame dragging without drawing',{skip:!backend},async()=>{
  const f=transformUIFixture();
  try{
    f.root.querySelector('.paint-transform-toggle').click();await f.frame();const rect=f.canvas.getBoundingClientRect(),corner=f.root.querySelector('[data-handle="nw"]');
    f.fire(corner,'pointerdown',rect.left,rect.top);f.fire(f.w,'pointermove',rect.left+rect.width*.25,rect.top+rect.height*.2);assert.equal(f.value('Слева, px'),10);
    f.fire(f.viewport,'pointerdown',rect.left+100,rect.top+100,2);assert.equal(f.value('Слева, px'),0);assert.equal(f.model.markCount,1);
    f.fire(f.w,'pointerup',rect.left,rect.top,1);f.fire(f.w,'pointerup',rect.left,rect.top,2);
    f.fire(corner,'pointerdown',rect.left,rect.top);f.fire(f.w,'pointermove',rect.left+rect.width*.25,rect.top);f.fire(f.w,'pointercancel',rect.left,rect.top);assert.equal(f.value('Слева, px'),0);
    const aspect=f.root.querySelector('[aria-label="Пропорции"]');aspect.value='1';aspect.dispatchEvent(new f.w.Event('change'));assert.equal(f.value('Ширина, px'),30);
    f.root.querySelector('[aria-label="Отразить по горизонтали"]').click();assert.equal(f.root.querySelector('[aria-label="Отразить по горизонтали"]').getAttribute('aria-pressed'),'true');
    f.root.querySelector('.paint-transform-controls').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    assert.equal(f.root.querySelector('.paint-transform-overlay').hidden,true);assert.equal(f.model.history.done.length,1);assert.equal(f.model.state.flipX,undefined);
    f.root.querySelector('.paint-transform-toggle').click();await f.frame();const right=f.root.querySelector('[data-handle="e"]');
    right.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'ArrowLeft',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(f.value('Ширина, px'),30);
    right.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));assert.equal(f.model.state.w,30);assert.equal(f.model.history.done.length,2);
  }finally{f.close();}
});

test('Live rotation keeps the image center stable across frames and after releasing its marker',{skip:!backend},async()=>{
  const f=transformUIFixture();
  try{
    f.root.querySelector('.paint-transform-toggle').click();await f.frame();const first=f.canvas.getBoundingClientRect(),cx=first.left+first.width/2,cy=first.top+first.height/2,handle=f.root.querySelector('[data-handle="rotate"]');
    f.fire(handle,'pointerdown',cx,cy-100);
    f.fire(f.w,'pointermove',cx+50,cy-100);await f.frame();let rect=f.canvas.getBoundingClientRect();
    assert.ok(Math.abs(rect.left+rect.width/2-cx)<1e-8);assert.ok(Math.abs(rect.top+rect.height/2-cy)<1e-8);
    f.fire(f.w,'pointerup',cx+100,cy);await f.frame();rect=f.canvas.getBoundingClientRect();
    assert.ok(Math.abs(rect.left+rect.width/2-cx)<1e-8);assert.ok(Math.abs(rect.top+rect.height/2-cy)<1e-8);assert.equal(f.value('Поворот, °'),90);
    const angle=f.root.querySelector('[aria-label="Поворот, °"]');angle.value=33;angle.dispatchEvent(new f.w.Event('input'));await f.frame();rect=f.canvas.getBoundingClientRect();
    assert.ok(Math.abs(rect.left+rect.width/2-cx)<1e-8);assert.ok(Math.abs(rect.top+rect.height/2-cy)<1e-8);assert.equal(f.model.state.turns,0);assert.equal(f.model.markCount,1);
  }finally{f.close();}
});

test('Painting UI accepts pointer drawing, color controls, pinch and cancellation',{skip:!backend},async()=>{
  const w=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true}).window,old=new Map();
  const contextValues={window:w,document:w.document,innerWidth:800,innerHeight:600,devicePixelRatio:1,requestAnimationFrame:w.requestAnimationFrame.bind(w),cancelAnimationFrame:w.cancelAnimationFrame.bind(w),ResizeObserver:class{observe(){}disconnect(){}}};
  for(const [key,value]of Object.entries(contextValues)){old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
  const rasters=new WeakMap(),proto=w.HTMLCanvasElement.prototype;
  for(const name of ['width','height']){const descriptor=Object.getOwnPropertyDescriptor(proto,name);Object.defineProperty(proto,name,{...descriptor,set(value){descriptor.set.call(this,value);if(rasters.has(this))rasters.get(this)[name]=descriptor.get.call(this);}});}
  const actual=node=>{if(!rasters.has(node))rasters.set(node,backend.createCanvas(node.width,node.height));return rasters.get(node);};
  proto.getContext=function(){const ctx=actual(this).getContext('2d');return new Proxy(ctx,{get(target,key){if(key==='drawImage')return (source,...args)=>target.drawImage(source instanceof w.HTMLCanvasElement?actual(source):source,...args);const value=target[key];return typeof value==='function'?value.bind(target):value;},set(target,key,value){target[key]=value;return true;}});};
  const model=createImageModel(raster(),'drawing.png',()=>backend.createCanvas(1,1)),root=w.document.querySelector('#root'),controller=new AbortController();
  let api;
  const fire=(target,type,x,y,id=1)=>{const e=new w.MouseEvent(type,{clientX:x,clientY:y,button:0,bubbles:true,cancelable:true});Object.defineProperty(e,'pointerId',{value:id});target.dispatchEvent(e);};
  try{
    api=openImageUI(model,{name:'drawing.png'},root,{signal:controller.signal,onSave(){},onClose(){},onError:assert.fail});
    const canvas=root.querySelector('.paint-canvas');canvas.getBoundingClientRect=()=>({left:0,top:0,width:400,height:300});
    root.querySelector('[aria-label="Размер, px"]').value=8;root.querySelector('[aria-label="Непрозрачность, %"]').value=50;
    const hex=root.querySelector('[aria-label="Цвет HEX"]');hex.value='#ff0000';hex.dispatchEvent(new w.Event('change'));
    fire(canvas,'pointerdown',50,150);fire(canvas,'pointermove',350,150);fire(canvas,'pointerup',350,150);
    await new Promise(resolve=>w.requestAnimationFrame(resolve));assert.equal(model.markCount,1);assert.deepEqual(pixel(actual(canvas),20,15),[255,128,128,255]);
    assert.equal(root.querySelector('.paint-options').open,false);
    assert.equal(root.querySelectorAll('.paint-color-row .paint-swatch').length,16);
    const bottom=root.querySelector('.paint-bottom-tools');
    assert.equal(bottom.previousElementSibling,root.querySelector('.paint-viewport'));
    assert.equal(bottom.querySelector('[aria-label="Размер, px"]'),root.querySelector('[aria-label="Размер, px"]'));
    const marks=model.markCount,exportBefore=Buffer.from(await api.export());
    api.setFocus(false);api.setFocus(true);await new Promise(resolve=>w.requestAnimationFrame(resolve));
    assert.equal(model.markCount,marks);assert.deepEqual(Buffer.from(await api.export()),exportBefore);
    assert.equal(root.querySelector('.paint-canvas'),canvas);
    const fitted={width:canvas.style.width,height:canvas.style.height};
    assert.deepEqual(fitted,{width:'800px',height:'600px'});
    api.toggleTools();assert.equal(root.querySelector('.paint-tools').hidden,true);
    await new Promise(resolve=>w.requestAnimationFrame(resolve));assert.deepEqual({width:canvas.style.width,height:canvas.style.height},fitted);
    api.toggleTools();
    const transparency=root.querySelector('[aria-label="Непрозрачность, %"]');
    root.querySelector('[data-tool="eraser"]').click();assert.equal(transparency.disabled,true);assert.equal(transparency.value,'100');
    fire(canvas,'pointerdown',200,150);fire(canvas,'pointerup',200,150);
    await new Promise(resolve=>w.requestAnimationFrame(resolve));assert.deepEqual(pixel(actual(canvas),20,15),[255,255,255,255]);
    model.history.undo();root.querySelector('[data-tool="brush"]').click();assert.equal(transparency.disabled,false);assert.equal(transparency.value,'50');
    canvas.dispatchEvent(new w.KeyboardEvent('keydown',{ctrlKey:true,altKey:true,key:'z',code:'KeyZ',bubbles:true,cancelable:true}));assert.equal(model.markCount,0);
    canvas.dispatchEvent(new w.KeyboardEvent('keydown',{ctrlKey:true,key:'y',code:'KeyY',bubbles:true,cancelable:true}));assert.equal(model.markCount,1);
    fire(canvas,'pointerdown',100,100);fire(canvas,'pointercancel',120,120);assert.equal(model.markCount,1);
    fire(canvas,'pointerdown',100,100);fire(canvas,'pointerdown',200,100,2);fire(canvas,'pointerup',100,100);fire(w,'pointerup',900,100,2);assert.equal(model.markCount,1);
    const viewport=root.querySelector('.paint-viewport');
    const touch=(type,width)=>{const e=new w.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'touches',{value:[{identifier:1,clientX:0,clientY:0},{identifier:2,clientX:width,clientY:0}]});viewport.dispatchEvent(e);};
    touch('touchstart',100);touch('touchmove',200);await new Promise(resolve=>w.requestAnimationFrame(resolve));assert.equal(api.position.zoom,2);assert.equal(model.markCount,1);
    root.querySelector('[data-tool="rectangle"]').click();fire(canvas,'pointerdown',100,50);fire(canvas,'pointermove',300,250);fire(canvas,'pointerup',300,250);assert.equal(model.markCount,2);
    const palette=root.querySelector('.paint-palette');palette.getBoundingClientRect=()=>({left:0,top:0,width:220,height:128});fire(palette,'pointerdown',110,64);fire(palette,'pointerup',110,64);
    assert.equal(root.querySelector('[aria-label="Насыщенность, %"]').value,'50');assert.equal(root.querySelector('[aria-label="Яркость, %"]').value,'50');
    controller.abort();fire(canvas,'pointerdown',100,100);assert.equal(model.markCount,0);
  }finally{api?.dispose();w.close();for(const [key,value]of old)if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}
});

test('Android Back dismisses dialogs and exits fullscreen before attempting to close the edited file',async()=>{
  const java=await readFile(new URL('../android/app/src/main/java/dev/klio/omni/MainActivity.java',import.meta.url),'utf8');
  const quoted=java.match(/onBackPressed\(\).*?evaluateJavascript\(("(?:[^"\\]|\\.)*")/)[1],script=JSON.parse(quoted);
  const w=new JSDOM('<body class="focus-mode"><dialog open></dialog><div id="reader"></div><button id="focus-exit"></button><button id="close"></button>',{runScripts:'outside-only'}).window;
  let closed=0;
  w.document.querySelector('dialog').close=function(){this.removeAttribute('open');};
  w.document.querySelector('#focus-exit').onclick=()=>w.document.body.classList.remove('focus-mode');
  w.document.querySelector('#close').onclick=()=>closed++;
  try{
    assert.equal(w.eval(script),'stay');assert.equal(w.document.body.classList.contains('focus-mode'),true);assert.equal(closed,0);
    assert.equal(w.eval(script),'stay');assert.equal(w.document.body.classList.contains('focus-mode'),false);assert.equal(closed,0);
    assert.equal(w.eval(script),'stay');assert.equal(closed,1);
    w.document.querySelector('#reader').hidden=true;assert.equal(w.eval(script),'exit');
  }finally{w.close();}
});

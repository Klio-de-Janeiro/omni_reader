import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import {hsvToHex,hexToHsv} from '../dist/colors.js';
import {initThemes,themeSettings,documentTheme} from '../dist/themes.js';
import {isFullscreenShortcut,isThemeShortcut,editingShortcut} from '../dist/shortcuts.js';
import {createImageModel,imagePoint} from '../dist/editors/image.js';
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

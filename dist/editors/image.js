import { History } from './history.js';

/** Validate crops in original image pixels before allocating an output canvas. */
export function imageGeometry(width, height, state) {
  const { x, y, w, h, turns } = state;
  if (![x, y, w, h, turns].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height || turns < 0 || turns > 3) throw new Error('Обрезка должна находиться внутри исходного изображения; размеры — целые пиксели.');
  if (!Number.isFinite(state.angle ?? 0) || Math.abs(state.angle ?? 0)>180 || ['flipX','flipY'].some(key=>state[key]!==undefined && typeof state[key]!=='boolean')) throw new Error('Некорректный поворот или отражение изображения.');
  const angle = imageAngle(state), c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  const size={width:Math.max(1,Math.ceil(w*c+h*s-1e-8)),height:Math.max(1,Math.ceil(w*s+h*c-1e-8))};
  if(size.width*size.height>80_000_000)throw new Error('Лимит изображения после поворота: 80 мегапикселей.');
  return size;
}

export const imageAngle = state => (state.turns*90+(state.angle || 0))*Math.PI/180;

/** Project an original pixel onto the cropped, rotated and mirrored preview. */
export function imagePreviewPoint(point,state) {
  const size=imageGeometry(state.x+state.w,state.y+state.h,state),angle=imageAngle(state);
  const x=(point.x-state.x-state.w/2)*(state.flipX?-1:1),y=(point.y-state.y-state.h/2)*(state.flipY?-1:1);
  return {x:size.width/2+x*Math.cos(angle)-y*Math.sin(angle),y:size.height/2+x*Math.sin(angle)+y*Math.cos(angle)};
}

/** Map a point in a rotated preview back to the original image coordinates. */
export function imagePoint(point, state, clamp=true) {
  const size = imageGeometry(state.x + state.w, state.y + state.h, state);
  const dx = point.x - size.width / 2, dy = point.y - size.height / 2, angle = imageAngle(state);
  const x=state.x+state.w/2+(dx*Math.cos(angle)+dy*Math.sin(angle))*(state.flipX?-1:1);
  const y=state.y+state.h/2+(-dx*Math.sin(angle)+dy*Math.cos(angle))*(state.flipY?-1:1);
  return clamp?{x:Math.max(state.x,Math.min(state.x+state.w,x)),y:Math.max(state.y,Math.min(state.y+state.h,y))}:{x,y};
}

/** Render one brush/eraser path or a filled rounded rectangle on the annotation layer. */
function paint(context, mark) {
  context.save();context.globalAlpha=mark.type==='eraser'?1:mark.opacity;
  context.globalCompositeOperation=mark.type==='eraser'?'destination-out':'source-over';
  context.fillStyle=context.strokeStyle=mark.color;
  if(mark.type==='rectangle'){
    const r=Math.min(mark.radius,mark.w/2,mark.h/2),{x,y,w,h}=mark;
    context.beginPath();context.moveTo(x+r,y);context.lineTo(x+w-r,y);context.quadraticCurveTo(x+w,y,x+w,y+r);
    context.lineTo(x+w,y+h-r);context.quadraticCurveTo(x+w,y+h,x+w-r,y+h);context.lineTo(x+r,y+h);
    context.quadraticCurveTo(x,y+h,x,y+h-r);context.lineTo(x,y+r);context.quadraticCurveTo(x,y,x+r,y);context.closePath();context.fill();
  }else{
    context.lineCap=context.lineJoin='round';context.lineWidth=mark.width;
    context.beginPath();context.moveTo(mark.points[0].x,mark.points[0].y);
    if(mark.points.length===1){context.arc(mark.points[0].x,mark.points[0].y,mark.width/2,0,2*Math.PI);context.fill();}
    else{for(const point of mark.points.slice(1))context.lineTo(point.x,point.y);context.stroke();}
  }
  context.restore();
}

/** Share annotation commands and crop/rotation history between preview and export. */
export function createImageModel(image, name, createCanvas = () => document.createElement('canvas')) {
  const width=image.naturalWidth || image.width,height=image.naturalHeight || image.height;
  if(width*height>40000000)throw new Error('Лимит изображения: 40 мегапикселей.');
  const history=new History();let state={x:0,y:0,w:width,h:height,turns:0},marks=[],layer;
  function draw(canvas,maxSide=Infinity,draft,preview=state){
    const size=imageGeometry(width,height,preview),scale=Math.min(1,maxSide/Math.max(size.width,size.height));
    canvas.width=Math.max(1,Math.round(size.width*scale));canvas.height=Math.max(1,Math.round(size.height*scale));
    const context=canvas.getContext('2d');if(!context)throw new Error('Графический редактор недоступен.');
    if(/\.jpe?g$/i.test(name)){context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);}
    context.save();context.translate(canvas.width/2,canvas.height/2);context.rotate(imageAngle(preview));context.scale(preview.flipX?-1:1,preview.flipY?-1:1);
    context.drawImage(image,preview.x,preview.y,preview.w,preview.h,-preview.w*scale/2,-preview.h*scale/2,preview.w*scale,preview.h*scale);context.restore();
    if(marks.length || draft){
      layer??=createCanvas();layer.width=canvas.width;layer.height=canvas.height;
      const overlay=layer.getContext('2d');if(!overlay)throw new Error('Слой рисования недоступен.');
      overlay.translate(layer.width/2,layer.height/2);overlay.rotate(imageAngle(preview));overlay.scale(scale*(preview.flipX?-1:1),scale*(preview.flipY?-1:1));
      overlay.translate(-preview.x-preview.w/2,-preview.y-preview.h/2);
      overlay.beginPath();overlay.rect(preview.x,preview.y,preview.w,preview.h);overlay.clip();
      for(const mark of marks)paint(overlay,mark);if(draft)paint(overlay,draft);
      context.drawImage(layer,0,0);layer.width=layer.height=0;
    }
  }
  function addMark(mark){
    if(!['brush','eraser','rectangle'].includes(mark.type) || !/^#[\da-f]{6}$/i.test(mark.color) || !Number.isFinite(mark.opacity) || mark.opacity<0 || mark.opacity>1)throw new Error('Некорректные параметры рисования.');
    if(mark.type==='rectangle'){
      if(![mark.x,mark.y,mark.w,mark.h,mark.radius].every(Number.isFinite) || mark.x<0 || mark.y<0 || mark.w<1 || mark.h<1 || mark.x+mark.w>width+.001 || mark.y+mark.h>height+.001 || mark.radius<0)throw new Error('Выделение должно находиться внутри изображения.');
    }else if(!Number.isFinite(mark.width) || mark.width<1 || mark.width>400 || !Array.isArray(mark.points) || !mark.points.length || mark.points.length>20000 || mark.points.some(p=>!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x<0 || p.y<0 || p.x>width || p.y>height))throw new Error('Некорректный штрих.');
    if(!mark.opacity && mark.type!=='eraser')return;
    const command=structuredClone(mark);
    if(command.type==='eraser')command.opacity=1;
    history.execute(()=>{marks.push(command);},()=>{marks.pop();});
  }
  return {width,height,history,get state(){return {...state};},get markCount(){return marks.length;},draw,addMark,
    set(next){imageGeometry(width,height,next);if(JSON.stringify(state)===JSON.stringify(next))return;const previous={...state};history.execute(()=>{state={...next};},()=>{state=previous;});},
    async export(){
      const canvas=createCanvas();draw(canvas);
      try{
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,/\.png$/i.test(name)?'image/png':'image/jpeg',.95));
        if(!blob)throw new Error('Не удалось закодировать изображение.');return new Uint8Array(await blob.arrayBuffer());
      }finally{canvas.width=canvas.height=0;}
    },
    dispose(){marks=[];if(layer)layer.width=layer.height=0;image.removeAttribute?.('src');}
  };
}
/** Draw the crop and rotation into pixels for both preview and exported files. */
export async function openImageEditor(file) {
  const url = URL.createObjectURL(file), image = new Image(); image.src = url;
  try { await image.decode(); } finally { URL.revokeObjectURL(url); }
  return createImageModel(image,file.name);
}

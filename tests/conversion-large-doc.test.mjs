import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, open, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { validateFile, validateBlob, LIMITS } from '../dist/validation.js';
import { BlobText, PAGE_BYTES, indexCsv, openLargeCsv } from '../dist/large-files.js';
import { parseCsv } from '../dist/table-core.js';
import { extractDocText } from '../dist/legacy-doc.js';

test('All supported formats accept <500 MB and reject the boundary', () => {
  for (const ext of Object.keys(LIMITS)) {
    assert.equal(validateFile({ name: 'test.' + ext, size: 499999999 }), ext);
    assert.throws(() => validateFile({ name: 'test.' + ext, size: 500000000 }), /500/);
  }
});
for (const ext of ['docx','pptx','xlsx','png','pdf','csv']) test('Blob validation reads only signatures or ZIP directory: '+ext, async () => {
  const file = new File([await readFile(new URL('./fixtures/sample.'+ext, import.meta.url))], 'sample.'+ext);
  file.arrayBuffer = () => { throw new Error('Full file read'); };
  assert.equal(await validateBlob(file), ext);
});
test('Nearly 500 MB WAV validates without allocating or reading its complete contents', async () => {
  const path = new URL('./large-sparse-test.wav', import.meta.url), handle = await open(path, 'w+');
  try {
    const size = 499999998, header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(size - 8, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22); header.writeUInt32LE(44100,24); header.writeUInt32LE(88200,28); header.writeUInt16LE(2,32); header.writeUInt16LE(16,34); header.write('data',36); header.writeUInt32LE(size-44,40);
    await handle.write(header); await handle.truncate(size); let read = 0;
    const file = { name: 'large.wav', size, slice(start,end) { return { async arrayBuffer() { const buf = Buffer.alloc(end-start); const result = await handle.read(buf,0,buf.length,start); read += result.bytesRead; return buf.buffer.slice(buf.byteOffset,buf.byteOffset+result.bytesRead); } }; }, arrayBuffer() { throw new Error('Full read'); } };
    assert.equal(await validateBlob(file),'wav'); assert.equal(read,4096);
  } finally { await handle.close(); await rm(path); }
});
test('UTF-8 page boundaries preserve BOM, emoji and bytes outside the edited range', async () => {
  const original = '\ufeff' + 'a'.repeat(PAGE_BYTES-4) + '😀Привет'.repeat(30000), file = new File([original], 'text.txt'), model = await BlobText.open(file), pages=[];
  for(let n=0;n<Math.ceil(file.size/PAGE_BYTES);n++)pages.push(await model.page(n));
  assert.equal(pages.map(p=>p.text).join(''),original);
  await model.replace(pages[1].start,pages[1].end,pages[1].text+' EDIT');
  const result = model.export(); assert.equal(model.decode(await result.arrayBuffer()), pages[0].text+pages[1].text+' EDIT'+pages.slice(2).map(p=>p.text).join(''));
  assert.deepEqual(new Uint8Array(await result.slice(0,pages[1].start).arrayBuffer()),new Uint8Array(await file.slice(0,pages[1].start).arrayBuffer()));
});
for(const encoding of ['utf-16le','utf-16be'])test('UTF-16 surrogate pairs survive part boundaries and export: '+encoding,async()=>{
  const helper=new BlobText(new Blob(),encoding), original='\ufeff'+'x'.repeat(PAGE_BYTES/2-2)+'😀текст'.repeat(10000), file=new File([helper.encode(original)],'text.txt'), model=await BlobText.open(file);let restored='';
  for(let n=0;n<Math.ceil(file.size/PAGE_BYTES);n++)restored+=(await model.page(n)).text;
  assert.equal(restored,original);const p=await model.page(1);await model.replace(p.start,p.end,p.text+'!');assert.equal(model.decode(await model.export().arrayBuffer()),original.slice(0,p.end/2)+'!'+original.slice(p.end/2));
});
test('CSV index respects quoted newlines and CRLF across chunk boundaries',async()=>{
  const lines=Array.from({length:250},(_,i)=>`${i},"a\r\nb"`),file=new File([lines.join('\r\n')+'\r\n'],'a.csv'),idx=await indexCsv(file,'utf-8');
  assert.equal(idx.rows,250);assert.equal(idx.checkpoints.length,3);
  assert.match(await file.slice(idx.checkpoints[1],idx.checkpoints[2]).text(),/^100,/);
  const prefix='"'+'x'.repeat(1048575)+'\ninside",1\r\n'; const large=await indexCsv(new Blob([prefix,'next,2\r\n']),'utf-8');assert.equal(large.rows,2);
});
function docFixture(text) {
  const buffer=Buffer.alloc(13*512), h=new DataView(buffer.buffer,buffer.byteOffset,buffer.byteLength), set=(at,v)=>h.setUint32(at,v,true), sector=id=>(id+1)*512;
  set(0,0xe011cfd0);set(4,0xe11ab1a1);h.setUint16(26,3,true);h.setUint16(28,0xfffe,true);h.setUint16(30,9,true);h.setUint16(32,6,true);set(44,1);set(48,1);set(56,4096);set(60,11);set(64,1);set(68,0xfffffffe);
  for(let at=76;at<512;at+=4)set(at,0xffffffff);set(76,0);
  for(let at=sector(0);at<sector(1);at+=4)set(at,0xffffffff);
  set(sector(0),0xfffffffd);set(sector(0)+4,0xfffffffe);for(let id=2;id<=11;id++)set(sector(0)+id*4,id<9?id+1:0xfffffffe);
  function entry(at,name,type,first,length){Buffer.from(name+'\0','utf16le').copy(buffer,at);h.setUint16(at+64,(name.length+1)*2,true);buffer[at+66]=type;set(at+116,first);set(at+120,length);}
  entry(sector(1),'Root Entry',5,10,64);entry(sector(1)+128,'WordDocument',2,2,4096);entry(sector(1)+256,'0Table',2,0,21);
  const w=sector(2);h.setUint16(w,0xa5ec,true);h.setUint16(w+2,0xc1,true);h.setUint16(w+32,14,true);h.setUint16(w+62,22,true);set(w+76,text.length);h.setUint16(w+152,93,true);set(w+154+33*8,0);set(w+158+33*8,21);Buffer.from(text,'utf16le').copy(buffer,w+2048);
  const t=sector(10);buffer[t]=2;set(t+1,16);set(t+5,0);set(t+9,text.length);set(t+15,2048);
  for(let at=sector(11);at<sector(12);at+=4)set(at,0xffffffff);set(sector(11),0xfffffffe);
  return buffer;
}
test('Legacy DOC reader extracts Unicode and field results from actual CFB streams',async()=>{
  const file=new File([docFixture('Привет 😀\r\x13DATE\x142026\x15\rA\x07B')],'old.doc');await validateBlob(file);
  assert.equal(await (await extractDocText(file)).text(),'Привет 😀\n2026\nA\tB');
});
test('Legacy DOC rejects encryption and cyclic allocation chains',async()=>{
  const encrypted=docFixture('text');encrypted.writeUInt16LE(0x100,3*512+10);await assert.rejects(extractDocText(new File([encrypted],'old.doc')),/паролем/);
  const cyclic=docFixture('text');cyclic.writeUInt32LE(2,512+2*4);await assert.rejects(extractDocText(new File([cyclic],'old.doc')),/Поврежд/);
});
function browser(html='<div id="root"></div>'){
  const w=new JSDOM(html,{url:'https://omni.test',pretendToBeVisual:true}).window,values={window:w,document:w.document,getComputedStyle:w.getComputedStyle.bind(w),requestAnimationFrame:w.requestAnimationFrame.bind(w),cancelAnimationFrame:w.cancelAnimationFrame.bind(w),innerWidth:390};
  const before=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));Object.assign(globalThis,values);w.HTMLElement.prototype.scrollIntoView=()=>{};
  return {w,close(){w.close();for(const [key,value]of before)if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}};
}
test('CSV cell edits survive page changes and leave untouched groups byte-identical',async()=>{
  const b=browser(),controller=new AbortController();
  try{
    const lines=Array.from({length:250},(_,i)=>`${i+1},"value ${i+1}"`),file=new File([lines.join('\r\n')+'\r\n'],'table.csv'),root=document.querySelector('#root');
    let saved=0;const api=await openLargeCsv(file,root,{signal:controller.signal,onSave:()=>{saved++;},onError:error=>{throw error;}},true);
    const edit=(address,value)=>{const cell=root.querySelector(`[aria-label="${address}"]`);assert.ok(cell);cell.value=value;cell.dispatchEvent(new b.w.Event('input',{bubbles:true}));};
    edit('B2','42');await api.setPage(3);edit('B205','98,7');const exported=await api.export(),text=await exported.text(),rows=parseCsv(text);
    root.querySelector('[aria-label="B205"]').dispatchEvent(new b.w.KeyboardEvent('keydown',{ctrlKey:true,key:'s',code:'KeyS',bubbles:true,cancelable:true}));assert.equal(saved,1);assert.equal(rows[1][1],'42');assert.equal(rows[204][1],'98,7');assert.equal(rows.length,250);assert.ok(text.includes(lines.slice(100,200).join('\r\n')+'\r\n'));
    api.toggleView();assert.equal(root.querySelector('[aria-label="B205"]').readOnly,true);api.toggleView();assert.equal(root.querySelector('[aria-label="B205"]').readOnly,false);
  }finally{controller.abort();b.close();}
});
test('Conversion menu works on hover and touch and hides unsupported formats',async()=>{
  const b=browser('<button id="edit-file">Edit</button><button id="focus-edit">Edit</button>');
  try{
    const {initConversion,conversionTargets}=await import('../dist/conversion.js');let record={ext:'docx'};const api=initConversion({getRecord:()=>record,getEditor:()=>null,notify(){}});api.sync();
    const wrapper=document.querySelector('.conversion-menu'),button=wrapper.firstElementChild,list=wrapper.lastElementChild;
    const enter=new b.w.Event('pointerenter');Object.defineProperty(enter,'pointerType',{value:'mouse'});wrapper.dispatchEvent(enter);assert.equal(list.hidden,false);assert.equal(list.textContent,'В PDF');
    button.click();assert.equal(list.hidden,true);button.click();assert.equal(list.hidden,false);
    record={ext:'ogg'};api.sync();assert.equal(wrapper.hidden,false);assert.equal(list.textContent,'В WAV');assert.deepEqual(conversionTargets('ogg'),['wav']);
    record={ext:'txt'};api.sync();assert.equal(wrapper.hidden,true);assert.deepEqual(conversionTargets('jpg'),['pdf','png']);
  }finally{b.close();}
});
test('Real image conversions preserve dimensions, flatten transparency to white and create valid PDF',async()=>{
  const b=browser();let backend;
  try{backend=await import('@napi-rs/canvas');}catch{backend=await import(pathToFileURL(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/@napi-rs/canvas/index.js').href);}
  const oldBitmap=globalThis.createImageBitmap,oldCreate=document.createElement.bind(document);
  try{
    document.createElement=tag=>{if(tag!=='canvas')return oldCreate(tag);const c=backend.createCanvas(1,1);c.toBlob=async(callback,mime)=>callback(new Blob([await c.encode(mime==='image/png'?'png':'jpeg')],{type:mime}));return c;};
    globalThis.createImageBitmap=async blob=>{const img=await backend.loadImage(Buffer.from(await blob.arrayBuffer()));img.close=()=>{};return img;};
    const {convertImage}=await import('../dist/conversion.js'),source=backend.createCanvas(100,50);source.getContext('2d').fillStyle='red';source.getContext('2d').fillRect(0,0,20,20);
    const jpg=await convertImage(new Blob([await source.encode('png')]),'jpg'),decoded=await backend.loadImage(Buffer.from(await jpg.arrayBuffer())),out=backend.createCanvas(100,50);out.getContext('2d').drawImage(decoded,0,0);assert.deepEqual([...out.getContext('2d').getImageData(90,40,1,1).data],[255,255,255,255]);
    const png=await convertImage(jpg,'png');assert.deepEqual([...new Uint8Array(await png.slice(0,8).arrayBuffer())],[137,80,78,71,13,10,26,10]);
    const pdf=await convertImage(jpg,'pdf'),{PDFDocument}=await import('../dist/vendor/pdf-lib.js'),doc=await PDFDocument.load(await pdf.arrayBuffer());assert.equal(doc.getPageCount(),1);assert.deepEqual(doc.getPage(0).getSize(),{width:100,height:50});
  }finally{globalThis.createImageBitmap=oldBitmap;b.close();}
});


test('OGG headers identify actual Vorbis and Opus audio without loading the whole file',async()=>{
  const {readOggInfo}=await import('../dist/audio-conversion.js');
  for(const [name,codec,rate,channels] of [['sample.ogg','vorbis',44100,2],['sample-opus.ogg','opus',48000,1]]){
    const file=new File([await readFile(new URL('./fixtures/'+name,import.meta.url))],name);file.arrayBuffer=()=>{throw new Error('Full read');};
    assert.equal(await validateBlob(file),'ogg');const info=await readOggInfo(file);
    assert.equal(info.codec,codec);assert.equal(info.rate,rate);assert.equal(info.channels,channels);assert.ok(Math.abs(info.duration-.15)<1/rate);
  }
  await assert.rejects(validateBlob(new File(['not audio'],'fake.ogg')),/повреждён|соответствует/);
});
test('WAV converter interleaves channels, clips PCM16, preserves rate and rejects oversized output before allocation',async()=>{
  const {encodeAudioWav}=await import('../dist/audio-conversion.js'),{readWav}=await import('../dist/editors/wav.js');
  const channels=[new Float32Array([-2,-.5,0,.5,2,NaN]),new Float32Array([1,.25,0,-.25,-1,Infinity])];
  const blob=await encodeAudioWav({sampleRate:44100,length:6,numberOfChannels:2,getChannelData:index=>channels[index]});assert.equal(blob.type,'audio/wav');
  const wav=readWav(await blob.arrayBuffer());assert.equal(wav.rate,44100);assert.equal(wav.channels,2);assert.equal(wav.frames,6);
  const pcm=new DataView(wav.bytes.buffer,wav.start,wav.size);
  assert.deepEqual(Array.from({length:12},(_,i)=>pcm.getInt16(i*2,true)),[-32768,32767,-16384,8192,0,0,16384,-8192,32767,-32768,0,0]);
  await assert.rejects(encodeAudioWav({sampleRate:48000,length:250000000,numberOfChannels:1,getChannelData(){assert.fail('Must reject before allocating');}}),/500/);
});
test('OGG conversion decodes at the codec clock and writes a valid WAV using the returned channels',async()=>{
  const {convertOggToWav}=await import('../dist/audio-conversion.js'),{readWav}=await import('../dist/editors/wav.js');
  const original=Object.getOwnPropertyDescriptor(globalThis,'OfflineAudioContext');let rate;
  class Decoder{
    constructor(channels,length,sampleRate){rate=sampleRate;}
    async decodeAudioData(bytes){assert.equal(new TextDecoder().decode(bytes.slice(0,4)),'OggS');return {numberOfChannels:2,sampleRate:rate,length:3,getChannelData:()=>new Float32Array([0,.5,-.5])};}
  }
  globalThis.OfflineAudioContext=Decoder;
  try{
    for(const [name,expected] of [['sample.ogg',44100],['sample-opus.ogg',48000]]){
      const file=new File([await readFile(new URL('./fixtures/'+name,import.meta.url))],name),wav=readWav(await (await convertOggToWav(file)).arrayBuffer());
      assert.equal(rate,expected);assert.equal(wav.rate,expected);assert.equal(wav.channels,2);assert.equal(wav.frames,3);
    }
    Decoder.prototype.decodeAudioData=async()=>{throw new Error('Unsupported codec');};
    await assert.rejects(convertOggToWav(new File([await readFile(new URL('./fixtures/sample.ogg',import.meta.url))],'sample.ogg')),/декодировать/);
  }finally{if(original)Object.defineProperty(globalThis,'OfflineAudioContext',original);else delete globalThis.OfflineAudioContext;}
});

test('OGG uses the audio viewer, keeps seek and speed controls, and disposes the media source',async()=>{
  const b=browser(),controller=new AbortController();
  try{
    b.w.HTMLMediaElement.prototype.pause=function(){};b.w.HTMLMediaElement.prototype.load=function(){};
    const {openViewer}=await import('../dist/viewers.js'),file=new File([await readFile(new URL('./fixtures/sample.ogg',import.meta.url))],'sample.ogg'),root=document.querySelector('#root');
    const pending=openViewer(file,root,{ext:'ogg',signal:controller.signal,onWarning:assert.fail}),audio=root.querySelector('audio');assert.ok(audio);
    Object.defineProperty(audio,'duration',{value:Infinity});audio.dispatchEvent(new b.w.Event('loadedmetadata'));await pending;
    const speed=root.querySelector('select');speed.value='1.5';speed.dispatchEvent(new b.w.Event('change'));assert.equal(audio.playbackRate,1.5);
    const at=root.querySelector('[aria-label="Перейти к времени"]');at.value='0.1';[...root.querySelectorAll('button')].find(el=>el.textContent==='Перейти').click();assert.equal(audio.currentTime,.1);
    [...root.querySelectorAll('button')].find(el=>el.textContent==='+10 с').click();assert.ok(Math.abs(audio.currentTime-.15)<1/44100);
    controller.abort();assert.equal(audio.getAttribute('src'),null);
  }finally{controller.abort();b.close();}
});

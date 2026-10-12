import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const { SpeechService } = require('../desktop/speech.cjs');
const { VoiceTranscripts } = require('../desktop/voice-transcripts.cjs');
const defaults = require('../desktop/speech-defaults.json');
const python = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c','import sys; print(sys.executable)'], { encoding:'utf8' }).trim();

async function until(check) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 5000) throw new Error('Timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t, { pt = false, wait = false } = {}) {
  const dir = await mkdtemp(path.join(process.cwd(), '../Stage2 voice & '));
  const modules = path.join(dir, 'modules'); await mkdir(modules);
  const model = path.join(dir, pt ? 'small.pt' : 'small');
  if (pt) await writeFile(model, 'model double');
  else { await mkdir(model); for (const file of ['model.bin','config.json','tokenizer.json']) await writeFile(path.join(model, file), '{}'); }
  const common = `import os,json,time\nfrom pathlib import Path\nCOUNT=Path(os.environ['VOICE_LOADS'])\ndef init():\n with COUNT.open('a',encoding='utf8') as f: f.write('load\\n')\n assert os.environ['HF_HUB_OFFLINE']=='1'\ndef text(source,kw):\n assert kw['language']=='ru'\n if Path(os.environ['VOICE_FAIL']).exists(): raise RuntimeError('Model test failure')\n if os.environ.get('VOICE_WAIT'):\n  while True: time.sleep(.05)\n time.sleep(.05)\n if Path(source).stem.endswith('& empty'): return ''\n return 'Распознано: '+Path(source).stem+' <img src=x onerror=alert(1)>'\n`;
  await writeFile(path.join(modules,'torch.py'),'def set_num_threads(n): assert n == 4\n');
  await writeFile(path.join(modules,'whisper.py'),common+`class Model:\n def transcribe(self,source,**kw): return {'text':text(source,kw)}\ndef load_model(model,device):\n assert device=='cpu';init();return Model()\n`);
  await writeFile(path.join(modules,'faster_whisper.py'),common+`from types import SimpleNamespace\nclass WhisperModel:\n def __init__(self,model,**kw):\n  assert kw['cpu_threads']==4 and kw['local_files_only'] is True;init()\n def transcribe(self,source,**kw):\n  assert kw['vad_filter'] is False\n  return iter([SimpleNamespace(text=text(source,kw))]),None\n`);
  let launches = 0;
  const speech = new SpeechService(path.join(dir, 'settings'),path.resolve('desktop/speech/transcribe.py'),{
    spawn(command,args,opts) { launches++; return spawn(command,args,{...opts,env:{...opts.env,PYTHONPATH:modules,VOICE_LOADS:path.join(dir,'loads'),VOICE_FAIL:path.join(dir,'fail'),...(wait?{VOICE_WAIT:'1'}:{})}}); }
  });
  await speech.configure('python',python);
  await speech.configure(pt?'model-file':'model-folder',model);
  const queue = new VoiceTranscripts(path.join(dir,'settings'),speech);
  t.after(async()=>{ await queue.shutdown(); await rm(dir,{recursive:true,force:true}); });
  await queue.ready;
  async function clip(id='one',duration=1) {
    const source=path.join(dir,'запись & '+id+'.wav');
    await writeFile(source,await readFile('tests/fixtures/sample.wav'));
    await writeFile(source.replace(/\.wav$/,'.json'),JSON.stringify({id,clean_audio:'clean/test.wav'}));
    return {id,path:source,duration};
  }
  return {dir,speech,queue,clip,launches:()=>launches};
}

for (const pt of [false,true]) test(`Recorder queue uses one cached ${pt?'.pt':'faster-whisper'} model and writes adjacent UTF-8 results`,async t=>{
  const {dir,queue,clip,launches}=await fixture(t,{pt});
  const first=await clip('one'),second=await clip('two');
  const metadata=await readFile(first.path.replace(/\.wav$/,'.json'),'utf8');
  const original=await readFile(first.path);
  await Promise.all([queue.submit(first,true),queue.submit(first,true)]); await queue.submit(second,true);
  await until(()=>queue.items.every(item=>item.status==='done')&&!queue.busy);
  assert.equal(launches(),1);assert.equal(await readFile(path.join(dir,'loads'),'utf8'),'load\n');
  assert.deepEqual(await readFile(first.path),original);
  assert.equal(await readFile(first.path.replace(/\.wav$/,'.json'),'utf8'),metadata);
  const text=await queue.text('one');assert.match(text.text,/Распознано/);
  assert.equal(text.savedPath,first.path.replace(/\.wav$/,'.txt'));
  const info=JSON.parse(await readFile(first.path.replace(/\.wav$/,'.transcription.json'),'utf8'));
  assert.equal(info.status,'done');assert.equal(info.savedPath,text.savedPath);assert.equal(info.settings.params.cpu_threads,4);
  await queue.submit(first,true);assert.equal(queue.items.length,2);
  await queue.retry('one');await until(()=>queue.items[0].status==='done'&&!queue.busy);
  assert.match(queue.items[0].savedPath,/-transcript-2\.txt$/);
  assert.equal(await readFile(text.savedPath,'utf8'),text.text);
});

test('Auto-off saves history without opening Whisper; only known IDs can be retried',async t=>{
  const {queue,clip,launches}=await fixture(t);
  await queue.submit(await clip(),false);assert.equal(launches(),0);
  assert.equal(queue.items[0].status,'not_requested');
  await assert.rejects(queue.retry('../../secret'),/не найден/);
  await assert.rejects(queue.text('unknown'),/не найден/);
  await queue.retry('one');await until(()=>queue.items[0].status==='done');
  assert.equal(launches(),1);
});

test('Empty speech result creates no TXT and does not stop later clips',async t=>{
  const {queue,clip}=await fixture(t);
  const empty=await clip('empty');await queue.submit(empty,true);
  await queue.submit(await clip('one'),true);
  await until(()=>queue.items[1].status==='done'&&!queue.busy);
  assert.equal(queue.items[0].status,'empty');assert.equal(queue.paused,false);
  await assert.rejects(readFile(empty.path.replace(/\.wav$/,'.txt')),error=>error.code==='ENOENT');
});

test('Queue waits for manual Whisper and processes files serially',async t=>{
  const {speech,queue,clip}=await fixture(t);
  await speech.saveParameters({cpu_threads:4});
  const source=await clip('manual');
  const manual=speech.run(7,'manual-job',source.path);
  await queue.submit(await clip('auto'),true);
  assert.equal(queue.items[0].status,'queued');
  await manual; await until(()=>queue.items[0].status==='done'&&!queue.busy);
});

test('User can pause pending jobs, change Whisper settings and resume',async t=>{
  const {speech,queue,clip,launches}=await fixture(t);
  await queue.pause();await queue.submit(await clip('one'),true);
  assert.equal(launches(),0);assert.equal(queue.items[0].status,'queued');
  await speech.saveParameters({beam_size:3});await queue.resume();
  await until(()=>queue.items[0].status==='done'&&!queue.busy);
  assert.equal(queue.items[0].settings.params.beam_size,3);
});

test('Model failure pauses the backlog; correcting it and retrying resumes safely',async t=>{
  const {dir,queue,clip}=await fixture(t);
  await writeFile(path.join(dir,'fail'),'fail');
  await queue.submit(await clip('one'),true);await queue.submit(await clip('two'),true);
  await until(()=>queue.items[0].status==='error'&&!queue.current);
  assert.equal(queue.paused,true);assert.equal(queue.items[1].status,'queued');
  await rm(path.join(dir,'fail'));await queue.retry('one');
  await until(()=>queue.items.every(item=>item.status==='done')&&!queue.busy);
});

test('Cancellation stops the active persistent worker and keeps WAV; restart retains history',async t=>{
  const {dir,speech,queue,clip}=await fixture(t,{wait:true});
  const source=await clip('one');const original=await readFile(source.path);
  await queue.submit(source,true);
  await until(()=>queue.items[0].message.includes('Распознаём'));
  await queue.cancel('one');await until(()=>queue.items[0].status==='cancelled'&&!queue.busy);
  assert.equal(speech.job,null);assert.deepEqual(await readFile(source.path),original);
  const restored=new VoiceTranscripts(path.join(dir,'settings'),speech);
  await restored.ready;assert.equal(restored.items[0].status,'cancelled');
  await restored.shutdown();
});

test('Bounded backlog marks overflow as retryable without deleting recordings',async t=>{
  const {queue,clip,launches}=await fixture(t);queue.paused=true;
  for(let i=0;i<25;i++)await queue.submit(await clip('n'+i),true);
  assert.equal(queue.items.filter(item=>item.status==='queued').length,24);
  assert.equal(queue.items[24].status,'error');assert.match(queue.items[24].message,/Очередь заполнена/);
  assert.equal(launches(),0);assert.ok((await readFile(queue.items[24].path)).length>44);
});

test('Transcript DOM shows safe inline text, known-ID actions and editable shared settings',async t=>{
  const dom=new JSDOM('<main></main>',{url:'https://local.test'});
  const old={window:globalThis.window,document:globalThis.document};Object.assign(globalThis,{window:dom.window,document:dom.window.document});
  t.after(()=>{Object.assign(globalThis,old);dom.window.close();});
  const {mountTranscripts}=await import('../dist/recorder-transcripts.js');
  let listener;const retry=[],chosen=[],saved=[];
  const state={pending:0,limit:24,items:[{id:'one',status:'done',duration:1,path:'record.wav',savedPath:'record.txt',message:'Готово'}]};
  const params=Object.fromEntries(defaults.fields.map(field=>[field.key,field.default]));
  const config={...defaults.paths,params,schema:defaults.fields};
  const api={voiceTranscripts:async()=>state,onVoiceTranscripts:fn=>{listener=fn;return()=>{};},voiceText:async()=>({text:'<img src=x onerror=alert(1)>',savedPath:'record.txt'}),voiceRetry:async id=>{retry.push(id);return state;},speechSettings:async()=>config,speechChoose:async kind=>{chosen.push(kind);return{...config,model:'new model'};},speechSave:async values=>{saved.push(values);return{...config,params:values};}};
  const {section}=mountTranscripts(dom.window.document.querySelector('main'),api,fn=>fn());
  await new Promise(resolve=>setImmediate(resolve));
  [...section.querySelectorAll('button')].find(b=>b.textContent==='Показать текст').click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(section.querySelector('textarea[data-text-output]').value,'<img src=x onerror=alert(1)>');assert.equal(section.querySelectorAll('img').length,0);
  [...section.querySelectorAll('button')].find(b=>b.textContent==='Распознать снова').click();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(retry,['one']);
  section.querySelector('[data-whisper-settings]').open=true;await new Promise(resolve=>setTimeout(resolve,10));
  const temperature=section.querySelector('[name="temperature"]');temperature.value='0.4';temperature.dispatchEvent(new dom.window.Event('input'));
  section.querySelector('[data-whisper-choose="model-folder"]').click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(temperature.value,'0.4');assert.deepEqual(chosen,['model-folder']);
  section.querySelector('[data-whisper-save]').click();await new Promise(resolve=>setImmediate(resolve));assert.equal(saved[0].temperature,0.4);
  listener({...state,paused:true,problem:'Ошибка модели'});assert.equal(section.querySelector('[data-resume]').hidden,false);
});

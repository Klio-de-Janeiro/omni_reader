import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const { RecorderService, parameters } = require('../desktop/recorder.cjs');
const exec = promisify(execFile);

async function fixture(t, code) {
  const dir = await mkdtemp(path.join(process.cwd(), 'voice test & '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'worker.py');
  await writeFile(script, code || `import json, sys\nc=json.loads(sys.stdin.readline())\nif c.get('command')=='devices':\n print(json.dumps({'type':'devices','devices':[{'key':'микрофон','name':'микрофон'}]}),flush=True)\nelse:\n print(json.dumps({'type':'ready'}),flush=True)\n for line in sys.stdin:\n  if json.loads(line).get('command')=='stop': break\n print(json.dumps({'type':'clip','id':'one','path':'запись.wav','duration':1.5,'used_mb':1}),flush=True)\n print(json.dumps({'type':'stopped'}),flush=True)\n`);
  return { dir, script };
}
async function until(check) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5000) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function runtimeFixture(t) {
  const { dir } = await fixture(t), voice = path.join(dir, 'desktop', 'voice'), scripts = path.join(dir, 'scripts');
  await mkdir(voice, { recursive:true }); await mkdir(scripts, { recursive:true });
  for (const name of ['record.py','vad.py','segments.py']) await cp(path.join('desktop','voice',name), path.join(voice,name));
  const checker = path.join(scripts, 'check-voice-runtime.py');
  await cp('scripts/check-voice-runtime.py', checker);
  return { dir, voice, checker };
}

async function localModelFixture(dir) {
  await mkdir(path.join(dir, 'silero_vad', 'data'), { recursive: true });
  await writeFile(path.join(dir, 'silero_vad', '__init__.py'), 'raise RuntimeError("Silero package code must not be imported")');
  await writeFile(path.join(dir, 'silero_vad', 'data', 'silero_vad.onnx'), 'model placeholder');
  for (const name of ['torch', 'torchaudio', 'onnxruntime']) await writeFile(path.join(dir, name + '.py'), 'raise RuntimeError("' + name + ' must not be imported")');
  await writeFile(path.join(dir, 'sherpa_onnx.py'), `import numpy as np
from types import SimpleNamespace
class VadModelConfig:
 def __init__(self): self.silero_vad = SimpleNamespace()
 def validate(self):
  assert self.silero_vad.model.endswith('silero_vad.onnx')
  assert self.sample_rate == 16000 and self.provider == 'cpu'
  assert self.num_threads == 1 and self.silero_vad.window_size == 512
  return True
class VadModel:
 @staticmethod
 def create(config): return VadModel()
 def window_size(self): return 576
 def reset(self): pass
 def is_speech(self, samples):
  assert samples.shape == (576,) and samples.dtype == np.float32
  return True
`);
}

test('VAD segmentation and WAV storage use real PCM and no ML dependencies', async () => {
  const result = await exec('python3', ['tests/voice_segments_test.py'], { cwd: process.cwd() });
  assert.match(result.stderr, /OK/);
});
test('Native Silero preserves PCM/context, applies the threshold and resets after warmup', async () => {
  const result = await exec('python3', ['tests/voice_vad_test.py'], { cwd: process.cwd() });
  assert.match(result.stderr, /OK/);
});
test('Recorder settings validate, persist, and never accept renderer paths', async t => {
  const { dir, script } = await fixture(t), service = new RecorderService(dir, script, async () => 'python3');
  assert.equal((await service.settings()).threshold, 0.5);
  await service.save({ threshold: 0.65, silence_ms: 900, quota_mb: 300, device: 'Микрофон' });
  assert.equal((await new RecorderService(dir, script, async () => 'other').settings()).device, 'Микрофон');
  assert.equal((await service.settings()).enhance, true);
  for (const invalid of [{ threshold: NaN }, { quota_mb: -1 }, { silence_ms: 10 }, { silence_ms: 12001 }, { enhance: 'true' }, { max_seconds: 601 }, { pre_ms: -1 }, { python: 'evil.exe' }, { constructor: 1 }]) assert.throws(() => parameters(invalid));
  assert.equal((await service.devices())[0].name, 'микрофон');
});
test('One background worker survives windows; stop flushes audio and unlocks settings', async t => {
  const { dir, script } = await fixture(t), events = [];
  const service = new RecorderService(dir, script, async () => 'python3', event => events.push(event));
  t.after(() => service.shutdown());
  assert.equal(service.start().phase, 'starting');
  assert.throws(() => service.start(), /завершения/);
  await assert.rejects(service.save({}), /завершения/);
  await until(() => service.state.phase === 'listening');
  await service.stop();
  assert.equal(service.active, false);
  assert.equal(service.state.phase, 'stopped');
  assert.equal(service.state.clips, 1);
  assert.equal(service.state.seconds, 1.5);
  assert.equal(service.state.recent[0].path, 'запись.wav');
  assert.ok(events.some(event => event.phase === 'stopping'));
  await service.save({});
  service.start(); await until(() => service.state.phase === 'listening'); await service.stop();
  assert.equal(service.state.clips, 1);
});
test('Stop during startup cannot launch a late microphone process', async t => {
  const { dir, script } = await fixture(t);
  let release, calls = 0;
  const service = new RecorderService(dir, script, () => new Promise(resolve => { release = resolve; }), () => {}, { spawn() { calls++; throw new Error('must not spawn'); } });
  service.start(); await until(() => release);
  const stopped = service.stop(); release('python3'); await stopped;
  assert.equal(calls, 0); assert.equal(service.state.phase, 'stopped');
});
test('Worker failure leaves a visible error and permits restart', async t => {
  const { dir, script } = await fixture(t, `import json, sys\njson.loads(sys.stdin.readline())\nprint(json.dumps({'type':'error','message':'Нет микрофона'}),flush=True)\nsys.exit(1)\n`);
  const service = new RecorderService(dir, script, async () => 'python3');
  service.start(); await until(() => !service.active);
  assert.equal(service.state.phase, 'error'); assert.match(service.state.message, /^Нет микрофона/);
  assert.equal(JSON.parse(await readFile(service.state.diagnostic_log, 'utf8')).error, 'Нет микрофона');
  await service.save({});
});
test('Python capture worker exits on parent pipe EOF and loads only local ONNX without Torch', async t => {
  const { dir } = await fixture(t);
  await localModelFixture(dir);
  await writeFile(path.join(dir, 'sounddevice.py'), '# no microphone may be opened after parent EOF\n');
  const runner = path.join(dir, 'parent.py');
  await writeFile(runner, `import subprocess,sys,json\np=subprocess.run([sys.executable,'-u',sys.argv[1]],input='{"command":"record"}\\n',text=True,capture_output=True,timeout=10)\nprint(p.stdout)\nif p.returncode: raise RuntimeError(p.stderr)\nassert '"type": "stopped"' in p.stdout\n`);
  const { stdout } = await exec('python3', [runner, path.resolve('desktop/voice/record.py')], { env: { ...process.env, PYTHONPATH: dir } });
  assert.match(stdout, /stopped/);
});

test('Desktop IPC rejects untrusted callers; tray stop restores the window; quit stops capture', async () => {
  const handlers = new Map(), app = new EventEmitter(), powerMonitor = new EventEmitter();
  let quit = 0, currentTray, service, dataset, assistant;
  Object.assign(app, { getPath: () => '/data', quit: () => quit++, isPackaged: false });
  class Tray extends EventEmitter {
    constructor() { super(); currentTray = this; }
    setToolTip(text) { this.tip = text; }
    setContextMenu(items) { this.items = items; }
    destroy() { this.destroyed = true; }
  }
  class FakeRecorder {
    constructor(_d, _s, getPython, report) { service = this; this.getPython = getPython; this.report = report; this.active = false; }
    assertIdle() { if (this.active) throw new Error('active'); }
    snapshot() { return { active: this.active }; }
    start() { this.active = true; this.report({ active:true, message:'Listening' }); return this.snapshot(); }
    async stop() { this.active = false; this.report({ active:false, message:'Stopped' }); }
    async shutdown() { await this.stop(); }
  }
  const window = new EventEmitter();
  Object.assign(window, { visible: true, hidden: 0, isDestroyed:()=>false, isMinimized:()=>false, isVisible:()=>window.visible, show:()=>window.visible=true, hide:()=>{ window.visible=false; window.hidden++; }, focus() {}, webContents: { send() {} } });
  const state = { window }, windows = new Map([[1, state]]), exported = {};
  vm.runInNewContext(await readFile('desktop/voice-desktop.cjs', 'utf8'), {
    require(name) {
      if (name === 'electron') return { app, Tray, Menu: { buildFromTemplate: value => value }, ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, powerMonitor };
      if (name === './recorder.cjs') return { RecorderService: FakeRecorder };
      if (name === './voice-commands.cjs') return { VoiceCommands: class {
        constructor(_dir, _speech, report) { assistant = this; this.report = report; this.busy = false; this.ready = Promise.resolve(); }
        cancel() { this.busy = false; }
        async shutdown() { this.cancel(); }
      } };
      if (name === './voice-transcripts.cjs') return { VoiceTranscripts: class {
        constructor() { this.busy = false; this.ready = Promise.resolve(); }
        suspend() {}
        async shutdown() {}
      } };
      if (name === './voice-dataset.cjs') return { DEFAULT_MODEL: 'speaker.onnx', VoiceDataset: class {
        constructor(_dir, _script, options) { dataset = this; this.report = options.report; this.busy = false; this.ready = Promise.resolve(); this.captureRole = 'candidate'; }
        async seed() {}
        async noteTranscript() {}
        async shutdown() {}
        cancel() {}
      } };
      return require(name);
    }, __dirname: '/desktop', process, module: exported
  });
  const control = exported.exports.installRecorder({ windows, createWindow:()=>state, senderState:event=>{ if (event !== 'trusted') throw new Error('Invalid sender'); return state; }, speech:{} });
  assert.equal(await service.getPython(), path.join('/data', 'Desktop', 'omni_voice_env', 'Scripts', 'python.exe'));
  control.attachWindow(window);
  assert.throws(() => handlers.get('omni-recorder-start')('iframe'), /Invalid sender/);
  for (const action of ['auto','retry','text','cancel-transcript','transcripts','resume-transcripts']) assert.throws(() => handlers.get('omni-recorder-' + action)('iframe'), /Invalid sender/);
  for (const action of ['status','list','detail','audio','review','recognize','analyze','cancel','auto','record-reference','choose','import','export']) assert.throws(() => handlers.get('omni-voice-dataset-' + action)('iframe'), /Invalid sender/);
  for (const action of ['status','save','models','text','select','list','reminders','history','retry','reject','confirm','cancel']) assert.throws(() => handlers.get('omni-voice-assistant-' + action)('iframe'), /Invalid sender/);
  handlers.get('omni-recorder-start')('trusted');
  assert.equal(control.keepAlive, true);
  let prevented = 0; window.emit('close', { preventDefault:()=>prevented++ });
  assert.equal(prevented, 1); assert.equal(window.visible, false);
  currentTray.items[1].click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(window.visible, true); assert.equal(currentTray.destroyed, true);
  dataset.busy = true; dataset.report({ busy: true });
  window.emit('close', { preventDefault:()=>prevented++ });
  assert.equal(control.keepAlive, true); assert.equal(window.visible, false);
  dataset.busy = false; dataset.report({ busy: false });
  assert.equal(window.visible, true); assert.equal(currentTray.destroyed, true);
  assistant.busy = true; assistant.report({ busy:true });
  window.emit('close', { preventDefault:()=>prevented++ }); assert.equal(window.visible, false); assert.equal(control.keepAlive, true);
  assistant.busy = false; assistant.report({ busy:false }); assert.equal(window.visible, true);
  handlers.get('omni-recorder-start')('trusted'); powerMonitor.emit('suspend');
  assert.equal(service.active, false);
  handlers.get('omni-recorder-start')('trusted'); app.emit('before-quit', { preventDefault:()=>prevented++ });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.active, false); assert.equal(quit, 1);
});

test('Desktop panel persists recording when closed; web/mobile never get controls', async t => {
  const dom = new JSDOM('<aside class="sidebar"></aside>', { url:'https://local.test' });
  const old = Object.fromEntries(['window','document','Option'].map(key=>[key,globalThis[key]]));
  Object.assign(globalThis, { window:dom.window, document:dom.window.document, Option:dom.window.Option });
  t.after(()=>{ for (const [key,value] of Object.entries(old)) if (value===undefined) delete globalThis[key]; else globalThis[key]=value; dom.window.close(); });
  const { mountRecorder } = await import('../dist/recorder-ui.js');
  assert.equal(mountRecorder({}), undefined);
  let starts = 0, stops = 0, report;
  const config = { device:'',threshold:0.5,silence_ms:700,quota_mb:500,python:'python',folder:'records' };
  const status = { active:false,phase:'stopped',clips:0,seconds:0,recent:[] };
  const pauses = [];
  const api = { recorderStart:async()=>{ starts++; return {...status,active:true,phase:'starting'}; },recorderStop:async()=>{stops++;return status;},recorderSettings:async()=>config,recorderStatus:async()=>status,recorderSave:async value=>({...config,...value}),recorderSilence:async value=>{pauses.push(value);return {...config,silence_ms:value};},onRecorderState:fn=>{report=fn;return()=>{};} };
  const { panel,launcher,indicator,settingsButton } = mountRecorder(api);
  panel.showModal=()=>panel.setAttribute('open',''); panel.close=()=>panel.removeAttribute('open');
  await new Promise(resolve=>setImmediate(resolve));
  launcher.click(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(panel.open,false);
  assert.equal(starts,1); assert.equal(indicator.hidden,false);
  api.recorderStatus = async () => ({...status,active:true,phase:'listening'});
  settingsButton.click(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(panel.open,true);
  panel.querySelector('[data-silence="8000"]').click(); await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(pauses,[8000]); assert.equal(starts,1);
  assert.equal(panel.querySelector('[name="threshold"]').disabled,true);
  assert.equal(panel.querySelector('[name="silence_ms"]').disabled,false);
  panel.querySelector('[data-action="close"]').click(); assert.equal(stops,0);
  report({...status,active:true,phase:'speech',message:'Речь'});
  launcher.click(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stops,1); assert.equal(indicator.hidden,true);
});

test('Silence changes persist and reach the same running worker', async t => {
  const { dir, script } = await fixture(t, `import json,sys\njson.loads(sys.stdin.readline())\nprint(json.dumps({'type':'ready'}),flush=True)\nfor line in sys.stdin:\n c=json.loads(line)\n if c['command']=='stop': break\n if c['command']=='silence': print(json.dumps({'type':'warning','message':'pause='+str(c['silence_ms'])}),flush=True)\n`);
  const service = new RecorderService(dir, script, async () => 'python3');
  t.after(() => service.shutdown());
  assert.equal((await service.settings()).silence_ms,5000);
  service.start(); await until(() => service.state.phase === 'listening');
  const process = service.job.process;
  await service.setSilence(12000);
  await until(() => service.state.warning === 'pause=12000');
  assert.equal(service.job.process,process);
  assert.equal((await service.settings()).silence_ms,12000);
  await service.stop();
});

test('Auto-transcription switch changes the next saved clip without restarting capture', async t => {
  const { dir, script } = await fixture(t), clips = [];
  const service = new RecorderService(dir, script, async () => 'python3', () => {}, { onClip: (clip, enabled) => clips.push({ clip, enabled }) });
  t.after(() => service.shutdown());
  assert.equal((await service.settings()).auto_transcribe,false);
  service.start(); await until(() => service.state.phase === 'listening');
  const process = service.job.process;
  await service.setAuto(true);
  assert.equal(service.job.process,process);
  assert.equal((await service.settings()).auto_transcribe,true);
  await service.stop();
  assert.equal(clips.length,1);assert.equal(clips[0].enabled,true);
  assert.equal(clips[0].clip.path,'запись.wav');
  await assert.rejects(service.setAuto('true'));
});

test('A hung microphone process is forcibly stopped within the bounded shutdown window', async t => {
  const { dir, script } = await fixture(t, `import json,sys,time\njson.loads(sys.stdin.readline())\nprint(json.dumps({'type':'ready'}),flush=True)\ntime.sleep(60)\n`);
  const service = new RecorderService(dir, script, async () => 'python3');
  t.after(() => service.shutdown());
  service.start(); await until(() => service.state.phase === 'listening');
  const started = Date.now(); await service.stop();
  assert.ok(Date.now() - started < 8000);
  assert.equal(service.active, false);
  assert.equal(service.state.phase, 'error');
  assert.match(service.state.message, /не ответил на остановку/);
});

test('Malformed worker output is rejected and shuts down the recorder', async t => {
  const { dir, script } = await fixture(t, `import json,sys,time\njson.loads(sys.stdin.readline())\nprint('not JSON',flush=True)\ntime.sleep(60)\n`);
  const service = new RecorderService(dir, script, async () => 'python3');
  t.after(() => service.shutdown());
  service.start(); await until(() => !service.active);
  assert.match(service.state.message, /Некорректный ответ/);
});

test('Silero self-check never imports PortAudio or Torch; recording reports audio import separately', async t => {
  const { dir } = await fixture(t);
  await localModelFixture(dir);
  await writeFile(path.join(dir, 'sounddevice.py'), `import sys\nassert 'torch' not in sys.modules and 'torchaudio' not in sys.modules and 'onnxruntime' not in sys.modules\nassert 'sherpa_onnx' in sys.modules\nraise RuntimeError('test_audio_import_after_onnx')\n`);
  const runner = path.join(dir, 'check.py');
  await writeFile(runner, `import subprocess,sys,json\nworker=sys.argv[1]\na=subprocess.run([sys.executable,'-u',worker],input='{"command":"check"}\\n',text=True,capture_output=True,timeout=10)\nassert a.returncode==0, a.stdout+a.stderr\nassert '"type": "checked"' in a.stdout\np=subprocess.Popen([sys.executable,'-u',worker],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)\np.stdin.write('{"command":"record"}\\n');p.stdin.flush()\nevents=[]\nfor line in p.stdout:\n events.append(json.loads(line))\nassert events[-1]['type']=='error' and 'test_audio_import_after_onnx' in events[-1]['message'],events\nassert any(e.get('stage')=='audio' for e in events)\np.wait(timeout=10)\np.stdin.close()\nprint('import_order_and_self_check_OK')\n`);
  const { stdout } = await exec('python3', [runner, path.resolve('desktop/voice/record.py')], { env: { ...process.env, PYTHONPATH:dir } });
  assert.match(stdout, /self_check_OK/);
});

test('Legacy runtime diagnostics still report installed version when Torch DLL import fails', async t => {
  const { dir } = await fixture(t);
  await mkdir(path.join(dir, 'torch-2.10.0.dist-info'));
  await writeFile(path.join(dir, 'torch-2.10.0.dist-info', 'METADATA'), 'Metadata-Version: 2.1\nName: torch\nVersion: 2.10.0\n');
  await writeFile(path.join(dir, 'torch.py'), 'raise OSError("test c10.dll failed to initialize")');
  await assert.rejects(exec('python3', [path.resolve('scripts/check-voice-runtime.py'), '--torch'], { env: { ...process.env, PYTHONPATH:dir } }), error => {
    assert.equal(error.code,1);
    assert.match(error.stdout,/Installed torch: 2\.10\.0/);
    assert.match(error.stdout,/Architecture:/);
    assert.match(error.stderr,/c10.dll failed/);
    return true;
  });
});

test('A blocked startup phase reports its Python, stage and stderr in a bounded log', async t => {
  const { dir, script } = await fixture(t, `import json,sys,time\njson.loads(sys.stdin.readline())\nprint(json.dumps({'type':'startup','stage':'onnx','message':'Загрузка ONNX'}),flush=True)\nprint('native DLL diagnostic',file=sys.stderr,flush=True)\ntime.sleep(60)\n`);
  const service = new RecorderService(dir, script, async () => 'python3', () => {}, { phaseTimeoutMs: 300 });
  t.after(() => service.shutdown());
  service.start(); await until(() => !service.active);
  assert.match(service.state.message, /sherpa-onnx/);
  assert.match(service.state.message, /Python: python3/);
  assert.match(service.state.message, /native DLL diagnostic/);
  assert.doesNotMatch(service.state.message, /Silero не запустился за 60/);
  const log = JSON.parse(await readFile(service.state.diagnostic_log, 'utf8'));
  assert.equal(log.last_stage, 'onnx'); assert.equal(log.stages[0].stage, 'onnx');
  assert.match(log.stderr, /native DLL diagnostic/);
  await service.save({});
});

test('Progressing startup gets a separate bounded deadline for each stage', async t => {
  const { dir, script } = await fixture(t, `import json,sys,time\njson.loads(sys.stdin.readline())\nfor phase in ['onnx','model','stream']:\n print(json.dumps({'type':'startup','stage':phase,'message':phase}),flush=True)\n time.sleep(0.12)\nprint(json.dumps({'type':'ready','engine':'silero-onnx-cpu'}),flush=True)\nfor line in sys.stdin:\n if json.loads(line).get('command')=='stop':break\n`);
  const service = new RecorderService(dir, script, async () => 'python3', () => {}, { phaseTimeoutMs: 300, startupLimitMs: 2000 });
  t.after(() => service.shutdown());
  service.start(); await until(() => service.state.phase === 'listening');
  assert.equal(service.state.engine, 'silero-onnx-cpu');
  await service.stop(); assert.equal(service.state.phase, 'stopped');
});

test('Repeated progress cannot extend the overall startup limit indefinitely', async t => {
  const { dir, script } = await fixture(t, `import json,sys,time\njson.loads(sys.stdin.readline())\nwhile True:\n for phase in ['onnx','model']:\n  print(json.dumps({'type':'startup','stage':phase,'message':phase}),flush=True)\n  time.sleep(0.05)\n`);
  const service = new RecorderService(dir, script, async () => 'python3', () => {}, { phaseTimeoutMs: 300, startupLimitMs: 500 });
  t.after(() => service.shutdown());
  service.start(); await until(() => !service.active);
  assert.equal(service.state.phase, 'error');
  assert.match(service.state.message, /не завершился/);
});

test('Stopping during initialization preserves cancellation instead of a startup timeout', async t => {
  const { dir, script } = await fixture(t, `import json,sys,time\njson.loads(sys.stdin.readline())\nprint(json.dumps({'type':'startup','stage':'model','message':'Loading'}),flush=True)\nfor line in sys.stdin:\n if json.loads(line).get('command')=='stop':\n  time.sleep(0.3)\n  break\n`);
  const service = new RecorderService(dir, script, async () => 'python3', () => {}, { phaseTimeoutMs: 150 });
  t.after(() => service.shutdown());
  service.start(); await until(() => service.state.startup_stage === 'model');
  await service.stop(); assert.equal(service.state.phase, 'stopped');
});

test('Recorder self-check bypasses broken Python ONNX Runtime and Torch', async t => {
  const { dir, voice, checker } = await runtimeFixture(t);
  await localModelFixture(voice);
  await mkdir(path.join(dir, 'onnxruntime-1.24.2.dist-info'));
  await writeFile(path.join(dir, 'onnxruntime-1.24.2.dist-info', 'METADATA'), 'Metadata-Version: 2.1\nName: onnxruntime\nVersion: 1.24.2\n');
  await writeFile(path.join(voice, 'torch.py'), 'raise RuntimeError("Torch must not be imported")');
  await writeFile(path.join(voice, 'onnxruntime.py'), 'raise OSError("test ONNX DLL failed to initialize")');
  const result = await exec('python3', [checker], { env: { ...process.env, PYTHONPATH:dir } });
  assert.match(result.stdout, /Installed onnxruntime: 1\.24\.2/);
  assert.match(result.stdout, /Voice environment self-check: OK/);
  assert.match(result.stdout, /sherpa-onnx/);
  assert.doesNotMatch(result.stderr, /test ONNX DLL|Torch must not/);
});

test('Native engine DLL failure reports its exact phase and repair command', async t => {
  const { voice, checker } = await runtimeFixture(t);
  await localModelFixture(voice);
  await writeFile(path.join(voice, 'sherpa_onnx.py'), 'raise OSError("test native CPU DLL failed to initialize")');
  await assert.rejects(exec('python3', [checker]), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /Загрузка CPU-движка sherpa-onnx/);
    assert.match(error.stderr, /test native CPU DLL/);
    assert.match(error.stdout, /SETUP_VOICE_WINDOWS\.ps1 -InstallVCRuntime/);
    assert.doesNotMatch(error.stderr, /must not be imported/); return true;
  });
});

test('A frozen native import is terminated by the setup self-check', async t => {
  const { voice, checker } = await runtimeFixture(t);
  await writeFile(path.join(voice, 'sherpa_onnx.py'), 'import time\ntime.sleep(60)');
  const started = Date.now();
  await assert.rejects(exec('python3', [checker, '--timeout', '1']), error => {
    assert.equal(error.code, 1); assert.match(error.stdout, /Загрузка CPU-движка sherpa-onnx/);
    assert.match(error.stderr, /Self-check timed out/); assert.ok(Date.now() - started < 4000); return true;
  });
});

test('Isolated NumPy check ignores foreign PYTHONHOME/PYTHONPATH and does not load audio or VAD', async t => {
  const { dir } = await fixture(t);
  await writeFile(path.join(dir, 'numpy.py'), 'raise RuntimeError("Foreign NumPy must not be imported")');
  const result = await exec('python3', ['-I','-X','utf8',path.resolve('scripts/check-voice-runtime.py'),'--numpy-only','--timeout','10'], {
    env:{ ...process.env, PYTHONPATH:dir, PYTHONHOME:path.join(dir,'foreign-python'), PYTHONUSERBASE:dir }
  });
  assert.match(result.stdout, /Checking NumPy CPU/); assert.match(result.stdout, /numpy-cpu/);
  assert.match(result.stdout, /"isolated": true/); assert.match(result.stdout, /numpy_path/);
  assert.doesNotMatch(result.stdout, /Загрузка CPU-движка|Загрузка библиотеки микрофона/);
  assert.doesNotMatch(result.stderr, /Foreign NumPy/);
});

test('Recorder launches a Python worker in isolated UTF-8 mode despite inherited Python variables', async t => {
  const { dir, script } = await fixture(t, `import json,sys\njson.loads(sys.stdin.readline())\nassert sys.flags.isolated and sys.flags.utf8_mode\nprint(json.dumps({'type':'ready'}),flush=True)\nfor line in sys.stdin:\n if json.loads(line).get('command')=='stop':break\n`);
  const { spawn } = await import('node:child_process');
  const service = new RecorderService(dir, script, async () => 'python3', () => {}, { spawn:(command,args,options) => spawn(command,args,{ ...options, env:{...options.env,PYTHONHOME:path.join(dir,'invalid'),PYTHONPATH:dir} }) });
  t.after(() => service.shutdown());
  service.start(); await until(() => service.state.phase==='listening'); await service.stop();
  assert.equal(service.state.phase, 'stopped');
});

test('Frozen NumPy import leaves a real Python stack in startup diagnostics before bounded shutdown', async t => {
  const { dir, voice } = await runtimeFixture(t), script=path.join(voice,'record.py');
  await writeFile(script,(await readFile(script,'utf8')).replace('STACK_DUMP_SECONDS = 15','STACK_DUMP_SECONDS = 0.05'));
  await writeFile(path.join(voice,'numpy.py'),'import time\ntime.sleep(60)');
  const service = new RecorderService(dir, script, async () => 'python3', () => {}, { phaseTimeoutMs:400 });
  t.after(() => service.shutdown());
  service.start(); await until(() => !service.active);
  assert.match(service.state.message,/загрузка NumPy/);
  const log=JSON.parse(await readFile(service.state.diagnostic_log,'utf8'));
  assert.equal(log.last_stage,'numpy'); assert.equal(log.runtime.isolated,true);
  assert.match(log.stderr,/Timeout/); assert.match(log.stderr,/numpy\.py/);
  await service.save({});
});

test('Repair setup reinstalls the scientific wheels and checks NumPy before the VAD runtime', async () => {
  const setup = await readFile('SETUP_VOICE_WINDOWS.ps1','utf8');
  assert.match(setup,/--force-reinstall[^\n]*numpy==2\.2\.6/);
  assert.ok(setup.indexOf('--numpy-only') < setup.indexOf("'sherpa-onnx==1.13.8'"));
  assert.match(setup,/--audio --timeout 300/);
});

test('A cold NumPy import that takes 60 seconds survives the previous 30-second cutoff', async t => {
  const { dir, script } = await fixture(t), timers = new Map(), exported = {};
  let clock = 0, id = 0, kills = 0;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = { on() {}, write() {}, end() { queueMicrotask(() => child.emit('close',0)); } };
  child.kill = () => { kills++; child.emit('close',0); };
  class Clock extends Date { constructor(value) { super(value ?? clock); } static now() { return clock; } }
  vm.runInNewContext(await readFile('desktop/recorder.cjs','utf8'), {
    require, process, Buffer, Date:Clock, module:exported,
    setTimeout:(action, delay) => { const key=++id; timers.set(key,{action,at:clock+delay}); return key; },
    clearTimeout:key => timers.delete(key), setInterval:() => ++id, clearInterval() {}
  });
  const service = new exported.exports.RecorderService(dir,script,async () => 'python3',() => {},{spawn:() => child});
  t.after(() => service.shutdown()); service.start(); await until(() => service.job?.process);
  const emit = event => child.stdout.emit('data',Buffer.from(JSON.stringify(event)+'\n'));
  emit({type:'startup',stage:'numpy',message:'Загрузка NumPy'});
  function advance(value) {
    const until=clock+value;
    for (;;) {
      const due=[...timers].filter(([,task]) => task.at<=until).sort((a,b) => a[1].at-b[1].at)[0];
      if (!due) break;
      clock=due[1].at; timers.delete(due[0]); due[1].action();
    }
    clock=until;
  }
  advance(31000); assert.equal(service.active,true); assert.equal(kills,0);
  advance(29000); emit({type:'ready'}); assert.equal(service.state.phase,'listening');
  await service.stop(); assert.equal(service.state.phase,'stopped'); assert.equal(kills,0);
});

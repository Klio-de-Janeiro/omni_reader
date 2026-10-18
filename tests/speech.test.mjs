import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { mountSpeech } from '../dist/speech-ui.js';
const { SpeechService } = createRequire(import.meta.url)('../desktop/speech.cjs');
const defaults = createRequire(import.meta.url)('../desktop/speech-defaults.json');
const defaultParams = Object.fromEntries(defaults.fields.map(field => [field.key, field.default]));
const root = fileURLToPath(new URL('../', import.meta.url));
const worker = path.join(root, 'desktop/speech/transcribe.py');
let python;
try { python = execFileSync(process.env.OMNI_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(); } catch {}

/** Exercise the real subprocess protocol with deterministic model doubles, without downloading models. */
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(root, '../Whisper русский & '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modules = path.join(dir, 'modules'), model = path.join(dir, options.folder ? 'модель small' : 'модель small.pt');
  await mkdir(modules);
  // Model doubles never decode audio, but the worker validates FFmpeg before loading .pt.
  const ffmpeg = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  await writeFile(ffmpeg, '', { mode: 0o755 });
  const ext = options.folder ? 'wav' : 'ogg';
  const source = path.join(dir, 'запись & пример.' + ext);
  await writeFile(source, await readFile(path.join(root, 'tests/fixtures/sample.' + ext)));
  if (options.folder) {
    await mkdir(model);
    for (const name of ['model.bin', 'config.json', 'tokenizer.json']) await writeFile(path.join(model, name), '{}');
  } else await writeFile(model, 'checkpoint double');
  const capture = path.join(dir, 'worker-options.json');
  const common = `import os, time, json\nfrom pathlib import Path\nINIT = {}\nassert os.environ['HF_HUB_OFFLINE'] == '1'\nassert os.environ['TRANSFORMERS_OFFLINE'] == '1'\ndef content(source, kwargs):\n    assert Path(source).is_file() and ' & ' in source\n    assert kwargs['language'] in ('ru', 'en', None) and kwargs['task'] in ('transcribe', 'translate')\n    Path(os.environ['OMNI_TEST_CAPTURE']).write_text(json.dumps({'init':INIT,'decode':kwargs}), encoding='utf8')\n    if os.environ.get('OMNI_TEST_WAIT'):\n        while True: time.sleep(0.05)\n    if os.environ.get('OMNI_TEST_FAIL'): raise RuntimeError('Ошибка модели')\n    return os.environ.get('OMNI_TEST_TEXT', 'Привет, мир! Русская речь. 🎤')\n`;
  await writeFile(path.join(modules, 'torch.py'), 'import os\ndef set_num_threads(value):\n    assert 1 <= value <= 32\n    os.environ["OMNI_TEST_THREADS"] = str(value)\n');
  await writeFile(path.join(modules, 'whisper.py'), common + `class Model:\n    def transcribe(self, source, **kwargs):\n        assert kwargs['fp16'] is False and kwargs['verbose'] is False\n        assert 'logprob_threshold' in kwargs and 'log_prob_threshold' not in kwargs\n        print('Library output must not break JSON protocol')\n        return {'text': content(source, kwargs)}\ndef load_model(model, device):\n    assert Path(model).is_file() and model.endswith('.pt') and device == 'cpu'\n    INIT.update(device=device, cpu_threads=int(os.environ['OMNI_TEST_THREADS']))\n    return Model()\n`);
  await writeFile(path.join(modules, 'faster_whisper.py'), common + `from types import SimpleNamespace\nclass WhisperModel:\n    def __init__(self, model, **kwargs):\n        assert Path(model).is_dir() and kwargs['device'] == 'cpu'\n        assert kwargs['compute_type'] in ('int8','float32') and kwargs['local_files_only'] is True\n        assert 1 <= kwargs['cpu_threads'] <= 32\n        INIT.update(kwargs)\n    def transcribe(self, source, **kwargs):\n        assert kwargs['vad_filter'] is False\n        assert 'log_prob_threshold' in kwargs and 'logprob_threshold' not in kwargs\n        text = content(source, kwargs)\n        return iter([SimpleNamespace(text=text)]), None\n`);
  const service = new SpeechService(path.join(dir, 'settings'), worker, {
    spawn(command, args, opts) {
      assert.equal(opts.shell, false);
      if (path.basename(command).toLowerCase() === 'taskkill.exe') {
        assert.deepEqual(args.filter((_, index) => index !== 1), ['/PID', '/T', '/F']);
        return spawn(command, args, opts);
      }
      assert.deepEqual(args, ['-u', worker]);
      return spawn(command, args, { ...opts, env: { ...opts.env, PYTHONPATH: modules, OMNI_TEST_CAPTURE:capture, ...options.env } });
    }
  });
  t.after(() => service.cancel(service.job?.owner, service.job?.id));
  await service.configure('python', python);
  await service.configure('ffmpeg', ffmpeg);
  await service.configure(options.folder ? 'model-folder' : 'model-file', model);
  return { service, dir, source, model, capture };
}

for (const folder of [false, true]) test(`Whisper ${folder ? 'folder' : '.pt'}: real UTF-8 subprocess, CPU settings and non-overwriting adjacent output`, { skip:!python }, async t => {
  const { service, source } = await fixture(t, { folder });
  const events = [], result = await service.run(7, 'job-1', source, message => events.push(message));
  assert.equal(result.savedPath, source.replace(/\.(ogg|wav)$/, '.txt'));
  assert.equal(await readFile(result.savedPath, 'utf8'), 'Привет, мир! Русская речь. 🎤\n');
  assert.equal(events[0].id, 'job-1');
  assert.ok(events.some(event => event.type === 'status'));
  assert.equal(events.some(event => event.type === 'segment'), folder);
  const again = await service.run(7, 'job-2', source);
  assert.match(again.savedPath, /-transcript-2\.txt$/);
  assert.equal(await readFile(result.savedPath, 'utf8'), result.text + '\n');
  assert.equal((await service.settings()).python, path.resolve(python));
});

test('Whisper silence and model error do not create transcript files', { skip:!python }, async t => {
  for (const env of [{ OMNI_TEST_TEXT: '' }, { OMNI_TEST_FAIL: '1' }]) {
    const { service, dir, source } = await fixture(t, { env });
    if (env.OMNI_TEST_FAIL) await assert.rejects(service.run(1, 'failed', source), /Ошибка модели/);
    else { const result = await service.run(1, 'silence', source); assert.equal(result.savedPath, null); assert.equal(result.text, ''); }
    assert.equal((await readdir(dir)).some(name => name.endsWith('.txt')), false);
    assert.equal(service.job, null);
  }
});

test('Cancellation is scoped to the owner, stops a real Python process and creates no text', { timeout: 10000, skip:!python }, async t => {
  const { service, source, dir } = await fixture(t, { env: { OMNI_TEST_WAIT: '1' } });
  let ready; const started = new Promise(resolve => { ready = resolve; });
  const running = service.run(8, 'long-job', source, message => { if (message.message?.includes('Распознаём')) ready(); });
  const rejected = assert.rejects(running, /отменено/);
  await started;
  await assert.rejects(service.run(9, 'second', source), /другую запись/);
  await assert.rejects(service.saveParameters({ language:'en' }), /завершите или отмените/);
  await assert.rejects(service.reset(), /завершите или отмените/);
  assert.equal(service.cancel(9, 'long-job'), false);
  assert.equal(service.cancel(8, 'wrong-job'), false);
  assert.equal(service.cancel(8, 'long-job'), true);
  await rejected;
  assert.equal(service.job, null);
  assert.equal((await readdir(dir)).some(name => name.endsWith('.txt')), false);
});

test('An output write error preserves recognized text in the response', { skip:!python }, async t => {
  const { service, source } = await fixture(t);
  service.saveTranscript = async () => { throw new Error('EACCES'); };
  const result = await service.run(1, 'read-only-dir', source);
  assert.match(result.text, /Русская речь/); assert.equal(result.savedPath, null); assert.match(result.message, /EACCES/);
});

test('Settings reject unsupported models; missing local tokenizer cannot trigger a download', { skip:!python }, async t => {
  const { service, source, model } = await fixture(t, { folder: true });
  await assert.rejects(service.configure('model-file', source), /\.pt/);
  await rm(path.join(model, 'tokenizer.json'));
  await assert.rejects(service.run(1, 'missing-tokenizer', source), /tokenizer.json/);
  assert.equal(service.job, null);
  await assert.rejects(service.run(1, '../invalid-id', source), /Неверный/);
});

test('Desktop speech UI submits the current native source, shows text and cleans up on file close', async t => {
  const dom = new JSDOM('<div id="panel"></div>'), before = globalThis.window;
  globalThis.window = dom.window;
  t.after(() => { globalThis.window = before; dom.window.close(); });
  const panel = dom.window.document.getElementById('panel'), abort = new AbortController();
  let progress, submitted, complete, removed = false; const cancellations = [];
  let config = { python:'/env/python.exe', model:'/models/small.pt', params:defaultParams, schema:defaults.fields };
  dom.window.omniDesktop = {
    speechSettings: async () => config,
    speechSave: async params => { config = { ...config, params }; return config; },
    speechChoose: async () => null,
    speechRun: input => { submitted = input; return new Promise(resolve => { complete = resolve; }); },
    speechCancel: async id => { cancellations.push(id); },
    onSpeechProgress: fn => { progress = fn; return () => { removed = true; }; }
  };
  mountSpeech(panel, { name: 'recording.ogg', omniNativeUrl: 'omni://app/native/token' }, { signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve));
  const run = [...panel.querySelectorAll('button')].find(button => button.textContent === 'Распознать речь');
  const waiting = run.onclick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(submitted.url, 'omni://app/native/token'); assert.equal(run.disabled, true);
  progress({ type: 'segment', id: 'other', text: 'Wrong file' }); assert.equal(panel.querySelector('.speech-result').value, '');
  progress({ type: 'segment', id: submitted.id, text: 'Речь' }); assert.equal(panel.querySelector('.speech-result').value, 'Речь');
  complete({ text: 'Речь целиком', message: 'Сохранено: recording.txt' }); await waiting;
  assert.equal(panel.querySelector('.speech-result').value, 'Речь целиком'); assert.match(panel.querySelector('[role=status]').textContent, /recording.txt/);
  const pending = run.onclick(); await new Promise(resolve => setImmediate(resolve)); const lastId = submitted.id; abort.abort();
  assert.equal(removed, true); assert.deepEqual(cancellations, [lastId]);
  complete(null); await pending;
});

test('Web/mobile audio does not receive Whisper controls', t => {
  const dom = new JSDOM('<div id="panel"></div>'), before = globalThis.window;
  globalThis.window = dom.window;
  t.after(() => { globalThis.window = before; dom.window.close(); });
  const panel = dom.window.document.getElementById('panel');
  mountSpeech(panel, { name: 'recording.wav' }, { signal: new AbortController().signal });
  assert.equal(panel.childElementCount, 0);
});

test('Packaged desktop includes the backend and extracts only the required Python workers outside ASAR', async () => {
  const config = JSON.parse(await readFile(path.join(root, 'desktop/package.json'), 'utf8')).build;
  assert.ok(config.files.includes('speech.cjs'));
  assert.ok(config.files.includes('speech-defaults.json'));
  assert.equal(config.files.some(file => /^(recorder|voice-|speaker-|qwen-|reminder)/.test(file)), false);
  assert.ok(config.files.includes('!www/recorder*'));
  assert.ok(config.files.includes('speech-session.cjs'));
  assert.deepEqual(config.extraResources.filter(item => item.from === 'speech'), [
    { from:'speech', to:'speech', filter:['transcribe.py'] }
  ]);
});

test('Known Windows paths are used on first launch and during migration of empty legacy settings', async t => {
  const dir = await mkdtemp(path.join(root, '../speech-defaults-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const service = new SpeechService(dir, worker);
  const initial = await service.settings();
  assert.equal(initial.python, String.raw`C:\Users\User\Desktop\whisper_env\Scripts\python.exe`);
  assert.equal(initial.model, String.raw`C:\Users\User\.cache\huggingface\hub\models--Systran--faster-whisper-small\snapshots\536b0662742c02347bc0e980a01041f333bce120`);
  assert.equal(initial.params.language, 'ru'); assert.equal(initial.params.temperature, 0);
  await writeFile(path.join(dir, 'speech-settings.json'), JSON.stringify({ python:'', model:'', ffmpeg:'' }));
  assert.equal((await service.settings()).model, initial.model);
  await writeFile(path.join(dir, 'speech-settings.json'), JSON.stringify({ python:'/my/python.exe', model:'/my/small' }));
  const migrated = await service.settings();
  assert.equal(migrated.python, '/my/python.exe'); assert.equal(migrated.model, '/my/small');
  assert.equal(migrated.params.beam_size, 5);
});

test('Parameters survive partial edits, path selection and restart; reset restores the supplied defaults', { skip:!python }, async t => {
  const { service, model } = await fixture(t);
  await service.saveParameters({ beam_size:8, best_of:4, language:'en' });
  await service.saveParameters({ temperature:0.3 });
  await service.configure('model-file', model);
  const restarted = new SpeechService(service.directory, worker), saved = await restarted.settings();
  assert.equal(saved.params.beam_size, 8); assert.equal(saved.params.best_of, 4);
  assert.equal(saved.params.language, 'en'); assert.equal(saved.params.temperature, 0.3);
  assert.equal(saved.model, model); assert.equal(saved.python, path.resolve(python));
  const stored = JSON.parse(await readFile(path.join(service.directory,'speech-settings.json'), 'utf8'));
  assert.equal(stored.schema, undefined);
  const reset = await restarted.reset(); assert.equal(reset.python, defaults.paths.python);
  assert.equal(reset.model, defaults.paths.model); assert.deepEqual(reset.params, defaultParams);
});

test('Invalid parameters are rejected without changing the settings or executable paths', async t => {
  const dir = await mkdtemp(path.join(root, '../speech-invalid-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const service = new SpeechService(dir, worker);
  const good = await service.saveParameters({ temperature:0.4 });
  const bad = [null, [], { python:'other.exe' }, { language:'xx' }, { temperature:NaN }, { temperature:Infinity }, { temperature:1.1 }, { beam_size:0 }, { beam_size:2.5 }, { cpu_threads:-1 }, { best_of:30 }, { length_penalty:1.5 }, { no_speech_threshold:'0.6' }, { temperature_fallback:'false' }, { compute_type:'float16' }, { initial_prompt:'x'.repeat(2001) }];
  for (const value of bad) await assert.rejects(async () => service.saveParameters(value), /параметр|значение/i);
  const unchanged = await service.settings(); assert.deepEqual(unchanged.params, good.params);
  assert.equal(unchanged.python, good.python);
});

for (const folder of [false, true]) test(`Decoding settings reach the real Python worker with ${folder ? 'faster-whisper' : 'OpenAI Whisper'} keyword names`, { skip:!python }, async t => {
  const { service, source, capture } = await fixture(t, { folder });
  await service.saveParameters({ language:'auto', task:'translate', temperature:0.4, temperature_fallback:false, beam_size:7, best_of:3, patience:1.4, length_penalty:0.5, condition_on_previous_text:false, no_speech_threshold:0.4, log_prob_threshold:-0.8, compression_ratio_threshold:3.2, cpu_threads:2, compute_type:'float32', initial_prompt:' Omni, распознавание речи ' });
  await service.run(1, 'custom-params', source);
  const actual = JSON.parse(await readFile(capture,'utf8'));
  assert.equal(actual.init.device,'cpu'); assert.equal(actual.init.cpu_threads,2);
  assert.equal(actual.decode.language,null); assert.equal(actual.decode.task,'translate');
  assert.equal(actual.decode.temperature,0.4); assert.equal(actual.decode.beam_size,7); assert.equal(actual.decode.best_of,3);
  assert.equal(actual.decode.patience,1.4); assert.equal(actual.decode.length_penalty,0.5);
  assert.equal(actual.decode.condition_on_previous_text,false); assert.equal(actual.decode.no_speech_threshold,0.4);
  assert.equal(actual.decode.compression_ratio_threshold,3.2); assert.equal(actual.decode.initial_prompt,'Omni, распознавание речи');
  assert.equal(actual.decode[folder ? 'log_prob_threshold' : 'logprob_threshold'],-0.8);
  if (folder) { assert.equal(actual.init.compute_type,'float32'); assert.equal(actual.decode.vad_filter,false); }
  await service.saveParameters({ temperature_fallback:true }); await service.run(1,'fallback',source);
  assert.deepEqual(JSON.parse(await readFile(capture,'utf8')).decode.temperature,[0.4,0.6,0.8,1]);
});

test('Settings UI preserves drafts while selecting paths, saves parameters and restores defaults', async t => {
  const dom = new JSDOM('<div id="panel"></div>'), before = globalThis.window;
  globalThis.window = dom.window;
  t.after(() => { globalThis.window = before; dom.window.close(); });
  const panel = dom.window.document.getElementById('panel'), abort = new AbortController();
  t.after(() => abort.abort());
  let config = { ...defaults.paths, params:{ ...defaultParams }, schema:defaults.fields };
  dom.window.omniDesktop = {
    speechSettings:async () => config,
    speechChoose:async () => { config = { ...config, model:'/another/model.pt' }; return config; },
    speechSave:async params => { config = { ...config, params }; return config; },
    speechReset:async () => { config = { ...defaults.paths, params:{ ...defaultParams }, schema:defaults.fields }; return config; },
    speechRun:async () => { throw new Error('Do not transcribe in settings test'); },
    onSpeechProgress:() => () => {}, speechCancel:async () => {}
  };
  mountSpeech(panel, { name:'audio.wav' }, { signal:abort.signal }); await new Promise(resolve => setImmediate(resolve));
  const input = key => panel.querySelector(`[name="${key}"]`), button = label => [...panel.querySelectorAll('button')].find(el => el.textContent === label);
  assert.equal(input('language').value,'ru'); assert.equal(input('beam_size').disabled,false);
  input('language').value = 'auto'; input('language').dispatchEvent(new dom.window.Event('input'));
  input('temperature').value = '0.4'; input('temperature').dispatchEvent(new dom.window.Event('input'));
  assert.equal(input('beam_size').disabled,true); assert.equal(input('patience').disabled,true); assert.equal(input('best_of').disabled,false);
  await button('Выбрать .pt').onclick(); assert.equal(input('language').value,'auto'); assert.equal(input('temperature').value,'0.4');
  assert.equal(input('compute_type').disabled,true);
  await button('Сохранить параметры').onclick(); assert.equal(config.params.language,'auto'); assert.equal(config.params.temperature,0.4);
  assert.equal(input('temperature').disabled,false);
  await button('Восстановить значения по умолчанию').onclick(); assert.equal(input('language').value,'ru'); assert.equal(input('temperature').value,'0');
  assert.equal(config.model,defaults.paths.model); assert.equal(input('compute_type').disabled,false);
});

test('Cancel during parameter saving prevents a later transcription launch', async t => {
  const dom = new JSDOM('<div id="panel"></div>'), before = globalThis.window;
  globalThis.window = dom.window;
  t.after(() => { globalThis.window = before; dom.window.close(); });
  const panel = dom.window.document.getElementById('panel'), abort = new AbortController(), config = { ...defaults.paths, params:defaultParams, schema:defaults.fields };
  t.after(() => abort.abort());
  let finishSave, launches = 0;
  dom.window.omniDesktop = {
    speechSettings:async () => config,
    speechSave:() => new Promise(resolve => { finishSave = resolve; }),
    speechRun:async () => { launches++; }, speechCancel:async () => false,
    onSpeechProgress:() => () => {}
  };
  mountSpeech(panel,{ name:'audio.ogg' },{ signal:abort.signal }); await new Promise(resolve => setImmediate(resolve));
  const buttons = [...panel.querySelectorAll('button')], pending = buttons.find(el => el.textContent === 'Распознать речь').onclick();
  await buttons.find(el => el.textContent === 'Отменить распознавание').onclick();
  finishSave(config); await pending; assert.equal(launches,0); assert.match(panel.querySelector('[role=status]').textContent,/отменено/);
});

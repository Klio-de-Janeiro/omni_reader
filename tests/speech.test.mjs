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
  const ext = options.folder ? 'wav' : 'ogg';
  const source = path.join(dir, 'запись & пример.' + ext);
  await writeFile(source, await readFile(path.join(root, 'tests/fixtures/sample.' + ext)));
  if (options.folder) {
    await mkdir(model);
    for (const name of ['model.bin', 'config.json', 'tokenizer.json']) await writeFile(path.join(model, name), '{}');
  } else await writeFile(model, 'checkpoint double');
  const common = `import os, time\nfrom pathlib import Path\nassert os.environ['HF_HUB_OFFLINE'] == '1'\nassert os.environ['TRANSFORMERS_OFFLINE'] == '1'\ndef content(source, kwargs):\n    assert Path(source).is_file() and ' & ' in source\n    assert kwargs['language'] == 'ru' and kwargs['task'] == 'transcribe'\n    if os.environ.get('OMNI_TEST_WAIT'):\n        while True: time.sleep(0.05)\n    if os.environ.get('OMNI_TEST_FAIL'): raise RuntimeError('Ошибка модели')\n    return os.environ.get('OMNI_TEST_TEXT', 'Привет, мир! Русская речь. 🎤')\n`;
  await writeFile(path.join(modules, 'torch.py'), 'def set_num_threads(value):\n    assert 1 <= value <= 8\n');
  await writeFile(path.join(modules, 'whisper.py'), common + `class Model:\n    def transcribe(self, source, **kwargs):\n        assert kwargs['fp16'] is False and kwargs['verbose'] is False\n        print('Library output must not break JSON protocol')\n        return {'text': content(source, kwargs)}\ndef load_model(model, device):\n    assert Path(model).is_file() and model.endswith('.pt') and device == 'cpu'\n    return Model()\n`);
  await writeFile(path.join(modules, 'faster_whisper.py'), common + `from types import SimpleNamespace\nclass WhisperModel:\n    def __init__(self, model, **kwargs):\n        assert Path(model).is_dir() and kwargs['device'] == 'cpu'\n        assert kwargs['compute_type'] == 'int8' and kwargs['local_files_only'] is True\n        assert 1 <= kwargs['cpu_threads'] <= 8\n    def transcribe(self, source, **kwargs):\n        assert kwargs['vad_filter'] is False\n        text = content(source, kwargs)\n        return iter([SimpleNamespace(text=text)]), None\n`);
  const service = new SpeechService(path.join(dir, 'settings'), worker, {
    spawn(command, args, opts) {
      assert.equal(opts.shell, false);
      assert.deepEqual(args, ['-u', worker]);
      return spawn(command, args, { ...opts, env: { ...opts.env, PYTHONPATH: modules, ...options.env } });
    }
  });
  await service.configure('python', python);
  await service.configure(options.folder ? 'model-folder' : 'model-file', model);
  return { service, dir, source, model };
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
  dom.window.omniDesktop = {
    speechSettings: async () => ({ python: '/env/python.exe', model: '/models/small.pt' }),
    speechChoose: async () => null,
    speechRun: input => { submitted = input; return new Promise(resolve => { complete = resolve; }); },
    speechCancel: async id => { cancellations.push(id); },
    onSpeechProgress: fn => { progress = fn; return () => { removed = true; }; }
  };
  mountSpeech(panel, { name: 'recording.ogg', omniNativeUrl: 'omni://app/native/token' }, { signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve));
  const run = [...panel.querySelectorAll('button')].find(button => button.textContent === 'Распознать речь');
  const waiting = run.onclick(); assert.equal(submitted.url, 'omni://app/native/token'); assert.equal(run.disabled, true);
  progress({ type: 'segment', id: 'other', text: 'Wrong file' }); assert.equal(panel.querySelector('textarea').value, '');
  progress({ type: 'segment', id: submitted.id, text: 'Речь' }); assert.equal(panel.querySelector('textarea').value, 'Речь');
  complete({ text: 'Речь целиком', message: 'Сохранено: recording.txt' }); await waiting;
  assert.equal(panel.querySelector('textarea').value, 'Речь целиком'); assert.match(panel.querySelector('[role=status]').textContent, /recording.txt/);
  const pending = run.onclick(), lastId = submitted.id; abort.abort();
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

test('Packaged desktop includes the backend and extracts only the Python worker outside ASAR', async () => {
  const config = JSON.parse(await readFile(path.join(root, 'desktop/package.json'), 'utf8')).build;
  assert.ok(config.files.includes('speech.cjs'));
  assert.deepEqual(config.extraResources, [{ from:'speech', to:'speech', filter:['transcribe.py'] }]);
});

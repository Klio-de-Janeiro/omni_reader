import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, copyFile, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url), exec = promisify(execFile);
const { VoiceDataset } = require('../desktop/voice-dataset.cjs');
const { SpeakerWorker } = require('../desktop/speaker-worker.cjs');
const { wavInfo } = require('../desktop/voice-files.cjs');
const { exportDataset } = require('../desktop/voice-dataset-export.cjs');
const core = require('../desktop/speaker-core.cjs');
const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();

function wav(salt, seconds = 6) {
  const pcm = Buffer.alloc(32000 * seconds);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE((i / 2 * (salt + 1) + salt * 37) % 24000 - 12000, i);
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
async function until(check) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 10000) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(process.cwd(), 'speaker-test-')), model = path.join(dir, 'model.onnx'), script = path.join(dir, 'worker.py');
  await writeFile(model, Buffer.alloc(2048, 8));
  await writeFile(script, `import hashlib,json,sys,time,wave,math,re\nfrom pathlib import Path\nc=json.loads(sys.stdin.readline());root=Path(c['model']).parent\ndef emit(kind,**kw): print(json.dumps({'type':kind,'id':c['id'],**kw}),flush=True)\nemit('phase',phase='speaker-runtime',message='Локальная загрузка')\nif (root/'wait').exists():\n print('Диагностика native DLL',file=sys.stderr,flush=True)\n while True: time.sleep(.05)\nif (root/'fail').exists():\n emit('error',message='модель недоступна');sys.exit(1)\nh=hashlib.sha256(Path(c['model']).read_bytes()).hexdigest()\nfor clip in c['clips']:\n emit('progress',clip_id=clip['id'],message='audio')\n time.sleep(.01)\n with wave.open(clip['path'],'rb') as w: pcm=w.readframes(w.getnframes())\n duration=len(pcm)/32000;s=float(re.search(r'_s([\\d.]+)\\.wav$',clip['path'])[1])\n vectors=[] if duration<3 else [[s,math.sqrt(1-s*s)]+[0.0]*14]\n emit('clip',clip_id=clip['id'],result={'audio_hash':hashlib.sha256(pcm).hexdigest(),'model_hash':h,'preprocess':'silero-0.5-frames-v1','speech_seconds':duration,'duration':duration,'vectors':vectors})\nemit('result',model_hash=h)\n`);
  const events = [], service = new VoiceDataset(path.join(dir, 'state'), script, { defaults: async () => ({ python, model }), report: state => events.push(state), phaseLimitMs: 1000 });
  await service.ready;
  t.after(async () => { await service.shutdown(); await rm(dir, { recursive: true, force: true }); });
  let salt = 1;
  async function clip(id, score = .9, seconds = 6) {
    const source = path.join(dir, `${id}_s${score}.wav`); await writeFile(source, wav(salt++, seconds));
    await writeFile(source.replace(/\.wav$/, '.json'), JSON.stringify({ id, speaker_verified: false }));
    const value = { id, path: source, duration: seconds }; await service.register(value, { auto: false }); return value;
  }
  async function label(id, role, text = '', review = 'pending', confirmed = false) {
    const detail = await service.detail(id); return service.review(id, { revision: detail.revision, role, review, text, text_confirmed: confirmed });
  }
  async function training() {
    for (let i = 1; i <= 3; i++) { await clip('ref' + i, 1); await label('ref' + i, 'reference'); }
    for (const [kind, scores] of [['owner', [.86, .84, .9]], ['other', [.1, .15, .2]]]) {
      for (let i = 0; i < 3; i++) { const id = kind + i; await clip(id, scores[i]); await label(id, 'calibration_' + kind); }
    }
    await service.analyze('calibrate');
  }
  return { dir, model, script, service, events, clip, label, training };
}

test('Speaker PCM preparation and pinned install use bounded real bytes', async () => {
  const result = await exec('python3', ['tests/voice_speaker_test.py']); assert.match(result.stderr, /OK/);
});

test('Speaker scores preserve uncertainty and separate FAR/FRR from manual review', () => {
  const vector = value => [value, Math.sqrt(1 - value * value), ...Array(14).fill(0)];
  const centroid = core.average([vector(1), vector(1), vector(1)]);
  assert.deepEqual(core.scores({ vectors: [vector(.9), vector(.1)] }, centroid), [.9, .1]);
  const thresholds = core.calibrate([[.86], [.84], [.9]], [[.1], [.15], [.2]]);
  assert.ok(Math.abs(thresholds.reject - .23) < 1e-9); assert.ok(Math.abs(thresholds.accept - .81) < 1e-9);
  assert.equal(core.decision([.9, .1], thresholds), 'uncertain'); assert.equal(core.decision([], thresholds), 'uncertain');
  assert.equal(core.decision([.99], null), 'uncertain');
  const metrics = core.evaluate([[.9], [.1], [.5]], [[.1], [.95], [.5]], thresholds);
  assert.equal(metrics.false_accepts, 1); assert.equal(metrics.false_rejects, 1); assert.equal(metrics.far, 1 / 3); assert.equal(metrics.frr, 1 / 3);
  assert.equal(metrics.owner_uncertain, 1); assert.equal(metrics.other_uncertain, 1);
  const inseparable = core.calibrate([[1], [1], [1]], [[1], [1], [1]]);
  assert.equal(core.decision([1], inseparable), 'uncertain');
});

test('Known IDs, optimistic revisions, PCM validation and review paths are enforced', async t => {
  const { dir, service, clip, label } = await fixture(t); const source = await clip('one');
  const original = await readFile(source.path), metadata = await readFile(source.path.replace(/\.wav$/, '.json'));
  await assert.rejects(service.audio('../../private'), /не найдена/);
  await assert.rejects(service.review('one', { revision: 0, role: 'candidate', review: 'approved', text: 'Текст', text_confirmed: false }), /Проверьте текст/);
  await label('one', 'candidate', 'Исправленный текст <img src=x>', 'approved', true);
  await assert.rejects(service.review('one', { revision: 0, role: 'candidate', review: 'pending', text: '', text_confirmed: false }), /другом окне/);
  await assert.rejects(service.review('one', { python: 'evil.exe' }), /Неверные параметры/);
  await assert.rejects(service.configure('python', 'relative.exe'), /Неверная настройка/);
  assert.deepEqual(await readFile(source.path), original); assert.deepEqual(await readFile(source.path.replace(/\.wav$/, '.json')), metadata);
  const stereo = path.join(dir, 'stereo.wav'), bad = wav(3); bad.writeUInt16LE(2, 22); await writeFile(stereo, bad); await assert.rejects(wavInfo(stereo), /mono PCM16/);
  const link = path.join(dir, 'symlink.wav'); await symlink(source.path, link); await assert.rejects(wavInfo(link), /недоступен/);
  await writeFile(path.join(dir, 'truncated.wav'), original.subarray(0, 100)); await assert.rejects(wavInfo(path.join(dir, 'truncated.wav')), /обрезан/);
});

test('ASR updates never overwrite corrected text or raw sidecar metadata', async t => {
  const { service, clip, label } = await fixture(t), source = await clip('one');
  const first = source.path.replace(/\.wav$/, '.txt'), second = source.path.replace(/\.wav$/, '-transcript-2.txt');
  await writeFile(first, 'Первый Whisper'); await service.noteTranscript({ id: 'one', savedPath: first });
  assert.equal((await service.detail('one')).text, 'Первый Whisper');
  await label('one', 'candidate', 'Исправлено человеком', 'approved', true);
  await writeFile(second, 'Новый Whisper'); await service.noteTranscript({ id: 'one', savedPath: second });
  const detail = await service.detail('one'); assert.equal(detail.text, 'Исправлено человеком'); assert.equal(detail.original_text, 'Новый Whisper'); assert.equal(detail.text_confirmed, true);
  await service.noteTranscript({ id: 'one', savedPath: null }); assert.equal((await service.detail('one')).original_text, 'Новый Whisper');
  assert.equal(await readFile(first, 'utf8'), 'Первый Whisper');
});

test('Calibration uses separate labels; independent tests count actual outcomes', async t => {
  const { service, clip, label, training } = await fixture(t); await training();
  assert.equal(service.profile.references.length, 3); assert.equal(service.profile.speech_seconds, 18);
  assert.equal(service.calibration.metrics.owner_accepted, 3); assert.equal(service.calibration.metrics.other_rejected, 3);
  assert.equal(service.evaluation, null); // Calibration metrics are not a held-out performance claim.
  for (const [kind, scores] of [['owner', [.9, .1, .5]], ['other', [.1, .95, .5]]]) for (let i = 0; i < 3; i++) {
    const id = 'test' + kind + i; await clip(id, scores[i]); await label(id, 'test_' + kind);
  }
  await service.analyze('evaluate');
  assert.equal(service.evaluation.false_accepts, 1); assert.equal(service.evaluation.false_rejects, 1);
  assert.equal(service.evaluation.owner_uncertain, 1); assert.equal(service.evaluation.other_uncertain, 1);
  assert.equal(service.evaluation.far, 1 / 3); assert.equal(service.evaluation.frr, 1 / 3);
  await label('ref1', 'candidate'); assert.equal(service.calibration, null); assert.equal(service.evaluation, null);
});

test('Duplicate audio in references/calibration/tests cannot contaminate error measurement', async t => {
  const { service, clip, label, training } = await fixture(t); await training();
  const own = await clip('testown', .9), other = await clip('testforeign', .1);
  await copyFile(service.find('ref1').path, own.path); await label(own.id, 'test_owner'); await label(other.id, 'test_other');
  await assert.rejects(service.analyze('evaluate'), /Одинаковый звук/); assert.equal(service.evaluation, null);
});

test('Changed reference audio or model invalidates a calibrated profile', async t => {
  const { service, clip, training } = await fixture(t); await training(); await clip('candidate');
  await writeFile(service.find('ref1').path, wav(100));
  await assert.rejects(service.analyze('verify', 'candidate'), /изменились/); assert.equal(service.calibration, null); assert.equal(service.config.auto_verify, false);
});

test('Replacing model bytes invalidates verification even when its filename stays the same', async t => {
  const { service, model, clip, training } = await fixture(t); await training(); await clip('candidate');
  await writeFile(model, Buffer.alloc(2048, 9));
  await assert.rejects(service.analyze('verify', 'candidate'), /модель изменилась/); assert.equal(service.calibration, null); assert.equal(service.summary(service.find('candidate')).decision, 'uncertain');
});

test('A bounded automatic backlog never removes recordings when it is full', async t => {
  const { service, clip, training } = await fixture(t); await training(); await service.setAuto(true); service.paused = true;
  for (let i = 0; i < 25; i++) {
    const source = await clip('queued' + i); service.enqueue(source.id);
  }
  assert.equal(service.pending.length, 24); assert.match(service.problem, /Очередь.*заполнена/); assert.equal(service.find('queued24').review, 'pending');
  await service.setAuto(false); assert.equal(service.pending.length, 0); assert.equal((await service.audio('queued24')).length > 0, true);
});

test('Automatic checks preserve raw recordings; short/uncertain audio is never auto-approved', async t => {
  const { service, clip, training } = await fixture(t); await training(); await service.setAuto(true);
  const own = await clip('automatic', .9); await service.register({ id: 'automatic2', path: own.path });
  await until(() => service.find('automatic2').check && !service.busy);
  assert.equal(service.summary(service.find('automatic2')).decision, 'owner'); assert.equal(service.find('automatic2').review, 'pending'); assert.equal(service.snapshot().approved, 0);
  const short = await clip('short', .9, 1); await service.analyze('verify', short.id); const item = service.find(short.id);
  assert.equal(item.check.decision, 'uncertain'); assert.match(item.check.reason, /3 секунд/);
  await service.setAuto(false); assert.equal(service.pending.length, 0);
});

test('Worker startup timeout/cancel include the last phase and Unicode native diagnostics', async t => {
  const { dir, model, script } = await fixture(t); await writeFile(path.join(dir, 'wait'), 'wait');
  const log = path.join(dir, 'diagnostic.json'), worker = new SpeakerWorker(script, log, { phaseLimitMs: 60, totalLimitMs: 500 });
  await assert.rejects(worker.run({ python, model }, []), /speaker-runtime/);
  const diagnostic = JSON.parse(await readFile(log, 'utf8')); assert.match(diagnostic.stderr, /Диагностика native DLL/); assert.equal(diagnostic.phase, 'speaker-runtime');
  const active = worker.run({ python, model }, []); await until(() => worker.child); worker.cancel(); await assert.rejects(active, /отменена/); assert.equal(worker.child, null);
});

test('Model failure pauses auto checks without deleting WAV or locking review forever', async t => {
  const { dir, service, clip, training } = await fixture(t); await training(); const source = await clip('candidate');
  await service.analyze('verify', source.id); assert.equal(service.find(source.id).check.decision, 'owner');
  await writeFile(path.join(dir, 'fail'), 'fail'); await assert.rejects(service.analyze('verify', source.id), /модель недоступна/);
  assert.equal(service.job, null); assert.equal(service.paused, true); assert.deepEqual(await service.audio(source.id), await readFile(source.path));
  assert.equal(service.summary(service.find(source.id)).decision, 'uncertain');
  await rm(path.join(dir, 'fail')); await service.analyze('verify', source.id); assert.equal(service.find(source.id).check.decision, 'owner');
});

test('Export contains only explicitly approved owner WAV, corrected UTF-8 TXT and JSONL', async t => {
  const { dir, service, clip, label, training } = await fixture(t); await training();
  const own = await clip('accepted', .9), pending = await clip('pending', .9), excluded = await clip('excluded', .9);
  const extra = await clip('accepted2', .9);
  await label(own.id, 'candidate', 'Привет, мир.\nИсправленный текст.', 'approved', true);
  await label(extra.id, 'candidate', 'Второй проверенный текст.', 'approved', true);
  await label(excluded.id, 'candidate', 'Не включать', 'rejected');
  const original = await readFile(own.path), result = await service.export(dir); assert.equal(result.count, 2);
  const rows = (await readFile(path.join(result.folder, 'dataset.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2); assert.equal(rows[0].id, 'accepted'); assert.equal(rows[0].speaker_verified, true); assert.equal(rows[0].verification_source, 'manual_review');
  assert.deepEqual(await readFile(path.join(result.folder, rows[0].audio)), original); assert.equal(await readFile(path.join(result.folder, rows[0].text_file), 'utf8'), rows[0].text);
  assert.deepEqual(await readdir(path.join(result.folder, 'wav')), ['accepted.wav', 'accepted2.wav']); assert.equal(service.find(pending.id).review, 'pending');
  assert.equal(rows[1].text, 'Второй проверенный текст.');
  await writeFile(own.path, wav(777)); await assert.rejects(service.export(dir), /WAV изменился/);
  assert.equal((await readdir(dir)).some(name => name.endsWith('.partial')), false);
});

test('Cancelling a streaming export removes only its incomplete folder', async t => {
  const { dir, service, clip, label } = await fixture(t); const source = await clip('one');
  await label('one', 'candidate', 'Проверенный текст', 'approved', true);
  const item = service.summary(service.find('one')), detail = await service.stored(service.find('one'));
  let cancelled = false;
  async function* entries() { yield { item, detail }; cancelled = true; yield { item, detail }; }
  await assert.rejects(exportDataset(dir, entries(), {}, () => cancelled), /отменён/);
  assert.equal((await readdir(dir)).some(name => name.endsWith('.partial') || name.startsWith('Omni-voice-')), false);
  assert.deepEqual(await readFile(source.path), await service.audio('one'));
});

test('Persistent dataset restores reviews but does not start microphone or old checks', async t => {
  const { dir, service, script, model, clip, label } = await fixture(t); await clip('one'); await label('one', 'candidate', 'Мой текст', 'approved', true); await service.shutdown();
  const restored = new VoiceDataset(path.join(dir, 'state'), script, { defaults: async () => ({ python, model }) }); await restored.ready;
  t.after(() => restored.shutdown()); assert.equal(restored.busy, false); assert.equal(restored.captureRole, 'candidate'); assert.equal(restored.pending.length, 0);
  assert.equal((await restored.detail('one')).text, 'Мой текст'); assert.equal(restored.snapshot().approved, 1);
  await assert.rejects(restored.list({ offset: -1 }), /Неверная страница/);
});

test('Dataset UI preserves edits, uses safe text, plays known audio and cleans Blob URLs', async t => {
  const dom = new JSDOM('<dialog></dialog>'), previous = Object.fromEntries(['window', 'document', 'URL'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, URL: dom.window.URL });
  const urls = [], revoked = []; dom.window.URL.createObjectURL = () => { const value = 'blob:test-' + urls.length; urls.push(value); return value; }; dom.window.URL.revokeObjectURL = value => revoked.push(value);
  dom.window.HTMLMediaElement.prototype.pause = () => {}; dom.window.HTMLMediaElement.prototype.load = () => {};
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); for (const [key, value] of Object.entries(previous)) globalThis[key] = value; });
  const { mountVoiceDataset } = await import('../dist/recorder-dataset.js'); assert.equal(mountVoiceDataset(document.querySelector('dialog'), {}), undefined);
  const rows = ['one', 'two'].map(id => ({ id, path: '/known/' + id + '.wav', role: 'candidate', duration: 6, review: 'pending', decision: 'uncertain', analysis_error: '<img src=x onerror=alert(1)>' }));
  const state = { config: { python: '/local/python.exe', model: '/local/model.onnx' }, roles: {}, total: 2, approved: 0, processing: false, pending: 0 };
  let report, off = 0, revision = 0; const api = {
    voiceDatasetStatus: async () => state, voiceDatasetList: async () => ({ total: 2, items: rows }),
    voiceDatasetDetail: async id => ({ item: rows.find(item => item.id === id), text: 'Whisper <script>', original_text: 'Свежий Whisper', revision, text_confirmed: false, speech_seconds: 6 }),
    voiceDatasetAudio: async () => wav(2), onVoiceDataset: callback => { report = callback; return () => { off++; }; }, onRecorderState: () => () => { off++; }
  };
  const { section } = mountVoiceDataset(document.querySelector('dialog'), api); await until(() => section.querySelectorAll('[data-dataset-list] button').length === 2);
  const choose = async index => { section.querySelectorAll('[data-dataset-list] button')[index].click(); await new Promise(resolve => setImmediate(resolve)); await until(() => !section.querySelector('[data-review-text]').disabled); };
  await choose(0); const text = section.querySelector('[data-review-text]'); text.value = 'Мой черновик'; text.dispatchEvent(new dom.window.Event('input'));
  report({ ...state, message: 'Whisper завершил работу' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(text.value, 'Мой черновик'); assert.equal(section.querySelector('[data-review-confirm]').checked, false);
  await choose(1); await choose(0); assert.equal(text.value, 'Мой черновик'); assert.equal(section.querySelectorAll('img,script').length, 0);
  revision = 1; await choose(0); assert.match(section.querySelector('[data-review-error]').textContent, /другом окне/);
  document.querySelector('dialog').dispatchEvent(new dom.window.Event('close')); assert.equal(revoked.length, urls.length);
  dom.window.dispatchEvent(new dom.window.Event('pagehide')); assert.equal(off, 2);
});

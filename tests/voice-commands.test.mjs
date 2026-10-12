import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const { resolveTime, wallToUtc, localTime } = require('../desktop/reminder-time.cjs');
const { wakeText, proposal, validateIntent, SCHEMA } = require('../desktop/voice-intents.cjs');
const { QwenLocal, defaults, settings, localEndpoint, request } = require('../desktop/qwen-local.cjs');
const { RemindersStore } = require('../desktop/reminders-store.cjs');
const { VoiceCommands } = require('../desktop/voice-commands.cjs');
const { SpeechService } = require('../desktop/speech.cjs');
const { VoiceTranscripts } = require('../desktop/voice-transcripts.cjs');
const now = '2026-10-11T09:00:10.000Z', zone = 'Europe/Moscow';
const config = extra => settings({ ...defaults(), timezone:zone, model:'qwen-local', ...extra });
const intent = extra => ({ type:'create_reminder', title:'Решить задачи', time_text:'завтра в 19:00', reminder_id:null, progress_current:null, progress_total:null, question:'', needs_confirmation:true, ...extra });
async function until(check) {
  const start = Date.now();
  while (!check()) { if (Date.now()-start > 5000) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function directory(t) {
  const dir = await mkdtemp(path.join(process.cwd(), 'assistant-test-'));
  t.after(() => rm(dir, { recursive:true, force:true })); return dir;
}
async function database(t) {
  const store = new RemindersStore(await directory(t)); await store.open();
  t.after(() => store.close()); return store;
}
function add(store, id, value = intent()) {
  store.add({ id, kind:'manual', text:'Омни, напомни завтра в 19:00 решить задачи', spoken_at:now }, zone, now);
  return store.status(id, 'proposed', 'Проверьте', proposal(value, { id, text:'Омни, напомни завтра в 19:00 решить задачи', spoken_at:now }, { timezone:zone, reminders:[] }), now);
}
function confirm(row, extra = {}) { return { revision:row.revision, title:row.intent.title, due_local:row.intent.due_local, timezone:zone, ...extra }; }

test('Russian dates use utterance time, preserve seconds and handle local calendar days', () => {
  assert.equal(resolveTime('Омни, напомни завтра в 19:00 решить задачи', now, zone).due_at, '2026-10-12T16:00:00.000Z');
  const relative = resolveTime('через час', now, zone);
  assert.equal(relative.due_at, '2026-10-11T10:00:10.000Z');
  assert.equal(wallToUtc(relative.due_local, zone), relative.due_at);
  assert.equal(resolveTime('через две минуты', now, zone).due_at, '2026-10-11T09:02:10.000Z');
  assert.equal(resolveTime('через полтора часа', now, zone).due_at, '2026-10-11T10:30:10.000Z');
  assert.equal(resolveTime('через день', '2026-10-31T16:00:00Z', 'America/New_York').due_at, '2026-11-01T17:00:00.000Z');
  assert.equal(resolveTime('12.10.2026 в 19:00', now, zone).due_at, '2026-10-12T16:00:00.000Z');
  assert.equal(localTime('2026-10-11T09:00:10Z', zone), '2026-10-11T12:00:10');
});
test('Ambiguous, missing, invalid and conflicting times require clarification', () => {
  for (const text of ['завтра','в 19:00','завтра примерно в 19:00','завтра и послезавтра в 19:00','через час завтра в 19:00','через час и 30 минут','2026-02-30 в 19:00','сегодня в 01:00','воскресенье в 19:00','завтра в 29:00']) {
    const result = resolveTime(text, now, zone); assert.equal(result.due_at, null, text); assert.ok(result.question, text);
  }
  assert.equal(resolveTime('через час', null, zone).due_at, null);
  assert.throws(() => wallToUtc('2026-03-08T02:30', 'America/New_York'), /перевода часов/);
  assert.throws(() => wallToUtc('2026-11-01T01:30', 'America/New_York'), /повторяется/);
  assert.throws(() => wallToUtc('2026-10-11T19:00', 'fake/zone'), /пояс/);
});
test('Wake word and intent schema cannot turn arbitrary speech into executable actions', () => {
  assert.equal(wakeText('Эй, Омни, напомни завтра в 19:00'), 'напомни завтра в 19:00');
  for (const text of ['я сказал Омни вчера','омник напомни','omni_some_task','обычный разговор']) assert.equal(wakeText(text), null);
  for (const invalid of [intent({ type:'run_shell' }), intent({ needs_confirmation:false }), { ...intent(), command:'del *' }, intent({ progress_current:NaN }), intent({ type:'update_progress', progress_current:3, progress_total:2 })]) assert.throws(() => validateIntent(invalid));
  const value = proposal(intent({ time_text:'сегодня в 13:00' }), { id:'one', text:'Омни, напомни завтра в 19:00', spoken_at:now }, { timezone:zone, reminders:[] });
  assert.equal(value.due_at, null); assert.match(value.question, /изменил фразу/);
  const ambiguous = proposal(intent({ type:'complete_reminder', reminder_id:'task' }), { id:'one', text:'Омни, готово', spoken_at:now }, { timezone:zone, reminders:[{ id:'task', title:'Решить задачи', status:'open' }] });
  assert.match(ambiguous.question, /явно/);
});
test('Local adapter rejects remote endpoints, credentials and cloud model tags', () => {
  assert.equal(localEndpoint('http://localhost:11434', 'ollama'), 'http://127.0.0.1:11434');
  assert.equal(localEndpoint('http://[::1]:1234/v1/', 'openai'), 'http://[::1]:1234/v1');
  for (const value of ['https://example.com','http://192.168.0.1:11434','http://localhost.example.com','http://user:pass@127.0.0.1','http://127.0.0.1/api','http://127.0.0.1?token=secret']) assert.throws(() => localEndpoint(value, 'ollama'));
  for (const change of [{ cpu_threads:7 }, { timeout_seconds:29 }, { temperature:NaN }, { model:'qwen:cloud' }, { run:'command' }]) assert.throws(() => config(change));
});
async function server(t, handler) {
  const service = createServer(handler);
  await new Promise((resolve, reject) => { service.once('error', reject); service.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { service.closeAllConnections(); service.close(resolve); }));
  return 'http://127.0.0.1:' + service.address().port;
}
test('Ollama and OpenAI-compatible requests use strict schemas and bounded completed responses', async t => {
  const requests = [];
  const endpoint = await server(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url:req.url, data:body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') res.end(JSON.stringify({ models:[{ name:'qwen-local' },{ name:'qwen-cloud' }] }));
    else if (req.url === '/v1/models') res.end(JSON.stringify({ data:[{ id:'qwen-gguf' }] }));
    else if (req.url === '/api/chat') res.end(JSON.stringify({ done:true, message:{ content:JSON.stringify(intent()) } }));
    else res.end(JSON.stringify({ choices:[{ finish_reason:'stop', message:{ content:JSON.stringify(intent()) } }] }));
  });
  const adapter = new QwenLocal(), input = { id:'one', text:'Омни, напомни завтра в 19:00', spoken_at:now }, context = { timezone:zone, reminders:[] };
  assert.deepEqual(await adapter.models(config({ endpoint })), ['qwen-local']);
  assert.deepEqual(await adapter.infer(config({ endpoint }), input, context), intent());
  assert.deepEqual(await adapter.models(config({ endpoint, backend:'openai' })), ['qwen-gguf']);
  assert.deepEqual(await adapter.infer(config({ endpoint, backend:'openai' }), input, context), intent());
  assert.deepEqual(requests[1].data.format, SCHEMA); assert.equal(requests[1].data.keep_alive, 0);
  assert.equal(requests[1].data.options.num_thread, 4); assert.equal(requests[1].data.stream, false);
  assert.equal(requests[3].data.response_format.json_schema.strict, true);
});
test('HTTP timeout, cancellation, oversize data, redirects and malformed JSON fail visibly', async t => {
  let redirected = 0;
  const endpoint = await server(t, (req, res) => {
    if (req.url === '/wait') return;
    if (req.url === '/redirect') { res.writeHead(302, { Location:endpoint + '/followed' }); res.end(); }
    else if (req.url === '/followed') { redirected++; res.end('{}'); }
    else if (req.url === '/huge') res.end('x'.repeat(300000));
    else res.end('not json');
  });
  await assert.rejects(request(endpoint + '/wait', null, undefined, 20), /таймаут/);
  const controller = new AbortController(), pending = request(endpoint + '/wait', null, controller.signal, 1000); controller.abort();
  await assert.rejects(pending, /отменена/);
  await assert.rejects(request(endpoint + '/huge', null, undefined, 1000), /большой/);
  await assert.rejects(request(endpoint + '/redirect', null, undefined, 1000), /HTTP 302/); assert.equal(redirected, 0);
  await assert.rejects(request(endpoint + '/bad', null, undefined, 1000));
});
test('SQLite requires explicit confirmation, commits once and restores interrupted work safely', async t => {
  const store = await database(t), row = add(store, 'one');
  assert.equal(store.reminders().total, 0);
  assert.throws(() => store.confirm('one', confirm(row, { revision:0 }), now), /изменилась/);
  assert.throws(() => store.confirm('one', confirm(row, { due_local:'2026-02-30T19:00' }), now));
  assert.equal(store.reminders().total, 0); assert.equal(store.get('one').status, 'proposed');
  const first = store.confirm('one', confirm(row), now);
  assert.equal(store.confirm('one', confirm(row), now).reminder_id, first.reminder_id);
  assert.equal(store.reminders().total, 1); assert.equal(store.history(first.reminder_id).length, 1);
  assert.equal(store.add({ id:'one', text:'повторное событие' }, zone, now).status, 'confirmed');
  store.add({ id:'interrupted', text:'Омни, через час', spoken_at:now }, zone, now);
  store.configure(config({ enabled:true })); store.close();
  await store.open();
  assert.equal(store.get('interrupted').status, 'cancelled'); assert.equal(store.pending().length, 0);
  assert.equal(store.reminders().items[0].due_at, '2026-10-12T16:00:00.000Z'); assert.equal(store.config().enabled, true);
});
test('SQLite revisions guard reschedule, progress and completion across windows', async t => {
  const store = await database(t), initial = add(store, 'one');
  const id = store.confirm(initial.id, confirm(initial), now).reminder_id;
  const changes = (source, type, extra = {}) => {
    store.add({ id:source, kind:'manual', text:'Явно выбрана задача', spoken_at:now }, zone, now);
    return store.status(source, 'proposed', 'Проверьте', { ...intent({ type }), reminder_id:id, ...extra }, now);
  };
  const progress = changes('progress', 'update_progress');
  store.confirm(progress.id, { revision:progress.revision, reminder_id:id, target_revision:0, progress_current:3, progress_total:10 }, now);
  const move = changes('move', 'reschedule_reminder');
  assert.throws(() => store.confirm(move.id, { revision:move.revision, reminder_id:id, target_revision:0, due_local:'2026-10-13T19:00', timezone:zone }, now), /изменилась/);
  store.confirm(move.id, { revision:move.revision, reminder_id:id, target_revision:1, due_local:'2026-10-13T19:00', timezone:zone }, now);
  const done = changes('done', 'complete_reminder');
  store.confirm(done.id, { revision:done.revision, reminder_id:id, target_revision:2 }, now);
  assert.equal(store.reminders({ status:'done' }).items[0].progress_current, 3);
  assert.equal(store.history(id).length, 4);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM notification_deliveries').get().n, 0);
});
test('Dataset proposal switches mode only after confirmation without approving audio', async t => {
  const store = await database(t), row = add(store, 'dataset', intent({ type:'dataset_candidate' }));
  assert.equal(store.config().mode, 'commands');
  store.confirm(row.id, { revision:row.revision }, now);
  assert.equal(store.config().mode, 'dataset'); assert.equal(store.reminders().total, 0);
});
async function assistant(t, options = {}) {
  const dir = await directory(t), speech = new SpeechService(dir, 'unused.py');
  const commands = new VoiceCommands(dir, speech, () => {}, { clock:() => new Date(now), model:{ infer:async () => intent(), models:async () => ['qwen-local'] }, ...options });
  await commands.ready; await commands.configure(config({ enabled:true, ...options.config }));
  t.after(() => commands.shutdown()); return { dir, speech, commands };
}
test('Voice intake filters conversation/reference clips and replays cannot duplicate a reminder', async t => {
  let calls = 0;
  const { commands } = await assistant(t, { model:{ infer:async () => { calls++; return intent(); } } });
  const input = { id:'voice-one', status:'done', text:'Омни, напомни завтра в 19:00 решить задачи', spoken_at:now, role:'candidate' };
  await commands.input({ ...input, text:'Обычный разговор', id:'chat' });
  await commands.input({ ...input, role:'reference', id:'reference' });
  assert.equal(commands.store.list().total, 0);
  await commands.input(input); await until(() => !commands.current);
  const row = commands.store.get(input.id); assert.equal(row.status, 'proposed'); assert.equal(commands.store.reminders().total, 0);
  await commands.confirm(row.id, confirm(row));
  await commands.input(input);
  assert.equal(calls, 1); assert.equal(commands.store.reminders().total, 1);
});
test('Explicit selection binds voice commands, including a task beyond the first context page', async t => {
  const { commands } = await assistant(t, { model:{ infer:async (_config, _input, context) => {
    assert.ok(context.selected_id); assert.equal(context.reminders[0].id, context.selected_id);
    return intent({ type:'complete_reminder', reminder_id:context.selected_id, time_text:'' });
  } } });
  let target;
  for (let index=0; index<51; index++) {
    const row = add(commands.store, 'task-' + index, intent({ title:'Задача ' + index }));
    const result = commands.store.confirm(row.id, confirm(row, { due_local:index===50?'2026-10-14T19:00':'2026-10-12T19:00' }), now);
    if(index===50) target=result.reminder_id;
  }
  assert.equal(commands.store.reminders({ limit:50 }).items.some(item => item.id === target), false);
  await commands.select(target);
  await commands.input({ id:'voice-complete', text:'Омни, готово', status:'done', spoken_at:now });
  await until(() => !commands.current);
  const row=commands.store.get('voice-complete'); assert.equal(row.status, 'proposed'); assert.equal(row.intent.reminder_id, target);
  await commands.confirm(row.id, { revision:row.revision, reminder_id:target, target_revision:row.intent.target_revision });
  assert.equal(commands.store.reminder(target).status, 'done'); assert.equal(commands.snapshot().selected_reminder_id, null);
  await assert.rejects(commands.select(target), /открытое/);
});
test('Whisper and Qwen share one CPU slot and the real transcript callback carries recorded time', async t => {
  let active = '', asr = 0, qwen = 0;
  const { dir, speech, commands } = await assistant(t, { model:{ infer:async (_config, input) => {
    assert.equal(active, ''); assert.equal(speech.job, null); assert.equal(speech.backgroundBusy, true);
    active = 'qwen'; qwen++; assert.equal(input.spoken_at, now);
    await new Promise(resolve => setTimeout(resolve, 5)); active = ''; return intent();
  } } });
  speech.session.run = async () => {
    assert.equal(active, ''); assert.equal(speech.backgroundBusy, false); active = 'asr'; asr++;
    await new Promise(resolve => setTimeout(resolve, 5)); active = ''; return 'Омни, напомни завтра в 19:00 решить задачи';
  };
  const transcripts = new VoiceTranscripts(dir, speech, () => {}, { onCompleted:async item => {
    await commands.input({ ...item, text:(await transcripts.text(item.id)).text, role:'candidate' });
  } });
  t.after(() => transcripts.shutdown());
  for (const id of ['one','two']) {
    const audio = path.join(dir, id + '.wav'); await writeFile(audio, Buffer.alloc(44));
    await transcripts.submit({ id, path:audio, duration:1, started_at:now }, true);
  }
  await until(() => qwen === 2 && !commands.busy && !transcripts.busy);
  assert.equal(asr, 2); assert.equal(speech.backgroundBusy, false);
  assert.equal(commands.store.list().total, 2); assert.equal(commands.store.reminders().total, 0);
});
test('Background slot blocks manual Whisper/settings and cancellation releases it', async t => {
  const { speech, commands } = await assistant(t, { model:{ infer:(_config, _input, _context, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once:true })) } });
  const row = await commands.text({ text:'Омни, напомни завтра в 19:00 решить задачи' });
  await until(() => commands.current);
  await assert.rejects(speech.run('window', 'one', '/unknown.wav'), /Qwen/);
  await assert.rejects(speech.saveParameters({ beam_size:3 }), /Qwen/);
  speech.releaseBackground('wrong-owner'); assert.equal(speech.backgroundBusy, true);
  commands.cancel(); await until(() => !commands.current);
  assert.equal(speech.backgroundBusy, false); assert.equal(commands.store.get(row.id).status, 'cancelled');
  assert.equal(commands.store.reminders().total, 0);
});
test('Owner verification precedes inference; unknown time and aged commands need clarification', async t => {
  let calls = 0;
  const { commands } = await assistant(t, { config:{ require_owner:true }, checkOwner:async () => false, model:{ infer:async () => { calls++; return intent(); } } });
  await commands.input({ id:'unverified', role:'candidate', status:'done', text:'Омни, напомни завтра в 19:00', spoken_at:now });
  await until(() => !commands.current);
  assert.equal(calls, 0); assert.equal(commands.store.get('unverified').status, 'error');
  await commands.configure(config({ enabled:true }));
  await commands.input({ id:'unknown-time', status:'done', text:'Омни, напомни завтра в 19:00' }); await until(() => !commands.current);
  assert.equal(commands.store.get('unknown-time').status, 'clarification');
  await commands.input({ id:'aged', status:'done', text:'Омни, напомни завтра в 19:00', spoken_at:'2026-10-01T09:00:00Z' }); await until(() => !commands.current);
  assert.match(commands.store.get('aged').message, /прошло/);
});
test('Bounded queue retains original text on overflow and retry preserves explicit selected target', async t => {
  let fail = true;
  const { speech, commands } = await assistant(t, { model:{ infer:async (_config, _input, context) => {
    if (fail) throw new Error('сервер выключен');
    return intent({ type:'complete_reminder', reminder_id:context.selected_id, time_text:'' });
  } } });
  const created = add(commands.store, 'created'), id = commands.store.confirm(created.id, confirm(created), now).reminder_id;
  const command = await commands.text({ text:'Готово', selected_id:id }); await until(() => !commands.current);
  assert.equal(commands.store.get(command.id).status, 'error');
  fail = false; await commands.retry(command.id); await until(() => !commands.current);
  assert.equal(commands.store.get(command.id).intent.reminder_id, id); assert.equal(commands.store.get(command.id).status, 'proposed');
  speech.job = { id:'busy' };
  for (let index=0; index<25; index++) await commands.text({ text:'Новая команда ' + index });
  assert.equal(commands.store.pendingCount(), 24);
  assert.equal(commands.store.list({ filter:'error' }).total, 1);
  commands.cancel(); speech.job = null;
});
test('Assistant UI escapes model content, keeps drafts, and saves only on explicit confirmation', async t => {
  const dom = new JSDOM('<dialog open></dialog>');
  const previous = Object.fromEntries(['window','document','Option'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { window:dom.window, document:dom.window.document, Option:dom.window.Option });
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); for (const [key,value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; });
  const { mountVoiceAssistant } = await import('../dist/recorder-assistant.js');
  const panel = document.querySelector('dialog'); assert.equal(mountVoiceAssistant(panel, {}), undefined);
  const state = { config:config(), message:'Готов', pending:0, database:'/local/reminders.sqlite' };
  const row = { id:'one', revision:2, status:'proposed', text:'<img src=x onerror=alert(1)>', message:'Проверьте', spoken_at:now, timezone:zone, intent:{ ...intent(), due_local:'2026-10-12T19:00:00' } };
  let report, off = 0; const saved = [];
  const api = {
    voiceAssistantStatus:async () => state, onVoiceAssistant:callback => { report = callback; return () => { off++; }; },
    voiceAssistantList:async () => ({ total:1, items:[row] }), voiceReminders:async () => ({ total:0, items:[] }),
    voiceAssistantConfirm:async (id,value) => { saved.push({ id,value }); row.status = 'confirmed'; row.revision++; }
  };
  const control = mountVoiceAssistant(panel, api), section = control.section;
  await until(() => section.querySelector('[data-draft-field="title"]'));
  assert.equal(section.querySelectorAll('img,script').length, 0); assert.equal(saved.length, 0);
  const title = section.querySelector('[data-draft-field="title"]'); title.value = 'Мой черновик'; title.dispatchEvent(new dom.window.Event('input'));
  const model = section.querySelector('[name="model"]'); model.value = 'other-local'; model.dispatchEvent(new dom.window.Event('input'));
  report({ ...state, config:config({ model:'old' }), message:'Whisper завершил запись' }); await control.refresh();
  assert.equal(section.querySelector('[data-draft-field="title"]').value, 'Мой черновик'); assert.equal(model.value, 'other-local');
  row.revision = 3; await control.refresh();
  assert.equal(section.querySelector('[data-draft-field="title"]').value, 'Мой черновик'); assert.match(section.textContent, /другом окне/);
  row.revision = 2; await control.refresh();
  section.querySelector('[data-proposals] form').dispatchEvent(new dom.window.Event('submit', { bubbles:true, cancelable:true }));
  await until(() => saved.length === 1);
  assert.equal(saved[0].value.title, 'Мой черновик'); assert.equal(saved[0].value.revision, 2);
  dom.window.dispatchEvent(new dom.window.Event('pagehide')); assert.equal(off, 1);
});

test('Windows package includes every stage 4 backend and renderer module', async () => {
  const desktop = JSON.parse(await readFile('desktop/package.json', 'utf8')), build = await readFile('BUILD_WINDOWS.cmd', 'utf8');
  for (const file of ['reminder-time.cjs','voice-intents.cjs','qwen-local.cjs','reminders-store.cjs','voice-commands.cjs']) { assert.ok(desktop.build.files.includes(file)); assert.ok(build.includes('desktop/' + file)); }
  assert.ok(build.includes('dist/recorder-assistant.js'));
});

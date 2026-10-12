const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_PENDING = 24, MAX_SECONDS = 3600, MAX_HISTORY = 100;
const waiting = item => item.status === 'queued' || item.status === 'running';

/** Atomically replace only the JSON file owned by the transcription queue. */
async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = target + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' }); await fs.rename(temp, target); }
  finally { await fs.rm(temp, { force: true }); }
}

/** Recognize known recorder clips sequentially without blocking the microphone. */
class VoiceTranscripts {
  constructor(directory, speech, report = () => {}, options = {}) {
    this.index = path.join(directory, 'voice-transcriptions.json');
    this.speech = speech; this.report = report; this.owner = Symbol('recorder-whisper');
    this.items = []; this.current = null; this.paused = false; this.closed = false;
    this.writes = Promise.resolve(); this.problem = '';
    this.saving = 0; this.onCompleted = options.onCompleted || (() => {});
    this.incoming = new Set();
    this.onIdle = () => this.kick();
    speech.on('idle', this.onIdle);
    this.ready = this.load();
  }
  get busy() { return this.incoming.size > 0 || this.saving > 0 || !!this.current || (!this.paused && this.items.some(item => item.status === 'queued')); }
  snapshot() {
    return { busy: this.busy, paused: this.paused, problem: this.problem,
      pending: this.items.filter(waiting).length, limit: MAX_PENDING,
      items: this.items.slice(-MAX_HISTORY).reverse().map(item => ({ ...item, settings: undefined })) };
  }
  publish() { this.report(this.snapshot()); }
  async load() {
    try {
      const stat = await fs.stat(this.index);
      if (stat.size > 2 * 1024 * 1024) throw new Error('История распознавания слишком большая.');
      const value = JSON.parse(await fs.readFile(this.index, 'utf8'));
      if (!Array.isArray(value.items)) throw new Error('Неверный формат истории распознавания.');
      const statuses = new Set(['queued','running','done','empty','error','cancelled','not_requested']);
      this.items = value.items.slice(-MAX_HISTORY).filter(item => item && typeof item.id === 'string' && /^[\w-]{1,80}$/.test(item.id) && typeof item.path === 'string' && path.isAbsolute(item.path) && path.extname(item.path).toLowerCase() === '.wav' && Number.isFinite(item.duration) && item.duration >= 0 && item.duration <= 602 && statuses.has(item.status));
      for (const item of this.items) if (waiting(item)) {
        item.status = 'cancelled'; item.message = 'Прервано при выходе. Можно повторить распознавание.';
      }
    } catch (error) { if (error.code !== 'ENOENT') this.problem = 'Не удалось прочитать историю: ' + error.message; }
    this.publish();
  }
  persist(item) {
    this.saving += 1;
    const entry = item && JSON.parse(JSON.stringify(item));
    const history = { schema_version: 1, items: JSON.parse(JSON.stringify(this.items)) };
    this.writes = this.writes.catch(() => {}).then(async () => {
      if (entry) await writeJson(entry.path.replace(/\.wav$/i, '.transcription.json'), { schema_version: 1, ...entry });
      await writeJson(this.index, history);
    }).finally(() => { this.saving -= 1; this.publish(); });
    return this.writes;
  }
  async submit(clip, enabled) {
    await this.ready;
    if (this.incoming.has(clip.id) || this.items.some(item => item.id === clip.id)) return;
    this.incoming.add(clip.id);
    try { await this.register(clip, enabled); }
    finally { this.incoming.delete(clip.id); this.publish(); }
  }
  async register(clip, enabled) {
    const source = await fs.realpath(clip.path);
    const item = { id: clip.id, path: source, duration: clip.duration,
      spokenAt: typeof clip.started_at === 'string' && Number.isFinite(Date.parse(clip.started_at)) ? new Date(clip.started_at).toISOString() : null,
      captureRole: clip.capture_role || clip.role || 'candidate',
      createdAt: new Date().toISOString(), status: 'not_requested', attempt: 0,
      message: 'Автоматическое распознавание выключено.', preview: '', savedPath: null };
    this.items.push(item);
    while (this.items.length > MAX_HISTORY) {
      const index = this.items.findIndex(entry => !waiting(entry) && entry !== item);
      if (index < 0) break;
      this.items.splice(index, 1);
    }
    if (enabled && !this.closed) this.enqueue(item);
    else if (enabled) { item.status = 'cancelled'; item.message = 'Omni закрывается. Запись сохранена; можно распознать позже.'; }
    this.publish();
    await this.persist(item);
    this.kick();
  }
  enqueue(item) {
    const pending = this.items.filter(waiting);
    if (pending.length >= MAX_PENDING || pending.reduce((sum, entry) => sum + entry.duration, 0) + item.duration > MAX_SECONDS) {
      item.status = 'error'; item.message = 'Очередь заполнена (24 фрагмента или 60 минут). WAV сохранён; повторите позже.';
      return;
    }
    item.status = 'queued'; item.message = 'В очереди Whisper.';
  }
  async retry(id) {
    await this.ready;
    if (this.closed) throw new Error('Очередь завершает работу.');
    const item = this.find(id);
    if (waiting(item)) throw new Error('Этот фрагмент уже находится в очереди.');
    this.enqueue(item);
    if (item.status === 'queued') { this.paused = false; this.problem = ''; }
    this.publish(); await this.persist(item); this.kick();
    return this.snapshot();
  }
  find(id) {
    const item = typeof id === 'string' && this.items.find(entry => entry.id === id);
    if (!item) throw new Error('Фрагмент не найден в истории диктофона.');
    return item;
  }
  async text(id) {
    await this.ready;
    const item = this.find(id);
    if (!item.savedPath) return { text: item.preview || '', savedPath: null };
    const base = item.path.slice(0, -4);
    if (typeof item.savedPath !== 'string' || !item.savedPath.startsWith(base) || path.extname(item.savedPath) !== '.txt' || path.dirname(item.savedPath) !== path.dirname(item.path)) throw new Error('Неверный путь расшифровки.');
    const stat = await fs.stat(item.savedPath);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Текстовый файл слишком большой или недоступен.');
    return { text: await fs.readFile(item.savedPath, 'utf8'), savedPath: item.savedPath };
  }
  async cancel(id) {
    await this.ready;
    const item = this.find(id);
    if (item.status === 'running') this.speech.cancel(this.owner, item.requestId);
    else if (item.status === 'queued') { item.status = 'cancelled'; item.message = 'Распознавание отменено. WAV сохранён.'; await this.persist(item); }
    this.publish(); return this.snapshot();
  }
  async resume() {
    await this.ready;
    if (this.closed) throw new Error('Очередь завершает работу.');
    this.paused = false; this.problem = ''; this.publish(); this.kick();
    return this.snapshot();
  }
  async pause() {
    await this.ready;
    this.paused = true;
    this.problem = 'Очередь приостановлена. Текущий фрагмент завершает распознавание; его можно отменить.';
    this.publish(); return this.snapshot();
  }
  kick() {
    if (this.closed || this.paused || this.current || this.speech.job || this.speech.updating || this.speech.backgroundBusy) return;
    const item = this.items.find(entry => entry.status === 'queued');
    if (!item) return;
    item.status = 'running'; item.attempt += 1; item.preview = ''; item.savedPath = null;
    item.requestId = 'voice-' + randomUUID(); item.message = 'Распознаётся…';
    const token = { item }; this.current = token;
    token.done = this.run(item).finally(() => {
      if (this.current === token) this.current = null;
      this.publish(); this.kick();
    });
    this.publish();
  }
  async run(item) {
    try {
      const running = this.speech.run(this.owner, item.requestId, item.path, event => {
        if (event.type === 'status') item.message = String(event.message).slice(0, 2000);
        else if (event.type === 'segment') item.preview = (item.preview + '\n' + String(event.text)).trim().slice(0, 2000);
        this.publish();
      }, { background: true, onConfig: config => { item.settings = { python: config.python, model: config.model, params: config.params }; } });
      // Attach rejection handling immediately, before disk I/O can yield.
      const result = await running;
      item.preview = result.text.slice(0, 2000); item.savedPath = result.savedPath;
      item.status = result.text.trim() ? result.savedPath ? 'done' : 'error' : 'empty';
      item.message = result.message;
      if (item.status === 'error') { this.paused = true; this.problem = result.message; }
    } catch (error) {
      item.status = this.closed || /отменено/.test(error.message) ? 'cancelled' : 'error';
      item.message = error.message;
      if (item.status === 'error') { this.paused = true; this.problem = 'Очередь приостановлена: ' + error.message; }
    }
    item.finishedAt = new Date().toISOString();
    try { await this.persist(item); }
    catch (error) { this.paused = true; this.problem = 'Ошибка сохранения истории: ' + error.message; }
    try { await this.onCompleted({ id: item.id, path: item.path, savedPath: item.savedPath, status: item.status, spoken_at: item.spokenAt, capture_role: item.captureRole }); }
    catch (error) { this.problem = 'Обработка сохранённого текста: ' + error.message; }
  }
  suspend() { this.closed = true; this.paused = true; }
  async shutdown() {
    this.suspend(); await this.ready;
    while (this.incoming.size) await new Promise(resolve => setTimeout(resolve, 10));
    if (this.current) {
      this.speech.cancel(this.owner, this.current.item.requestId);
      this.speech.session.close();
      await this.current?.done;
    }
    this.speech.session.close();
    this.speech.off('idle', this.onIdle);
    await this.persist(); this.publish();
  }
}
module.exports = { VoiceTranscripts };

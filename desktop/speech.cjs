const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { SpeechSession } = require('./speech-session.cjs');
const defaults = require('./speech-defaults.json');

const MAX_TEXT = 16 * 1024 * 1024;
const audioName = name => ['.wav', '.ogg'].includes(path.extname(name).toLowerCase());

/** Validate renderer-supplied parameters against the same schema shown in settings. */
function parameters(input = {}, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Неверные параметры Whisper.');
  const fields = new Map(defaults.fields.map(field => [field.key, field]));
  for (const key of Object.keys(input)) if (!fields.has(key)) throw new Error('Неизвестный параметр Whisper: ' + key);
  return Object.fromEntries(defaults.fields.filter(field => !partial || Object.hasOwn(input, field.key)).map(field => {
    const value = Object.hasOwn(input, field.key) ? input[field.key] : field.default;
    const choices = field.choices?.map(choice => Array.isArray(choice) ? choice[0] : choice);
    const valid = field.type === 'number' ? typeof value === 'number' && Number.isFinite(value) && value >= field.min && value <= field.max && (!field.integer || Number.isInteger(value))
      : field.type === 'checkbox' ? typeof value === 'boolean'
      : field.type === 'select' ? choices.includes(value)
      : typeof value === 'string' && value.length <= field.maxLength;
    if (!valid) throw new Error('Неверное значение: ' + field.label + '.');
    return [field.key, value];
  }));
}

/** Start only a selected Python and keep transcription jobs outside the renderer. */
class SpeechService extends EventEmitter {
  constructor(directory, worker, options = {}) {
    super();
    this.directory = directory; this.worker = worker;
    this.spawn = options.spawn || spawn; this.job = null;
    this.session = new SpeechSession(worker, this.spawn);
    this.backgroundOwner = null;
  }
  get backgroundBusy() { return this.backgroundOwner !== null; }
  reserveBackground(owner) {
    if (this.job || this.updating || this.backgroundBusy) return false;
    this.backgroundOwner = owner; return true;
  }
  releaseBackground(owner) {
    if (this.backgroundOwner !== owner) return;
    this.backgroundOwner = null; this.emit('idle');
  }
  async settings() {
    let value = {};
    try {
      value = JSON.parse(await fs.readFile(path.join(this.directory, 'speech-settings.json'), 'utf8'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const paths = Object.fromEntries(Object.entries(defaults.paths).map(([key, fallback]) => [key, typeof value[key] === 'string' && value[key] ? value[key] : fallback]));
    return { ...paths, params: parameters(value.params), schema: defaults.fields };
  }
  async update(change) {
    if (this.backgroundBusy) throw new Error('Сначала завершите или отмените обработку Qwen.');
    if (this.job) throw new Error('Сначала завершите или отмените распознавание.');
    if (this.updating) throw new Error('Настройки сохраняются. Подождите.');
    this.updating = true;
    try {
      const config = await change(await this.settings());
      const saved = { python: config.python, model: config.model, ffmpeg: config.ffmpeg, params: parameters(config.params) };
      await fs.mkdir(this.directory, { recursive: true });
      const target = path.join(this.directory, 'speech-settings.json'), temp = target + '.' + randomUUID() + '.tmp';
      try { await fs.writeFile(temp, JSON.stringify(saved, null, 2), { flag: 'wx' }); await fs.rename(temp, target); }
      finally { await fs.rm(temp, { force: true }); }
      return { ...saved, schema: defaults.fields };
    } finally { this.updating = false; this.emit('idle'); }
  }
  saveParameters(input) {
    const patch = parameters(input, true);
    return this.update(config => ({ ...config, params: parameters({ ...config.params, ...patch }) }));
  }
  reset() {
    return this.update(() => ({ ...defaults.paths, params: parameters() }));
  }
  async configure(kind, selected) {
    return this.update(async config => {
      const resolved = await fs.realpath(selected), stat = await fs.stat(resolved);
      if (kind === 'python') {
        if (!stat.isFile() || !/^python(?:[\d.]*)?(?:\.exe)?$/i.test(path.basename(resolved))) throw new Error('Выберите python.exe вашего окружения.');
        // Keep a virtual environment's launcher path; resolving its symlink can lose its packages.
        config.python = path.resolve(selected);
      } else if (kind === 'model-file') {
        if (!stat.isFile() || path.extname(resolved).toLowerCase() !== '.pt') throw new Error('Выберите файл модели .pt.');
        config.model = resolved;
      } else if (kind === 'model-folder') {
        if (!stat.isDirectory()) throw new Error('Выберите папку модели faster-whisper.');
        for (const name of ['model.bin', 'config.json', 'tokenizer.json']) if (!(await fs.stat(path.join(resolved, name))).isFile()) throw new Error('В папке модели отсутствует ' + name);
        config.model = resolved;
      } else if (kind === 'ffmpeg') {
        if (!stat.isFile() || !/^ffmpeg(?:\.exe)?$/i.test(path.basename(resolved))) throw new Error('Выберите ffmpeg.exe.');
        config.ffmpeg = resolved;
      } else throw new Error('Неверная настройка Whisper.');
      return config;
    });
  }
  cancel(owner, requestId) {
    const job = this.job;
    if (!job || job.owner !== owner || requestId && job.id !== requestId) return false;
    job.cancelled = true;
    if (job.child?.pid && process.platform === 'win32') {
      const killer = this.spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.on('error', () => job.child.kill());
      killer.on('close', code => { if (code !== 0) job.child.kill(); });
    } else job.child?.kill();
    return true;
  }
  async run(owner, id, audio, report = () => {}, options = {}) {
    if (this.backgroundBusy) throw new Error('Qwen обрабатывает команду. Дождитесь завершения или отмените запрос.');
    if (this.job) throw new Error('Whisper уже распознаёт другую запись. Дождитесь завершения.');
    if (this.updating) throw new Error('Дождитесь сохранения настроек Whisper.');
    if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw new Error('Неверный запрос распознавания.');
    const job = { owner, id, cancelled: false }; this.job = job;
    try {
      const config = await this.settings();
      if (options.background && config.params.cpu_threads === 0) config.params.cpu_threads = 4;
      options.onConfig?.(config);
      if (!config.python || !config.model) throw new Error('Откройте «Настройки Whisper» и выберите Python и скачанную модель.');
      const source = await fs.realpath(audio), stat = await fs.stat(source);
      if (!stat.isFile() || !audioName(source) || stat.size >= 500000000) throw new Error('Выберите OGG или WAV размером меньше 500 МБ.');
      if (job.cancelled) throw new Error('Распознавание отменено.');
      const { schema, ...request } = config;
      const text = await (options.background ? this.session.run(job, { ...request, audio: source }, report) : this.recognize(job, { ...request, audio: source }, report));
      if (job.cancelled) throw new Error('Распознавание отменено.');
      if (!text.trim()) return { text: '', savedPath: null, message: 'Речь не обнаружена; текстовый файл не создан.' };
      let savedPath;
      try { savedPath = await this.saveTranscript(source, text, job); }
      catch (error) { if (job.cancelled) throw error; return { text, savedPath: null, message: 'Речь распознана, но сохранить рядом с записью не удалось: ' + error.message }; }
      return { text, savedPath, message: 'Сохранено: ' + savedPath };
    } finally { if (this.job === job) this.job = null; this.emit('idle'); }
  }
  recognize(job, config, report) {
    return new Promise((resolve, reject) => {
      let buffer = '', result, errorMessage = '', diagnostics = '', bytes = 0, settled = false;
      const decoder = new StringDecoder('utf8');
      const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
      const consume = chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { errorMessage = 'Некорректный ответ локального Whisper.'; job.child.kill(); return; }
          if (!message || typeof message !== 'object') { errorMessage = 'Некорректный ответ локального Whisper.'; job.child.kill(); return; }
          if (message.type === 'result' && typeof message.text === 'string') result = message.text;
          else if (message.type === 'error') errorMessage = String(message.message || 'Ошибка Whisper.');
          else if (['status', 'segment'].includes(message.type)) report({ ...message, id: job.id });
        }
      };
      const child = this.spawn(config.python, ['-u', this.worker], {
        shell: false, windowsHide: true, cwd: path.dirname(this.worker),
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      job.child = child;
      child.on('error', error => finish(new Error('Не удалось запустить выбранный Python: ' + error.message)));
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_TEXT * 3) { errorMessage = 'Ответ Whisper слишком большой.'; child.kill(); return; }
        consume(decoder.write(chunk));
      });
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-8192); });
      child.on('close', code => {
        consume(decoder.end()); if (buffer.trim()) consume('\n');
        if (job.cancelled) return finish(new Error('Распознавание отменено.'));
        if (errorMessage || code !== 0 || typeof result !== 'string') return finish(new Error(errorMessage || 'Whisper завершился с ошибкой (' + code + '). Проверьте выбранное Python-окружение. ' + diagnostics.slice(-2000)));
        if (Buffer.byteLength(result, 'utf8') > MAX_TEXT) return finish(new Error('Распознанный текст слишком большой.'));
        finish(null, result);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(config) + '\n', 'utf8');
      if (job.cancelled) this.cancel(job.owner, job.id);
    });
  }
  async saveTranscript(source, text, job) {
    const base = source.slice(0, -path.extname(source).length);
    for (let number = 1; number <= 10000; number++) {
      if (job?.cancelled) throw new Error('Распознавание отменено.');
      const target = base + (number === 1 ? '' : '-transcript-' + number) + '.txt';
      let handle;
      try { handle = await fs.open(target, 'wx'); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      try { if (job?.cancelled) throw new Error('Распознавание отменено.'); await handle.writeFile(text.trim() + '\n', 'utf8'); if (job?.cancelled) throw new Error('Распознавание отменено.'); return target; }
      catch (error) { await handle.close(); handle = null; await fs.rm(target, { force: true }); throw error; }
      finally { if (handle) await handle.close(); }
    }
    throw new Error('Не удалось подобрать имя текстового файла.');
  }
}
module.exports = { SpeechService };

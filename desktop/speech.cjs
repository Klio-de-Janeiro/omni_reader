const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');

const MAX_TEXT = 16 * 1024 * 1024;
const audioName = name => ['.wav', '.ogg'].includes(path.extname(name).toLowerCase());

/** Start only a selected Python and keep transcription jobs outside the renderer. */
class SpeechService {
  constructor(directory, worker, options = {}) {
    this.directory = directory; this.worker = worker;
    this.spawn = options.spawn || spawn; this.job = null;
  }
  async settings() {
    try {
      const value = JSON.parse(await fs.readFile(path.join(this.directory, 'speech-settings.json'), 'utf8'));
      return { python: value.python || '', model: value.model || '', ffmpeg: value.ffmpeg || '' };
    } catch (error) { if (error.code === 'ENOENT') return { python: '', model: '', ffmpeg: '' }; throw error; }
  }
  async configure(kind, selected) {
    if (this.job) throw new Error('Сначала завершите или отмените распознавание.');
    const config = await this.settings(), resolved = await fs.realpath(selected), stat = await fs.stat(resolved);
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
    await fs.mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, 'speech-settings.json'), temp = target + '.' + randomUUID() + '.tmp';
    try { await fs.writeFile(temp, JSON.stringify(config, null, 2), { flag: 'wx' }); await fs.rename(temp, target); }
    finally { await fs.rm(temp, { force: true }); }
    return config;
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
  async run(owner, id, audio, report = () => {}) {
    if (this.job) throw new Error('Whisper уже распознаёт другую запись. Дождитесь завершения.');
    if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw new Error('Неверный запрос распознавания.');
    const job = { owner, id, cancelled: false }; this.job = job;
    try {
      const config = await this.settings();
      if (!config.python || !config.model) throw new Error('Откройте «Настройки Whisper» и выберите Python и скачанную модель.');
      const source = await fs.realpath(audio), stat = await fs.stat(source);
      if (!stat.isFile() || !audioName(source) || stat.size >= 500000000) throw new Error('Выберите OGG или WAV размером меньше 500 МБ.');
      if (job.cancelled) throw new Error('Распознавание отменено.');
      const text = await this.recognize(job, { ...config, audio: source }, report);
      if (job.cancelled) throw new Error('Распознавание отменено.');
      if (!text.trim()) return { text: '', savedPath: null, message: 'Речь не обнаружена; текстовый файл не создан.' };
      let savedPath;
      try { savedPath = await this.saveTranscript(source, text, job); }
      catch (error) { if (job.cancelled) throw error; return { text, savedPath: null, message: 'Речь распознана, но сохранить рядом с записью не удалось: ' + error.message }; }
      return { text, savedPath, message: 'Сохранено: ' + savedPath };
    } finally { if (this.job === job) this.job = null; }
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

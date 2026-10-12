const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const MAX_TEXT = 16 * 1024 * 1024;

/** Keep one offline model worker for sequential recorder jobs. */
class SpeechSession {
  constructor(script, spawnProcess) {
    this.script = script; this.spawn = spawnProcess;
    this.child = null; this.pending = null; this.idleTimer = null;
  }
  start(python) {
    const child = this.spawn(python, ['-u', this.script], {
      shell: false, windowsHide: true, cwd: path.dirname(this.script),
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child; this.python = python;
    let buffer = '', stderr = '';
    const decoder = new StringDecoder('utf8');
    const fail = message => {
      if (this.child !== child) return;
      this.settle(new Error(message)); this.close();
    };
    child.stdin.on('error', () => {});
    child.on('error', error => fail('Не удалось запустить Python Whisper: ' + error.message));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer, 'utf8') > MAX_TEXT * 3) return fail('Ответ Whisper слишком большой.');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { return fail('Некорректный ответ локального Whisper.'); }
        const pending = this.pending;
        if (!pending || !event || event.id !== pending.job.id) return fail('Whisper вернул ответ для другого фрагмента.');
        if (event.type === 'result' && typeof event.text === 'string') {
          if (Buffer.byteLength(event.text, 'utf8') > MAX_TEXT) return fail('Распознанный текст слишком большой.');
          this.settle(null, event.text);
        } else if (event.type === 'error') this.settle(new Error(String(event.message).slice(0, 2000)));
        else if (['status', 'segment'].includes(event.type)) pending.report(event);
        else return fail('Неизвестный ответ локального Whisper.');
      }
    });
    child.on('close', code => {
      if (this.child !== child) return;
      this.settle(new Error(this.pending?.job.cancelled ? 'Распознавание отменено.' : 'Whisper завершился с ошибкой (' + code + '). ' + stderr));
      this.child = null; clearTimeout(this.idleTimer);
    });
    child.stdin.write(JSON.stringify({ command: 'serve' }) + '\n');
  }
  run(job, config, report) {
    clearTimeout(this.idleTimer);
    if (this.pending) throw new Error('Whisper уже распознаёт другую запись.');
    if (this.child && this.python !== config.python) this.close();
    if (!this.child) this.start(config.python);
    job.child = this.child;
    return new Promise((resolve, reject) => {
      this.pending = { job, report, resolve, reject };
      job.child.stdin.write(JSON.stringify({ ...config, id: job.id }) + '\n');
    });
  }
  settle(error, text) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.job.cancelled ? pending.reject(new Error('Распознавание отменено.')) : error ? pending.reject(error) : pending.resolve(text);
    this.idleTimer = setTimeout(() => this.close(), 30000);
    this.idleTimer.unref();
  }
  close() {
    clearTimeout(this.idleTimer);
    const child = this.child; this.child = null;
    if (this.pending) this.settle(new Error('Распознавание отменено.'));
    clearTimeout(this.idleTimer);
    if (child) { child.stdin.end(); child.kill(); }
  }
}
module.exports = { SpeechSession };

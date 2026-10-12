const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');

const defaults = { device: '', threshold: 0.5, silence_ms: 5000, quota_mb: 500, enhance: true, normalize: false, pre_ms: 1024, max_seconds: 600, auto_transcribe: false };
const startupPhases = {
  python: ['запуск Python', 15000], numpy: ['загрузка NumPy', 120000],
  numpy_check: ['проверка NumPy', 30000],
  onnx: ['загрузка sherpa-onnx для Silero', 45000], model: ['загрузка модели Silero', 30000],
  validation: ['проверка Silero на CPU', 15000], audio: ['загрузка PortAudio', 30000],
  device: ['проверка микрофона', 30000], storage: ['проверка папки записей', 90000],
  enhance: ['загрузка очистки аудио', 30000], stream: ['открытие микрофона', 30000]
};
/** Validate the small public settings surface; filesystem paths use native pickers. */
function parameters(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Неверные настройки диктофона.');
  for (const key of Object.keys(input)) if (!Object.hasOwn(defaults, key)) throw new Error('Неизвестная настройка диктофона.');
  const value = { ...defaults, ...input };
  if (typeof value.auto_transcribe !== 'boolean') throw new Error('Неверный режим автоматического распознавания.');
  if (typeof value.device !== 'string' || value.device.length > 1024 || !Number.isFinite(value.threshold) || value.threshold < 0.1 || value.threshold > 0.95 || !Number.isInteger(value.silence_ms) || value.silence_ms < 200 || value.silence_ms > 12000 || !Number.isInteger(value.quota_mb) || value.quota_mb < 100 || value.quota_mb > 10000 || typeof value.enhance !== 'boolean' || typeof value.normalize !== 'boolean' || !Number.isInteger(value.pre_ms) || value.pre_ms < 0 || value.pre_ms > 2000 || !Number.isInteger(value.max_seconds) || value.max_seconds < 30 || value.max_seconds > 600) throw new Error('Проверьте настройки диктофона: паузу, порог речи, длину фрагмента и лимит записей.');
  return value;
}

/** Supervise the local worker with bounded protocol buffers and graceful stop. */
function worker(python, script, config, report, spawnProcess = spawn) {
  const child = spawnProcess(python, ['-I', '-u', '-X', 'utf8', '-X', 'faulthandler', script], {
    shell: false, windowsHide: true, cwd: path.dirname(script),
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1',
      OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let timer, error = '', stderr = '', buffer = '', settled = false, stopping = false, micClosed = false;
  const decoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  const kill = () => child.kill();
  const stop = () => {
    if (settled || stopping) return;
    stopping = true;
    child.stdin.end(JSON.stringify({ command: 'stop' }) + '\n');
    timer ||= setTimeout(() => { error ||= 'Диктофон не ответил на остановку; процесс завершён.'; kill(); }, micClosed ? 120000 : 5000);
  };
  const done = new Promise((resolve, reject) => {
    const finish = problem => { if (settled) return; settled = true; clearTimeout(timer); problem ? reject(new Error(problem)) : resolve(); };
    child.on('error', problem => finish('Не удалось запустить Python диктофона: ' + python + '. ' + problem.message + '\nЗапустите SETUP_VOICE_WINDOWS.ps1 и выберите Python из omni_voice_env.'));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (buffer.length > 65536) { error = 'Слишком большой ответ диктофона.'; kill(); return; }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (!event || typeof event !== 'object') throw new Error();
          if (event.type === 'microphone_closed' && !micClosed) {
            micClosed = true; clearTimeout(timer);
            timer = setTimeout(() => { error ||= 'Очистка записей не завершилась за 2 минуты. Оригиналы сохранены.'; kill(); }, 120000);
          }
          if (event.type === 'error') error = String(event.message).slice(0, 2000);
          else report(event);
        } catch { error = 'Некорректный ответ диктофона.'; kill(); return; }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + stderrDecoder.write(chunk)).slice(-24000); });
    child.on('close', code => finish(error || (code !== 0 ? 'Диктофон завершился с ошибкой. ' + stderr : '')));
    child.stdin.write(JSON.stringify(config) + '\n');
  });
  return { done, stop, kill, diagnostic: () => stderr, send: message => {
    if (!settled && !stopping) child.stdin.write(JSON.stringify(message) + '\n');
  } };
}

/** Own exactly one background recorder across all Omni windows. */
class RecorderService {
  constructor(directory, script, getPython, report = () => {}, options = {}) {
    this.directory = directory; this.script = script; this.getPython = getPython;
    this.report = report; this.spawn = options.spawn || spawn;
    this.onClip = options.onClip || (() => {});
    this.startupLimitMs = options.startupLimitMs ?? 300000;
    this.phaseTimeoutMs = options.phaseTimeoutMs;
    this.job = null; this.probe = null; this.editing = false;
    this.state = { phase: 'stopped', message: 'Микрофон выключен.', clips: 0, seconds: 0, recent: [] };
  }
  get active() { return !!this.job; }
  snapshot() { return { ...this.state, active: this.active }; }
  publish(change) { Object.assign(this.state, change); this.report(this.snapshot()); }
  async settings() {
    let value = {};
    try { value = JSON.parse(await fs.readFile(path.join(this.directory, 'recorder-settings.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { python: value.python || await this.getPython(), folder: value.folder || path.join(this.directory, 'voice-recordings'), ...parameters(Object.fromEntries(Object.keys(defaults).filter(key => key in value).map(key => [key, value[key]]))) };
  }
  assertIdle() { if (this.active || this.probe || this.editing) throw new Error('Дождитесь завершения операции или остановите диктофон.'); }
  async update(change, live = false) {
    if (live) { if (this.probe || this.editing) throw new Error('Дождитесь сохранения настроек.'); }
    else this.assertIdle();
    this.editing = true;
    try {
      const config = await change(await this.settings());
      await fs.mkdir(this.directory, { recursive: true });
      const target = path.join(this.directory, 'recorder-settings.json'), temp = target + '.' + randomUUID() + '.tmp';
      try { await fs.writeFile(temp, JSON.stringify(config, null, 2), { flag: 'wx' }); await fs.rename(temp, target); }
      finally { await fs.rm(temp, { force: true }); }
      return config;
    } finally { this.editing = false; }
  }
  save(input) { const value = parameters(input); return this.update(config => ({ ...config, ...value })); }
  async setSilence(silence_ms) {
    parameters({ silence_ms });
    const config = await this.update(value => ({ ...value, silence_ms }), true);
    if (this.job) {
      this.job.silence_ms = silence_ms;
      this.job.process?.send({ command: 'silence', silence_ms });
    }
    this.publish({ silence_ms });
    return config;
  }
  async setAuto(auto_transcribe) {
    parameters({ auto_transcribe });
    const config = await this.update(value => ({ ...value, auto_transcribe }), true);
    if (this.job) this.job.auto_transcribe = auto_transcribe;
    this.publish({ auto_transcribe }); return config;
  }
  configure(kind, selected) {
    return this.update(async config => {
      const stat = await fs.stat(selected);
      if (kind === 'python' && stat.isFile() && /^python(?:[\d.]*)?(?:\.exe)?$/i.test(path.basename(selected))) config.python = path.resolve(selected);
      else if (kind === 'folder' && stat.isDirectory()) config.folder = path.resolve(selected);
      else throw new Error('Неверный файл Python или папка записей.');
      return config;
    });
  }
  async devices() {
    this.assertIdle(); const token = {}; this.probe = token;
    let timer, totalTimer, result, expired = false, stage = 'python';
    try {
      const config = await this.settings();
      const expire = () => { expired = true; token.process?.kill(); };
      const arm = next => {
        stage = next; clearTimeout(timer);
        timer = setTimeout(expire, this.phaseTimeoutMs ?? startupPhases[stage][1]);
      };
      arm('python');
      token.process = worker(config.python, this.script, { command: 'devices' }, event => {
        if (event.type === 'devices') result = event.devices;
        else if (event.type === 'startup' && Object.hasOwn(startupPhases, event.stage) && stage !== event.stage) arm(event.stage);
      }, this.spawn);
      totalTimer = setTimeout(expire, this.startupLimitMs);
      try { await token.process.done; }
      catch (error) { if (!expired) throw error; }
      if (expired) throw new Error('Поиск микрофонов остановлен: этап «' + startupPhases[stage][0] + '» не завершён. Python: ' + config.python + '.\n' + token.process.diagnostic().slice(-2000));
      if (!Array.isArray(result)) throw new Error('Не удалось получить список микрофонов.');
      return result;
    } finally { clearTimeout(timer); clearTimeout(totalTimer); if (this.probe === token) this.probe = null; }
  }
  start() {
    this.assertIdle(); const token = { cancelled: false }; this.job = token;
    this.publish({ phase: 'starting', message: 'Запуск Silero и микрофона…', clips: 0, seconds: 0, recent: [], speech_detected: false, warning: '', startup_stage: 'python', diagnostic_log: '' });
    token.done = this.record(token);
    return this.snapshot();
  }
  async record(token) {
    let startupTimer, totalTimer, watchdog, config;
    const started = Date.now(), steps = [];
    let runtime = null;
    let stage = 'python';
    try {
      config = await this.settings();
      if (token.cancelled) return;
      if (token.silence_ms !== undefined) config.silence_ms = token.silence_ms;
      this.publish({ silence_ms: config.silence_ms, auto_transcribe: token.auto_transcribe ?? config.auto_transcribe });
      let ready = false, bootFinished = false, heartbeat = Date.now(), failure = '';
      const timeout = (limit, overall = false) => {
        if (token.cancelled || bootFinished || failure) return;
        failure = (overall ? 'Запуск диктофона не завершился за общий лимит ' + Math.ceil(limit / 1000) + ' с. Последний этап: «' + startupPhases[stage][0] + '».' : 'Запуск диктофона остановлен: этап «' + startupPhases[stage][0] + '» не завершился за ' + Math.ceil(limit / 1000) + ' с.') + '\nPython: ' + config.python + '.\n' +
          'Запустите обновлённый SETUP_VOICE_WINDOWS.ps1. Для NumPy доступна отдельная проверка: scripts/check-voice-runtime.py --numpy-only. Журнал содержит стек зависания, если Python успел его записать.';
        token.process.kill();
      };
      const arm = next => {
        stage = next; clearTimeout(startupTimer);
        const limit = this.phaseTimeoutMs ?? startupPhases[stage][1];
        startupTimer = setTimeout(() => timeout(limit), limit);
      };
      token.process = worker(config.python, this.script, { ...config, command: 'record' }, event => {
        if (event.type === 'runtime') {
          runtime = Object.fromEntries(['python','version','prefix','base_prefix'].map(key => [key, String(event[key] || '').slice(0, 2000)]));
          runtime.isolated = event.isolated === true;
        } else if (event.type === 'startup' && !bootFinished && Object.hasOwn(startupPhases, event.stage)) {
          if (steps.length < 32) steps.push({ elapsed_ms: Date.now() - started, stage: event.stage, message: String(event.message || '').slice(0, 2000) });
          if (stage !== event.stage) arm(event.stage);
          if (!token.cancelled) this.publish({ startup_stage: event.stage, message: String(event.message || startupPhases[event.stage][0]).slice(0, 2000) });
        } else if (event.type === 'ready') {
          ready = true; bootFinished = true; clearTimeout(startupTimer); clearTimeout(totalTimer); heartbeat = Date.now();
          if (token.silence_ms !== undefined) token.process?.send({ command: 'silence', silence_ms: token.silence_ms });
          if (!token.cancelled) this.publish({ phase: 'listening', message: 'Микрофон включён · ожидание речи.', engine: event.engine, startup_stage: '' });
        } else if (event.type === 'activity') {
          heartbeat = Date.now();
          if (!token.cancelled) this.publish({ phase: event.speaking ? 'speech' : 'listening', speech_detected: event.speech_detected, message: event.speaking ? 'Обнаружена речь…' : 'Микрофон включён · ожидание речи.' });
        } else if (event.type === 'clip') {
          this.publish({ clips: this.state.clips + 1, seconds: this.state.seconds + event.duration, used_mb: event.used_mb, recent: [event, ...this.state.recent].slice(0, 8) });
          this.onClip(event, token.auto_transcribe ?? config.auto_transcribe);
        } else if (event.type === 'cleaned') {
          this.publish({ used_mb: event.used_mb, recent: this.state.recent.map(clip => clip.id === event.id ? { ...clip, cleanPath: event.path } : clip) });
        } else if (event.type === 'warning') {
          this.publish({ warning: event.message });
        } else if (event.type === 'microphone_closed') {
          ready = false; bootFinished = true; clearTimeout(startupTimer); clearTimeout(totalTimer);
          this.publish({ phase: 'stopping', message: 'Микрофон выключен · сохранение очищенных копий…' });
        }
      }, this.spawn);
      arm('python');
      totalTimer = setTimeout(() => timeout(this.startupLimitMs, true), this.startupLimitMs);
      watchdog = setInterval(() => { if (ready && Date.now() - heartbeat > 10000 && !token.cancelled) { failure = 'Микрофон перестал отвечать. Запись остановлена.'; token.process.kill(); } }, 2000);
      if (token.cancelled) token.process.stop();
      try { await token.process.done; }
      catch (error) { throw new Error(failure ? failure + '\n' + token.process.diagnostic().slice(-1000) : error.message); }
      if (failure) throw new Error(failure);
      if (!token.cancelled) throw new Error('Диктофон неожиданно завершился. Запустите запись заново.');
    } catch (error) {
      token.error = error.message;
    } finally {
      clearTimeout(startupTimer); clearTimeout(totalTimer); clearInterval(watchdog);
      if (config && token.process) {
        const target = path.join(this.directory, 'voice-startup.log'), temporary = target + '.' + randomUUID() + '.tmp';
        try {
          await fs.mkdir(this.directory, { recursive: true });
          await fs.writeFile(temporary, JSON.stringify({ started_at: new Date(started).toISOString(), python: config.python, runtime, engine: 'silero-sherpa-onnx-cpu', last_stage: stage, stages: steps, error: token.error || '', stderr: token.process.diagnostic() }, null, 2), { flag: 'wx' });
          await fs.rename(temporary, target);
          this.state.diagnostic_log = target;
          if (token.error) token.error += '\nЖурнал: ' + target;
        } catch { this.state.warning = 'Не удалось сохранить журнал запуска диктофона.'; }
        finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      }
      if (this.job === token) {
        this.job = null;
        this.publish({ phase: token.error ? 'error' : 'stopped', speech_detected: false, message: token.error || 'Микрофон выключен. Фрагменты сохранены.' });
      }
    }
  }
  async stop() {
    const token = this.job;
    if (!token) return this.snapshot();
    if (!token.cancelled) {
      token.cancelled = true;
      this.publish({ phase: 'stopping', message: 'Остановка и сохранение фрагмента…' });
      token.process?.stop();
    }
    await token.done;
    return this.snapshot();
  }
  async shutdown() { this.probe?.process?.kill(); await this.stop(); }
}
module.exports = { RecorderService, parameters, worker };

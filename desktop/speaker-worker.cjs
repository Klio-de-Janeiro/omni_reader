const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const path = require('node:path');
const { writeJson } = require('./voice-files.cjs');
const { unit, PREPROCESS } = require('./speaker-core.cjs');

/** Run one isolated, bounded CPU batch with progress, cancellation and logs. */
class SpeakerWorker {
  constructor(script, log, options = {}) {
    this.script = script; this.log = log; this.spawn = options.spawn || spawn;
    this.phaseLimit = options.phaseLimitMs || 120000;
    this.totalLimit = options.totalLimitMs || 30 * 60 * 1000;
    this.child = null;
  }
  run(config, clips, report = () => {}) {
    if (this.child) throw new Error('Speaker-проверка уже выполняется.');
    const id = randomUUID(), expected = new Set(clips.map(clip => clip.id)), outputs = new Map();
    const child = this.spawn(config.python, ['-u', this.script], {
      cwd: path.dirname(this.script), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' }
    });
    this.child = child;
    return new Promise((resolve, reject) => {
      let buffer = '', stderr = '', phase = 'python', failure = null, finished = false, result, timer;
      const decoder = new StringDecoder('utf8'), errorDecoder = new StringDecoder('utf8'), stages = [];
      const fail = message => {
        if (!failure) failure = new Error(message);
        child.kill();
      };
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => fail('Speaker-проверка зависла на этапе «' + phase + '». Проверьте окружение и модель.'), this.phaseLimit); };
      const total = setTimeout(() => fail('Превышено время speaker-проверки. Записи сохранены.'), this.totalLimit);
      this.cancel = () => fail('Проверка голоса отменена.');
      arm();
      child.stdin.on('error', error => fail('Ошибка связи с Python: ' + error.message));
      child.on('error', error => fail('Не удалось запустить Python для проверки голоса: ' + error.message));
      child.stderr.on('data', chunk => { stderr = (stderr + errorDecoder.write(chunk)).slice(-6000); });
      child.stdout.on('data', chunk => {
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > 256 * 1024) return fail('Слишком большой ответ speaker-модели.');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0 && !failure) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.id !== id || finished) throw new Error('Неверный ответ speaker-модели.');
            if (event.type === 'phase') {
              phase = String(event.phase).slice(0, 80);
              stages.push({ phase, at: new Date().toISOString(), message: String(event.message).slice(0, 1000) });
              report({ phase, message: String(event.message).slice(0, 1000) }); arm();
            } else if (event.type === 'progress') {
              if (!expected.has(event.clip_id)) throw new Error('Неизвестный фрагмент speaker-проверки.');
              phase = 'audio'; report({ phase, clipId: event.clip_id, message: String(event.message).slice(0, 1000) }); arm();
            } else if (event.type === 'clip') {
              phase = 'audio';
              if (!expected.delete(event.clip_id)) throw new Error('Повторный или неизвестный фрагмент.');
              if (!event.error) {
                const value = event.result;
                if (!value || !/^[a-f0-9]{64}$/.test(value.audio_hash) || !/^[a-f0-9]{64}$/.test(value.model_hash) || value.preprocess !== PREPROCESS || !Number.isFinite(value.speech_seconds) || value.speech_seconds < 0 || value.speech_seconds > 602 || !Array.isArray(value.vectors) || value.vectors.length > 3 || (value.vectors.length && value.speech_seconds < 3)) throw new Error('Неверные данные speaker-модели.');
                value.vectors = value.vectors.map(unit);
              }
              outputs.set(event.clip_id, event.error ? { error: String(event.error).slice(0, 2000) } : event.result);
              report({ phase: 'audio', clipId: event.clip_id, message: 'Обработано ' + outputs.size + ' из ' + clips.length }); arm();
            } else if (event.type === 'result') {
              if (expected.size || !/^[a-f0-9]{64}$/.test(event.model_hash)) throw new Error('Неполный ответ speaker-модели.');
              result = event; finished = true;
            } else if (event.type === 'error') fail(String(event.message).slice(0, 2000));
            else throw new Error('Неизвестный ответ speaker-модели.');
          } catch (error) { fail(error.message); }
        }
      });
      child.on('close', code => {
        clearTimeout(timer); clearTimeout(total); this.child = null; this.cancel = null;
        if (!failure && (!finished || code !== 0)) failure = new Error('Python проверки голоса завершился (' + code + '). ' + stderr);
        const diagnostic = { at: new Date().toISOString(), python: config.python, model: config.model, phase, stages, error: failure?.message || null, stderr };
        void writeJson(this.log, diagnostic).then(() => {
          failure ? reject(new Error(failure.message + ' Журнал: ' + this.log)) : resolve({ modelHash: result.model_hash, results: outputs });
        }, error => reject(new Error((failure?.message || 'Не удалось сохранить журнал проверки голоса.') + ' ' + error.message)));
      });
      child.stdin.end(JSON.stringify({ id, model: config.model, clips }) + '\n');
    });
  }
}
module.exports = { SpeakerWorker };

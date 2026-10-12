const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SpeakerWorker } = require('./speaker-worker.cjs');
const { validId, writeJson, readJson, wavInfo } = require('./voice-files.cjs');
const core = require('./speaker-core.cjs');
const { exportDataset } = require('./voice-dataset-export.cjs');

const MAX_CLIPS = 5000, MAX_PENDING = 24, MAX_TEXT = 1024 * 1024;
const DEFAULT_MODEL = 'wespeaker_en_voxceleb_resnet34_LM.onnx';

/** Own reviews, calibration and speaker data independently of raw WAV/JSON. */
class VoiceDataset {
  constructor(directory, script, options = {}) {
    this.root = path.join(directory, 'voice-dataset'); this.index = path.join(this.root, 'index.json');
    this.defaults = options.defaults; this.report = options.report || (() => {});
    this.worker = new SpeakerWorker(script, path.join(directory, 'voice-speaker.log'), options);
    this.items = []; this.config = null; this.profile = null; this.calibration = null; this.evaluation = null;
    this.job = null; this.pending = []; this.paused = false; this.closed = false; this.problem = ''; this.message = '';
    this.captureRole = 'candidate'; this.incoming = new Set(); this.edits = 0; this.writes = Promise.resolve();
    this.ready = this.load();
  }
  get busy() { return !!this.job || this.incoming.size > 0 || this.edits > 0 || (!this.paused && this.pending.length > 0); }
  snapshot() {
    const roles = Object.fromEntries(core.ROLES.map(role => [role, this.items.filter(item => item.role === role).length]));
    return { busy: this.busy, processing: !!this.job, pending: this.pending.length, paused: this.paused, problem: this.problem, message: this.message,
      total: this.items.length, limit: MAX_CLIPS, roles, approved: this.items.filter(item => item.role === 'candidate' && item.review === 'approved' && item.text_confirmed).length,
      enrollment: this.captureRole === 'reference', config: this.config, profile: this.profile && { references: this.profile.references.length, speech_seconds: this.profile.speech_seconds },
      calibration: this.calibration, evaluation: this.evaluation };
  }
  publish() { this.report(this.snapshot()); }
  async load() {
    this.config = { ...(await this.defaults()), auto_verify: false };
    try {
      const value = await readJson(this.index, 16 * 1024 * 1024);
      if (value.schema_version !== 1 || !Array.isArray(value.items) || value.items.length > MAX_CLIPS) throw new Error('Неверный каталог записей.');
      const ids = new Set();
      this.items = value.items.filter(item => item && validId(item.id) && !ids.has(item.id) && ids.add(item.id) && typeof item.path === 'string' && path.isAbsolute(item.path) && path.extname(item.path).toLowerCase() === '.wav' && core.ROLES.includes(item.role));
      for (const key of ['python', 'model']) if (typeof value.config?.[key] === 'string' && path.isAbsolute(value.config[key])) this.config[key] = value.config[key];
      this.profile = value.profile || null; this.calibration = value.calibration || null; this.evaluation = value.evaluation || null;
      if (this.profile && this.calibration && typeof value.config?.auto_verify === 'boolean') this.config.auto_verify = value.config.auto_verify;
    } catch (error) { if (error.code !== 'ENOENT') this.problem = 'Не удалось прочитать датасет: ' + error.message; }
    // No capture, inference or export resumes automatically after a restart.
    this.publish();
  }
  persist() {
    return writeJson(this.index, { schema_version: 1, config: this.config, items: this.items, profile: this.profile, calibration: this.calibration, evaluation: this.evaluation });
  }
  edit(action) {
    this.edits++;
    const operation = this.writes.catch(() => {}).then(action).then(() => this.persist());
    const result = operation.finally(() => { this.edits--; this.publish(); });
    // Invalid edits reject their own caller, not every later read/shutdown.
    this.writes = result.catch(() => {});
    return result;
  }
  assertIdle() {
    if (this.closed) throw new Error('Датасет завершает работу.');
    if (this.job) throw new Error('Дождитесь проверки голоса/экспорта или отмените её.');
  }
  find(id) {
    const item = validId(id) && this.items.find(item => item.id === id);
    if (!item) throw new Error('Запись не найдена в датасете.');
    return item;
  }
  detailPath(id) {
    if (!validId(id)) throw new Error('Неверный идентификатор записи.');
    return path.join(this.root, 'clips', id + '.json');
  }
  async stored(item) {
    try { return await readJson(this.detailPath(item.id)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { revision: 0, role: item.role, review: 'pending', corrected_text: null, text_confirmed: false, analysis: null };
    }
  }
  summary(item) {
    const check = item.check && this.calibration && item.check.profile_version === this.calibration.version ? item.check : null;
    return { ...item, check, decision: check?.decision || 'uncertain' };
  }
  async list(query = {}) {
    await this.ready;
    const offset = query.offset ?? 0, limit = query.limit ?? 30, filter = query.filter || 'all';
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50 || !['all', 'pending', 'approved', ...core.ROLES].includes(filter)) throw new Error('Неверная страница датасета.');
    const rows = this.items.filter(item => filter === 'all' || (filter === 'pending' ? item.role === 'candidate' && item.review !== 'approved' && item.review !== 'rejected' : filter === 'approved' ? item.role === 'candidate' && item.review === 'approved' : item.role === filter)).slice().reverse();
    return { total: rows.length, offset, items: rows.slice(offset, offset + limit).map(item => this.summary(item)) };
  }
  async register(clip, options = {}) {
    const token = {}; this.incoming.add(token);
    try {
      await this.ready;
      if (!validId(clip.id)) throw new Error('Неверный фрагмент диктофона.');
      const source = await fs.realpath(clip.path), audio = await wavInfo(source);
      let added = false;
      await this.edit(async () => {
        if (this.items.some(item => item.id === clip.id)) return;
        if (this.items.length >= MAX_CLIPS) throw new Error('Каталог содержит 5000 записей. WAV сохранён в папке диктофона.');
        const role = options.role || this.captureRole;
        if (!core.ROLES.includes(role)) throw new Error('Неверная роль записи.');
        const item = { id: clip.id, path: source, duration: audio.duration, createdAt: clip.createdAt || new Date().toISOString(), role, review: 'pending', text_confirmed: false, check: null };
        this.items.push(item); added = true;
        if (role === 'reference') this.invalidate();
      });
      if (added && !this.closed && options.auto !== false && this.config.auto_verify && this.captureRole === 'candidate') this.enqueue(clip.id);
    } finally { this.incoming.delete(token); this.publish(); this.kick(); }
  }
  async seed(items) {
    for (const item of items) if (!this.items.some(entry => entry.id === item.id)) {
      try { await this.register(item, { auto: false, role: 'candidate' }); }
      catch (error) { this.problem = 'Импорт истории: ' + error.message; }
    }
  }
  async noteTranscript(item) {
    await this.ready;
    if (!this.items.some(entry => entry.id === item.id) || typeof item.savedPath !== 'string') return;
    await this.edit(async () => { this.find(item.id).transcript = item.savedPath; });
  }
  async originalText(item) {
    if (!item.transcript) return '';
    const source = item.path.slice(0, -4), filename = item.transcript;
    if (typeof filename !== 'string' || !filename.startsWith(source) || path.dirname(filename) !== path.dirname(item.path) || !/^(?:-transcript-\d+)?\.txt$/.test(filename.slice(source.length))) throw new Error('Неверный путь текста Whisper.');
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT) throw new Error('Текст Whisper слишком большой или недоступен.');
    return fs.readFile(filename, 'utf8');
  }
  async detail(id) {
    await this.ready; await this.writes;
    const item = this.find(id), detail = await this.stored(item);
    let original = '', textProblem = '';
    try { original = await this.originalText(item); } catch (error) { textProblem = error.message; }
    return { item: this.summary(item), revision: detail.revision, text: detail.corrected_text ?? original,
      original_text: original, text_confirmed: detail.text_confirmed, text_problem: textProblem,
      speech_seconds: detail.analysis?.speech_seconds ?? null };
  }
  async audio(id) { await this.ready; return (await wavInfo(this.find(id).path)).bytes; }
  invalidate() {
    this.profile = null; this.calibration = null; this.evaluation = null; this.config.auto_verify = false; this.pending = [];
  }
  async review(id, value) {
    await this.ready; this.assertIdle();
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['revision', 'role', 'review', 'text', 'text_confirmed'].includes(key)) || !Number.isInteger(value.revision) || !core.ROLES.includes(value.role) || !['pending', 'approved', 'rejected'].includes(value.review) || typeof value.text !== 'string' || Buffer.byteLength(value.text) > MAX_TEXT || typeof value.text_confirmed !== 'boolean') throw new Error('Неверные параметры отбора записи.');
    await this.edit(async () => {
      this.assertIdle();
      const item = this.find(id), detail = await this.stored(item);
      if (detail.revision !== value.revision) throw new Error('Запись изменена в другом окне. Откройте её повторно.');
      if (value.role === 'candidate' && value.review === 'approved' && (!value.text_confirmed || !value.text.trim())) throw new Error('Проверьте текст перед подтверждением своего голоса.');
      const audio = await wavInfo(item.path);
      if (item.check && item.check.audio_hash !== audio.hash) item.check = null;
      const roleChanged = item.role !== value.role;
      if (roleChanged && [item.role, value.role].some(role => role === 'reference' || role.startsWith('calibration_'))) this.invalidate();
      else if (roleChanged) this.evaluation = null;
      Object.assign(detail, { revision: detail.revision + 1, role: value.role, review: value.review,
        corrected_text: value.text, text_confirmed: value.text_confirmed, review_audio_hash: audio.hash,
        reviewed_at: new Date().toISOString() });
      await writeJson(this.detailPath(id), detail);
      Object.assign(item, { role: value.role, review: value.review, text_confirmed: value.text_confirmed });
    });
    return this.detail(id);
  }
  async configure(kind, selected) {
    await this.ready; this.assertIdle();
    if (!['python', 'model'].includes(kind) || typeof selected !== 'string' || !path.isAbsolute(selected)) throw new Error('Неверная настройка speaker-модели.');
    const resolved = await fs.realpath(selected), stat = await fs.stat(resolved);
    if (!stat.isFile() || (kind === 'python' ? !/^python(?:[\d.]*)?(?:\.exe)?$/i.test(path.basename(selected)) : path.extname(resolved).toLowerCase() !== '.onnx' || stat.size > 512 * 1024 * 1024)) throw new Error('Выберите Python окружения omni_voice_env или speaker-модель ONNX.');
    await this.edit(() => { this.assertIdle(); this.config[kind] = kind === 'python' ? path.resolve(selected) : resolved; this.invalidate(); });
    return this.snapshot();
  }
  async setAuto(enabled) {
    await this.ready;
    if (typeof enabled !== 'boolean') throw new Error('Неверный переключатель проверки голоса.');
    if (enabled && !this.calibration) throw new Error('Сначала запишите эталоны и выполните калибровку.');
    await this.edit(() => {
      if (enabled && !this.calibration) throw new Error('Калибровка изменилась. Повторите её.');
      this.config.auto_verify = enabled; if (!enabled) this.pending = [];
    });
    return this.snapshot();
  }
  enrollment(enabled) {
    this.captureRole = enabled ? 'reference' : 'candidate'; this.publish();
  }
  enqueue(id) {
    if (this.pending.includes(id) || this.job?.ids?.includes(id)) return;
    if (this.pending.length >= MAX_PENDING) { this.problem = 'Очередь проверки голоса заполнена. WAV сохранён; проверьте его вручную.'; return; }
    this.pending.push(id); this.publish();
  }
  kick() {
    if (this.closed || this.paused || this.job || !this.calibration || !this.config.auto_verify || !this.pending.length) return;
    const id = this.pending.shift();
    void this.run('verify', [id]).catch(error => { this.paused = true; this.problem = error.message; this.publish(); });
  }
  async validateProfile() {
    if (!this.profile || !this.calibration) throw new Error('Сначала выполните калибровку по эталонам и отдельным своим/чужим записям.');
    for (const reference of [...this.profile.references, ...this.calibration.sources]) {
      if ((await wavInfo(this.find(reference.id).path)).hash !== reference.audio_hash) {
        await this.edit(() => this.invalidate());
        throw new Error('Эталоны или записи калибровки изменились. Повторите калибровку.');
      }
    }
  }
  async analyze(mode, id) {
    await this.ready;
    if (!['verify', 'calibrate', 'evaluate'].includes(mode)) throw new Error('Неверная операция проверки голоса.');
    if (mode === 'calibrate' && this.captureRole === 'reference') throw new Error('Сначала закончите запись эталонов.');
    let ids;
    if (mode === 'verify') ids = [this.find(id).id];
    else ids = this.items.filter(item => mode === 'calibrate' ? item.role === 'reference' || item.role.startsWith('calibration_') : item.role.startsWith('test_')).map(item => item.id);
    if (!ids.length) throw new Error('Сначала отметьте нужные записи в списке.');
    if (ids.length > 100) throw new Error('За одну проверку допускается до 100 записей.');
    this.paused = false;
    return this.run(mode, ids);
  }
  async run(mode, ids) {
    this.assertIdle();
    const token = { mode, ids, cancelled: false }; this.job = token; this.problem = ''; this.message = 'Подготовка проверки голоса…'; this.publish();
    token.done = this.process(token).finally(() => { if (this.job === token) this.job = null; this.publish(); if (!this.paused) this.kick(); });
    return token.done;
  }
  async process(token) {
    try {
      await this.edit(() => {
        for (const id of token.ids) this.find(id).check = null;
        if (token.mode === 'calibrate') this.invalidate();
        if (token.mode === 'evaluate') this.evaluation = null;
      });
      if (token.mode !== 'calibrate') await this.validateProfile();
      if (token.cancelled) throw new Error('Проверка голоса отменена.');
      const clips = token.ids.map(id => ({ id, path: this.find(id).path }));
      const result = await this.worker.run(this.config, clips, event => { this.message = event.message; this.publish(); });
      if (token.cancelled) throw new Error('Проверка голоса отменена.');
      await this.edit(async () => {
        for (const [id, analysis] of result.results) {
          const item = this.find(id), detail = await this.stored(item);
          detail.analysis = analysis.error ? null : analysis;
          if (!analysis.error && (analysis.model_hash !== result.modelHash || (await wavInfo(item.path)).hash !== analysis.audio_hash)) throw new Error('WAV или модель изменились во время проверки. Повторите её.');
          detail.analysis_error = analysis.error || null;
          await writeJson(this.detailPath(id), detail);
          item.analysis_error = analysis.error || null;
          item.speech_seconds = analysis.speech_seconds ?? null;
          item.check = null;
        }
      });
      if (token.mode === 'calibrate') await this.buildCalibration(token.ids, result.modelHash);
      else {
        if (result.modelHash !== this.profile.model_hash) {
          await this.edit(() => this.invalidate());
          throw new Error('Speaker-модель изменилась. Повторите калибровку.');
        }
        await this.applyChecks(token.ids);
        if (token.mode === 'evaluate') await this.buildEvaluation(token.ids);
      }
      this.message = token.mode === 'calibrate' ? 'Калибровка сохранена. Сомнительные результаты остаются на ручной проверке.' : token.mode === 'evaluate' ? 'Ошибки на отдельных тестовых записях подсчитаны.' : 'Проверка голоса завершена.';
      return this.snapshot();
    } catch (error) { this.problem = error.message; this.message = ''; this.paused = true; throw error; }
  }
  async entries(ids, modelHash = this.profile?.model_hash) {
    const result = [];
    for (const id of ids) {
      const item = this.find(id), detail = await this.stored(item);
      if (!detail.analysis || (modelHash && detail.analysis.model_hash !== modelHash) || detail.analysis.preprocess !== core.PREPROCESS) throw new Error('Запись не обработана совместимой моделью: ' + id + (detail.analysis_error ? ' · ' + detail.analysis_error : ''));
      result.push({ item, ...detail, analysis: detail.analysis });
    }
    return result;
  }
  async buildCalibration(ids, modelHash) {
    // A fresh calibration never reuses embeddings or thresholds from an old model.
    const entries = await this.entries(ids, modelHash), references = entries.filter(entry => entry.item.role === 'reference');
    const owner = entries.filter(entry => entry.item.role === 'calibration_owner'), other = entries.filter(entry => entry.item.role === 'calibration_other');
    if (references.length < 3 || references.reduce((sum, entry) => sum + entry.analysis.speech_seconds, 0) < 15) throw new Error('Нужны минимум 3 эталона и суммарно 15 секунд речи.');
    core.independent(entries);
    const centroid = core.average(references.map(entry => core.average(entry.analysis.vectors)));
    const source = entry => ({ id: entry.item.id, role: entry.item.role, audio_hash: entry.analysis.audio_hash });
    const profile = { model_hash: modelHash, centroid, references: references.map(source), speech_seconds: references.reduce((sum, entry) => sum + entry.analysis.speech_seconds, 0) };
    profile.version = core.fingerprint({ modelHash, preprocess: core.PREPROCESS, sources: profile.references, centroid });
    const ownScores = owner.map(entry => core.scores(entry.analysis, centroid)), otherScores = other.map(entry => core.scores(entry.analysis, centroid));
    const thresholds = core.calibrate(ownScores, otherScores), sources = [...owner, ...other].map(source);
    const calibration = { at: new Date().toISOString(), thresholds, sources,
      metrics: core.evaluate(ownScores, otherScores, thresholds), version: core.fingerprint({ profile: profile.version, thresholds, sources }) };
    await this.edit(() => { this.profile = profile; this.calibration = calibration; this.evaluation = null; });
    await this.applyChecks(ids);
  }
  async applyChecks(ids) {
    await this.edit(async () => {
      for (const id of ids) {
        const item = this.find(id), detail = await this.stored(item);
        const values = detail.analysis?.model_hash === this.profile.model_hash ? core.scores(detail.analysis, this.profile.centroid) : [];
        item.check = { decision: core.decision(values, this.calibration.thresholds), scores: values,
          audio_hash: detail.analysis?.audio_hash || null,
          profile_version: this.calibration.version, at: new Date().toISOString(),
          reason: values.length ? null : detail.analysis_error || 'Меньше 3 секунд подтверждённой речи: нужна ручная проверка.' };
      }
    });
  }
  async buildEvaluation(ids) {
    const entries = await this.entries(ids);
    const training = await this.entries([...this.profile.references, ...this.calibration.sources].map(source => source.id));
    core.independent([...training, ...entries]);
    const own = entries.filter(entry => entry.item.role === 'test_owner'), other = entries.filter(entry => entry.item.role === 'test_other');
    if (!own.length || !other.length) throw new Error('Отметьте отдельные тестовые записи: свой и чужой голос.');
    const metric = core.evaluate(own.map(entry => core.scores(entry.analysis, this.profile.centroid)), other.map(entry => core.scores(entry.analysis, this.profile.centroid)), this.calibration.thresholds);
    await this.edit(() => { this.evaluation = { at: new Date().toISOString(), profile_version: this.calibration.version, ...metric }; });
  }
  async export(parent) {
    await this.ready; this.assertIdle();
    const token = { mode: 'export', cancelled: false }; this.job = token; this.message = 'Экспорт подтверждённых записей…'; this.publish();
    token.done = (async () => {
      const candidates = this.items.filter(item => item.role === 'candidate' && item.review === 'approved');
      if (!candidates.length) throw new Error('Нет подтверждённых записей с проверенным текстом.');
      const service = this;
      async function* entries() {
        for (const item of candidates) yield { item: service.summary(item), detail: await service.stored(item) };
      }
      const result = await exportDataset(parent, entries(), { profile_version: this.calibration?.version || null, model_sha256: this.profile?.model_hash || null, calibration_metrics: this.calibration?.metrics || null, test_metrics: this.evaluation }, () => token.cancelled);
      this.message = 'Экспортировано ' + result.count + ' записей: ' + result.folder; return result;
    })().catch(error => { this.problem = error.message; throw error; }).finally(() => { this.job = null; this.publish(); this.kick(); });
    return token.done;
  }
  cancel() { this.pending = []; if (this.job) { this.job.cancelled = true; this.worker.cancel?.(); } this.paused = true; this.publish(); return this.snapshot(); }
  async shutdown() {
    this.closed = true; this.enrollment(false); this.cancel();
    await this.ready; await this.job?.done?.catch(() => {});
    while (this.incoming.size) await new Promise(resolve => setTimeout(resolve, 10));
    await this.writes;
  }
}
module.exports = { VoiceDataset, DEFAULT_MODEL };

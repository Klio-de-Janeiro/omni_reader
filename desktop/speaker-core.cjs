const { createHash } = require('node:crypto');

const PREPROCESS = 'silero-0.5-frames-v1';
const ROLES = ['candidate', 'reference', 'calibration_owner', 'calibration_other', 'test_owner', 'test_other'];
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Normalize finite embeddings before averaging or comparison. */
function unit(vector) {
  if (!Array.isArray(vector) || vector.length < 16 || vector.length > 1024 || vector.some(value => !Number.isFinite(value))) throw new Error('Неверный голосовой признак.');
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm < 1e-8) throw new Error('Пустой голосовой признак.');
  return vector.map(value => value / norm);
}

/** Give every reference recording equal weight regardless of its length. */
function average(vectors) {
  if (!vectors.length) throw new Error('Нет голосовых признаков.');
  const values = vectors.map(unit), size = values[0].length;
  if (values.some(value => value.length !== size)) throw new Error('Несовместимые голосовые признаки.');
  return unit(values[0].map((_, i) => values.reduce((sum, value) => sum + value[i], 0) / values.length));
}

/** Compare all sampled speech windows; mixed outcomes stay uncertain. */
function scores(analysis, centroid) {
  return analysis.vectors.map(vector => {
    const normalized = unit(vector);
    if (normalized.length !== centroid.length) throw new Error('Несовместимая speaker-модель.');
    return Math.max(-1, Math.min(1, normalized.reduce((sum, value, i) => sum + value * centroid[i], 0)));
  });
}
function decision(values, thresholds) {
  if (!values.length || !thresholds) return 'uncertain';
  if (values.every(value => value >= thresholds.accept)) return 'owner';
  if (values.every(value => value <= thresholds.reject)) return 'other';
  return 'uncertain';
}

/** Reject reused audio, even if imported under another name or identifier. */
function independent(entries) {
  const hashes = new Set();
  for (const entry of entries) {
    if (!entry.analysis?.vectors?.length || entry.analysis.speech_seconds < 3) throw new Error('Для эталонов и оценки нужно не менее 3 секунд речи в каждом WAV.');
    if (hashes.has(entry.analysis.audio_hash)) throw new Error('Одинаковый звук попал в эталоны и/или проверочные записи. Используйте разные записи.');
    hashes.add(entry.analysis.audio_hash);
  }
}

/** Choose conservative bounds from calibration data, never test data. */
function calibrate(owner, other, margin = 0.03) {
  if (owner.length < 3 || other.length < 3) throw new Error('Для калибровки отметьте минимум 3 свои и 3 чужие записи.');
  const lowestOwner = Math.min(...owner.flat()), highestOther = Math.max(...other.flat());
  const lower = lowestOwner - margin, upper = highestOther + margin;
  let reject = Math.min(lower, upper), accept = Math.max(lower, upper);
  if (accept - reject < margin) { const center = (accept + reject) / 2; reject = center - margin / 2; accept = center + margin / 2; }
  // A bound outside [-1, 1] deliberately disables automatic acceptance/rejection.
  return { reject, accept, margin };
}

/** Count false accepts, false rejects and undecided clips separately. */
function evaluate(owner, other, thresholds) {
  const count = values => values.reduce((result, scores) => { result[decision(scores, thresholds)]++; return result; }, { owner: 0, other: 0, uncertain: 0 });
  const own = count(owner), foreign = count(other);
  return { owner_count: owner.length, other_count: other.length,
    false_accepts: foreign.owner, false_rejects: own.other,
    far: other.length ? foreign.owner / other.length : null,
    frr: owner.length ? own.other / owner.length : null,
    owner_uncertain: own.uncertain, other_uncertain: foreign.uncertain,
    owner_accepted: own.owner, other_rejected: foreign.other };
}
module.exports = { PREPROCESS, ROLES, fingerprint, unit, average, scores, decision, independent, calibrate, evaluate };

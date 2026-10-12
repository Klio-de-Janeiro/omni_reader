const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { wavInfo, validId } = require('./voice-files.cjs');

/** Export explicitly reviewed owner clips into a new, self-contained folder. */
async function exportDataset(parent, entries, manifest, cancelled = () => false) {
  if (Array.isArray(entries) && !entries.length) throw new Error('Нет подтверждённых записей с проверенным текстом.');
  const root = await fs.realpath(parent);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Выберите папку для экспорта.');
  const name = 'Omni-voice-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const staging = path.join(root, '.' + name + '.partial'), target = path.join(root, name);
  await fs.mkdir(staging);
  let output;
  try {
    await fs.mkdir(path.join(staging, 'wav')); await fs.mkdir(path.join(staging, 'text'));
    output = await fs.open(path.join(staging, 'dataset.jsonl'), 'wx');
    let count = 0;
    for await (const { item, detail } of entries) {
      if (cancelled()) throw new Error('Экспорт отменён.');
      if (!validId(item.id) || item.role !== 'candidate' || detail.role !== 'candidate' || detail.review !== 'approved' || !detail.text_confirmed || !detail.corrected_text?.trim()) throw new Error('Запись не подтверждена для экспорта.');
      const audio = await wavInfo(item.path);
      if (audio.hash !== detail.review_audio_hash) throw new Error('Подтверждённый WAV изменился. Прослушайте его повторно: ' + item.id);
      await fs.writeFile(path.join(staging, 'wav', item.id + '.wav'), audio.bytes, { flag: 'wx' });
      await fs.writeFile(path.join(staging, 'text', item.id + '.txt'), detail.corrected_text, { encoding: 'utf8', flag: 'wx' });
      const row = { schema_version: 1, id: item.id, audio: 'wav/' + item.id + '.wav', text_file: 'text/' + item.id + '.txt', text: detail.corrected_text,
        sample_rate: 16000, channels: 1, duration_seconds: audio.duration, created_at: item.createdAt,
        audio_sha256: audio.hash, speaker_verified: true, verification_source: 'manual_review',
        model_check: item.check?.profile_version === manifest.profile_version ? item.check : null };
      await output.writeFile(JSON.stringify(row) + '\n', { encoding: 'utf8' }); count++;
    }
    await output.close(); output = null;
    if (!count) throw new Error('Нет подтверждённых записей с проверенным текстом.');
    await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ schema_version: 1, exported_at: new Date().toISOString(), clips: count, ...manifest }, null, 2), { flag: 'wx' });
    if (cancelled()) throw new Error('Экспорт отменён.');
    await fs.rename(staging, target);
    return { folder: target, count };
  } catch (error) { await output?.close().catch(() => {}); await fs.rm(staging, { recursive: true, force: true }); throw error; }
}
module.exports = { exportDataset };

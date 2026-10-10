import { MAX_FILE_BYTES, validateBlob } from './validation.js';

const text = (bytes, at, size) => String.fromCharCode(...bytes.subarray(at, at + size));

/** Inspect audio parameters and the last page without loading a whole Ogg stream. */
export async function readOggInfo(file) {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  if (head.length < 28 || text(head, 0, 4) !== 'OggS' || head[4] !== 0 || !(head[5] & 2)) throw new Error('Повреждённый заголовок OGG.');
  const at = 27 + head[26], view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let rate, channels, skip = 0, codec;
  if (head.length >= at + 19 && text(head, at, 8) === 'OpusHead') {
    codec = 'opus'; rate = 48000; channels = head[at + 9]; skip = view.getUint16(at + 10, true);
  } else if (head.length >= at + 30 && head[at] === 1 && text(head, at + 1, 6) === 'vorbis' && view.getUint32(at + 7, true) === 0) {
    codec = 'vorbis'; channels = head[at + 11]; rate = view.getUint32(at + 12, true);
  } else throw new Error('Для конвертации поддерживаются OGG Vorbis и OGG Opus.');
  if (channels < 1 || channels > 8 || rate < 8000 || rate > 96000) throw new Error('Для WAV поддерживаются 1–8 каналов и частота 8–96 кГц.');
  const serial = view.getUint32(14, true), tail = new Uint8Array(await file.slice(Math.max(0, file.size - 131072)).arrayBuffer());
  const last = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let duration = null;
  for (let i = tail.length - 27; i >= 0; i--) {
    if (text(tail, i, 4) !== 'OggS' || tail[i + 4] !== 0 || !(tail[i + 5] & 4) || last.getUint32(i + 14, true) !== serial) continue;
    const segments = tail[i + 26], start = i + 27 + segments;
    if (start > tail.length) continue;
    const payload = tail.subarray(i + 27, start).reduce((sum, size) => sum + size, 0);
    if (start + payload > tail.length) continue;
    const frames = last.getBigUint64(i + 6, true);
    if (frames !== 0xffffffffffffffffn && frames >= BigInt(skip)) duration = Number(frames - BigInt(skip)) / rate;
    break;
  }
  return { codec, channels, rate, duration };
}

/** Encode planar floating-point samples as chunked interleaved PCM16 RIFF. */
export async function encodeAudioWav(audio, { onProgress } = {}) {
  const channels = audio.numberOfChannels, rate = audio.sampleRate, frames = audio.length;
  if (!Number.isInteger(channels) || channels < 1 || channels > 8 || !Number.isInteger(frames) || frames < 1 || !Number.isInteger(rate) || rate < 1 || rate > 384000) throw new Error('Некорректные параметры декодированного аудио.');
  const size = frames * channels * 2;
  if (!Number.isSafeInteger(size) || size + 44 >= MAX_FILE_BYTES) throw new Error('Результат WAV должен быть меньше 500 МБ.');
  const header = new Uint8Array(44), view = new DataView(header.buffer);
  const write = (at, value) => { for (let i = 0; i < value.length; i++) header[at + i] = value.charCodeAt(i); };
  write(0, 'RIFF'); view.setUint32(4, size + 36, true); write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, size, true);
  const data = Array.from({ length: channels }, (_, index) => audio.getChannelData(index)), parts = [header];
  const blockFrames = Math.max(1, Math.floor(1048576 / (channels * 2)));
  for (let start = 0; start < frames; start += blockFrames) {
    const count = Math.min(blockFrames, frames - start), block = new Uint8Array(count * channels * 2), output = new DataView(block.buffer);
    for (let i = 0; i < count; i++) for (let channel = 0; channel < channels; channel++) {
      const raw = data[channel][start + i], sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      output.setInt16((i * channels + channel) * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    parts.push(new Blob([block])); onProgress?.(Math.round((start + count) / frames * 100));
    if (start + count < frames) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return new Blob(parts, { type: 'audio/wav' });
}

/** Decode locally at the stream's rate; Opus always uses its 48 kHz output clock. */
export async function convertOggToWav(file, options = {}) {
  await validateBlob(file, 'ogg');
  const info = await readOggInfo(file);
  if (info.duration !== null && info.duration * info.rate * info.channels * 2 + 44 >= MAX_FILE_BYTES) throw new Error('Результат WAV должен быть меньше 500 МБ.');
  const Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Context) throw new Error('Конвертация аудио недоступна. Обновите браузер или Android System WebView.');
  const context = new Context(1, 1, info.rate);
  let audio;
  try { audio = await context.decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error('Не удалось декодировать OGG: файл повреждён или его кодек не поддерживается на устройстве.'); }
  return encodeAudioWav(audio, options);
}

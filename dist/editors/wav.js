import { History } from './history.js';

/** Parse PCM16 RIFF chunks without assuming fixed metadata offsets. */
export function readWav(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
  if (bytes.length < 44 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('Нужен WAV RIFF PCM 16-bit.');
  const limit = view.getUint32(4, true) + 8;
  if (limit > bytes.length) throw new Error('WAV обрезан или повреждён.');
  let fmt, data;
  for (let at = 12; at + 8 <= limit;) {
    const name = ascii(at, 4), size = view.getUint32(at + 4, true), start = at + 8;
    if (start + size > limit) throw new Error('Повреждён блок WAV.');
    if (name === 'fmt ' && size >= 16) fmt = { format: view.getUint16(start, true), channels: view.getUint16(start + 2, true), rate: view.getUint32(start + 4, true), align: view.getUint16(start + 12, true), bits: view.getUint16(start + 14, true) };
    if (name === 'data') { if (data) throw new Error('Несколько data-блоков WAV пока не поддерживаются.'); data = { start, size }; }
    at = start + size + (size % 2);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1 || fmt.channels > 8 || fmt.align !== fmt.channels * 2 || fmt.rate < 1 || fmt.rate > 384000 || data.size % fmt.align) throw new Error('Редактор поддерживает PCM 16-bit WAV, 1–8 каналов. Другие WAV можно просматривать.');
  return { ...fmt, ...data, bytes, frames: data.size / fmt.align, duration: data.size / fmt.align / fmt.rate };
}
/** Export a frame-aligned selection, applying gain with signed 16-bit clipping. */
export function writeWav(wav, { start, end, gain }) {
  if (![start, end, gain].every(Number.isFinite) || start < 0 || end > wav.duration || end <= start || gain < -24 || gain > 24) throw new Error('Укажите корректный диапазон и громкость от −24 до +24 dB.');
  const first = Math.round(start * wav.rate), last = Math.round(end * wav.rate), size = (last - first) * wav.align;
  if (size < wav.align) throw new Error('Выбранный отрезок слишком короткий.');
  const out = new Uint8Array(44 + size), view = new DataView(out.buffer);
  const string = (at, text) => [...text].forEach((ch, i) => { out[at + i] = ch.charCodeAt(0); });
  string(0, 'RIFF'); view.setUint32(4, size + 36, true); string(8, 'WAVE'); string(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, wav.channels, true); view.setUint32(24, wav.rate, true); view.setUint32(28, wav.rate * wav.align, true);
  view.setUint16(32, wav.align, true); view.setUint16(34, 16, true); string(36, 'data'); view.setUint32(40, size, true);
  const source = new DataView(wav.bytes.buffer, wav.bytes.byteOffset + wav.start + first * wav.align, size), factor = 10 ** (gain / 20);
  for (let at = 0; at < size; at += 2) view.setInt16(44 + at, Math.max(-32768, Math.min(32767, Math.round(source.getInt16(at, true) * factor))), true);
  return out;
}
export class WavEditor {
  constructor(bytes) { this.wav = readWav(bytes); this.state = { start: 0, end: this.wav.duration, gain: 0 }; this.history = new History(); }
  set(next) {
    writeWav(this.wav, next);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    const previous = { ...this.state }; this.history.execute(() => { this.state = { ...next }; }, () => { this.state = previous; });
  }
  async export() { return writeWav(this.wav, this.state); }
}

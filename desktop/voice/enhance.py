"""Create optional cleaned WAV copies using the phone collector's DSP steps."""

from pathlib import Path
import queue
import threading
import wave

import numpy as np
from scipy.signal import butter, sosfilt

RATE = 16000
SIZE = 512
HOP = SIZE // 2
WINDOW = np.sqrt(np.hanning(SIZE + 1)[:-1])
FILTER = butter(2, 70, btype='highpass', fs=RATE, output='sos')


class NoiseEstimator:
    """Learn noise power only during sustained VAD-negative intervals."""

    def __init__(self):
        """Start with an empty noise profile and filter history."""
        self.zi = np.zeros((len(FILTER), 2))
        self.power = None
        self.quiet = self.observations = 0

    def observe(self, pcm, probability):
        """Update the estimate after at least half a second of silence."""
        samples = np.frombuffer(pcm, dtype='<i2').astype(float) / 32768
        filtered, self.zi = sosfilt(FILTER, samples, zi=self.zi)
        self.quiet = self.quiet + 1 if probability < 0.25 else 0
        if self.quiet < 16:
            return
        power = np.abs(np.fft.rfft(filtered * WINDOW)) ** 2
        self.power = (power if self.power is None else
                      0.95 * self.power + 0.05 * power)
        self.observations += 1

    def snapshot(self):
        """Return a stable profile only after enough quiet observations."""
        return self.power.copy() if self.observations >= 8 else None


def enhance_wav(source, output, noise_power=None, normalize=False):
    """High-pass and gently denoise a copy with bounded working memory."""
    previous = np.zeros(HOP)
    tail = np.zeros(HOP)
    gains = np.ones(SIZE // 2 + 1)
    zi = np.zeros((len(FILTER), 2))
    pending = 0
    peak = 0.0
    count = 0
    with wave.open(str(source), 'rb') as reader, \
            wave.open(str(output), 'wb') as writer:
        if (reader.getnchannels(), reader.getsampwidth(),
                reader.getframerate()) != (1, 2, RATE):
            raise ValueError('Expected mono PCM16 WAV at 16000 Hz')
        writer.setparams(reader.getparams())
        while True:
            raw = reader.readframes(HOP)
            length = len(raw) // 2
            samples = np.zeros(HOP)
            if length:
                values = np.frombuffer(raw, dtype='<i2').astype(float)
                samples[:length] = values / 32768
            samples, zi = sosfilt(FILTER, samples, zi=zi)
            frame = np.concatenate((previous, samples)) * WINDOW
            spectrum = np.fft.rfft(frame)
            if noise_power is not None:
                power = np.abs(spectrum) ** 2
                desired = np.sqrt(np.clip(
                    1 - 0.9 * noise_power / np.maximum(power, 1e-12),
                    0.0625, 1))
                padded = np.pad(desired, (1, 1), mode='reflect')
                smooth = (padded[:-2] + 2 * desired + padded[2:]) / 4
                gains = 0.6 * gains + 0.4 * smooth
                spectrum *= gains
            reconstructed = np.fft.irfft(spectrum, n=SIZE) * WINDOW
            values = reconstructed[:HOP] + tail
            tail = reconstructed[HOP:]
            previous = samples
            if pending:
                values = np.clip(values[:pending], -1, 32767 / 32768)
                peak = max(peak, float(np.max(np.abs(values))))
                writer.writeframes(np.rint(values * 32768)
                                   .astype('<i2').tobytes())
                count += pending
            pending = length
            if not length:
                break
    gain = min(10 ** (6 / 20), 10 ** (-1 / 20) / peak) \
        if normalize and peak > 1e-8 else 1.0
    if abs(gain - 1) > 1e-6:
        # This file is our canonical PCM16 WAV, whose data starts at byte 44.
        with Path(output).open('r+b') as handle:
            handle.seek(44)
            while True:
                position = handle.tell()
                raw = handle.read(131072)
                if not raw:
                    break
                values = np.frombuffer(raw, dtype='<i2').astype(float)
                pcm = np.clip(np.rint(values * gain), -32768, 32767)
                handle.seek(position)
                handle.write(pcm.astype('<i2').tobytes())
    return {'gain': gain, 'denoised': noise_power is not None,
            'samples': count, 'highpass_hz': 70}


class BackgroundEnhancer:
    """Process a bounded queue without blocking microphone inference."""

    def __init__(self, store, normalize, report):
        """Create one low-concurrency processing worker for the session."""
        self.store = store
        self.normalize = normalize
        self.report = report
        self.jobs = queue.Queue(maxsize=2)
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def submit(self, result, noise):
        """Queue a copy or explicitly report that the original is retained."""
        try:
            self.jobs.put_nowait((result, noise))
        except queue.Full:
            self.report({'type': 'warning', 'message':
                         'Очередь очистки заполнена. Оригинал сохранён; '
                         'очищенная копия этого фрагмента пропущена.'})

    def run(self):
        """Finish queued jobs and preserve the raw recording on failure."""
        while not self.done.is_set() or not self.jobs.empty():
            try:
                result, noise = self.jobs.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                value = self.store.clean_copy(result, noise, self.normalize,
                                               enhance_wav)
                self.report({'type': 'cleaned', **value})
            except Exception as error:
                self.report({'type': 'warning', 'message':
                             'Оригинал сохранён, ошибка очистки: '
                             + str(error)})
            finally:
                self.jobs.task_done()

    def close(self):
        """Drain the bounded queue after the microphone has been closed."""
        self.done.set()
        while self.thread.is_alive():
            self.thread.join(0.5)
            if self.thread.is_alive():
                self.report({'type': 'processing'})

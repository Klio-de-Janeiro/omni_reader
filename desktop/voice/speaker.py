"""Offline, single-thread speaker embeddings; never import Torch."""

import hashlib
import importlib.util
import json
import sys
import traceback
from pathlib import Path

from speaker_audio import PREPROCESS_VERSION, read_pcm, speech_windows

MAX_REQUEST = 128 * 1024


class SpeakerVAD:
    """Reuse the bundled Silero weights through the speaker CPU runtime."""

    def __init__(self, numpy, runtime, report):
        """Locate weights without importing silero_vad, Torch or TorchAudio."""
        self.np = numpy
        report('speaker-vad', 'Загрузка локального Silero для проверки…')
        spec = importlib.util.find_spec('silero_vad')
        if spec is None or not spec.submodule_search_locations:
            raise RuntimeError('Нет локальных весов Silero. Выполните '
                               'SETUP_VOICE_WINDOWS.ps1.')
        model = (Path(next(iter(spec.submodule_search_locations)))
                 / 'data' / 'silero_vad.onnx')
        if not model.is_file():
            raise RuntimeError('Нет локального silero_vad.onnx.')
        config = runtime.VadModelConfig()
        config.sample_rate = 16000
        config.num_threads = 1
        config.provider = 'cpu'
        config.silero_vad.model = str(model)
        config.silero_vad.threshold = 0.5
        config.silero_vad.window_size = 512
        config.silero_vad.min_speech_duration = 0.032
        config.silero_vad.min_silence_duration = 0.032
        config.silero_vad.max_speech_duration = 8
        if not config.validate():
            raise RuntimeError('Неверная локальная модель Silero.')
        self.detector = runtime.VoiceActivityDetector(
            config, buffer_size_in_seconds=10)
        self.score(bytes(1024))
        self.reset()

    def reset(self):
        """Clear recurrent state before each independent recording."""
        self.detector.reset()

    def score(self, pcm):
        """Classify exactly one PCM frame and bound the native audio queue."""
        samples = self.np.frombuffer(pcm, dtype='<i2').astype(self.np.float32)
        samples /= 32768.0
        self.detector.accept_waveform(samples)
        detected = self.detector.is_speech_detected()
        while not self.detector.empty():
            self.detector.pop()
        return float(detected)


def emit(kind, request_id=None, **values):
    """Write one flushed UTF-8 protocol event."""
    print(json.dumps({'type': kind, 'id': request_id, **values},
                     ensure_ascii=False, allow_nan=False), flush=True)


def file_hash(filename):
    """Fingerprint a bounded local ONNX model without loading it into RAM."""
    source = Path(filename)
    if not source.is_absolute() or source.suffix.lower() != '.onnx':
        raise ValueError('Выберите локальную speaker-модель ONNX.')
    if not 1024 < source.stat().st_size <= 512 * 1024 * 1024:
        raise ValueError('Неверный размер speaker-модели.')
    digest = hashlib.sha256()
    with source.open('rb') as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


class SpeakerModel:
    """Cache local Silero and WeSpeaker models for one bounded batch."""

    def __init__(self, model_path, report):
        """Load CPU providers and exercise the embedding API before use."""
        self.report = report
        report('fingerprint', 'Проверка файла speaker-модели…')
        self.model_hash = file_hash(model_path)
        report('speaker-runtime', 'Загрузка sherpa-onnx…')
        import numpy as np
        import sherpa_onnx

        self.np = np
        report('speaker-model', 'Загрузка локальной WeSpeaker на CPU…')
        config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=model_path, num_threads=1, provider='cpu', debug=False)
        if not config.validate():
            raise ValueError('sherpa-onnx не принимает эту ONNX-модель.')
        self.extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
        report('speaker-test', 'Проверка speaker-модели…')
        self.embedding(bytes(16000 * 2 * 3))
        self.vad = SpeakerVAD(np, sherpa_onnx, report)

    def embedding(self, pcm):
        """Return a finite, unit-length vector for a single speech window."""
        np = self.np
        samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32)
        samples /= 32768.0
        stream = self.extractor.create_stream()
        stream.accept_waveform(sample_rate=16000, waveform=samples)
        stream.input_finished()
        if not self.extractor.is_ready(stream):
            raise ValueError('Недостаточно звука для speaker-модели.')
        vector = np.asarray(self.extractor.compute(stream), dtype=np.float64)
        norm = np.linalg.norm(vector)
        if (vector.ndim != 1 or not 16 <= len(vector) <= 1024
                or not np.all(np.isfinite(vector))
                or not np.isfinite(norm) or norm < 1e-8):
            raise RuntimeError('Speaker-модель вернула неверный вектор.')
        return (vector / norm).tolist()

    def analyze(self, clip, request_id):
        """Analyze raw audio; short/no-speech clips always require review."""
        pcm, audio_hash = read_pcm(clip['path'])
        progress = lambda: emit('progress', request_id, clip_id=clip['id'],
                                message='Выделение речи для проверки голоса…')
        windows, seconds = speech_windows(pcm, self.vad, progress)
        vectors = []
        for window in windows:
            emit('progress', request_id, clip_id=clip['id'],
                 message='Вычисление голосового признака…')
            vectors.append(self.embedding(window))
        return {'audio_hash': audio_hash, 'model_hash': self.model_hash,
                'preprocess': PREPROCESS_VERSION, 'speech_seconds': seconds,
                'vectors': vectors, 'duration': len(pcm) / 32000}


def run_request(config):
    """Process a finite batch with per-clip errors and no hidden downloads."""
    request_id = config['id']
    clips = config.get('clips', [])
    if (not isinstance(clips, list) or len(clips) > 100
            or any(not isinstance(clip, dict) for clip in clips)):
        raise ValueError('Неверная очередь speaker-проверки.')
    report = lambda phase, message: emit('phase', request_id, phase=phase,
                                       message=message)
    model = SpeakerModel(config['model'], report)
    if config.get('self_check'):
        emit('result', request_id, model_hash=model.model_hash,
             dimension=model.extractor.dim, self_check=True)
        return
    for clip in clips:
        try:
            emit('progress', request_id, clip_id=clip['id'],
                 message='Чтение исходного WAV…')
            result = model.analyze(clip, request_id)
            emit('clip', request_id, clip_id=clip['id'], result=result)
        except Exception as error:
            emit('clip', request_id, clip_id=clip.get('id'),
                 error=str(error)[:2000])
    emit('result', request_id, model_hash=model.model_hash)


def main():
    """Read one main-process request and exit after finishing or an error."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    request_id = None
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--self-check':
            config = {'id': 'self-check', 'model': sys.argv[2],
                      'self_check': True}
        else:
            line = sys.stdin.readline(MAX_REQUEST + 1)
            if not line or len(line) > MAX_REQUEST:
                raise ValueError('Неверный запрос speaker-проверки.')
            config = json.loads(line)
        request_id = config['id']
        run_request(config)
        return 0
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit('error', request_id, message=str(error)[:2000])
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

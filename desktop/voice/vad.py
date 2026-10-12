"""Run local Silero through sherpa-onnx without Python ONNX Runtime."""

import importlib.util
from pathlib import Path

from segments import FRAME, RATE


class SileroVAD:
    """Keep native recurrent state and 64 context samples between frames."""

    engine = 'silero-sherpa-onnx-cpu'

    def __init__(self, session, numpy):
        """Use a loaded native CPU model; never fetch weights at runtime."""
        self.session = session
        self.np = numpy
        if session.window_size() != FRAME + 64:
            raise RuntimeError('Неожиданный размер окна локального Silero.')
        self.reset()

    def reset(self):
        """Start a fresh stream, including after the startup self-check."""
        self.session.reset()
        self.context = self.np.zeros((1, 64), dtype=self.np.float32)

    def score(self, pcm):
        """Return a thresholded decision for exactly 512 PCM16 samples."""
        if len(pcm) != FRAME * 2:
            raise ValueError('Silero ожидает блок из 512 отсчётов PCM16.')
        samples = self.np.frombuffer(pcm, dtype='<i2').astype(
            self.np.float32).reshape(1, FRAME) / 32768.0
        audio = self.np.concatenate((self.context, samples), axis=1)
        detected = self.session.is_speech(audio.reshape(-1))
        if type(detected) is not bool:
            raise RuntimeError('Silero вернул неверное решение о речи.')
        self.context = audio[:, -64:].copy()
        return float(detected)


def load_numpy(report=lambda *args: None):
    """Import and exercise NumPy before loading any VAD or audio library."""
    report('numpy', 'Загрузка NumPy…')
    try:
        import numpy as np
    except (ImportError, OSError) as error:
        raise RuntimeError('Не удалось загрузить NumPy: ' + str(error)
                           + '\nПовторите обновлённый '
                           'SETUP_VOICE_WINDOWS.ps1.') from error
    report('numpy_check', 'Проверка NumPy ' + np.__version__
           + ': ' + str(np.__file__))
    samples = np.arange(4, dtype=np.float32)
    if float(np.dot(samples, samples)) != 14.0:
        raise RuntimeError('NumPy не прошёл проверку вычислений на CPU.')
    return np


def load_model(report=lambda *args: None, threshold=0.5):
    """Load and exercise the local CPU model without importing Silero code."""
    if type(threshold) not in (int, float) or not 0.1 <= threshold <= 0.95:
        raise ValueError('Порог речи должен быть от 0,1 до 0,95.')
    np = load_numpy(report)

    report('onnx', 'Загрузка CPU-движка sherpa-onnx для Silero…')
    try:
        import sherpa_onnx
    except (ImportError, OSError) as error:
        raise RuntimeError('Не удалось загрузить sherpa-onnx: '
                           + str(error) + '\nПовторите '
                           'SETUP_VOICE_WINDOWS.ps1 -InstallVCRuntime '
                           'для Python из omni_voice_env.') from error

    report('model', 'Загрузка локальной модели Silero…')
    spec = importlib.util.find_spec('silero_vad')
    if spec is None or not spec.submodule_search_locations:
        raise RuntimeError('Silero VAD не установлен. Запустите '
                           'SETUP_VOICE_WINDOWS.ps1 и выберите его Python.')
    model_path = (Path(next(iter(spec.submodule_search_locations)))
                  / 'data' / 'silero_vad.onnx')
    if not model_path.is_file():
        raise RuntimeError('Нет локального silero_vad.onnx. Повторите '
                           'установку голосового окружения.')
    config = sherpa_onnx.VadModelConfig()
    config.sample_rate = RATE
    config.num_threads = 1
    config.provider = 'cpu'
    config.silero_vad.model = str(model_path)
    config.silero_vad.threshold = float(threshold)
    config.silero_vad.window_size = FRAME
    config.silero_vad.min_speech_duration = FRAME / RATE
    config.silero_vad.min_silence_duration = FRAME / RATE
    if not config.validate():
        raise RuntimeError('Неверная конфигурация локальной модели Silero.')
    session = sherpa_onnx.VadModel.create(config)
    model = SileroVAD(session, np)
    report('validation', 'Проверка Silero на CPU…')
    model.score(bytes(FRAME * 2))
    model.reset()
    return model

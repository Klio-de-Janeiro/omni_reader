"""Offline microphone worker: sounddevice, Silero ONNX, WAV clips."""

import contextlib
from datetime import datetime, timezone
import faulthandler
import json
from pathlib import Path
import queue
import struct
import sys
import threading
import time
import traceback

# -I excludes script folders; restore only this trusted application's modules.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from segments import ClipStore, FRAME, RATE, Segmenter
from vad import load_model, load_numpy

EMIT_LOCK = threading.Lock()
STARTUP = 'python'
STACK_DUMP_SECONDS = 15


def emit(message):
    """Write one UTF-8 event to the Electron parent."""
    with EMIT_LOCK:
        print(json.dumps(message, ensure_ascii=False),
              file=sys.__stdout__, flush=True)


def devices(sd):
    """List input endpoints with stable names instead of transient indices."""
    hosts = sd.query_hostapis()
    return [
        {'id': index, 'key': hosts[item['hostapi']]['name'] + ': '
         + item['name'], 'name': item['name'],
         'host': hosts[item['hostapi']]['name']}
        for index, item in enumerate(sd.query_devices())
        if item['max_input_channels'] > 0
    ]


def startup(stage, message):
    """Report the next blocking operation before entering a native library."""
    global STARTUP
    STARTUP = stage
    faulthandler.cancel_dump_traceback_later()
    faulthandler.dump_traceback_later(STACK_DUMP_SECONDS, repeat=True,
                                    file=sys.__stderr__)
    emit({'type': 'startup', 'stage': stage, 'message': message})


def watch_commands(stop, changes):
    """Stop on an explicit command or when the parent closes its pipe."""
    try:
        for line in sys.stdin:
            message = json.loads(line)
            if message.get('command') == 'stop':
                break
            if message.get('command') == 'silence':
                value = message.get('silence_ms')
                if type(value) is int and 200 <= value <= 12000:
                    try:
                        changes.get_nowait()
                    except queue.Empty:
                        pass
                    changes.put_nowait(value)
    except (ValueError, TypeError, AttributeError):
        emit({'type': 'error', 'message': 'Неверная команда диктофона.'})
    finally:
        stop.set()


def capture(config, sd, stop, loaded, changes):
    """Capture bounded PCM blocks and stop rather than hide audio losses."""
    model = loaded
    if stop.is_set():
        return
    startup('device', 'Проверка выбранного микрофона…')
    selected = config.get('device', '')
    matches = [item for item in devices(sd) if item['key'] == selected]
    if selected and not matches:
        raise RuntimeError('Выбранный микрофон недоступен. Выберите его '
                           'заново или используйте системный.')
    device = matches[0]['id'] if selected else None
    sd.check_input_settings(device=device, channels=1, dtype='int16',
                            samplerate=RATE)
    # The native model already applies the user's threshold and hysteresis.
    segmenter = Segmenter(threshold=0.5, silence_ms=config['silence_ms'],
                          pre_ms=config.get('pre_ms', 1024),
                          max_seconds=config.get('max_seconds', 600))
    startup('storage', 'Проверка папки и лимита записей…')
    store = ClipStore(config['folder'], config['quota_mb'], {
        'device': selected or 'system_default',
        'threshold': config['threshold'],
        'silence_ms': config['silence_ms'], 'engine': model.engine,
        'pre_ms': config.get('pre_ms', 1024),
        'max_seconds': config.get('max_seconds', 600),
    })
    cleaner = noise = None
    if config.get('enhance', True):
        startup('enhance', 'Загрузка очистки аудио…')
        try:
            from enhance import BackgroundEnhancer, NoiseEstimator

            noise = NoiseEstimator()
            cleaner = BackgroundEnhancer(
                store, config.get('normalize', False), emit)
        except Exception as error:
            emit({'type': 'warning', 'message': 'Очистка аудио недоступна; '
                  'оригиналы будут записаны. ' + str(error)})

    def save(clip):
        """Publish the original first, then schedule its optional copy."""
        result = store.save(clip)
        if result:
            emit(result)
            if cleaner:
                cleaner.submit(result, noise.snapshot())

    def process(pcm):
        """Feed one captured block to VAD and preserve completed clips."""
        probability = model.score(pcm)
        if noise:
            noise.observe(pcm, probability)
        save(segmenter.push(pcm, probability))
        return probability
    frames = queue.Queue(maxsize=64)
    failure = threading.Event()

    def callback(data, count, timing, status):
        """Copy audio quickly; keep all ML and file I/O off the callback."""
        if status or count != FRAME:
            failure.set()
            return
        try:
            frames.put_nowait(bytes(data))
        except queue.Full:
            failure.set()

    last_report = time.monotonic()
    try:
        if stop.is_set():
            return
        startup('stream', 'Открытие микрофона…')
        with sd.RawInputStream(samplerate=RATE, blocksize=FRAME,
                               device=device, channels=1, dtype='int16',
                               callback=callback):
            store.started = datetime.now(timezone.utc)
            faulthandler.cancel_dump_traceback_later()
            emit({'type': 'ready', 'session': store.session_id,
                  'engine': model.engine})
            while not stop.is_set():
                try:
                    silence = changes.get_nowait()
                except queue.Empty:
                    pass
                else:
                    segmenter.set_silence(silence)
                    with store.lock:
                        store.settings['silence_ms'] = silence
                    emit({'type': 'settings', 'silence_ms': silence})
                if failure.is_set():
                    raise RuntimeError('Микрофон потерял аудиоданные '
                                       'или очередь переполнена. '
                                       'Запись остановлена.')
                try:
                    pcm = frames.get(timeout=1)
                except queue.Empty:
                    raise RuntimeError('Микрофон перестал передавать '
                                       'звук. Запустите запись заново.')
                probability = process(pcm)
                if time.monotonic() - last_report >= 0.5:
                    last_report = time.monotonic()
                    emit({'type': 'activity',
                          'speaking': bool(segmenter.frames),
                          'speech_detected': bool(probability)})
    finally:
        try:
            # PortAudio is closed now; preserve blocks queued before Stop.
            if stop.is_set() and not failure.is_set():
                while not frames.empty():
                    process(frames.get_nowait())
            save(segmenter.flush('stop' if stop.is_set() else 'interrupted'))
        finally:
            emit({'type': 'microphone_closed'})
            if cleaner:
                cleaner.close()


def main():
    """Read one configuration and run probe or microphone capture."""
    stop = threading.Event()
    changes = queue.Queue(maxsize=1)
    try:
        for stream in (sys.stdin, sys.stdout, sys.stderr):
            if hasattr(stream, 'reconfigure'):
                stream.reconfigure(encoding='utf-8', errors='replace')
        config = json.loads(sys.stdin.readline())
        startup('python', 'Python запущен: ' + sys.executable)
        emit({'type': 'runtime', 'python': sys.executable,
              'version': sys.version.split()[0],
              'isolated': bool(sys.flags.isolated),
              'prefix': sys.prefix, 'base_prefix': sys.base_prefix})
        if struct.calcsize('P') != 8:
            raise RuntimeError('Для диктофона требуется Python x64.')
        with contextlib.redirect_stdout(sys.stderr):
            command = config.get('command')
            if command == 'check_numpy':
                np = load_numpy(startup)
                emit({'type': 'checked', 'engine': 'numpy-cpu',
                      'numpy_version': np.__version__,
                      'numpy_path': str(np.__file__)})
                return
            if command in ('check', 'check_audio'):
                model = load_model(startup, config.get('threshold', 0.5))
                if command == 'check_audio':
                    startup('audio', 'Загрузка библиотеки микрофона…')
                    import sounddevice

                    startup('enhance', 'Проверка очистки аудио…')
                    from enhance import NoiseEstimator

                    NoiseEstimator()
                emit({'type': 'checked', 'engine': model.engine})
                return
            if command == 'devices':
                load_numpy(startup)
                startup('audio', 'Загрузка библиотеки микрофона…')
                import sounddevice as sd

                startup('device', 'Получение списка микрофонов…')
                emit({'type': 'devices', 'devices': devices(sd)})
                return
            if command != 'record':
                raise ValueError('Неизвестная команда диктофона.')
            threading.Thread(target=watch_commands, args=(stop, changes),
                             daemon=True).start()
            loaded = load_model(startup, config.get('threshold', 0.5))
            if not stop.is_set():
                startup('audio', 'Загрузка библиотеки микрофона…')
                import sounddevice as sd

                capture(config, sd, stop, loaded, changes)
        emit({'type': 'stopped'})
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit({'type': 'error', 'message': str(error) + '\nЭтап: '
              + STARTUP + '. Python: ' + sys.executable
              + '\nПроверьте SETUP_VOICE_WINDOWS.ps1 и Python диктофона.'})
        sys.exit(1)
    finally:
        faulthandler.cancel_dump_traceback_later()


if __name__ == '__main__':
    main()

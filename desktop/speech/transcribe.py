"""Run an installed Whisper model offline and emit UTF-8 JSON lines."""

import contextlib
import json
import os
from pathlib import Path
import shutil
import sys

REQUEST_ID = None


def emit(kind, **values):
    """Send one protocol event without mixing it with library output."""
    if REQUEST_ID is not None:
        values['id'] = REQUEST_ID
    print(json.dumps({"type": kind, **values}, ensure_ascii=False),
          file=sys.__stdout__, flush=True)


def decode_options(params):
    """Build shared decoding options; temperature fallback remains explicit."""
    temperature = params["temperature"]
    if params["temperature_fallback"]:
        temperatures = [temperature]
        while temperatures[-1] < 1:
            temperatures.append(round(min(1, temperatures[-1] + 0.2), 6))
        temperature = temperatures
    keys = ("task", "beam_size", "best_of", "patience", "length_penalty",
            "condition_on_previous_text", "compression_ratio_threshold",
            "no_speech_threshold")
    return {
        **{key: params[key] for key in keys},
        "language": (None if params["language"] == "auto"
                     else params["language"]),
        "temperature": temperature,
        "initial_prompt": params["initial_prompt"].strip() or None,
    }


def cached_model(cache, key, load):
    """Retain at most one local model for consecutive recorder clips."""
    if cache is None:
        emit('status', message='Загружаем локальную модель…')
        return load()
    if cache.get('key') != key:
        emit('status', message='Загружаем локальную модель…')
        cache.clear()
        cache['model'] = load()
        cache['key'] = key
    return cache['model']


def transcribe(config, cache=None):
    """Recognize speech on CPU using local files and saved user parameters."""
    model_path = Path(config["model"])
    source = Path(config["audio"])
    params = config["params"]
    threads = params["cpu_threads"] or max(
        1, min(8, (os.cpu_count() or 2) - 1))
    options = decode_options(params)
    message = ("Распознаём речь на CPU: "
               + (options["language"] or "автоопределение языка") + "…")
    if not source.is_file() or source.suffix.lower() not in {".ogg", ".wav"}:
        raise ValueError("Выберите существующую запись OGG или WAV.")
    if not model_path.exists():
        raise ValueError("Модель не найдена. "
                         "Выберите её в настройках Whisper.")
    if model_path.is_dir():
        for name in ("model.bin", "config.json", "tokenizer.json"):
            if not (model_path / name).is_file():
                raise ValueError(f"В папке faster-whisper отсутствует {name}.")
        from faster_whisper import WhisperModel

        def load():
            """Load the selected faster-whisper model without network."""
            return WhisperModel(str(model_path), device="cpu",
                                compute_type=params["compute_type"],
                                cpu_threads=threads, local_files_only=True)

        model = cached_model(cache, (str(model_path), threads,
                                     params['compute_type']), load)
        emit("status", message=message)
        segments, _ = model.transcribe(
            str(source), **options, vad_filter=False,
            log_prob_threshold=params["log_prob_threshold"])
        lines = []
        for segment in segments:
            text = segment.text.strip()
            if text:
                lines.append(text)
                emit("segment", text=text)
        return "\n".join(lines)
    if model_path.suffix.lower() != ".pt":
        raise ValueError("Выберите модель OpenAI Whisper .pt или папку "
                         "faster-whisper с model.bin.")
    if config.get("ffmpeg"):
        os.environ["PATH"] = (str(Path(config["ffmpeg"]).parent)
                              + os.pathsep + os.environ.get("PATH", ""))
    if not shutil.which("ffmpeg"):
        raise ValueError("Для модели .pt выберите ffmpeg.exe в настройках "
                         "или добавьте FFmpeg в PATH.")
    import torch
    import whisper

    torch.set_num_threads(threads)
    model = cached_model(cache, (str(model_path), threads, 'pt'),
                         lambda: whisper.load_model(str(model_path),
                                                    device='cpu'))
    emit("status", message=message)
    result = model.transcribe(
        str(source), **options, fp16=False, verbose=False,
        logprob_threshold=params["log_prob_threshold"])
    return result["text"].strip()


def main():
    """Load one request; model names never trigger automatic downloads."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    try:
        config = json.loads(sys.stdin.readline())
        if config.get('command') == 'serve':
            return serve()
        with contextlib.redirect_stdout(sys.stderr):
            text = transcribe(config)
        emit("result", text=text)
    except ModuleNotFoundError as error:
        emit("error", message="В выбранном Python отсутствует модуль "
             f"{error.name}. Выберите окружение с установленным Whisper.")
        return 1
    except Exception as error:
        emit("error", message=str(error))
        return 1
    return 0


def serve():
    """Accept sequential jobs, keep one model, and stop on parent EOF."""
    global REQUEST_ID
    cache = {}
    for line in sys.stdin:
        REQUEST_ID = None
        try:
            config = json.loads(line)
            if config.get('command') == 'stop':
                break
            REQUEST_ID = config['id']
            with contextlib.redirect_stdout(sys.stderr):
                text = transcribe(config, cache)
            emit('result', text=text)
        except ModuleNotFoundError as error:
            emit('error', message='В выбранном Python отсутствует модуль '
                 f'{error.name}. Выберите окружение с установленным Whisper.')
        except Exception as error:
            emit('error', message=str(error))
        finally:
            REQUEST_ID = None
    return 0


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())

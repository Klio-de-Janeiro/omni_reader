"""Run an installed Whisper model offline and emit UTF-8 JSON lines."""

import contextlib
import json
import os
from pathlib import Path
import shutil
import sys


def emit(kind, **values):
    """Send one protocol event without mixing it with library output."""
    print(json.dumps({"type": kind, **values}, ensure_ascii=False),
          file=sys.__stdout__, flush=True)


def transcribe(config):
    """Recognize Russian speech on CPU using a selected local checkpoint."""
    model_path = Path(config["model"])
    source = Path(config["audio"])
    threads = max(1, min(8, (os.cpu_count() or 2) - 1))
    if not source.is_file() or source.suffix.lower() not in {".ogg", ".wav"}:
        raise ValueError("Выберите существующую запись OGG или WAV.")
    if not model_path.exists():
        raise ValueError("Модель не найдена. Выберите её в настройках Whisper.")
    emit("status", message="Загружаем локальную модель…")
    if model_path.is_dir():
        for name in ("model.bin", "config.json", "tokenizer.json"):
            if not (model_path / name).is_file():
                raise ValueError(f"В папке faster-whisper отсутствует {name}.")
        from faster_whisper import WhisperModel

        model = WhisperModel(str(model_path), device="cpu",
                             compute_type="int8", cpu_threads=threads,
                             local_files_only=True)
        emit("status", message="Распознаём русскую речь на CPU…")
        segments, _ = model.transcribe(str(source), language="ru",
                                      task="transcribe", beam_size=5,
                                      vad_filter=False)
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
    model = whisper.load_model(str(model_path), device="cpu")
    emit("status", message="Распознаём русскую речь на CPU…")
    result = model.transcribe(str(source), language="ru", task="transcribe",
                              fp16=False, verbose=False)
    return result["text"].strip()


def main():
    """Load one request; model names never trigger automatic downloads."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    try:
        config = json.loads(sys.stdin.readline())
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


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())

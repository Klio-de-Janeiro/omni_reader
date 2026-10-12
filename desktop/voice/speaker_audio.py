"""Read bounded recorder WAVs and keep speech for speaker embeddings."""

import hashlib
import wave
from pathlib import Path

from segments import FRAME, RATE

MAX_SECONDS = 602
MIN_SPEECH_SECONDS = 3
MAX_WINDOW_SECONDS = 8
MAX_WINDOWS = 3
PREPROCESS_VERSION = 'silero-0.5-frames-v1'


def read_pcm(filename):
    """Accept only local mono PCM16 at 16 kHz, with a bounded duration."""
    source = Path(filename)
    if not source.is_absolute() or source.suffix.lower() != '.wav':
        raise ValueError('Нужен абсолютный путь к WAV диктофона.')
    if source.stat().st_size > RATE * 2 * MAX_SECONDS + 65536:
        raise ValueError('WAV превышает лимит 602 секунды.')
    with wave.open(str(source), 'rb') as audio:
        if (audio.getnchannels() != 1 or audio.getsampwidth() != 2
                or audio.getframerate() != RATE
                or audio.getcomptype() != 'NONE'):
            raise ValueError('Для проверки голоса нужен mono PCM16, 16 кГц.')
        frames = audio.getnframes()
        if not 0 < frames <= RATE * MAX_SECONDS:
            raise ValueError('Неверная длительность WAV.')
        pcm = audio.readframes(frames)
    if len(pcm) != frames * 2:
        raise ValueError('WAV обрезан или повреждён.')
    return pcm, hashlib.sha256(pcm).hexdigest()


def speech_windows(pcm, vad, progress=lambda: None):
    """Remove silence and cover the beginning, middle and end of speech."""
    vad.reset()
    pieces = []
    for start in range(0, len(pcm), FRAME * 2):
        block = pcm[start:start + FRAME * 2]
        padded = block.ljust(FRAME * 2, b'\0')
        if vad.score(padded) >= 0.5:
            pieces.append(block)
        if start % (RATE * 2 * 8) < FRAME * 2:
            progress()
    speech = b''.join(pieces)
    seconds = len(speech) / (RATE * 2)
    if seconds < MIN_SPEECH_SECONDS:
        return [], seconds
    length = min(len(speech), RATE * 2 * MAX_WINDOW_SECONDS)
    count = min(MAX_WINDOWS, max(1, (len(speech) + length - 1) // length))
    if count == 1:
        starts = [(len(speech) - length) // 4 * 2]
    else:
        starts = [round(i * (len(speech) - length) / (count - 1) / 2) * 2
                  for i in range(count)]
    return [speech[start:start + length] for start in starts], seconds

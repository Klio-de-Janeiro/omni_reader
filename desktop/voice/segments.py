"""Bounded speech segmentation and local WAV storage, independent of ML."""

from collections import deque
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import shutil
import threading
import uuid
import wave

RATE = 16000
FRAME = 512


class Segmenter:
    """Turn PCM frames and VAD probabilities into padded speech clips."""

    def __init__(self, threshold=0.5, silence_ms=700, min_speech_ms=250,
                 pre_ms=320, max_seconds=30):
        """Set bounds in samples; keep at most one clip in memory."""
        self.threshold = threshold
        self.silence = math.ceil(silence_ms * RATE / 1000 / FRAME)
        self.minimum = math.ceil(min_speech_ms * RATE / 1000 / FRAME)
        self.maximum = math.ceil(max_seconds * RATE / FRAME)
        self.padding = math.ceil(pre_ms * RATE / 1000 / FRAME)
        self.pre = deque(maxlen=self.padding)
        self.position = 0
        self.frames = []
        self.start = 0
        self.voiced = 0
        self.gap = 0
        self.last_voice = 0
        self.continuation = False

    def set_silence(self, milliseconds):
        """Change the next silence boundary without discarding audio."""
        if type(milliseconds) is not int or not 200 <= milliseconds <= 12000:
            raise ValueError('Invalid silence duration')
        self.silence = math.ceil(milliseconds * RATE / 1000 / FRAME)

    def push(self, pcm, probability):
        """Accept one 32 ms mono PCM16 frame and possibly return a clip."""
        if len(pcm) != FRAME * 2:
            raise ValueError('Expected 512 PCM16 samples')
        at = self.position
        self.position += FRAME
        level = (self.threshold - 0.15 if self.frames or self.continuation
                 else self.threshold)
        voice = probability >= level
        if not self.frames:
            if not voice and not self.continuation:
                self.pre.append((at, pcm))
                return None
            self.start = self.pre[0][0] if self.pre else at
            self.frames = [data for _, data in self.pre]
            self.pre.clear()
        self.frames.append(pcm)
        if voice:
            self.voiced += 1
            self.gap = 0
            self.last_voice = len(self.frames)
        else:
            self.gap += 1
        if len(self.frames) >= self.maximum:
            return self.flush('max_duration')
        if self.gap >= self.silence:
            tail = self.frames[-self.padding:] if self.padding else []
            clip = self.flush('silence')
            begin = self.position - len(tail) * FRAME
            self.pre.extend((begin + i * FRAME, data)
                            for i, data in enumerate(tail))
            return clip
        return None

    def flush(self, reason='stop'):
        """Finish a valid clip; discard short clicks and reset the buffer."""
        clip = None
        if self.voiced >= self.minimum or (self.continuation and self.frames):
            count = (len(self.frames) if reason == 'max_duration' else
                     min(len(self.frames), self.last_voice + self.padding))
            clip = {
                'pcm': b''.join(self.frames[:count]),
                'start_sample': self.start,
                'end_sample': self.start + count * FRAME,
                'speech_ms': round(self.voiced * FRAME / RATE * 1000),
                'reason': reason,
            }
        self.continuation = reason == 'max_duration' and clip is not None
        self.frames = []
        self.voiced = self.gap = self.last_voice = 0
        self.pre.clear()
        return clip


class ClipStore:
    """Save unique WAV/JSON pairs without overwriting previous recordings."""

    def __init__(self, root, quota_mb, settings):
        """Create an isolated session and account for existing voice data."""
        self.root = Path(root) / 'sessions'
        self.root.mkdir(parents=True, exist_ok=True)
        self.used = sum(p.stat().st_size for p in self.root.rglob('*')
                        if p.is_file())
        self.limit = quota_mb * 1024 * 1024
        if self.used >= self.limit:
            raise RuntimeError('Лимит записей исчерпан. Освободите папку '
                               'или увеличьте лимит в настройках.')
        self.session_id = str(uuid.uuid4())
        self.folder = self.root / self.session_id
        self.folder.mkdir()
        self.started = datetime.now(timezone.utc)
        self.settings = settings
        self.lock = threading.Lock()

    def save(self, clip):
        """Serialize quota accounting with background copy processing."""
        with self.lock:
            return self._save(clip)

    def _save(self, clip):
        """Persist one complete pair or clean up this failed pair only."""
        if clip is None:
            return None
        pcm = clip['pcm']
        required = len(pcm) + 8192
        if self.used + required > self.limit:
            raise RuntimeError('Лимит записей исчерпан; запись остановлена.')
        if shutil.disk_usage(self.folder).free < required + 100 * 1024**2:
            raise RuntimeError('Недостаточно свободного места для записи.')
        clip_id = str(uuid.uuid4())
        wav_path = self.folder / (clip_id + '.wav')
        meta_path = wav_path.with_suffix('.json')
        start = clip['start_sample'] / RATE
        duration = len(pcm) / (RATE * 2)
        metadata = {
            'schema_version': 1, 'id': clip_id,
            'session_id': self.session_id, 'audio': wav_path.name,
            'transcription_file': clip_id + '.transcription.json',
            'started_at': (self.started + timedelta(seconds=start))
            .isoformat(),
            'duration_seconds': duration,
            'sample_rate': RATE, 'channels': 1, 'sample_width': 2,
            'speaker_verified': False, 'status': 'captured_unverified',
            'end_reason': clip['reason'], 'speech_ms': clip['speech_ms'],
            'settings': self.settings,
        }
        try:
            with wav_path.open('xb') as output:
                with wave.open(output, 'wb') as writer:
                    writer.setnchannels(1)
                    writer.setsampwidth(2)
                    writer.setframerate(RATE)
                    writer.writeframes(pcm)
            with meta_path.open('x', encoding='utf-8') as output:
                json.dump(metadata, output, ensure_ascii=False, indent=2)
        except Exception:
            wav_path.unlink(missing_ok=True)
            meta_path.unlink(missing_ok=True)
            raise
        self.used += wav_path.stat().st_size + meta_path.stat().st_size
        return {'type': 'clip', 'id': clip_id, 'path': str(wav_path),
                'started_at': metadata['started_at'],
                'duration': duration, 'used_mb': round(self.used / 1024**2, 2)}

    def clean_copy(self, result, noise, normalize, process):
        """Reserve disk budget and atomically publish an optional copy."""
        source = Path(result['path'])
        folder = source.parent / 'clean'
        folder.mkdir(exist_ok=True)
        target = folder / source.name
        temporary = target.with_suffix('.wav.part')
        reserve = source.stat().st_size + 8192
        with self.lock:
            if self.used + reserve > self.limit:
                raise RuntimeError('Нет места в лимите для очищенной копии')
            if shutil.disk_usage(folder).free < reserve + 100 * 1024**2:
                raise RuntimeError('Недостаточно свободного места')
            self.used += reserve
        committed = False
        try:
            info = process(source, temporary, noise, normalize)
            temporary.replace(target)
            committed = True
            metadata = source.with_suffix('.json')
            with self.lock:
                old_size = metadata.stat().st_size
                value = json.loads(metadata.read_text(encoding='utf-8'))
                value['clean_audio'] = 'clean/' + target.name
                value['processing'] = info
                meta_temp = metadata.with_suffix('.json.part')
                try:
                    meta_temp.write_text(json.dumps(value, ensure_ascii=False,
                                                    indent=2), encoding='utf-8')
                    meta_temp.replace(metadata)
                finally:
                    meta_temp.unlink(missing_ok=True)
                self.used += (target.stat().st_size + metadata.stat().st_size
                              - old_size - reserve)
                return {'id': result['id'], 'path': str(target),
                        'used_mb': round(self.used / 1024**2, 2)}
        except Exception:
            temporary.unlink(missing_ok=True)
            with self.lock:
                self.used += (target.stat().st_size if committed else 0)
                self.used -= reserve
            raise

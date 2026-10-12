"""Check real PCM processing without Torch, a model, or microphone access."""

import builtins
import json
from pathlib import Path
import queue
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]
                       / 'desktop' / 'voice'))
from enhance import BackgroundEnhancer, NoiseEstimator, enhance_wav
from segments import ClipStore, FRAME, RATE
import record


class EnhancementTests(unittest.TestCase):
    """Verify copy fidelity, bounded gain, noise reduction and quotas."""

    def setUp(self):
        """Create a private storage area for every test."""
        self.temp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def source(self, samples):
        """Write a mono PCM16 WAV fixture."""
        source = self.root / 'original.wav'
        with wave.open(str(source), 'wb') as writer:
            writer.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
            writer.writeframes(np.rint(samples * 32768)
                               .astype('<i2').tobytes())
        return source

    def read(self, path):
        """Load samples for numerical assertions only."""
        with wave.open(str(path), 'rb') as reader:
            return np.frombuffer(reader.readframes(reader.getnframes()),
                                 dtype='<i2').astype(float) / 32768

    def test_copy_length_original_and_normalization(self):
        """Preserve original bytes and partial final hops; cap gain at 6 dB."""
        samples = 0.1 * np.sin(np.arange(16001) * 2 * np.pi * 440 / RATE)
        source = self.source(samples)
        original = source.read_bytes()
        target = self.root / 'clean.wav'
        info = enhance_wav(source, target, normalize=True)
        result = self.read(target)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(len(result), len(samples))
        self.assertAlmostEqual(info['gain'], 10 ** (6 / 20))
        self.assertGreater(np.max(np.abs(result)), 0.19)
        self.assertLess(np.max(np.abs(result[1000:])), 0.21)
        plain = self.root / 'plain.wav'
        enhance_wav(source, plain)
        self.assertLess(np.max(np.abs(result - self.read(plain)
                                      * info['gain'])), 1 / 32768)
        # The filter must not shift the output by a whole STFT hop.
        self.assertGreater(np.corrcoef(samples[1000:], result[1000:])[0, 1],
                           0.96)

    def test_sustained_silence_learns_noise_and_reduces_it(self):
        """A quiet profile enables suppression; speech does not train it."""
        rng = np.random.default_rng(9)
        samples = rng.normal(0, 0.02, RATE * 2)
        source = self.source(samples)
        noise = NoiseEstimator()
        pcm = np.rint(samples[:FRAME] * 32768).astype('<i2').tobytes()
        for _ in range(30):
            noise.observe(pcm, 0.9)
        self.assertIsNone(noise.snapshot())
        for i in range(50):
            pcm = np.rint(samples[i * FRAME:(i + 1) * FRAME] * 32768)
            noise.observe(pcm.astype('<i2').tobytes(), 0)
        self.assertIsNotNone(noise.snapshot())
        clean = self.root / 'clean.wav'
        info = enhance_wav(source, clean, noise.snapshot())
        self.assertTrue(info['denoised'])
        self.assertLess(np.std(self.read(clean)), np.std(samples) * 0.85)

    def test_background_copy_metadata_and_quota(self):
        """Publish a cleaned pair and preserve raw audio on quota errors."""
        store = ClipStore(self.root, 100, {})
        result = store.save({'pcm': b'\x01\x00' * 10001,
                             'start_sample': 0, 'speech_ms': 600,
                             'reason': 'stop'})
        source = Path(result['path'])
        original = source.read_bytes()
        events = []
        cleaner = BackgroundEnhancer(store, False, events.append)
        cleaner.submit(result, None)
        cleaner.close()
        self.assertTrue(any(e['type'] == 'cleaned' for e in events))
        self.assertEqual(source.read_bytes(), original)
        metadata = json.loads(source.with_suffix('.json').read_text())
        self.assertTrue((source.parent / metadata['clean_audio']).is_file())
        self.assertEqual(store.used, sum(p.stat().st_size
                         for p in store.root.rglob('*') if p.is_file()))
        store.limit = store.used + 10
        with self.assertRaisesRegex(RuntimeError, 'лимите'):
            store.clean_copy(result, None, False, enhance_wav)
        self.assertEqual(source.read_bytes(), original)

    def test_failed_copy_releases_its_reservation(self):
        """Failed processing cannot consume budget or alter the original."""
        store = ClipStore(self.root, 100, {})
        result = store.save({'pcm': b'\x01\x00' * 10001,
                             'start_sample': 0, 'speech_ms': 600,
                             'reason': 'stop'})
        used = store.used
        original = Path(result['path']).read_bytes()

        def fail(source, target, noise, normalize):
            """Simulate an interrupted copy after writing some bytes."""
            target.write_bytes(b'partial')
            raise OSError('disk unavailable')

        with self.assertRaises(OSError):
            store.clean_copy(result, None, False, fail)
        self.assertEqual(store.used, used)
        self.assertEqual(Path(result['path']).read_bytes(), original)
        self.assertEqual(list(store.folder.rglob('*.part')), [])

    def test_stop_drains_captured_audio_and_finishes_clean_copy(self):
        """Exercise capture shutdown with simulated PortAudio and VAD."""
        stop = threading.Event()
        pcm = b'\x00\x04' * FRAME
        events = []

        class Stream:
            """Queue microphone frames before the user presses Stop."""

            def __init__(self, **options):
                """Retain only the callback supplied by capture."""
                self.callback = options['callback']

            def __enter__(self):
                """Deliver 1.28 seconds of audio then request shutdown."""
                for _ in range(40):
                    self.callback(pcm, FRAME, None, False)
                stop.set()
                return self

            def __exit__(self, *args):
                """Close the simulated endpoint."""
                return False

        model = SimpleNamespace(engine='silero-onnx-cpu', score=lambda pcm: 0.9)
        sd = SimpleNamespace(
            query_hostapis=lambda: [], query_devices=lambda: [],
            check_input_settings=lambda **kw: None, RawInputStream=Stream)
        config = {'folder': str(self.root), 'quota_mb': 100,
                  'threshold': 0.5, 'silence_ms': 5000, 'enhance': True}
        with patch.object(record, 'emit', events.append):
            record.capture(config, sd, stop, model, queue.Queue())
        clip = next(e for e in events if e['type'] == 'clip')
        clean = next(e for e in events if e['type'] == 'cleaned')
        with wave.open(clip['path'], 'rb') as reader:
            self.assertEqual(reader.readframes(100000), pcm * 40)
        self.assertEqual(len(self.read(clean['path'])), FRAME * 40)
        self.assertTrue(any(e['type'] == 'microphone_closed' for e in events))

    def test_cleanup_dll_failure_preserves_raw_recording(self):
        """Optional DSP failure must not prevent the microphone from starting."""
        stop = threading.Event()
        events = []
        pcm = b'\x00\x04' * FRAME

        class Stream:
            """Deliver a complete speech clip before Stop."""

            def __init__(self, **options):
                """Retain the PortAudio callback."""
                self.callback = options['callback']

            def __enter__(self):
                """Simulate captured blocks followed by a user stop."""
                for _ in range(40):
                    self.callback(pcm, FRAME, None, False)
                stop.set()
                return self

            def __exit__(self, *args):
                """Close the simulated input stream."""
                return False

        original_import = builtins.__import__

        def import_dependency(name, *args, **kwargs):
            """Simulate a failed SciPy DLL while allowing other imports."""
            if name == 'enhance':
                raise OSError('test DSP DLL failed')
            return original_import(name, *args, **kwargs)

        sd = SimpleNamespace(
            query_hostapis=lambda: [], query_devices=lambda: [],
            check_input_settings=lambda **kw: None, RawInputStream=Stream)
        model = SimpleNamespace(engine='silero-onnx-cpu', score=lambda pcm: 0.9)
        config = {'folder': str(self.root), 'quota_mb': 100,
                  'threshold': 0.5, 'silence_ms': 5000, 'enhance': True}
        with patch.object(record, 'emit', events.append), \
                patch('builtins.__import__', side_effect=import_dependency):
            record.capture(config, sd, stop, model, queue.Queue())
        self.assertTrue(any(e['type'] == 'ready' for e in events))
        self.assertTrue(any(e['type'] == 'warning' and 'DSP DLL' in e['message']
                            for e in events))
        clip = next(e for e in events if e['type'] == 'clip')
        with wave.open(clip['path'], 'rb') as reader:
            self.assertEqual(reader.readframes(100000), pcm * 40)
        self.assertFalse(any(e['type'] == 'cleaned' for e in events))


if __name__ == '__main__':
    unittest.main()

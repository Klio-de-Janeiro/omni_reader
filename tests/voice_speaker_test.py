"""Test PCM preparation and pinned model installation without a microphone."""

import hashlib
import importlib.util
import io
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'desktop/voice'))
from speaker_audio import read_pcm, speech_windows

SPEC = importlib.util.spec_from_file_location(
    'setup_model', ROOT / 'scripts/setup-speaker-model.py')
SETUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SETUP)


class FakeVAD:
    """A deterministic gate allows testing exact samples and window bounds."""

    def __init__(self):
        """Count independent streams for the reset contract."""
        self.resets = 0

    def reset(self):
        """Reset once per clip."""
        self.resets += 1

    def score(self, block):
        """Treat nonzero PCM as speech without any ML dependency."""
        if len(block) != 1024:
            raise AssertionError('Wrong frame size')
        return 1 if any(block) else 0


class SpeakerAudioTests(unittest.TestCase):
    """Exercise real WAV bytes and silent tails without changing originals."""

    def test_silence_and_short_speech_are_not_identity_evidence(self):
        """Fewer than three seconds cannot produce a model decision."""
        vad = FakeVAD()
        self.assertEqual(speech_windows(bytes(32000 * 6), vad), ([], 0))
        pcm = struct.pack('<h', 300) * 16000
        windows, duration = speech_windows(pcm, vad)
        self.assertEqual(windows, [])
        self.assertEqual(duration, 1)
        self.assertEqual(vad.resets, 2)

    def test_silent_tails_removed_and_all_parts_sampled(self):
        """A long clip samples its beginning and end, not only its center."""
        speech = b''.join(struct.pack('<h', n + 1) * 512
                          for n in range(1000))
        raw = bytes(1024 * 200) + speech + bytes(1024 * 200)
        windows, seconds = speech_windows(raw, FakeVAD())
        self.assertEqual(seconds, 32)
        self.assertEqual(len(windows), 3)
        self.assertEqual(windows[0], speech[:32000 * 8])
        self.assertEqual(windows[-1], speech[-32000 * 8:])
        self.assertEqual(raw[:1024 * 200], bytes(1024 * 200))

    def test_window_shorter_than_two_full_windows_covers_both_ends(self):
        """Nine seconds must not silently discard the ends of a phrase."""
        pcm = struct.pack('<h', 900) * 16000 * 9
        windows, seconds = speech_windows(pcm, FakeVAD())
        self.assertEqual(seconds, 9)
        self.assertEqual(len(windows), 2)
        self.assertTrue(all(len(window) == 32000 * 8 for window in windows))

    def test_wav_hashes_pcm_and_rejects_stereo(self):
        """Container metadata is not confused with the audio fingerprint."""
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'пример & запись.wav'
            pcm = struct.pack('<h', 600) * 16000 * 4
            with wave.open(str(filename), 'wb') as audio:
                audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                audio.writeframes(pcm)
            self.assertEqual(read_pcm(filename),
                             (pcm, hashlib.sha256(pcm).hexdigest()))
            with wave.open(str(filename), 'wb') as audio:
                audio.setparams((2, 2, 16000, 0, 'NONE', 'not compressed'))
                audio.writeframes(pcm)
            with self.assertRaisesRegex(ValueError, 'mono PCM16'):
                read_pcm(filename)


class ModelInstallTests(unittest.TestCase):
    """Verify atomic installation, checksums and existing-model protection."""

    def test_pinned_model_download_and_cache(self):
        """Commit valid weights once; use the local cache on later runs."""
        model = b'pinned test model'
        with tempfile.TemporaryDirectory() as directory:
            with (patch.object(SETUP, 'MODEL_SIZE', len(model)),
                  patch.object(SETUP, 'MODEL_SHA256',
                               hashlib.sha256(model).hexdigest())):
                calls = []

                def fetch(url, timeout):
                    """Record the exact official URL used for download."""
                    calls.append((url, timeout))
                    return io.BytesIO(model)

                target = SETUP.download_model(directory, fetch)
                self.assertEqual(target.read_bytes(), model)
                cached = SETUP.download_model(directory, fetch)
                self.assertEqual(cached, target)
                self.assertEqual(len(calls), 1)
                self.assertIn('github.com/k2-fsa/sherpa-onnx/', calls[0][0])
                self.assertTrue((Path(directory) / 'WESPEAKER_LICENSE.txt')
                                .is_file())

    def test_corrupt_or_existing_weights_are_never_overwritten(self):
        """A failed checksum leaves neither a model nor partial files."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, 'SHA-256'):
                SETUP.download_model(root, lambda *a, **k:
                                     io.BytesIO(b'bad'))
            self.assertEqual(list(root.iterdir()), [])
            target = root / SETUP.MODEL_NAME
            target.write_bytes(b'user model')
            with self.assertRaisesRegex(ValueError, 'Existing model'):
                SETUP.download_model(root)
            self.assertEqual(target.read_bytes(), b'user model')


if __name__ == '__main__':
    unittest.main()

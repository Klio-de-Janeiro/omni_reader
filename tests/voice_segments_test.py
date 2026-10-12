"""Deterministic PCM tests without a microphone or downloaded ML model."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]
                       / 'desktop' / 'voice'))
from segments import ClipStore, FRAME, RATE, Segmenter

PCM = b'\x01\x00' * FRAME


class SegmentationTests(unittest.TestCase):
    """Check speech boundaries, bounded memory and durable audio output."""

    def test_silence_and_click_are_discarded(self):
        """Silence and a single VAD spike must not become recordings."""
        segmenter = Segmenter()
        for _ in range(1000):
            self.assertIsNone(segmenter.push(PCM, 0))
        self.assertLessEqual(len(segmenter.pre), 10)
        segmenter.push(PCM, 0.9)
        for _ in range(50):
            self.assertIsNone(segmenter.push(PCM, 0))
        self.assertIsNone(segmenter.flush())

    def test_padding_pause_and_stop(self):
        """Preserve the beginning and a bounded tail, then flush on stop."""
        segmenter = Segmenter()
        for _ in range(20):
            segmenter.push(PCM, 0)
        for _ in range(20):
            segmenter.push(PCM, 0.9)
        clips = [segmenter.push(PCM, 0) for _ in range(30)]
        clip = next(item for item in clips if item)
        self.assertEqual(clip['start_sample'], 10 * FRAME)
        self.assertEqual(len(clip['pcm']), 40 * FRAME * 2)
        self.assertEqual(clip['reason'], 'silence')
        for _ in range(10):
            segmenter.push(PCM, 0.9)
        self.assertEqual(segmenter.flush()['reason'], 'stop')
        self.assertIsNone(segmenter.flush())

    def test_long_speech_is_bounded(self):
        """Long utterances split without unbounded buffers or sample loss."""
        segmenter = Segmenter(max_seconds=1, pre_ms=0)
        clips = []
        for _ in range(100):
            result = segmenter.push(PCM, 0.8)
            if result:
                clips.append(result)
            self.assertLess(len(segmenter.frames), 32)
        self.assertEqual(len(clips), 3)
        self.assertEqual(clips[1]['start_sample'], clips[0]['end_sample'])
        self.assertTrue(all(c['reason'] == 'max_duration' for c in clips))
        clips.append(segmenter.flush())
        self.assertEqual(sum(len(c['pcm']) for c in clips), 100 * FRAME * 2)

    def test_pause_changes_preserve_the_active_fragment(self):
        """Changing the silence limit applies to the current recording."""
        segmenter = Segmenter(silence_ms=12000)
        for _ in range(20):
            segmenter.push(PCM, 1)
        for _ in range(100):
            self.assertIsNone(segmenter.push(PCM, 0))
        segmenter.set_silence(3000)
        self.assertEqual(segmenter.push(PCM, 0)['reason'], 'silence')
        with self.assertRaises(ValueError):
            segmenter.set_silence(13000)

    def test_hysteresis_and_invalid_frame(self):
        """Use a lower continuation threshold without starting on noise."""
        segmenter = Segmenter()
        self.assertIsNone(segmenter.push(PCM, 0.4))
        self.assertFalse(segmenter.frames)
        segmenter.push(PCM, 0.8)
        for _ in range(10):
            segmenter.push(PCM, 0.4)
        self.assertIsNotNone(segmenter.flush())
        with self.assertRaises(ValueError):
            segmenter.push(b'bad', 1)

    def test_wav_metadata_unique_names_and_quota(self):
        """Write valid audio pairs, keep old files and enforce total quota."""
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temporary:
            store = ClipStore(temporary, 100, {'threshold': 0.5})
            segmenter = Segmenter()
            for _ in range(10):
                segmenter.push(PCM, 1)
            clip = segmenter.flush()
            first = store.save(clip)
            second = store.save(clip)
            self.assertNotEqual(first['path'], second['path'])
            with wave.open(first['path'], 'rb') as reader:
                self.assertEqual(reader.getnchannels(), 1)
                self.assertEqual(reader.getframerate(), RATE)
                self.assertEqual(reader.getsampwidth(), 2)
                self.assertEqual(reader.readframes(100000), clip['pcm'])
            meta = json.loads(Path(first['path']).with_suffix('.json')
                              .read_text(encoding='utf-8'))
            self.assertFalse(meta['speaker_verified'])
            self.assertEqual(meta['status'], 'captured_unverified')
            another = ClipStore(temporary, 100, {})
            self.assertEqual(another.used, store.used)
            store.limit = store.used + 10
            with self.assertRaisesRegex(RuntimeError, 'Лимит'):
                store.save(clip)
            self.assertEqual(len(list(store.folder.glob('*.wav'))), 2)


if __name__ == '__main__':
    unittest.main()

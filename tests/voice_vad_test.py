"""Verify native Silero input, context and configurable speech decisions."""

from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]
                       / 'desktop' / 'voice'))
from vad import SileroVAD, load_model, load_numpy


class Session:
    """Capture native windows and expose a controllable speech decision."""

    def __init__(self):
        """Keep copied requests independently from mutable VAD buffers."""
        self.requests = []
        self.detected = True
        self.resets = 0

    def window_size(self):
        """Report the 512 samples plus the v5/v6 model's 64-sample context."""
        return 576

    def reset(self):
        """Count native resets without exposing implementation tensors."""
        self.resets += 1

    def is_speech(self, samples):
        """Keep the exact waveform given to the native recurrent model."""
        self.requests.append(samples.copy())
        return self.detected


class SileroStreamTests(unittest.TestCase):
    """Check PCM scaling, recurrent context, warmup reset and validation."""

    def test_pcm_state_and_context(self):
        """Native windows retain context without modifying original PCM."""
        session = Session()
        model = SileroVAD(session, np)
        values = np.array([-32768, 32767, 0, 256] * 128, dtype='<i2')
        pcm = values.tobytes()
        self.assertEqual(model.score(pcm), 1.0)
        first = session.requests[0]
        self.assertEqual(first.dtype, np.float32)
        self.assertEqual(first.shape, (576,))
        np.testing.assert_array_equal(first[:64], 0)
        np.testing.assert_array_equal(first[64:],
                                      values.astype(np.float32) / 32768)
        session.detected = False
        model.score(bytes(1024))
        second = session.requests[1]
        np.testing.assert_array_equal(second[:64], first[-64:])
        self.assertEqual(pcm, values.tobytes())
        model.reset()
        self.assertEqual(session.resets, 2)
        np.testing.assert_array_equal(model.context, 0)
        self.assertEqual(model.score(bytes(1024)), 0.0)
        np.testing.assert_array_equal(session.requests[-1], 0)

    def test_numpy_cpu_check_precedes_native_model_loading(self):
        """Validate the actual NumPy module and report its binary location."""
        messages = []
        result = load_numpy(lambda stage, message:
                            messages.append((stage, message)))
        self.assertIs(result, np)
        self.assertEqual(messages[0][0], 'numpy')
        self.assertEqual(messages[-1][0], 'numpy_check')
        self.assertIn(np.__version__, messages[-1][1])
        self.assertIn(str(np.__file__), messages[-1][1])

    def test_invalid_audio_and_model_output(self):
        """Reject lost samples and unexpected results before false silence."""
        session = Session()
        model = SileroVAD(session, np)
        with self.assertRaises(ValueError):
            model.score(bytes(1022))
        self.assertEqual(session.requests, [])
        for detected in (float('nan'), 0.75, None):
            session.detected = detected
            with self.assertRaises(RuntimeError):
                model.score(bytes(1024))

    def test_local_loader_resets_after_warmup(self):
        """Load only local weights on one CPU thread with a fresh state."""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'data').mkdir()
            (root / 'data/silero_vad.onnx').write_bytes(b'local model')
            session = Session()
            received = {}

            def create(config):
                """Capture the threshold and single-thread CPU settings."""
                received['config'] = config
                return session

            def configuration():
                """Provide the nested native configuration surface."""
                return SimpleNamespace(silero_vad=SimpleNamespace(),
                                       validate=lambda: True)

            runtime = SimpleNamespace(VadModelConfig=configuration,
                                      VadModel=SimpleNamespace(create=create))
            spec = SimpleNamespace(submodule_search_locations=[folder])
            phases = []
            with patch.dict(sys.modules, {'sherpa_onnx': runtime}), \
                    patch('vad.importlib.util.find_spec', return_value=spec):
                model = load_model(
                    lambda stage, message: phases.append(stage), 0.8)
            config = received['config']
            self.assertEqual(config.provider, 'cpu')
            self.assertEqual(config.num_threads, 1)
            self.assertEqual(config.sample_rate, 16000)
            self.assertEqual(config.silero_vad.threshold, 0.8)
            self.assertEqual(Path(config.silero_vad.model),
                             root / 'data/silero_vad.onnx')
            self.assertEqual(len(session.requests), 1)
            self.assertEqual(session.resets, 2)
            np.testing.assert_array_equal(model.context, 0)
            self.assertEqual(phases[-1], 'validation')

    def test_invalid_threshold_never_starts_native_inference(self):
        """Reject invalid public settings before importing a native engine."""
        for threshold in (float('nan'), True, '0.5', 0.09, 0.96):
            with self.assertRaises(ValueError):
                load_model(threshold=threshold)

    def test_wrong_model_window_never_reaches_native_inference(self):
        """Reject an incompatible model before a native fatal size error."""
        session = Session()
        session.window_size = lambda: 512
        with self.assertRaises(RuntimeError):
            SileroVAD(session, np)
        self.assertEqual(session.requests, [])


if __name__ == '__main__':
    unittest.main()

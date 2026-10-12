"""Exercise local speaker models in a bounded isolated CPU process."""

import argparse
import os
from pathlib import Path
import subprocess
import sys

from importlib.metadata import PackageNotFoundError, version


def main():
    """Show model-loading phases and terminate a blocked native import."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--timeout', type=int, default=180)
    args = parser.parse_args()
    if not 1 <= args.timeout <= 300:
        parser.error('--timeout must be between 1 and 300 seconds')
    print('Python:', sys.executable, flush=True)
    for name in ('sherpa-onnx', 'sherpa-onnx-core', 'onnxruntime', 'numpy'):
        try:
            installed = version(name)
        except PackageNotFoundError:
            installed = 'not installed'
        print(name + ': ' + installed, flush=True)
    environment = dict(os.environ, PYTHONUTF8='1',
                       PYTHONIOENCODING='utf-8', PYTHONNOUSERSITE='1',
                       OMP_NUM_THREADS='1', MKL_NUM_THREADS='1',
                       OPENBLAS_NUM_THREADS='1', HF_HUB_OFFLINE='1')
    worker = Path(__file__).resolve().parents[1] / 'desktop/voice/speaker.py'
    try:
        result = subprocess.run(
            [sys.executable, '-u', str(worker), '--self-check',
             str(args.model.resolve())], env=environment,
            capture_output=True, encoding='utf-8', errors='replace',
            timeout=args.timeout)
    except subprocess.TimeoutExpired as error:
        for output in (error.stdout, error.stderr):
            if output:
                print(output.decode('utf-8', errors='replace')
                      if isinstance(output, bytes) else output, flush=True)
        print('Speaker self-check timed out. Child Python was terminated.',
              file=sys.stderr, flush=True)
        return 1
    print(result.stdout, flush=True)
    if result.stderr:
        print(result.stderr, file=sys.stderr, flush=True)
    if result.returncode or '"self_check": true' not in result.stdout:
        return 1
    print('Local speaker + Silero CPU self-check: OK', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

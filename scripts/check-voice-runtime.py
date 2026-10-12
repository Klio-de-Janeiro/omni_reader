"""Check the voice environment in a bounded, isolated Python process."""

import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import struct
import subprocess
import sys


def show_output(stdout, stderr):
    """Show startup phases and preserve native loader diagnostics."""
    if isinstance(stdout, bytes):
        stdout = stdout.decode('utf-8', errors='replace')
    if isinstance(stderr, bytes):
        stderr = stderr.decode('utf-8', errors='replace')
    for line in (stdout or '').splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            print(line, flush=True)
            continue
        print(event.get('message') or line, flush=True)
    if stderr:
        print(stderr, file=sys.stderr, flush=True)


def main():
    """Report versions without importing Torch, then test the local model."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio', action='store_true',
                        help='Also import PortAudio and cleanup libraries.')
    parser.add_argument('--torch', action='store_true',
                        help='Diagnose an old Torch environment instead.')
    parser.add_argument('--numpy-only', action='store_true',
                        help='Test NumPy without VAD, PortAudio or Torch.')
    parser.add_argument('--timeout', type=int, default=300)
    args = parser.parse_args()
    if not 1 <= args.timeout <= 600:
        parser.error('--timeout must be between 1 and 600 seconds')
    if args.numpy_only and (args.audio or args.torch):
        parser.error('--numpy-only cannot be combined with --audio or --torch')
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    print('Python:', sys.version.replace('\n', ' '), flush=True)
    print('Executable:', sys.executable, flush=True)
    print('Architecture:', struct.calcsize('P') * 8, 'bit', flush=True)
    print('Windows/platform:', platform.platform(), flush=True)
    for package in ('silero-vad', 'sherpa-onnx', 'sherpa-onnx-core', 'numpy',
                    'sounddevice', 'scipy', 'onnxruntime', 'torch'):
        try:
            version = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            version = 'not installed'
        print('Installed ' + package + ':', version, flush=True)
    if struct.calcsize('P') != 8:
        print('The recorder requires Python x64.', file=sys.stderr)
        return 1
    environment = dict(os.environ, PYTHONUTF8='1',
                       PYTHONIOENCODING='utf-8', PYTHONNOUSERSITE='1',
                       OMP_NUM_THREADS='1', MKL_NUM_THREADS='1',
                       OPENBLAS_NUM_THREADS='1')
    worker = Path(__file__).resolve().parents[1] / 'desktop/voice/record.py'
    command = [sys.executable, '-I', '-u', '-X', 'utf8',
               '-X', 'faulthandler', str(worker)]
    operation = ('check_numpy' if args.numpy_only else
                 'check_audio' if args.audio else 'check')
    config = {'command': operation}
    if args.torch:
        command = [sys.executable, '-u', '-c',
                   'import torch; '
                   'assert torch.ones(4, device="cpu").sum().item() == 4; '
                   'print("Torch CPU: OK")']
    print('Checking ' + ('NumPy CPU' if args.numpy_only else
          'legacy Torch' if args.torch else
          'Silero via sherpa-onnx CPU') + '...', flush=True)
    try:
        result = subprocess.run(
            command, input=json.dumps(config) + '\n', capture_output=True,
            text=True, encoding='utf-8', errors='replace', env=environment,
            timeout=args.timeout)
    except subprocess.TimeoutExpired as error:
        show_output(error.stdout, error.stderr)
        print('Self-check timed out after ' + str(args.timeout)
              + ' s; the child Python process was terminated. The last '
              'phase above identifies the blocked dependency.',
              file=sys.stderr, flush=True)
        return 1
    show_output(result.stdout, result.stderr)
    if result.returncode:
        return 1
    if not args.torch and not any(
            '"type": "checked"' in line
            for line in result.stdout.splitlines()):
        print('The requested runtime did not confirm readiness.',
              file=sys.stderr)
        return 1
    print('Voice environment self-check: OK', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())

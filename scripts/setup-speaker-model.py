"""Fetch pinned WeSpeaker weights once; runtime inference stays offline."""

import argparse
import hashlib
import os
from pathlib import Path
import tempfile
import urllib.request

MODEL_NAME = 'wespeaker_en_voxceleb_resnet34_LM.onnx'
MODEL_URL = ('https://github.com/k2-fsa/sherpa-onnx/releases/download/'
             'speaker-recongition-models/' + MODEL_NAME)
MODEL_SIZE = 26530550
MODEL_SHA256 = ('e9848563da86f263117134dfd7ad63c92355b37de492b55e325400'
                'c9d9c39012')
ATTRIBUTION = """WeSpeaker ResNet34 LM, trained on VoxCeleb2 Dev.
Authors: WeSpeaker project, https://github.com/wenet-e2e/wespeaker
Model: https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM
License: Creative Commons Attribution 4.0 (CC BY 4.0).
https://creativecommons.org/licenses/by/4.0/
ONNX distribution: k2-fsa/sherpa-onnx speaker-recongition-models release.
Omni uses the distributed weights unchanged.
"""


def checksum(filename):
    """Hash an existing model without keeping its weights in memory."""
    result = hashlib.sha256()
    with Path(filename).open('rb') as stream:
        while block := stream.read(1024 * 1024):
            result.update(block)
    return result.hexdigest()


def download_model(directory, open_url=urllib.request.urlopen):
    """Commit only a complete, byte-for-byte matching official model."""
    root = Path(directory).resolve()
    root.mkdir(parents=True, exist_ok=True)
    target = root / MODEL_NAME
    if target.exists():
        if (target.stat().st_size == MODEL_SIZE
                and checksum(target) == MODEL_SHA256):
            (root / 'WESPEAKER_LICENSE.txt').write_text(ATTRIBUTION,
                                                      encoding='utf-8')
            return target
        raise ValueError('Existing model differs from the pinned model. '
                         'Choose another folder or rename that file.')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=root, suffix='.partial',
                                         delete=False) as output:
            temporary = Path(output.name)
            digest = hashlib.sha256()
            size = 0
            with open_url(MODEL_URL, timeout=60) as source:
                while block := source.read(1024 * 1024):
                    size += len(block)
                    if size > MODEL_SIZE:
                        raise ValueError('Downloaded model is too large.')
                    digest.update(block)
                    output.write(block)
            if size != MODEL_SIZE or digest.hexdigest() != MODEL_SHA256:
                raise ValueError('WeSpeaker SHA-256 verification failed.')
        # A link is atomic and refuses to overwrite an existing target.
        os.link(temporary, target)
        (root / 'WESPEAKER_LICENSE.txt').write_text(ATTRIBUTION,
                                                  encoding='utf-8')
        return target
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def main():
    """Download to the selected dedicated voice environment's model folder."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    print('Downloading/verifying WeSpeaker (26.5 MB)…', flush=True)
    print('Model:', download_model(args.directory), flush=True)
    print('SHA-256:', MODEL_SHA256, flush=True)


if __name__ == '__main__':
    main()

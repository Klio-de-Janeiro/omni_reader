param(
    [string]$VoiceEnvironment = (Join-Path $env:USERPROFILE 'Desktop\omni_voice_env')
)
$ErrorActionPreference = 'Stop'
$VoiceEnvironment = [IO.Path]::GetFullPath($VoiceEnvironment)
$SpeakerPython = Join-Path $VoiceEnvironment 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $SpeakerPython -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $VoiceEnvironment 'pyvenv.cfg'))) {
    throw 'First run SETUP_VOICE_WINDOWS.ps1. Speaker verification uses the separate omni_voice_env environment.'
}
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONNOUSERSITE = '1'
$env:OMP_NUM_THREADS = '1'
$env:MKL_NUM_THREADS = '1'
$env:OPENBLAS_NUM_THREADS = '1'
& $SpeakerPython -m pip install --only-binary=:all: 'sherpa-onnx==1.13.8'
if ($LASTEXITCODE -ne 0) { throw 'Cannot install sherpa-onnx CPU. See the pip error above.' }
$ModelDirectory = Join-Path $VoiceEnvironment 'models'
& $SpeakerPython -u (Join-Path $PSScriptRoot 'scripts\setup-speaker-model.py') --directory $ModelDirectory
if ($LASTEXITCODE -ne 0) { throw 'Speaker model download/checksum failed. Existing files were not replaced.' }
$SpeakerModel = Join-Path $ModelDirectory 'wespeaker_en_voxceleb_resnet34_LM.onnx'
& $SpeakerPython -u (Join-Path $PSScriptRoot 'scripts\check-speaker-runtime.py') --model $SpeakerModel --timeout 180
if ($LASTEXITCODE -ne 0) { throw 'Speaker self-check failed. See the exact phase and native error above. Torch is not used. For a missing Windows DLL, rerun SETUP_VOICE_WINDOWS.ps1 -InstallVCRuntime.' }
Write-Host "Speaker Python: $SpeakerPython"
Write-Host "Speaker model: $SpeakerModel"
Write-Host 'Ready. Open Omni > My voice and dataset. Record references, label separate calibration clips, then calibrate.'

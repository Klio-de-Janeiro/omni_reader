param(
    [string]$BasePython = 'C:\Users\User\Desktop\whisper_env\Scripts\python.exe',
    [string]$VoiceEnvironment = (Join-Path $env:USERPROFILE 'Desktop\omni_voice_env'),
    [switch]$InstallVCRuntime
)
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONNOUSERSITE = '1'
$env:OMP_NUM_THREADS = '1'
$env:MKL_NUM_THREADS = '1'
$env:OPENBLAS_NUM_THREADS = '1'

function Run-Python {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable -I -X utf8 @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Python command failed (exit $LASTEXITCODE)." }
}

if (-not (Test-Path -LiteralPath $BasePython -PathType Leaf)) {
    throw 'Base Python was not found. Pass -BasePython with your python.exe path.'
}
$VoiceEnvironment = [IO.Path]::GetFullPath($VoiceEnvironment)
$VoicePython = Join-Path $VoiceEnvironment 'Scripts\python.exe'
$BasePrefix = & $BasePython -I -c 'import sys; print(sys.prefix)'
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect base Python.' }
if ($VoiceEnvironment.TrimEnd('\') -eq ([string]$BasePrefix).Trim().TrimEnd('\')) {
    throw 'Choose a separate environment. The Whisper environment must stay unchanged.'
}
if (-not (Test-Path -LiteralPath $VoicePython -PathType Leaf)) {
    if (Test-Path -LiteralPath $VoiceEnvironment) {
        throw 'The target exists but is not a Python environment. Choose a new folder.'
    }
    Run-Python $BasePython @('-m', 'venv', $VoiceEnvironment)
}
if (-not (Test-Path -LiteralPath (Join-Path $VoiceEnvironment 'pyvenv.cfg'))) {
    throw 'The target must be a dedicated Python virtual environment.'
}
& $VoicePython -I -c 'import sys; sys.exit(0 if sys.version_info.major == 3 and 10 <= sys.version_info.minor <= 13 and sys.maxsize > 2**32 else 1)'
if ($LASTEXITCODE -ne 0) {
    throw 'This voice environment requires Python 3.10-3.13 x64. Use your Python 3.11 environment as -BasePython.'
}
if ($InstallVCRuntime) {
    $RuntimeDirectory = Join-Path ([IO.Path]::GetTempPath()) ('omni-vc-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $RuntimeDirectory | Out-Null
    $RuntimeInstaller = Join-Path $RuntimeDirectory 'vc_redist.x64.exe'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri 'https://aka.ms/vc14/vc_redist.x64.exe' -OutFile $RuntimeInstaller
    $RuntimeSignature = Get-AuthenticodeSignature -LiteralPath $RuntimeInstaller
    if ($RuntimeSignature.Status -ne 'Valid' -or $RuntimeSignature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
        throw 'Visual C++ installer does not have a valid Microsoft signature.'
    }
    $RuntimeProcess = Start-Process -FilePath $RuntimeInstaller -ArgumentList '/install', '/passive', '/norestart' -Wait -PassThru
    if ($RuntimeProcess.ExitCode -eq 3010) {
        throw 'Visual C++ runtime installed. Restart Windows, then run this setup again without -InstallVCRuntime.'
    }
    if ($RuntimeProcess.ExitCode -notin @(0, 1638)) {
        throw "Visual C++ installation failed (exit $($RuntimeProcess.ExitCode))."
    }
}
Run-Python $VoicePython @('-m', 'pip', 'install', '--upgrade', 'pip')
Run-Python $VoicePython @('-m', 'pip', 'install', '--force-reinstall', '--no-cache-dir', '--only-binary=:all:', 'sounddevice==0.5.2', 'numpy==2.2.6', 'scipy==1.15.3')
Write-Host 'Checking NumPy separately before installing the native VAD engine...'
Run-Python $VoicePython @('-u', (Join-Path $PSScriptRoot 'scripts\check-voice-runtime.py'), '--numpy-only', '--timeout', '180')
# Reinstall both native CPU packages, including when repairing an existing venv.
Run-Python $VoicePython @('-m', 'pip', 'install', '--force-reinstall', '--no-cache-dir', '--only-binary=:all:', '--no-deps', 'sherpa-onnx==1.13.8', 'sherpa-onnx-core==1.13.8')
# Read bundled ONNX weights directly. Silero's Torch/TorchAudio code is unused.
Run-Python $VoicePython @('-m', 'pip', 'install', '--only-binary=:all:', '--no-deps', 'silero-vad==6.2.1')
& $VoicePython -I -X utf8 -u (Join-Path $PSScriptRoot 'scripts\check-voice-runtime.py') --audio --timeout 300
if ($LASTEXITCODE -ne 0) {
    throw 'Voice environment check failed. See the exact phase and error above. The recorder uses sherpa-onnx CPU, not the standalone onnxruntime package. For a native DLL error, rerun with -InstallVCRuntime. Select this omni_voice_env Python in Omni, not the Whisper Python.'
}
Write-Host "Ready. Recorder Python: $VoicePython"
Write-Host 'Local Silero via sherpa-onnx CPU, PortAudio and audio cleanup: ready. Python onnxruntime and Torch are not imported.'
Write-Host 'Open Omni > Microphone settings. Select this Python if needed, then refresh microphones. Use the recorder button to start/stop.'

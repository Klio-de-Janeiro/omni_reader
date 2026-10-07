$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22+ first.' }
$studioJdk = Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'
if (-not $env:JAVA_HOME -and (Test-Path $studioJdk)) { $env:JAVA_HOME = $studioJdk }
if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) { throw 'Set JAVA_HOME to JDK 17+ or install Android Studio.' }
$env:Path = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:Path
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$androidPlatform = Join-Path $env:ANDROID_HOME 'platforms\android-35\android.jar'
if (-not (Test-Path $androidPlatform)) { throw 'In Android Studio > SDK Manager install Android SDK Platform 35 and Build-Tools 35.0.0, then rerun.' }
if (-not (Test-Path (Join-Path $env:ANDROID_HOME 'build-tools\35.0.0\aapt2.exe'))) { throw 'Install Android SDK Build-Tools 35.0.0 in SDK Manager.' }
node scripts/sync-native.mjs
if ($LASTEXITCODE -ne 0) { throw 'Native asset synchronization failed.' }
$gradleRoot = Join-Path $PSScriptRoot '.tools\gradle-8.11.1'
$gradleBin = Join-Path $gradleRoot 'bin\gradle.bat'
if (-not (Test-Path $gradleBin)) {
    New-Item -ItemType Directory -Force '.tools' | Out-Null
    $gradleZip = Join-Path $PSScriptRoot '.tools\gradle-8.11.1-bin.zip'
    $distribution = 'https://services.gradle.org/distributions/gradle-8.11.1-bin.zip'
    $checksumFile = Join-Path $PSScriptRoot '.tools\gradle-8.11.1-bin.zip.sha256'
    Write-Host 'Downloading the official Gradle checksum...'
    Invoke-WebRequest -Uri ($distribution + '.sha256') -OutFile $checksumFile -UseBasicParsing
    $expected = [System.IO.File]::ReadAllText($checksumFile).Trim().ToLowerInvariant()
    if ($expected -notmatch '\A[0-9a-f]{64}\z') { throw 'Invalid Gradle SHA-256 response. Build stopped.' }
    $actual = ''
    if (Test-Path -LiteralPath $gradleZip -PathType Leaf) {
        $actual = (Get-FileHash -LiteralPath $gradleZip -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    if ($actual -ne $expected) {
        Write-Host 'Downloading the official Gradle distribution...'
        Invoke-WebRequest -Uri $distribution -OutFile $gradleZip -UseBasicParsing
        $actual = (Get-FileHash -LiteralPath $gradleZip -Algorithm SHA256).Hash.ToLowerInvariant()
    } else {
        Write-Host 'Using the previously downloaded Gradle archive (SHA-256 verified).'
    }
    if ($actual -ne $expected) { throw 'Gradle checksum mismatch. Build stopped.' }
    Expand-Archive -Path $gradleZip -DestinationPath '.tools' -Force
}
& $gradleBin -p android wrapper --gradle-version 8.11.1 --distribution-type bin
if ($LASTEXITCODE -ne 0) { throw 'Gradle setup failed. See the log above.' }
& $gradleBin -p android assembleDebug --stacktrace
if ($LASTEXITCODE -ne 0) { throw 'APK build failed. See the log above.' }
New-Item -ItemType Directory -Force 'release' | Out-Null
Copy-Item 'android\app\build\outputs\apk\debug\app-debug.apk' 'release\Omni-Reader-0.3.0-Android.apk' -Force
Write-Host 'APK ready: release\Omni-Reader-0.3.0-Android.apk'

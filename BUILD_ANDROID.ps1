param([ValidateSet('Release', 'Debug')][string]$Configuration = 'Release')
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
if ($Configuration -eq 'Release' -and -not (Test-Path (Join-Path $PSScriptRoot 'android\keystore.properties'))) {
    if (-not ($env:OMNI_KEYSTORE_FILE -and $env:OMNI_KEYSTORE_PASSWORD -and $env:OMNI_KEY_ALIAS -and $env:OMNI_KEY_PASSWORD)) {
        throw 'Release signing is not configured. Restore the signing backup or run SETUP_ANDROID_SIGNING.cmd first. Do not create a new key if you already published this app.'
    }
}
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
& $gradleBin -p android ('assemble' + $Configuration) --stacktrace
if ($LASTEXITCODE -ne 0) { throw 'APK build failed. See the log above.' }
New-Item -ItemType Directory -Force 'release' | Out-Null
if ($Configuration -eq 'Release') {
    $apk = Join-Path $PSScriptRoot 'android\app\build\outputs\apk\release\app-release.apk'
    $signer = Join-Path $env:ANDROID_HOME 'build-tools\35.0.0\apksigner.bat'
    $aapt = Join-Path $env:ANDROID_HOME 'build-tools\35.0.0\aapt.exe'
    if (-not (Test-Path $apk)) { throw 'Signed release APK was not produced.' }
    & $signer verify --verbose $apk
    if ($LASTEXITCODE -ne 0) { throw 'Release APK signature verification failed.' }
    $manifest = & $aapt dump badging $apk
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the release APK.' }
    if (($manifest -join "`n") -match 'application-debuggable') { throw 'The APK is debuggable. Upload stopped.' }
    Copy-Item $apk 'release\omni.apk' -Force
    Write-Host 'Signed release APK ready: release\omni.apk'
} else {
    Copy-Item 'android\app\build\outputs\apk\debug\app-debug.apk' 'release\Omni-Reader-0.3.0-Android-debug.apk' -Force
    Write-Host 'Debug APK ready (not for store upload): release\Omni-Reader-0.3.0-Android-debug.apk'
}

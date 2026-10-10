$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$studioJdk = Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'
if (-not $env:JAVA_HOME -and (Test-Path $studioJdk)) { $env:JAVA_HOME = $studioJdk }
if (-not $env:JAVA_HOME) { throw 'Set JAVA_HOME to JDK 17+ or install Android Studio.' }
$keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
if (-not (Test-Path $keytool)) { throw 'JDK keytool was not found.' }
$properties = Join-Path $PSScriptRoot 'android\keystore.properties'
$keystore = Join-Path $PSScriptRoot '.signing\omni-release.p12'
if ((Test-Path $properties) -or (Test-Path $keystore)) { throw 'A signing configuration or key already exists. Keep your original key; it must not be replaced for updates.' }
Write-Host 'Create a signing key only for your FIRST release. If you already published Omni, restore its original key instead.'
$first = Read-Host 'New keystore password (at least 12 characters)' -AsSecureString
$second = Read-Host 'Repeat password' -AsSecureString
function Read-Secret([Security.SecureString]$Value) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
function Escape-Property([string]$Value) {
    $result = New-Object Text.StringBuilder
    foreach ($character in $Value.ToCharArray()) {
        $number = [int]$character
        if ($number -lt 33 -or $number -gt 126 -or '\=:#!'.Contains([string]$character)) { [void]$result.Append(('\u{0:x4}' -f $number)) }
        else { [void]$result.Append($character) }
    }
    return $result.ToString()
}
$password = Read-Secret $first
if ($password.Length -lt 12 -or $password -cne (Read-Secret $second)) { throw 'Passwords differ or are too short. No key was created.' }
$previousPassword = $env:OMNI_SIGNING_PASSWORD
try {
    New-Item -ItemType Directory -Force '.signing' | Out-Null
    $env:OMNI_SIGNING_PASSWORD = $password
    & $keytool -genkeypair -keystore $keystore -storetype PKCS12 -storepass:env OMNI_SIGNING_PASSWORD -keypass:env OMNI_SIGNING_PASSWORD -alias omni -keyalg RSA -keysize 3072 -sigalg SHA256withRSA -validity 10000 -dname 'CN=Omni Reader'
    if ($LASTEXITCODE -ne 0) { throw 'Signing key generation failed.' }
    $escaped = Escape-Property $password
    $content = "storeFile=../.signing/omni-release.p12`nstorePassword=$escaped`nkeyAlias=omni`nkeyPassword=$escaped`n"
    [IO.File]::WriteAllText($properties, $content, [Text.Encoding]::ASCII)
    Write-Host 'Signing configured. Back up .signing\omni-release.p12 and android\keystore.properties. Do not upload them to GitHub or a store.'
} finally {
    $env:OMNI_SIGNING_PASSWORD = $previousPassword
    $password = $null; $escaped = $null; $content = $null
}

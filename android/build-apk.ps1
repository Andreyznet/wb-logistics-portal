param(
 [string]$SdkRoot="$env:LOCALAPPDATA/Android/Sdk",
 [string]$JavaRoot='C:/Program Files/Android/Android Studio/jbr',
 [string]$SigningStore="$PSScriptRoot/.local-signing/debug.jks"
)
$ErrorActionPreference='Stop'
if(!(Test-Path -LiteralPath $SigningStore)){throw 'The original signing key is required to update existing installations. Restore it from your private backup.'}
if(!(Test-Path -LiteralPath "$PSScriptRoot/app/google-services.json")){throw 'Firebase Android configuration is missing.'}
$env:JAVA_HOME=$JavaRoot
$env:ANDROID_HOME=$SdkRoot
& "$PSScriptRoot/gradlew.bat" -p $PSScriptRoot :app:assembleDebug "-PsigningStore=$SigningStore" --no-daemon
if($LASTEXITCODE -ne 0){throw "Gradle build failed ($LASTEXITCODE)"}
Write-Output "APK: $PSScriptRoot/app/build/outputs/apk/debug/app-debug.apk"

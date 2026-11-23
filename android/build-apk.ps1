param(
 [string]$SdkRoot="$env:LOCALAPPDATA/Android/Sdk",
 [string]$JavaRoot='C:/Program Files/Android/Android Studio/jbr',
 [string]$SigningStore="$PSScriptRoot/.local-signing/debug.jks"
)
$ErrorActionPreference='Stop'
$androidBuild=Join-Path $PSScriptRoot 'app/build/manual'
$tools=Join-Path $SdkRoot 'build-tools/36.0.0'
$platform=Join-Path $SdkRoot 'platforms/android-35/android.jar'
$java=Join-Path $JavaRoot 'bin/java.exe'
$javac=Join-Path $JavaRoot 'bin/javac.exe'
$jar=Join-Path $JavaRoot 'bin/jar.exe'
function Invoke-Checked([string]$Exe,[string[]]$Arguments){ & $Exe @Arguments; if($LASTEXITCODE -ne 0){throw "Build failed: $Exe ($LASTEXITCODE)"} }
foreach($path in @($tools,$platform,$java,$javac)){if(!(Test-Path -LiteralPath $path)){throw "Missing Android build prerequisite: $path"}}
foreach($dir in @($androidBuild,"$androidBuild/generated","$androidBuild/classes","$androidBuild/dex")){New-Item -ItemType Directory -Force $dir | Out-Null}
Invoke-Checked "$tools/aapt2.exe" @('compile','--dir',"$PSScriptRoot/app/src/main/res",'-o',"$androidBuild/resources.zip")
$manifest=[IO.File]::ReadAllText("$PSScriptRoot/app/src/main/AndroidManifest.xml").Replace('<manifest xmlns:', '<manifest package="ru.rostprom.marshrut" xmlns:')
[IO.File]::WriteAllText("$androidBuild/AndroidManifest.xml",$manifest,(New-Object Text.UTF8Encoding($false)))
Invoke-Checked "$tools/aapt2.exe" @('link','-o',"$androidBuild/unsigned.apk",'-I',$platform,'--manifest',"$androidBuild/AndroidManifest.xml",'--java',"$androidBuild/generated",'--min-sdk-version','26','--target-sdk-version','35','--version-code','1','--version-name','1.0.0',"$androidBuild/resources.zip")
$sources=@(Get-ChildItem "$PSScriptRoot/app/src/main/java","$androidBuild/generated" -Recurse -Filter '*.java' | ForEach-Object { '"'+$_.FullName.Replace('\','/')+'"' })
[IO.File]::WriteAllLines("$androidBuild/sources.txt",$sources,(New-Object Text.UTF8Encoding($false)))
Invoke-Checked $javac @('-encoding','UTF-8','-source','17','-target','17','-classpath',$platform,'-d',"$androidBuild/classes","@$androidBuild/sources.txt")
Invoke-Checked $jar @('cf',"$androidBuild/classes.jar",'-C',"$androidBuild/classes",'.')
Invoke-Checked $java @('-cp',"$tools/lib/d8.jar",'com.android.tools.r8.D8','--lib',$platform,'--min-api','26','--output',"$androidBuild/dex","$androidBuild/classes.jar")
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zip=[IO.Compression.ZipFile]::Open("$androidBuild/unsigned.apk",[IO.Compression.ZipArchiveMode]::Update)
try{foreach($dex in Get-ChildItem "$androidBuild/dex" -Filter '*.dex'){[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$dex.FullName,$dex.Name,[IO.Compression.CompressionLevel]::Optimal)|Out-Null}}finally{$zip.Dispose()}
Invoke-Checked "$tools/zipalign.exe" @('-f','-p','4',"$androidBuild/unsigned.apk","$androidBuild/aligned.apk")
if(!(Test-Path -LiteralPath $SigningStore)){
 New-Item -ItemType Directory -Force (Split-Path $SigningStore) | Out-Null
 Invoke-Checked "$JavaRoot/bin/keytool.exe" @('-genkeypair','-keystore',$SigningStore,'-storepass','android','-alias','androiddebugkey','-keypass','android','-keyalg','RSA','-keysize','2048','-validity','10000','-dname','CN=Marshrut Development,O=Rostprom,C=RU')
}
Invoke-Checked $java @('-jar',"$tools/lib/apksigner.jar",'sign','--ks',$SigningStore,'--ks-key-alias','androiddebugkey','--ks-pass','pass:android','--key-pass','pass:android','--out',"$androidBuild/marshrut-1.0.0.apk","$androidBuild/aligned.apk")
Invoke-Checked $java @('-jar',"$tools/lib/apksigner.jar",'verify','--verbose',"$androidBuild/marshrut-1.0.0.apk")
Write-Output "APK: $androidBuild/marshrut-1.0.0.apk"

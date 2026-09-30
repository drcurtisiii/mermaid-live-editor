<#
.SYNOPSIS
  Builds a versioned Mermaid View Edit release.

.DESCRIPTION
  Version comes from desktop\package.json ("version") - the single source of truth.
  Produces:
    installer\Mermaid View Edit v<version>.exe
    updates\Mermaid View Edit v<version>.exe
    updates\latest.json
  then creates the versioned desktop shortcut and offers Common Software publication.
  Refuses to overwrite an existing release of the same version.

.EXAMPLE
  .\build.ps1 -ReleaseNotes "Adds X"
#>
[CmdletBinding()]
param(
  [string]$ReleaseNotes = 'Initial release',
  [switch]$SkipTests,
  # Skip the Common Software question (for unattended builds). Default is to ask.
  [switch]$NoPublishPrompt
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = $PSScriptRoot
$Desktop = Join-Path $Root 'desktop'
$AppName = 'Mermaid View Edit'

function Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Invoke-Checked([string]$what, [scriptblock]$block) {
  # Native tools write progress to stderr; judge them by exit code, not stderr
  # (Windows PowerShell 5.1 would otherwise turn stderr lines into terminating errors).
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $block 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)." }
}
function Copy-Verified([string]$source, [string]$destination, [string]$sha256, [long]$size) {
  if (Test-Path -LiteralPath $destination) { throw "Refusing to overwrite existing release: $destination" }
  $temp = "$destination.$PID.tmp"
  try {
    Copy-Item -LiteralPath $source -Destination $temp
    $item = Get-Item -LiteralPath $temp
    $hash = (Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($item.Length -ne $size -or $hash -ne $sha256) { throw "Verification failed for $destination" }
    Move-Item -LiteralPath $temp -Destination $destination
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
  }
}

# --- Version and release names --------------------------------------------
$package = Get-Content -LiteralPath (Join-Path $Desktop 'package.json') -Raw | ConvertFrom-Json
$Version = [string]$package.version
if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw "desktop\package.json version '$Version' is not semantic." }
$ExeName = "$AppName v$Version.exe"
$InstallerDir = Join-Path $Root 'installer'
$UpdatesDir = Join-Path $Root 'updates'
$InstallerExe = Join-Path $InstallerDir $ExeName
$UpdatesExe = Join-Path $UpdatesDir $ExeName
foreach ($existing in @($InstallerExe, $UpdatesExe)) {
  if (Test-Path -LiteralPath $existing) {
    throw "$existing already exists. Bump the version in desktop\package.json before building."
  }
}
Step "Building $AppName v$Version"

# --- Prerequisites ---------------------------------------------------------
foreach ($tool in 'node', 'npm', 'corepack') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required tool '$tool' is not on PATH. Install Node.js 24+." }
}
foreach ($asset in 'assets\app.ico', 'pnpm-lock.yaml', 'desktop\package-lock.json', 'launcher\Launcher.cs') {
  if (-not (Test-Path -LiteralPath (Join-Path $Root $asset))) { throw "Missing required file: $asset" }
}
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'

Push-Location $Root
try {
  # Keep bulky build folders out of Dropbox sync.
  foreach ($dir in 'node_modules', 'docs', '.svelte-kit', 'desktop\node_modules', 'desktop\dist', 'desktop\web') {
    $full = Join-Path $Root $dir
    New-Item -ItemType Directory -Force -Path $full | Out-Null
    Set-Content -LiteralPath $full -Stream com.dropbox.ignored -Value 1
  }

  Step 'Installing locked dependencies'
  Invoke-Checked 'pnpm install' { corepack pnpm install --frozen-lockfile }
  Push-Location $Desktop
  try {
    # npm ci wipes node_modules first, which fails if Windows holds a lock on it;
    # on an existing checkout install from the lockfile in place instead.
    if (Test-Path -LiteralPath 'node_modules\electron-builder') {
      Invoke-Checked 'npm install' { npm install --no-audit --no-fund }
    } else {
      Invoke-Checked 'npm ci' { npm ci --no-audit --no-fund }
    }
    if (-not (Test-Path -LiteralPath 'node_modules\electron\dist\electron.exe')) {
      Invoke-Checked 'electron download' { node node_modules\electron\install.js }
    }
  } finally { Pop-Location }

  Step 'Building the editor (web)'
  # Desktop build: no analytics, no Mermaid Chart promos, no external renderer links
  # (diagram text must not be sent to mermaid.ink/kroki.io by accident).
  $env:MERMAID_ANALYTICS_URL = ''
  $env:MERMAID_IS_ENABLED_MERMAID_CHART_LINKS = 'false'
  $env:MERMAID_RENDERER_URL = ''
  $env:MERMAID_KROKI_RENDERER_URL = ''
  Invoke-Checked 'embed build' { corepack pnpm exec vite build --config vite.embed.config.js }
  # Antivirus/Dropbox can briefly lock files in .svelte-kit; retry transient failures.
  for ($attempt = 1; ; $attempt++) {
    try { Invoke-Checked 'web build' { corepack pnpm exec vite build }; break }
    catch { if ($attempt -ge 3) { throw }; Write-Host "Web build failed (attempt $attempt); retrying..."; Start-Sleep -Seconds 10 }
  }

  $web = Join-Path $Desktop 'web'
  Get-ChildItem -LiteralPath $web -Force | Remove-Item -Recurse -Force
  Copy-Item -Path (Join-Path $Root 'docs\*') -Destination $web -Recurse
  Copy-Item -LiteralPath (Join-Path $Root 'assets\app.ico') -Destination (Join-Path $Desktop 'app.ico') -Force

  if (-not $SkipTests) {
    Step 'Running tests'
    Push-Location $Desktop
    try { Invoke-Checked 'desktop tests' { npm test } } finally { Pop-Location }
    Invoke-Checked 'editor unit tests' { corepack pnpm exec vitest run --dir src --testTimeout=60000 }
  }

  Step 'Packaging the application'
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  # Package outside Dropbox: the ~400 MB intermediate folder gets locked by sync/antivirus
  # scanning when written inside the synced tree. Only the finished exe is copied back.
  $stage = Join-Path $env:LOCALAPPDATA 'MermaidViewEdit-build\dist'
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  Push-Location $Desktop
  try { Invoke-Checked 'electron-builder' { npx --no-install electron-builder --win dir --x64 --publish never "-c.directories.output=$stage" } } finally { Pop-Location }
  $unpacked = Join-Path $stage 'win-unpacked'
  if (-not (Test-Path -LiteralPath (Join-Path $unpacked "$AppName.exe"))) { throw "electron-builder did not produce $unpacked\$AppName.exe" }

  Step 'Building the single-file launcher'
  # The release exe is launcher\Launcher.cs with the app embedded as a zip; it unpacks
  # once per version to %LOCALAPPDATA%\MermaidViewEdit\app and starts it from there.
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $csc)) { throw "C# compiler not found: $csc (.NET Framework 4.x is required)." }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $payloadZip = Join-Path $stage 'payload.zip'
  [System.IO.Compression.ZipFile]::CreateFromDirectory($unpacked, $payloadZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  $payloadId = (Get-FileHash -LiteralPath $payloadZip -Algorithm SHA256).Hash.ToLowerInvariant().Substring(0, 12)
  $payloadIdFile = Join-Path $stage 'payload.id'
  [System.IO.File]::WriteAllText($payloadIdFile, $payloadId)
  $numeric = ($Version -replace '-.*$', '') + '.0'
  $assemblyInfo = Join-Path $stage 'AssemblyInfo.cs'
  [System.IO.File]::WriteAllText($assemblyInfo, @"
using System.Reflection;
[assembly: AssemblyTitle("$AppName")]
[assembly: AssemblyProduct("$AppName")]
[assembly: AssemblyDescription("View and edit Mermaid diagrams")]
[assembly: AssemblyCompany("The Curtis Law Firm")]
[assembly: AssemblyVersion("$numeric")]
[assembly: AssemblyFileVersion("$numeric")]
[assembly: AssemblyInformationalVersion("$Version")]
"@)
  $distExe = Join-Path $stage $ExeName
  Invoke-Checked 'launcher compile' {
    & $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$distExe" `
      "/win32icon:$(Join-Path $Root 'assets\app.ico')" `
      "/resource:$payloadZip,payload.zip" "/resource:$payloadIdFile,payload.id" `
      /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
      /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll `
      (Join-Path $Root 'launcher\Launcher.cs') $assemblyInfo
  }
  if (-not (Test-Path -LiteralPath $distExe)) { throw "Launcher compile did not produce $distExe" }

  $size = (Get-Item -LiteralPath $distExe).Length
  $sha256 = (Get-FileHash -LiteralPath $distExe -Algorithm SHA256).Hash.ToLowerInvariant()

  Step 'Publishing release files'
  New-Item -ItemType Directory -Force -Path $InstallerDir, $UpdatesDir | Out-Null
  Copy-Verified $distExe $InstallerExe $sha256 $size
  Copy-Verified $distExe $UpdatesExe $sha256 $size

  # Manifest last, via temp file + rename, only after the exe is verified in place.
  $manifest = [ordered]@{
    app_name      = $AppName
    version       = $Version
    filename      = $ExeName
    sha256        = $sha256
    size          = $size
    release_notes = $ReleaseNotes
  } | ConvertTo-Json
  $manifestPath = Join-Path $UpdatesDir 'latest.json'
  $manifestTemp = "$manifestPath.$PID.tmp"
  [System.IO.File]::WriteAllText($manifestTemp, $manifest, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $manifestTemp -Destination $manifestPath -Force

  Step 'Creating desktop shortcut'
  & (Join-Path $Root 'scripts\create-shortcut.ps1') -ExePath $InstallerExe -Version $Version

  Write-Host ''
  Write-Host "Release:  $InstallerExe" -ForegroundColor Green
  Write-Host "Size:     $size bytes"
  Write-Host "SHA-256:  $sha256"

  if (-not $NoPublishPrompt) {
    $answer = Read-Host "Publish $ExeName to the firm's Common Software folder and remove prior versions of this app there? [y/N]"
    if ($answer -match '^(?i:y|yes)$') {
      & (Join-Path $Root 'scripts\publish-common.ps1') -ExePath $InstallerExe
    } else {
      Write-Host 'Common Software folder left unchanged.'
    }
  }
} finally {
  Pop-Location
}

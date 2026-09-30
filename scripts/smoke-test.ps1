<#
.SYNOPSIS
  Release smoke test for the packaged Mermaid View Edit executable.
  Launches the real exe (and the desktop shortcut) with MVE_SMOKE_REPORT set,
  which makes the app suppress dialogs and write its window/error state to JSON.
  Close the app before running: the test stops every running copy of it.
#>
[CmdletBinding()]
param([string]$Version)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
if (-not $Version) { $Version = (Get-Content -LiteralPath (Join-Path $Root 'desktop\package.json') -Raw | ConvertFrom-Json).version }
$ExeName = "Mermaid View Edit v$Version.exe"
$Exe = Join-Path $Root "installer\$ExeName"
$Results = New-Object System.Collections.Generic.List[object]
function Result($name, [bool]$ok, $detail = '') {
  $Results.Add([pscustomobject]@{ Test = $name; Result = $(if ($ok) { 'PASS' } else { 'FAIL' }); Detail = $detail }); Write-Host "$(if ($ok) {'PASS'} else {'FAIL'})  $name  $detail"
}

# The release exe is a launcher that starts the app from this folder and exits,
# so the app is found by its path rather than as a child of the launched process.
$InstalledAppDir = Join-Path $env:LOCALAPPDATA 'MermaidViewEdit\app'
function Get-App {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($InstalledAppDir, [StringComparison]::OrdinalIgnoreCase) })
}
function Stop-App {
  Get-App | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  $deadline = (Get-Date).AddSeconds(15)
  while (@(Get-App).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
}
if (@(Get-App).Count -gt 0) { throw 'Mermaid View Edit is already running. Close it before running the smoke test (the test stops every running copy).' }
function Wait-Report([string]$path, [scriptblock]$done, [int]$seconds = 90) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $path) {
      try { $report = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json; if (& $done $report) { return $report } } catch {}
    }
    Start-Sleep -Milliseconds 500
  }
  if (Test-Path -LiteralPath $path) { return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json) }
  $null
}
function Start-App([string]$file, [string[]]$arguments, [string]$report) {
  Remove-Item -LiteralPath $report -ErrorAction SilentlyContinue
  $env:MVE_SMOKE_REPORT = $report
  try {
    if ($arguments) { Start-Process -FilePath $file -ArgumentList $arguments } else { Start-Process -FilePath $file }
  } finally { Remove-Item Env:MVE_SMOKE_REPORT }
}

function Quote([string]$p) { '"' + $p + '"' }

$work = Join-Path $env:TEMP ("mve smoke ü (it's) " + [guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Path $work | Out-Null
$mmd = Join-Path $work 'intake flow.mmd'
$md = Join-Path $work 'notes – draft.md'
Set-Content -LiteralPath $mmd -Encoding UTF8 -Value "flowchart LR`n  A[Intake] --> B{Conflict?}`n  B -->|no| C[Engage]"
Set-Content -LiteralPath $md -Encoding UTF8 -Value "# Notes`n`n``````mermaid`nsequenceDiagram`n  A->>B: hi`n```````n"
$bad = Join-Path $work 'letter.docx'; Set-Content -LiteralPath $bad -Value 'x'
$missing = Join-Path $work 'missing.mmd'

# 1. Exe exists in both release locations; manifest matches -------------------
$updatesExe = Join-Path $Root "updates\$ExeName"
Result 'Exe in installer\ and updates\' ((Test-Path -LiteralPath $Exe) -and (Test-Path -LiteralPath $updatesExe))
$manifest = Get-Content -LiteralPath (Join-Path $Root 'updates\latest.json') -Raw | ConvertFrom-Json
$hash = (Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $Exe).Length
Result 'latest.json parses and matches exe' ($manifest.version -eq $Version -and $manifest.filename -eq $ExeName -and $manifest.sha256 -eq $hash -and $manifest.size -eq $size) "sha256=$hash size=$size"

# 2. Icon embedded + version resource -------------------------------------------
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Exe)
$info = (Get-Item -LiteralPath $Exe).VersionInfo
Result 'Icon embedded' ($null -ne $icon -and $icon.Width -gt 0)
Result 'Exe version resource' ($info.ProductVersion -like "$Version*") $info.ProductVersion

# 3. Shortcut --------------------------------------------------------------------
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) "Mermaid View Edit v$Version.lnk"
$shell = New-Object -ComObject WScript.Shell
$sc = if (Test-Path -LiteralPath $lnk) { $shell.CreateShortcut($lnk) } else { $null }
Result 'Desktop shortcut points to exe' ($null -ne $sc -and $sc.TargetPath -eq $Exe -and $sc.WorkingDirectory -eq (Split-Path $Exe)) $lnk

# 4. Plain launch: stays alive 15 s, title has version, missing manifest harmless --
$report = Join-Path $work 'plain.json'
Start-App $Exe @() $report
$r = Wait-Report $report { param($x) @($x.windows | Where-Object ready).Count -ge 1 }
Start-Sleep -Seconds 20   # past the first update check (15 s) with no updates\ folder
$alive = @(Get-App).Count -gt 0
$title = if ($r) { @($r.windows)[0].title } else { '' }
Result 'Double-click launch opens editor window' ($null -ne $r -and @($r.windows).Count -eq 1 -and $alive) $title
Result 'Title contains version' ($title -like "*Mermaid View Edit v$Version*") $title
Stop-App

# 5. Drop several files on the shortcut (spaces, Unicode, .md, bad, missing) -------
$report = Join-Path $work 'drop.json'
Start-App $lnk @((Quote $mmd), (Quote $md), (Quote $bad), (Quote $missing)) $report
$r = Wait-Report $report { param($x) @($x.windows | Where-Object ready).Count -ge 2 -and @($x.errors).Count -ge 1 }
$files = if ($r) { @($r.windows | ForEach-Object file) } else { @() }
Result 'Multi-file drop on shortcut opens each file' ($files -contains $mmd -and $files -contains $md) ($files -join '; ')
Result 'Unsupported + missing files reported, valid ones still open' ($null -ne $r -and ($r.errors[0].detail -match 'letter\.docx') -and ($r.errors[0].detail -match 'missing\.mmd'))
Stop-App

# 6. Only invalid files: controlled error, app exits by itself ---------------------
$report = Join-Path $work 'bad.json'
Start-App $Exe @((Quote $missing)) $report
$null = Wait-Report $report { param($x) @($x.errors).Count -ge 1 }
$deadline = (Get-Date).AddSeconds(30)
while (@(Get-App).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
$exited = @(Get-App).Count -eq 0
$r = if (Test-Path -LiteralPath $report) { Get-Content -LiteralPath $report -Raw | ConvertFrom-Json } else { $null }
Result 'Nonexistent path: error recorded and app exits' ($exited -and $null -ne $r -and @($r.windows).Count -eq 0 -and @($r.errors).Count -eq 1)
$leftover = @(Get-App)
Result 'No hidden process left after exit' ($leftover.Count -eq 0) (($leftover | ForEach-Object Id) -join ',')
Stop-App

# 7. Malformed update manifest does not crash ---------------------------------------
$appDir = Join-Path $work 'app dir'
New-Item -ItemType Directory -Path (Join-Path $appDir 'updates') | Out-Null
Copy-Item -LiteralPath $Exe -Destination $appDir
Set-Content -LiteralPath (Join-Path $appDir 'updates\latest.json') -Value '{"app_name": "Mermaid View'
$report = Join-Path $work 'malformed.json'
Start-App (Join-Path $appDir $ExeName) @() $report
$r = Wait-Report $report { param($x) @($x.windows | Where-Object ready).Count -ge 1 }
Start-Sleep -Seconds 20
Result 'Malformed latest.json: app keeps running' ($null -ne $r -and @(Get-App).Count -gt 0)
Stop-App

# 8. Defender custom scan -------------------------------------------------------------
$mp = Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'
if (Test-Path -LiteralPath $mp) {
  $out = & $mp -Scan -ScanType 3 -File $Exe -DisableRemediation 2>&1 | Out-String
  Result 'Microsoft Defender custom scan' ($LASTEXITCODE -eq 0 -and $out -notmatch 'found \d+ threats') ($out.Trim() -split "`n" | Select-Object -Last 1)
} else {
  $Results.Add([pscustomobject]@{ Test = 'Microsoft Defender custom scan'; Result = 'NOT VERIFIED'; Detail = 'MpCmdRun.exe not found' })
}

Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
$Results | Format-Table -AutoSize -Wrap | Out-String -Width 220
if ($Results | Where-Object Result -eq 'FAIL') { exit 1 }

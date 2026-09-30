<#
.SYNOPSIS
  Publishes a verified release to the firm's Common Software folder and removes
  ONLY prior versions of this app there ("Mermaid View Edit v<semver>.exe").
  Run only after explicit approval (build.ps1 asks; default is No).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ExePath,
  [string]$Destination = 'D:\Curtis Law Firm Dropbox\Curtis Law Firm Team Folder\Common Software'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$AppName = 'Mermaid View Edit'
$ReleasePattern = '^Mermaid View Edit v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?\.exe$'

$source = Get-Item -LiteralPath $ExePath
if ($source.Name -notmatch $ReleasePattern) { throw "Not a release file name: $($source.Name)" }
if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
  throw "Common Software folder not found or unavailable: $Destination (nothing was changed)."
}
$destDir = (Get-Item -LiteralPath $Destination).FullName.TrimEnd('\')
$size = $source.Length
$sha256 = (Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$final = Join-Path $destDir $source.Name

function Test-Match([string]$path) {
  (Get-Item -LiteralPath $path).Length -eq $size -and
  (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $sha256
}

if (Test-Path -LiteralPath $final) {
  if (-not (Test-Match $final)) {
    throw "$final already exists with different contents. Nothing was overwritten or deleted."
  }
  Write-Host "Same version already present and verified: $final"
} else {
  $temp = Join-Path $destDir ".$($source.Name).$PID.tmp"
  try {
    Copy-Item -LiteralPath $source.FullName -Destination $temp
    if (-not (Test-Match $temp)) { throw 'Copied file failed verification. Nothing was deleted.' }
    Move-Item -LiteralPath $temp -Destination $final
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
  }
  if (-not (Test-Match $final)) { throw "Published file failed verification: $final. Nothing was deleted." }
  Write-Host "Published: $final"
}
Write-Host "SHA-256:   $sha256"

# Only now, with the new release verified, remove prior versions of THIS app.
$removed = @()
foreach ($file in Get-ChildItem -LiteralPath $destDir -File) {
  if ($file.Name -notmatch $ReleasePattern) { continue }
  if ($file.Name -eq $source.Name) { continue }
  $resolved = $file.FullName
  if ((Split-Path -Parent $resolved).TrimEnd('\') -ne $destDir) { continue }
  Remove-Item -LiteralPath $resolved -Force
  $removed += $file.Name
}
if ($removed.Count -gt 0) {
  Write-Host 'Removed prior versions:'
  $removed | ForEach-Object { Write-Host "  $_" }
} else {
  Write-Host 'No prior versions to remove.'
}

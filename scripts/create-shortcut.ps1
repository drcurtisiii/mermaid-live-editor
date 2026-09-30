<#
.SYNOPSIS
  Creates the versioned desktop shortcut "Mermaid View Edit v<version>.lnk".
  Never replaces an existing shortcut. Files dragged onto the shortcut are
  passed to the exe as arguments and open in the editor.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ExePath,
  [Parameter(Mandatory)][string]$Version
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$target = (Resolve-Path -LiteralPath $ExePath).ProviderPath
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop "Mermaid View Edit v$Version.lnk"
if (Test-Path -LiteralPath $link) {
  Write-Host "Shortcut already exists (left unchanged): $link"
  return
}
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = Split-Path -Parent $target
$shortcut.IconLocation = "$target,0"
$shortcut.Description = 'Mermaid View Edit - view and edit Mermaid diagrams (drop .mmd/.mermaid/.md files here)'
$shortcut.Save()
Write-Host "Created shortcut: $link"

<#
.SYNOPSIS
  Copy this repository's provider files into a local OpenCode plugins directory.

.DESCRIPTION
  The repository is the editing source; this script is the manual step that
  carries a change into the directory OpenCode actually loads from.

  It is deliberately never run automatically. Preview first:

      ./scripts/sync-to-config.ps1 -WhatIf

  Then apply:

      ./scripts/sync-to-config.ps1

.EXAMPLE
  ./scripts/sync-to-config.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  # Where OpenCode auto-discovers global plugins.
  [string]$Destination = (Join-Path $env:USERPROFILE '.config\opencode\plugins')
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'plugins'
$files = Get-ChildItem -Path $source -Filter '*-search.ts' -File

if (-not $files) {
  throw "No *-search.ts files found in $source"
}

if (-not (Test-Path $Destination)) {
  throw "Destination does not exist: $Destination`nCreate it first, or pass -Destination."
}

$changed = 0
$identical = 0
$missing = 0

foreach ($file in $files) {
  $target = Join-Path $Destination $file.Name

  if (-not (Test-Path $target)) {
    Write-Host ("NEW      {0}" -f $file.Name) -ForegroundColor Yellow
    $missing++
    if ($PSCmdlet.ShouldProcess($target, 'Copy')) {
      Copy-Item -Path $file.FullName -Destination $target
      $changed++
    }
    continue
  }

  $a = Get-FileHash -Path $file.FullName -Algorithm SHA256
  $b = Get-FileHash -Path $target -Algorithm SHA256

  if ($a.Hash -eq $b.Hash) {
    Write-Host ("SAME     {0}" -f $file.Name) -ForegroundColor DarkGray
    $identical++
    continue
  }

  Write-Host ("DIFFERS  {0}" -f $file.Name) -ForegroundColor Cyan
  $changed++
  if ($PSCmdlet.ShouldProcess($target, 'Overwrite')) {
    Copy-Item -Path $file.FullName -Destination $target -Force
  }
}

Write-Host ""
Write-Host ("identical: {0}, to copy: {1}, absent at destination: {2}" -f $identical, $changed, $missing)

if ($changed -gt 0) {
  Write-Host ""
  Write-Host "Reload the plugins afterwards:" -ForegroundColor Yellow
  Write-Host "  opencode service restart"
  Write-Host ""
  Write-Host "Verify:" -ForegroundColor Yellow
  Write-Host '  opencode api get "/api/websearch/provider"'
}

param(
  [switch]$SkipBuild,
  [switch]$SkipSmoke,
  [switch]$KeepTemp
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Step {
  param(
    [string]$Command,
    [string[]]$Arguments = @()
  )

  Write-Host ("$ " + $Command + " " + ($Arguments -join " ")) -ForegroundColor DarkGray
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
  }
}

function Resolve-CommandPath {
  param([string[]]$Names)

  foreach ($name in $Names) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
      return $cmd.Source
    }
  }
  return $null
}

function Resolve-NpmInvocation {
  $node = Resolve-CommandPath @("node.exe", "node")
  if ($env:npm_execpath -and (Test-Path -LiteralPath $env:npm_execpath) -and $node) {
    return @{
      Command = $node
      PrefixArgs = @($env:npm_execpath)
    }
  }

  $npm = Resolve-CommandPath @("npm.cmd", "npm")
  if ($npm) {
    return @{
      Command = $npm
      PrefixArgs = @()
    }
  }

  if ($node) {
    $nodeDir = Split-Path -Parent $node
    $candidate = Join-Path $nodeDir "npm.cmd"
    if (Test-Path -LiteralPath $candidate) {
      return @{
        Command = $candidate
        PrefixArgs = @()
      }
    }
  }

  throw "Unable to locate npm. Add Node.js/npm to PATH or run from a Node.js command prompt."
}

function Invoke-NpmStep {
  param([string[]]$Arguments = @())

  $npmInvocation = Resolve-NpmInvocation
  Invoke-Step $npmInvocation.Command @($npmInvocation.PrefixArgs + $Arguments)
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $scriptDir "..")).Path
$reportPath = "artifacts/surface-package-smoke-pwa.json"

Set-Location $root

Write-Step "Packaging PWA artifact"
$packageArgs = @("run", "package:surfaces", "--", "--pwa")
if ($SkipBuild) {
  $packageArgs += "--skip-build"
}
Invoke-NpmStep $packageArgs

if (!$SkipSmoke) {
  $smokeScript = Join-Path $root "scripts\surface-package-smoke.mjs"
  if (Test-Path -LiteralPath $smokeScript) {
    Write-Step "Smoke testing packaged PWA artifact"
    $smokeArgs = @($smokeScript, "--pwa", "--report=$reportPath")
    if ($KeepTemp) {
      $smokeArgs += "--keep-temp"
    }
    Invoke-Step "node" $smokeArgs
  } else {
    Write-Step "Skipping PWA smoke test because scripts\surface-package-smoke.mjs is not present"
    $SkipSmoke = $true
  }
} else {
  Write-Step "Skipping PWA smoke test"
}

Write-Step "PWA artifact"
$artifact = Get-ChildItem -LiteralPath (Join-Path $root "artifacts\pwa-package") -Filter "*-PWA-*.zip" -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (!$artifact) {
  throw "PWA zip artifact was not created."
}

Write-Host "pwa:    $($artifact.FullName)"
if (!$SkipSmoke) {
  Write-Host "report: $(Join-Path $root $reportPath)"
}

Write-Host ""
Write-Host "PWA packaging completed." -ForegroundColor Green

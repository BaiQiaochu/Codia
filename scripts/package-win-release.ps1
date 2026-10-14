param(
  [string]$Version = "",
  [string]$TestFilter = "",
  [string]$ProductNameOverride = "",
  [string]$AppIdOverride = "",
  [string]$IconSourceOverride = "",
  [string]$ProductVariant = "codia",
  [switch]$SkipTests,
  [switch]$SkipSmoke,
  [switch]$NoInstaller,
  [switch]$NoPortable
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

function Invoke-PackagingStep {
  param(
    [string]$Command,
    [string[]]$Arguments = @(),
    [string]$RetryTempPath = "",
    [int]$Attempts = 2
  )

  for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
    try {
      Invoke-Step $Command $Arguments
      return
    } catch {
      if ($attempt -ge $Attempts) {
        throw
      }
      Write-Host ("packaging step failed; retrying ({0}/{1}) after clearing temporary output" -f $attempt, $Attempts) -ForegroundColor Yellow
      if (![string]::IsNullOrWhiteSpace($RetryTempPath)) {
        Remove-KnownPath -Root $root -Path $RetryTempPath
      }
      Start-Sleep -Seconds 2
    }
  }
}

function Write-Utf8NoBomFile {
  param(
    [string]$Path,
    [string]$Value
  )

  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Remove-KnownPath {
  param(
    [string]$Root,
    [string]$Path
  )

  if (!(Test-Path -LiteralPath $Path)) {
    return
  }

  $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
  $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
  $allowed = @(
    (Join-Path $resolvedRoot "dist\win-unpacked"),
    (Join-Path $resolvedRoot "dist-folder"),
    (Join-Path $resolvedRoot "dist-repack")
  )

  if ($allowed -notcontains $resolvedPath) {
    throw "Refusing to remove unexpected path: $resolvedPath"
  }

  for ($i = 0; $i -lt 6; $i += 1) {
    try {
      Remove-Item -LiteralPath $resolvedPath -Recurse -Force
      Write-Host "removed $resolvedPath"
      return
    } catch {
      if ($i -eq 5) {
        throw
      }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Remove-UpdateArtifacts {
  param([string]$DistDir)

  if (!(Test-Path -LiteralPath $DistDir)) {
    return
  }

  Get-ChildItem -LiteralPath $DistDir -Force |
    Where-Object { $_.Name -eq "latest.yml" -or $_.Name.EndsWith(".blockmap") } |
    ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Force
      Write-Host "removed $($_.FullName)"
    }
}

function Get-NormalizedWindowsArtifactVersion {
  param([string]$Version)

  $match = [regex]::Match($Version, '^(\d+)\.(\d+)\.(\d+)(.*)$')
  if (!$match.Success) {
    return $Version
  }

  return ([int]$match.Groups[1].Value).ToString() + "." +
    ([int]$match.Groups[2].Value).ToString() + "." +
    ([int]$match.Groups[3].Value).ToString() +
    $match.Groups[4].Value
}

function Resolve-InstallerArtifactPath {
  param(
    [string]$DistDir,
    [string]$ProductName,
    [string]$PackageVersion,
    [string]$Arch,
    [string]$ExpectedPath
  )

  $normalizedVersion = Get-NormalizedWindowsArtifactVersion -Version $PackageVersion
  if ($normalizedVersion -and $normalizedVersion -ne $PackageVersion) {
    $normalizedPath = Join-Path $DistDir "$ProductName-$normalizedVersion-Windows-$Arch.exe"
    if (Test-Path -LiteralPath $normalizedPath) {
      Write-Host "normalizing installer artifact name: $normalizedPath -> $ExpectedPath"
      Move-Item -LiteralPath $normalizedPath -Destination $ExpectedPath -Force
      return $ExpectedPath
    }
  }

  if (Test-Path -LiteralPath $ExpectedPath) {
    return $ExpectedPath
  }

  return $ExpectedPath
}

function ConvertTo-RootRelativePath {
  param(
    [string]$Root,
    [string]$Path
  )

  $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
  $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
  if (!$resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is not inside root: $resolvedPath"
  }

  return $resolvedPath.Substring($resolvedRoot.Length).TrimStart('\', '/').Replace('\', '/')
}

function Set-PackageVersion {
  param(
    [string]$Root,
    [string]$TargetVersion
  )

  if ([string]::IsNullOrWhiteSpace($TargetVersion)) {
    return
  }

  if ($TargetVersion -match '^\d+\.\d+$') {
    $TargetVersion = "$TargetVersion.0"
  }

  if ($TargetVersion -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') {
    throw "Version must look like 0.6.6 or 0.6.6-beta.1: $TargetVersion"
  }

  $script = @'
const fs = require("fs");
const version = process.env.CODIA_PACKAGE_VERSION;
const rootPackageKey = String();
for (const file of ["package.json", "package-lock.json"]) {
  if (!fs.existsSync(file)) continue;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.version) data.version = version;
  if (data.packages && data.packages[rootPackageKey]) data.packages[rootPackageKey].version = version;
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
'@

  Push-Location $Root
  try {
    $env:CODIA_PACKAGE_VERSION = $TargetVersion
    $scriptPath = Join-Path $env:TEMP ("codia-set-package-version-" + [guid]::NewGuid().ToString("N") + ".cjs")
    Write-Utf8NoBomFile -Path $scriptPath -Value $script
    Invoke-Step "node" @($scriptPath)
  } finally {
    if ($scriptPath -and (Test-Path -LiteralPath $scriptPath)) {
      Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
    }
    Remove-Item Env:\CODIA_PACKAGE_VERSION -ErrorAction SilentlyContinue
    Pop-Location
  }
}

function Increment-PackagePatchVersion {
  param([string]$CurrentVersion)

  $match = [regex]::Match($CurrentVersion, '^(\d+)\.(\d+)\.(\d+)([-.][0-9A-Za-z.-]+)?$')
  if (!$match.Success) {
    throw "Cannot auto-increment package version. Pass -Version explicitly. Current version: $CurrentVersion"
  }

  return $match.Groups[1].Value + "." +
    $match.Groups[2].Value + "." +
    (([int]$match.Groups[3].Value) + 1).ToString()
}

function Resolve-PackageVersionForPackaging {
  param(
    [string]$Root,
    [string]$RequestedVersion
  )

  if (![string]::IsNullOrWhiteSpace($RequestedVersion)) {
    return $RequestedVersion
  }

  $meta = Read-PackageMetadata -Root $Root
  $nextVersion = Increment-PackagePatchVersion -CurrentVersion $meta.version
  Write-Host "auto-incremented package version: $($meta.version) -> $nextVersion"
  return $nextVersion
}

function Read-PackageMetadata {
  param([string]$Root)

  $packagePath = Join-Path $Root "package.json"
  if (!(Test-Path -LiteralPath $packagePath)) {
    throw "Unable to read package.json"
  }

  $pkg = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $productName = $pkg.name
  if ($pkg.build -and $pkg.build.productName) {
    $productName = $pkg.build.productName
  }
  if ([string]::IsNullOrWhiteSpace($productName)) {
    $productName = "app"
  }

  return [pscustomobject]@{
    version = [string]$pkg.version
    productName = [string]$productName
  }
}

function Set-TemporaryPackageBranding {
  param(
    [string]$Root,
    [string]$ProductName,
    [string]$AppId,
    [string]$IconSource,
    [string]$Variant
  )

  if ([string]::IsNullOrWhiteSpace($ProductName) -and [string]::IsNullOrWhiteSpace($AppId) -and [string]::IsNullOrWhiteSpace($IconSource)) {
    return $null
  }

  $packagePath = Join-Path $Root "package.json"
  $original = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8
  $pkg = $original | ConvertFrom-Json
  if (-not $pkg.build) {
    $pkg | Add-Member -MemberType NoteProperty -Name build -Value ([pscustomobject]@{})
  }
  if (![string]::IsNullOrWhiteSpace($ProductName)) {
    $pkg.build.productName = $ProductName
  }
  if (![string]::IsNullOrWhiteSpace($AppId)) {
    $pkg.build.appId = $AppId
  }

  if (![string]::IsNullOrWhiteSpace($IconSource)) {
    $resolvedIconSource = if ([System.IO.Path]::IsPathRooted($IconSource)) { $IconSource } else { Join-Path $Root $IconSource }
    if (!(Test-Path -LiteralPath $resolvedIconSource)) {
      throw "Icon source override not found: $resolvedIconSource"
    }

    $variantName = if ([string]::IsNullOrWhiteSpace($Variant)) { "custom" } else { $Variant }
    $iconDir = Join-Path $Root ("desktop\src\branding\" + $variantName)
    New-Item -ItemType Directory -Path $iconDir -Force | Out-Null
    $iconPng = Join-Path $iconDir "icon.png"
    $iconIco = Join-Path $iconDir "icon.ico"
    Copy-Item -LiteralPath $resolvedIconSource -Destination $iconPng -Force
    Invoke-Step "node" @("scripts/generate-windows-icon.cjs", "--source", $iconPng, "--target", $iconIco) | Out-Host

    $relativeIconPng = ConvertTo-RootRelativePath -Root $Root -Path $iconPng
    $relativeIconIco = ConvertTo-RootRelativePath -Root $Root -Path $iconIco
    if ($pkg.build.win) { $pkg.build.win.icon = $relativeIconIco }
    if ($pkg.build.nsis) {
      $pkg.build.nsis.installerIcon = $relativeIconIco
      $pkg.build.nsis.uninstallerIcon = $relativeIconIco
    }
    if ($pkg.build.linux) { $pkg.build.linux.icon = $relativeIconPng }
    Write-Host "using product icon: $relativeIconPng / $relativeIconIco"
  }
  Write-Utf8NoBomFile -Path $packagePath -Value (($pkg | ConvertTo-Json -Depth 100) + [Environment]::NewLine)
  return $original
}

function Restore-PackageJson {
  param(
    [string]$Root,
    [string]$Original
  )

  if ([string]::IsNullOrEmpty($Original)) {
    return
  }

  Write-Utf8NoBomFile -Path (Join-Path $Root "package.json") -Value $Original
}

function Test-PortableServer {
  param(
    [string]$Root,
    [string]$PortableDir,
    [string]$ExpectedVersion
  )

  $resources = Join-Path $PortableDir "resources"
  $serverRoot = Join-Path $resources "server"
  $exe = Join-Path $serverRoot "codia-server.exe"
  $bootstrap = Join-Path $serverRoot "bootstrap.js"
  $smokeHome = Join-Path $env:TEMP ("codia-package-smoke-" + [guid]::NewGuid().ToString("N"))
  $stdoutLog = Join-Path $smokeHome "stdout.log"
  $stderrLog = Join-Path $smokeHome "stderr.log"
  $process = $null
  $stdoutTask = $null
  $stderrTask = $null
  $smokeSucceeded = $false

  New-Item -ItemType Directory -Path $smokeHome | Out-Null

  try {
    if (!(Test-Path -LiteralPath $exe)) {
      throw "Missing bundled server executable: $exe"
    }
    if (!(Test-Path -LiteralPath $bootstrap)) {
      throw "Missing bundled server bootstrap: $bootstrap"
    }

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $exe
    $psi.Arguments = '"' + $bootstrap + '"'
    $psi.WorkingDirectory = $serverRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $psi.EnvironmentVariables["CODIA_HOME"] = $smokeHome
    $psi.EnvironmentVariables["CODIA_ROOT"] = $serverRoot
    $psi.EnvironmentVariables["CODIA_SERVER_ENTRY"] = Join-Path $serverRoot "bundle\index.js"
    $psi.EnvironmentVariables["CODIA_PORT"] = "0"

    $pathEntries = @(
      (Join-Path $resources "git\mingw64\bin"),
      (Join-Path $resources "git\cmd"),
      (Join-Path $serverRoot "ffmpeg")
    ) | Where-Object { Test-Path -LiteralPath $_ }

    if ($pathEntries.Count -gt 0) {
      $currentPath = [Environment]::GetEnvironmentVariable("PATH", "Process")
      $psi.EnvironmentVariables["PATH"] = (($pathEntries -join ";") + ";" + $currentPath)
    }

    $process = [System.Diagnostics.Process]::Start($psi)
    if ($null -eq $process) {
      throw "Failed to start bundled server"
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    $infoPath = Join-Path $smokeHome "server-info.json"
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
      if ($process.HasExited) {
        $stderr = ""
        try { if ($stderrTask) { $stderr = $stderrTask.GetAwaiter().GetResult() } } catch {}
        if ($stderr) { Write-Utf8NoBomFile -Path $stderrLog -Value $stderr }
        throw "Bundled server exited early with code $($process.ExitCode): $stderr"
      }
      if (Test-Path -LiteralPath $infoPath) {
        break
      }
      Start-Sleep -Milliseconds 500
    }

    if (!(Test-Path -LiteralPath $infoPath)) {
      throw "Bundled server did not create server-info.json within 90 seconds"
    }

    $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
    if ($ExpectedVersion -and $info.version -ne $ExpectedVersion) {
      throw "Bundled server version mismatch. Expected $ExpectedVersion, got $($info.version)"
    }

    $headers = @{ Authorization = "Bearer $($info.token)" }
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($info.port)/api/health" -Headers $headers -TimeoutSec 10
    if ($health.status -ne "ok") {
      throw "Health check did not return ok"
    }

    Write-Host "running packaged PWA/skills/theme smoke"
    Test-PackagedRuntimeSmoke -Root $Root -BaseUrl "http://127.0.0.1:$($info.port)" -Token $info.token

    try {
      Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($info.port)/api/shutdown" -Headers $headers -TimeoutSec 5 | Out-Null
    } catch {
      Write-Warning "Shutdown endpoint failed; killing smoke-test server process."
    }

    if (!$process.WaitForExit(10000)) {
      $process.Kill()
      $process.WaitForExit()
    }

    Write-Host "portable smoke test passed: port=$($info.port), version=$($info.version)"
    $smokeSucceeded = $true
  } finally {
    if ($process -and !$process.HasExited) {
      try {
        $process.Kill()
        $process.WaitForExit()
      } catch {
      }
    }

    if ($process) {
      try {
        if ($stdoutTask) {
          $stdout = $stdoutTask.GetAwaiter().GetResult()
          if ($stdout) { Write-Utf8NoBomFile -Path $stdoutLog -Value $stdout }
        }
        if ($stderrTask) {
          $stderr = $stderrTask.GetAwaiter().GetResult()
          if ($stderr) { Write-Utf8NoBomFile -Path $stderrLog -Value $stderr }
        }
      } catch {
      }
    }

    if ($smokeSucceeded -and (Test-Path -LiteralPath $smokeHome)) {
      Remove-Item -LiteralPath $smokeHome -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Test-PackagedRuntimeSmoke {
  param(
    [string]$Root,
    [string]$BaseUrl,
    [string]$Token
  )

  $script = Join-Path $Root "scripts\packaged-runtime-smoke.mjs"
  if (!(Test-Path -LiteralPath $script)) {
    throw "Missing packaged runtime smoke script: $script"
  }

  $previousBaseUrl = $env:CODIA_PACKAGE_SMOKE_BASE_URL
  $previousToken = $env:CODIA_PACKAGE_SMOKE_TOKEN
  try {
    $env:CODIA_PACKAGE_SMOKE_BASE_URL = $BaseUrl
    $env:CODIA_PACKAGE_SMOKE_TOKEN = $Token
    Invoke-Step "node" @($script)
  } finally {
    if ([string]::IsNullOrEmpty($previousBaseUrl)) {
      Remove-Item Env:\CODIA_PACKAGE_SMOKE_BASE_URL -ErrorAction SilentlyContinue
    } else {
      $env:CODIA_PACKAGE_SMOKE_BASE_URL = $previousBaseUrl
    }
    if ([string]::IsNullOrEmpty($previousToken)) {
      Remove-Item Env:\CODIA_PACKAGE_SMOKE_TOKEN -ErrorAction SilentlyContinue
    } else {
      $env:CODIA_PACKAGE_SMOKE_TOKEN = $previousToken
    }
  }
}

function Test-PrePackageHealth {
  param([string]$Root)

  $script = Join-Path $Root "scripts\local-health-check.mjs"
  if (!(Test-Path -LiteralPath $script)) {
    throw "Missing local health check script: $script"
  }

  Invoke-Step "node" @($script, "--skip-build", "--report=artifacts/local-health-check.json")
}

function Test-SourceTreeConsistency {
  param([string]$Root)

  if ($env:CODIA_ALLOW_DIRTY_SOURCE_TREE -eq "1") {
    Write-Warning "Skipping source tree consistency audit because CODIA_ALLOW_DIRTY_SOURCE_TREE=1."
    return
  }

  $script = Join-Path $Root "scripts\source-tree-audit.mjs"
  if (!(Test-Path -LiteralPath $script)) {
    throw "Missing source tree audit script: $script"
  }

  Invoke-Step "node" @($script, "--strict", "--report=artifacts/source-tree-audit.json", "--markdown=artifacts/source-tree-audit.md")
}

function Read-RendererDragCss {
  param(
    [string]$Root,
    [string]$PortableDir,
    [switch]$SourceOnly
  )

  if ($SourceOnly) {
    $cssPath = Join-Path $Root "desktop\dist-renderer\styles.css"
    if (!(Test-Path -LiteralPath $cssPath)) {
      throw "Missing renderer stylesheet: $cssPath"
    }
    return Get-Content -LiteralPath $cssPath -Raw
  }

  if ([string]::IsNullOrWhiteSpace($PortableDir)) {
    throw "PortableDir is required for packaged renderer drag-region checks."
  }

  $asarPath = Join-Path $PortableDir "resources\app.asar"
  if (!(Test-Path -LiteralPath $asarPath)) {
    throw "Missing packaged app archive: $asarPath"
  }

  $script = @'
const path = require("path");
const archive = process.argv[2];
const root = process.argv[3];
const asar = require(path.join(root, "node_modules", "@electron", "asar"));
const cssPath = "desktop\\dist-renderer\\styles.css";
process.stdout.write(asar.extractFile(archive, cssPath).toString("utf8"));
'@

  $scriptPath = Join-Path $env:TEMP ("codia-read-packaged-renderer-css-" + [guid]::NewGuid().ToString("N") + ".cjs")
  try {
    Write-Utf8NoBomFile -Path $scriptPath -Value $script
    $output = & node $scriptPath $asarPath $Root 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Unable to read packaged renderer stylesheet from $asarPath`: $($output -join "`n")"
    }
    return ($output -join "`n")
  } finally {
    if ($scriptPath -and (Test-Path -LiteralPath $scriptPath)) {
      Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-CssRuleBody {
  param(
    [string]$Css,
    [string]$SelectorPattern,
    [string]$Name
  )

  $match = [regex]::Match($Css, "$SelectorPattern\s*\{(?<body>[\s\S]*?)\}", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (!$match.Success) {
    throw "Renderer drag-region check failed: missing CSS rule for $Name"
  }
  return $match.Groups["body"].Value
}

function Test-PackagedRendererDragRegion {
  param(
    [string]$Root,
    [string]$PortableDir,
    [switch]$SourceOnly
  )

  $css = Read-RendererDragCss -Root $Root -PortableDir $PortableDir -SourceOnly:$SourceOnly
  $titlebar = Get-CssRuleBody -Css $css -SelectorPattern "\.titlebar" -Name ".titlebar"
  $groups = Get-CssRuleBody -Css $css -SelectorPattern "\.tb-left-group,\s*\.tb-right-group" -Name ".tb-left-group/.tb-right-group"
  $toggle = Get-CssRuleBody -Css $css -SelectorPattern "(?:^|\n)\.tb-toggle" -Name ".tb-toggle"
  $obsidianIdeMenu = $null
  if ($css -match "\.obsidian-ide-menu\s*\{") {
    $obsidianIdeMenu = Get-CssRuleBody -Css $css -SelectorPattern "\.obsidian-ide-menu" -Name ".obsidian-ide-menu"
  }
  $windowControls = Get-CssRuleBody -Css $css -SelectorPattern "\.window-controls" -Name ".window-controls"

  if ($titlebar -notmatch "-webkit-app-region:\s*drag") {
    throw "Renderer drag-region check failed: .titlebar must be draggable."
  }
  if ($titlebar -notmatch "pointer-events:\s*auto") {
    throw "Renderer drag-region check failed: .titlebar must receive pointer events."
  }
  if ($titlebar -match "pointer-events:\s*none") {
    throw "Renderer drag-region check failed: .titlebar still disables pointer events."
  }
  if ($groups -notmatch "-webkit-app-region:\s*drag") {
    throw "Renderer drag-region check failed: titlebar groups must preserve a draggable hit area."
  }
  if ($toggle -notmatch "-webkit-app-region:\s*no-drag") {
    throw "Renderer drag-region check failed: titlebar toggle buttons must remain clickable."
  }
  if ($obsidianIdeMenu -and $obsidianIdeMenu -notmatch "-webkit-app-region:\s*no-drag") {
    throw "Renderer drag-region check failed: Obsidian IDE menu must remain clickable."
  }
  if ($windowControls -notmatch "-webkit-app-region:\s*no-drag") {
    throw "Renderer drag-region check failed: window controls must remain clickable."
  }

  $target = if ($SourceOnly) { "renderer dist" } else { $PortableDir }
  Write-Host "renderer drag-region check passed: $target"
}

function Test-PackagedDesktopE2E {
  param(
    [string]$Root,
    [string]$PortableDir
  )

  $script = Join-Path $Root "scripts\desktop-e2e-packaged-smoke.mjs"
  if (!(Test-Path -LiteralPath $script)) {
    Write-Step "Skipping packaged desktop E2E because scripts\desktop-e2e-packaged-smoke.mjs is not present"
    return
  }

  if (!(Test-Path -LiteralPath $PortableDir)) {
    throw "PortableDir is required for packaged desktop E2E: $PortableDir"
  }

  $appExe = Get-ChildItem -LiteralPath $PortableDir -Filter "*.exe" -File |
    Where-Object { $_.Name -notmatch "server" } |
    Select-Object -First 1
  if (!$appExe) {
    throw "Unable to locate packaged desktop executable in $PortableDir"
  }

  $previousApp = $env:CODIA_E2E_DESKTOP_APP
  try {
    $env:CODIA_E2E_DESKTOP_APP = $appExe.FullName
    Invoke-Step "node" @($script)
  } finally {
    if ([string]::IsNullOrEmpty($previousApp)) {
      Remove-Item Env:\CODIA_E2E_DESKTOP_APP -ErrorAction SilentlyContinue
    } else {
      $env:CODIA_E2E_DESKTOP_APP = $previousApp
    }
  }
}

if ($NoInstaller -and $NoPortable) {
  throw "NoInstaller and NoPortable cannot both be set."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $scriptDir "..")).Path
Set-Location $root
Test-SourceTreeConsistency -Root $root
$originalPackageJson = $null

try {
Write-Step "Preparing Windows release packaging"
$targetPackageVersion = Resolve-PackageVersionForPackaging -Root $root -RequestedVersion $Version
Set-PackageVersion -Root $root -TargetVersion $targetPackageVersion
$meta = Read-PackageMetadata -Root $root
$productName = if ([string]::IsNullOrWhiteSpace($ProductNameOverride)) { [string]$meta.productName } else { [string]$ProductNameOverride }
$packageVersion = [string]$meta.version
$arch = "x64"
$distDir = Join-Path $root "dist"
$installerPath = Join-Path $distDir "$productName-$packageVersion-Windows-$arch.exe"
$portableDir = Join-Path $distDir "$productName-$packageVersion-Windows-$arch-Portable-Folder"
$lastPortableMarker = Join-Path $distDir ".last-portable-folder"

$env:CODIA_PRODUCT_VARIANT = if ([string]::IsNullOrWhiteSpace($ProductVariant)) { "codia" } else { $ProductVariant }

Write-Host "product: $productName"
Write-Host "version: $packageVersion"
Write-Host "variant: $env:CODIA_PRODUCT_VARIANT"
Write-Host "root:    $root"

Write-Step "Cleaning temporary packaging outputs"
Remove-KnownPath -Root $root -Path (Join-Path $root "dist\win-unpacked")
Remove-KnownPath -Root $root -Path (Join-Path $root "dist-folder")
Remove-KnownPath -Root $root -Path (Join-Path $root "dist-repack")
Remove-UpdateArtifacts -DistDir $distDir

if (!$SkipTests) {
  Write-Step "Running tests"
  $vitestArgs = @("vitest", "run", "--testTimeout", "30000", "--hookTimeout", "30000")
  if ([string]::IsNullOrWhiteSpace($TestFilter)) {
    Invoke-Step "npx" $vitestArgs
  } else {
    Invoke-Step "npx" ($vitestArgs + @($TestFilter))
  }
  Write-Step "Running pre-package health check"
  Test-PrePackageHealth -Root $root
} else {
  Write-Step "Skipping tests"
}

$originalPackageJson = Set-TemporaryPackageBranding -Root $root -ProductName $ProductNameOverride -AppId $AppIdOverride -IconSource $IconSourceOverride -Variant $ProductVariant

Write-Step "Building renderer, desktop bundles, and server bundle"
Invoke-Step "node" @("scripts/build-computer-use-helper.mjs")
Invoke-Step "node" @("scripts/build-windows-sandbox-helper.mjs", $arch)
Invoke-Step "node" @("scripts/generate-professional-icon.cjs")
Invoke-Step "npx" @("vite", "build", "--config", "vite.config.main.js")
Invoke-Step "npx" @("vite", "build", "--config", "vite.config.preload.js")
Invoke-Step "npx" @("vite", "build", "--config", "vite.config.ts")
Invoke-Step "npx" @("vite", "build", "--config", "vite.config.theme.js")
Invoke-Step "node" @("scripts/build-server.mjs", "win32", $arch)
Invoke-Step "node" @("scripts/prepare-win-dist.cjs")

Write-Step "Checking renderer titlebar drag region"
Test-PackagedRendererDragRegion -Root $root -SourceOnly

Write-Step "Patching electron-builder Windows integrity retry"
Invoke-Step "node" @("scripts/patch-electron-builder-win-asar-integrity.cjs")

if (!$NoInstaller) {
  Write-Step "Building NSIS installer"
  Invoke-PackagingStep "npx" @("electron-builder", "--win", "nsis", "--x64", "--publish", "never", "--config.directories.output=dist-repack") (Join-Path $root "dist-repack") 3

  $nsisUnpackedDir = Join-Path $root "dist-repack\win-unpacked"
  if (Test-Path -LiteralPath $nsisUnpackedDir) {
    Write-Step "Checking installer renderer titlebar drag region"
    Test-PackagedRendererDragRegion -Root $root -PortableDir $nsisUnpackedDir
  }

  Invoke-Step "node" @("scripts/finalize-win-artifacts.cjs", "dist-repack", "nsis")
}

if (!$NoPortable) {
  Write-Step "Building portable folder"
  Remove-Item -LiteralPath $lastPortableMarker -Force -ErrorAction SilentlyContinue
  Invoke-PackagingStep "npx" @("electron-builder", "--win", "dir", "--x64", "--publish", "never", "--config.directories.output=dist-folder") (Join-Path $root "dist-folder") 3
  Invoke-Step "node" @("scripts/finalize-folder-portable.cjs")

  if (Test-Path -LiteralPath $lastPortableMarker) {
    $markedPortableDir = (Get-Content -LiteralPath $lastPortableMarker -Raw -Encoding UTF8).Trim()
    if (![string]::IsNullOrWhiteSpace($markedPortableDir)) {
      $portableDir = $markedPortableDir
    }
  }

  Write-Step "Checking portable renderer titlebar drag region"
  Test-PackagedRendererDragRegion -Root $root -PortableDir $portableDir

  if (!$SkipSmoke) {
    Write-Step "Smoke testing portable server"
    Test-PortableServer -Root $root -PortableDir $portableDir -ExpectedVersion $packageVersion
    Write-Step "Smoke testing packaged desktop app"
    Test-PackagedDesktopE2E -Root $root -PortableDir $portableDir
  } else {
    Write-Step "Skipping portable smoke test"
  }
}

Write-Step "Final cleanup"
Remove-KnownPath -Root $root -Path (Join-Path $root "dist\win-unpacked")
Remove-KnownPath -Root $root -Path (Join-Path $root "dist-folder")
Remove-KnownPath -Root $root -Path (Join-Path $root "dist-repack")
Remove-UpdateArtifacts -DistDir $distDir

Write-Step "Release artifacts"
if (!$NoInstaller) {
  $installerPath = Resolve-InstallerArtifactPath -DistDir $distDir -ProductName $productName -PackageVersion $packageVersion -Arch $arch -ExpectedPath $installerPath
  if (!(Test-Path -LiteralPath $installerPath)) {
    throw "Installer was not created: $installerPath"
  }
  Write-Host "installer: $installerPath"
}
if (!$NoPortable) {
  if (!(Test-Path -LiteralPath $portableDir)) {
    throw "Portable folder was not created: $portableDir"
  }
  Write-Host "portable:  $portableDir"
}

Write-Host ""
Write-Host "Packaging completed." -ForegroundColor Green
} finally {
  Restore-PackageJson -Root $root -Original $originalPackageJson
  Remove-Item Env:\CODIA_PRODUCT_VARIANT -ErrorAction SilentlyContinue
}

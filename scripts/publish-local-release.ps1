param(
  [string]$Version = "",
  [string]$Repository = "",
  [string]$Token = "",
  [switch]$SkipBuild,
  [switch]$SkipTests,
  [switch]$SkipSmoke,
  [switch]$Publish
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Invoke-CheckedCommand {
  param([string]$FilePath, [string[]]$Arguments)
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath failed with exit code $LASTEXITCODE"
  }
}

function Get-GitHubToken {
  param([string]$ExplicitToken)
  if (![string]::IsNullOrWhiteSpace($ExplicitToken)) { return $ExplicitToken }
  if (![string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) { return $env:GITHUB_TOKEN }

  $credentialInput = "protocol=https`nhost=github.com`n`n"
  $credentialLines = @($credentialInput | git credential fill)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read the GitHub credential from Git Credential Manager."
  }
  foreach ($line in $credentialLines) {
    if ($line.StartsWith("password=")) { return $line.Substring("password=".Length) }
  }
  throw "No GitHub token is available. Sign in with Git Credential Manager or set GITHUB_TOKEN."
}

function Get-RepositoryName {
  param([string]$ExplicitRepository)
  if (![string]::IsNullOrWhiteSpace($ExplicitRepository)) { return $ExplicitRepository }
  if (![string]::IsNullOrWhiteSpace($env:GITHUB_REPOSITORY)) { return $env:GITHUB_REPOSITORY }

  $remote = (& git remote get-url origin).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Unable to read the origin remote." }
  $match = [regex]::Match($remote, 'github\.com[/:](?<repo>[^/]+/[^/]+?)(?:\.git)?$')
  if (!$match.Success) { throw "The origin remote is not a GitHub repository: $remote" }
  return $match.Groups["repo"].Value
}

function Invoke-GitHubJson {
  param(
    [string]$Method,
    [string]$Uri,
    [hashtable]$Headers,
    [object]$Body = $null
  )
  $parameters = @{ Method = $Method; Uri = $Uri; Headers = $Headers }
  if ($null -ne $Body) {
    $parameters.ContentType = "application/json"
    $parameters.Body = $Body | ConvertTo-Json -Depth 8 -Compress
  }
  return Invoke-RestMethod @parameters
}

function Get-OrCreateDraftRelease {
  param(
    [string]$Repository,
    [string]$Tag,
    [string]$Commit,
    [string]$Title,
    [string]$Notes,
    [hashtable]$Headers
  )
  $apiRoot = "https://api.github.com/repos/$Repository"
  $release = $null
  try {
    $release = Invoke-GitHubJson -Method Get -Uri "$apiRoot/releases/tags/$Tag" -Headers $Headers
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
  }
  if ($release -and !$release.draft) {
    throw "Release $Tag is already published. Increase the package version before uploading again."
  }

  $body = @{
    tag_name = $Tag
    target_commitish = $Commit
    name = $Title
    body = $Notes
    draft = $true
    prerelease = $false
  }
  if ($release) {
    return Invoke-GitHubJson -Method Patch -Uri "$apiRoot/releases/$($release.id)" -Headers $Headers -Body $body
  }
  return Invoke-GitHubJson -Method Post -Uri "$apiRoot/releases" -Headers $Headers -Body $body
}

function Remove-DuplicateReleaseAsset {
  param([object]$Release, [string]$Name, [hashtable]$Headers)
  $asset = $Release.assets | Where-Object { $_.name -eq $Name } | Select-Object -First 1
  if ($asset) {
    Invoke-GitHubJson -Method Delete -Uri $asset.url -Headers $Headers | Out-Null
  }
}

function Upload-ReleaseAsset {
  param([object]$Release, [string]$Path, [hashtable]$Headers)
  $item = Get-Item -LiteralPath $Path
  Remove-DuplicateReleaseAsset -Release $Release -Name $item.Name -Headers $Headers
  $uploadRoot = [string]$Release.upload_url
  $uploadRoot = $uploadRoot.Substring(0, $uploadRoot.IndexOf("{"))
  $encodedName = [uri]::EscapeDataString($item.Name)
  Write-Host "uploading: $($item.Name)"
  Invoke-RestMethod -Method Post -Uri "${uploadRoot}?name=$encodedName" -Headers $Headers -ContentType "application/octet-stream" -InFile $item.FullName | Out-Null
}

if ($env:OS -ne "Windows_NT") { throw "Local release packaging currently requires Windows." }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $scriptDir "..")).Path
Set-Location $root

$package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = [string]$package.version }
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') { throw "Invalid release version: $Version" }
if ([string]$package.version -ne $Version) {
  throw "package.json is version $($package.version), but the requested release is $Version. Commit the version change first."
}

$status = (& git status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the Git working tree." }
if ($status) { throw "The working tree must be clean so the source archive and binaries describe the same commit." }

$commit = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw "Unable to resolve HEAD." }
$repositoryName = Get-RepositoryName -ExplicitRepository $Repository
$distDir = Join-Path $root "dist"
$productName = if ($package.build.productName) { [string]$package.build.productName } else { "Codia" }
$installer = Join-Path $distDir "$productName-$Version-Windows-x64.exe"
$portableDir = Join-Path $distDir "$productName-$Version-Windows-x64-Portable-Folder"
$portableZip = Join-Path $distDir "$productName-$Version-Windows-x64-Portable.zip"
$sourceZip = Join-Path $distDir "$productName-$Version-Source.zip"
$checksums = Join-Path $distDir "SHA256SUMS.txt"
$releaseNotes = Join-Path $distDir "RELEASE-NOTES.md"

if (!$SkipBuild) {
  $packArguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $scriptDir "package-win-release.ps1"), "-Version", $Version)
  if ($SkipTests) { $packArguments += "-SkipTests" }
  if ($SkipSmoke) { $packArguments += "-SkipSmoke" }
  Invoke-CheckedCommand -FilePath "powershell" -Arguments $packArguments
}

if (!(Test-Path -LiteralPath $installer)) { throw "Installer not found: $installer" }
if (!(Test-Path -LiteralPath $portableDir -PathType Container)) { throw "Portable folder not found: $portableDir" }

Remove-Item -LiteralPath $portableZip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $portableDir "*") -DestinationPath $portableZip -CompressionLevel Optimal
Remove-Item -LiteralPath $sourceZip -Force -ErrorAction SilentlyContinue
Invoke-CheckedCommand -FilePath "git" -Arguments @("archive", "--format=zip", "--prefix=$productName-$Version/", "--output=$sourceZip", "HEAD")

$notesText = @"
# $productName v$Version

This draft was compiled on a local Windows x64 machine from commit ``$commit``. It uses no GitHub-hosted paid runner.

Included files:

- Windows x64 installer
- Windows x64 portable archive
- Source archive for the exact packaged commit
- SHA-256 checksums

Linux and macOS packages are not included because this release was built locally on Windows.
"@
[System.IO.File]::WriteAllText($releaseNotes, $notesText, [System.Text.UTF8Encoding]::new($false))

$payloadFiles = @($installer, $portableZip, $sourceZip, $releaseNotes)
$checksumLines = foreach ($file in $payloadFiles) {
  $item = Get-Item -LiteralPath $file
  $hash = Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256
  "$($hash.Hash.ToLowerInvariant())  $($item.Name)"
}
[System.IO.File]::WriteAllLines($checksums, $checksumLines, [System.Text.UTF8Encoding]::new($false))
$payloadFiles += $checksums

$githubToken = Get-GitHubToken -ExplicitToken $Token
$headers = @{
  Authorization = "Bearer $githubToken"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent" = "Codia-local-release"
}
$tag = "v$Version"
$release = Get-OrCreateDraftRelease -Repository $repositoryName -Tag $tag -Commit $commit -Title "$productName $tag" -Notes $notesText -Headers $headers
foreach ($file in $payloadFiles) { Upload-ReleaseAsset -Release $release -Path $file -Headers $headers }

if ($Publish) {
  $release = Invoke-GitHubJson -Method Patch -Uri "https://api.github.com/repos/$repositoryName/releases/$($release.id)" -Headers $headers -Body @{ draft = $false; make_latest = "true" }
}

$githubToken = $null
$headers.Clear()
Write-Host "release: $($release.html_url)"
Write-Host "state:   $(if ($release.draft) { 'draft' } else { 'published' })"
Write-Host "commit:  $commit"

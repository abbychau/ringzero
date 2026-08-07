#requires -version 5.1
<#
    RingZero installer (Windows) — installs the self-extracting single-file
    build and puts `ringzero` on your PATH.

    Usage:
        irm https://raw.githubusercontent.com/abbychau/ringzero/main/install.ps1 | iex

    What it does:
      - Fetches the latest release info from the GitHub API and downloads
        ringzero-win-x64.exe from GitHub Releases.
      - Installs it to %LOCALAPPDATA%\Programs\RingZero\ringzero.exe.
      - Adds that directory to your USER PATH (no admin needed) and updates
        the current shell, so `ringzero` works immediately.
      - Runs it once so the embedded Node runtime unpacks
        (%LOCALAPPDATA%\RingZero\<version>\) during install.

    The script is intentionally small and reviewable:
    https://github.com/abbychau/ringzero/blob/main/install.ps1
#>

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

if ($env:OS -ne 'Windows_NT') {
    throw 'This installer only supports Windows.'
}
if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'ringzero-win-x64.exe requires 64-bit Windows.'
}

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\RingZero'
$exePath    = Join-Path $installDir 'ringzero.exe'
$userAgent  = 'ringzero-installer'

Write-Host 'Fetching the latest RingZero release...' -ForegroundColor Cyan
$release = Invoke-RestMethod -Headers @{ 'User-Agent' = $userAgent } `
    -Uri 'https://api.github.com/repos/abbychau/ringzero/releases/latest'
$asset = $release.assets | Where-Object { $_.name -eq 'ringzero-win-x64.exe' } |
    Select-Object -First 1
if (-not $asset) {
    throw 'ringzero-win-x64.exe was not found in the latest release.'
}
$url     = $asset.browser_download_url
$version = $release.tag_name -replace '^v', ''
$sizeMb  = [math]::Round($asset.size / 1MB, 1)

Write-Host "Downloading RingZero v$version ($sizeMb MB)..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$tmp = Join-Path $installDir 'ringzero.exe.tmp'
Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = $userAgent } `
    -Uri $url -OutFile $tmp
Move-Item -Force -Path $tmp -Destination $exePath

Write-Host 'Adding to PATH (user)...' -ForegroundColor Cyan
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = $userPath -split ';' |
    Where-Object { $_.TrimEnd('\') -ieq $installDir.TrimEnd('\') }
if (-not $onPath) {
    [Environment]::SetEnvironmentVariable(
        'Path',
        $userPath.TrimEnd(';') + ';' + $installDir,
        'User')
}
# Make it usable in the current shell too (new shells pick it up from PATH).
$env:Path = $installDir + ';' + $env:Path

Write-Host 'Running first-time setup (unpacks the embedded runtime)...' -ForegroundColor Cyan
& $exePath --version

Write-Host ''
Write-Host "RingZero v$version installed. Type 'ringzero' to start." -ForegroundColor Green
Write-Host '  docs:      https://github.com/abbychau/ringzero'
Write-Host ('  uninstall: Remove-Item -Recurse -Force "{0}" ; remove the PATH entry:' -f $installDir)
Write-Host "             [Environment]::SetEnvironmentVariable('Path', ([Environment]::GetEnvironmentVariable('Path','User') -replace ';$([regex]::Escape($installDir))',''), 'User')"

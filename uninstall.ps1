#requires -version 5.1
<#
    RingZero uninstaller (Windows) — removes what install.ps1 installed:
      - %LOCALAPPDATA%\Programs\RingZero (the ringzero.exe binary)
      - %LOCALAPPDATA%\RingZero (extracted payload from older self-extracting
        builds)
      - the user PATH entry

    Your data (~/.ringzero — sessions, config, skills) is kept. Remove it
    separately with: Remove-Item -Recurse -Force "$env:USERPROFILE\.ringzero"

    Usage:
      irm https://ringzero.abby.md/uninstall.ps1 | iex
#>

$ErrorActionPreference = 'Stop'

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\RingZero'
$dataDir    = Join-Path $env:LOCALAPPDATA 'RingZero'

if (Test-Path $installDir) {
    Write-Host "Removing $installDir ..."
    Remove-Item -Recurse -Force $installDir
}
if (Test-Path $dataDir) {
    Write-Host "Removing $dataDir ..."
    Remove-Item -Recurse -Force $dataDir
}

# Remove the user PATH entry the installer added.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
    $kept = @($userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $installDir.TrimEnd('\') })
    $newPath = $kept -join ';'
    if ($newPath -ne $userPath) {
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Host "Removed $installDir from your user PATH."
    }
}

Write-Host ''
Write-Host 'RingZero uninstalled.'
Write-Host 'Your data (~/.ringzero) was kept. Remove it with:'
Write-Host "  Remove-Item -Recurse -Force `"$env:USERPROFILE\.ringzero`""

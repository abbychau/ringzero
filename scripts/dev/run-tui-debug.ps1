$env:RINGZERO_TUI_DEBUG = "$env:TEMP\rz_tui_dbg.txt"
Remove-Item $env:RINGZERO_TUI_DEBUG -ErrorAction SilentlyContinue
$p = Start-Process node -ArgumentList 'dist/src/cli/index.js' -PassThru -NoNewWindow
Start-Sleep -Seconds 3
if ($p.HasExited) { Write-Host "EXITED code=$($p.ExitCode)" } else { Write-Host "RUNNING (killing)"; $p.Kill() }
Write-Host "--- DEBUG FILE ---"
Get-Content $env:RINGZERO_TUI_DEBUG -ErrorAction SilentlyContinue

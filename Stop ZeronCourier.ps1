$ErrorActionPreference = 'Stop'
$taskRuntime = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'work\zeroncourier-runtime'))
$taskPidFile = Join-Path $taskRuntime 'bridge.pid'
if (-not (Test-Path -LiteralPath $taskPidFile)) { Write-Output 'No zeroncourier process record was found.'; exit 0 }
$taskProcessId = [int](Get-Content -LiteralPath $taskPidFile -Raw).Trim()
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $taskProcessId"
$taskScript = Join-Path $PSScriptRoot 'bridge.mjs'
if (-not $taskProcess) { Write-Output 'The zeroncourier is already stopped.'; exit 0 }
if ($taskProcess.Name -ne 'node.exe' -or -not $taskProcess.CommandLine.Contains($taskScript)) { throw 'Process identity differs from the zeroncourier. Nothing was stopped.' }
Get-CimInstance Win32_Process -Filter "ParentProcessId = $taskProcessId" | Where-Object { $_.Name -eq 'zeron.exe' -and $_.CommandLine -match '\bmcp\b' } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /F | Out-Null }
& taskkill.exe /PID $taskProcessId /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Windows could not stop the verified zeroncourier process.' }
Write-Output 'ZeronCourier stopped. Your Zeron desktop app was left running.'

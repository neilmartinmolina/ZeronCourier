$ErrorActionPreference = 'Stop'
$taskRuntime = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'work\zeroncourier-runtime'))
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
$taskHealth = $null
try { $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2 } catch {}
if ($taskHealth.service -eq 'zeroncourier') { Write-Output 'ZeronCourier is already running: http://127.0.0.1:8787'; exit 0 }
$taskNode = Get-Command node -ErrorAction SilentlyContinue
if (-not $taskNode) { throw 'Node.js 20 or newer is required. It was available when the zeroncourier was created.' }
$taskScript = Join-Path $PSScriptRoot 'bridge.mjs'
$taskProcess = Start-Process -FilePath $taskNode.Source -ArgumentList @('"' + $taskScript + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRuntime 'bridge.log') -RedirectStandardError (Join-Path $taskRuntime 'bridge-errors.log')
Set-Content -LiteralPath (Join-Path $taskRuntime 'bridge.pid') -Value $taskProcess.Id
for ($taskAttempt = 0; $taskAttempt -lt 10; $taskAttempt++) {
  Start-Sleep -Milliseconds 300
  try { $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2 } catch {}
  if ($taskHealth.service -eq 'zeroncourier') { Write-Output 'ZeronCourier is running: http://127.0.0.1:8787'; exit 0 }
}
throw ('ZeronCourier did not start. Check ' + (Join-Path $taskRuntime 'bridge-errors.log'))

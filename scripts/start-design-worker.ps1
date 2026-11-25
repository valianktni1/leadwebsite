$ErrorActionPreference = 'Stop'
$connector = Join-Path $env:LOCALAPPDATA 'IvoryDigital\DesignConnector'
$token = Get-Content -Raw (Join-Path $connector 'pairing.dpapi') | ConvertTo-SecureString
$env:IVORY_WORKER_TOKEN = [Net.NetworkCredential]::new('', $token).Password
$desktop = Get-AppxPackage OpenAI.Codex | Select-Object -First 1
$runtime = Get-AppxPackage 'OpenAI.CodexPrimaryRuntime*' | Sort-Object Version -Descending | Select-Object -First 1
$env:IVORY_CODEX = Join-Path $desktop.InstallLocation 'app\resources\codex.exe'
$python = Join-Path $runtime.InstallLocation 'dependencies\python\python.exe'
& $python (Join-Path $connector 'design-worker.py')
exit $LASTEXITCODE

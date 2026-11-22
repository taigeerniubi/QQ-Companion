param([switch]$Background)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EntryPath = Join-Path $ProjectRoot 'dist\main.js'
$ConfigPath = Join-Path $ProjectRoot 'config.local.json'
if (-not (Test-Path -LiteralPath $EntryPath)) { throw '请先运行 npm run build。' }
if (-not (Test-Path -LiteralPath $ConfigPath)) { Copy-Item -LiteralPath (Join-Path $ProjectRoot 'config.example.json') -Destination $ConfigPath }
$EnvPath = Join-Path $ProjectRoot '.env.local'
$NodePath = (Get-Command node -ErrorAction Stop).Source
if (-not $Background) {
    & $NodePath "--env-file-if-exists=$EnvPath" $EntryPath '--config' $ConfigPath
    exit $LASTEXITCODE
}
$LogDir = Join-Path $ProjectRoot 'work\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LaunchArgs = @("--env-file-if-exists=`"$EnvPath`"", "`"$EntryPath`"", '--config', "`"$ConfigPath`"")
$ServiceProcess = Start-Process -FilePath $NodePath -ArgumentList $LaunchArgs -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $LogDir 'service.out.log') -RedirectStandardError (Join-Path $LogDir 'service.err.log')
$Settings = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$ServicePort = if ($Settings.port) { $Settings.port } else { 3210 }
for ($Attempt = 0; $Attempt -lt 20; $Attempt++) {
    Start-Sleep -Milliseconds 250
    $ServiceProcess.Refresh()
    if ($ServiceProcess.HasExited) { throw "服务启动失败，请查看 $LogDir\service.err.log" }
    try {
        $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$ServicePort/healthz" -TimeoutSec 1
        if ($Health.pid -eq $ServiceProcess.Id) { Write-Output "服务已启动：http://127.0.0.1:$ServicePort/qq-companion/"; return }
    } catch { }
}
throw "服务尚未就绪，请查看 $LogDir。"

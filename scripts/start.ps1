param([switch]$Background)
$ErrorActionPreference = 'Stop'
$Starter = Join-Path $PSScriptRoot 'start.mjs'
if ($Background) { & node $Starter '--background' } else { & node $Starter }
exit $LASTEXITCODE

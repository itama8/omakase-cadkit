$ErrorActionPreference = 'Stop'
try {
    $root = Split-Path -Parent $PSScriptRoot
    $file = Join-Path $root '.tools\environment.json'
    if (-not (Test-Path -LiteralPath $file)) { throw 'Run setup.cmd first.' }
    $settings = Get-Content -Raw -Encoding UTF8 -LiteralPath $file | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath $settings.node)) { throw 'The Node installation moved. Run setup.cmd again.' }
    & $settings.node (Join-Path $PSScriptRoot 'launch.mjs') @args
    exit $LASTEXITCODE
} catch {
    Write-Error -ErrorAction Continue $_
    exit 1
}

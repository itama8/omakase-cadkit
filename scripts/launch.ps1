$ErrorActionPreference = 'Stop'
try {
    $root = Split-Path -Parent $PSScriptRoot
    $file = Join-Path $root '.tools\environment.json'
    if (-not (Test-Path -LiteralPath $file)) { throw 'Run setup.cmd first.' }
    $settings = Get-Content -Raw -Encoding UTF8 -LiteralPath $file | ConvertFrom-Json
    # A downloaded bundle saves a relative path, so the folder can be moved; resolve it
    # against the app root rather than whatever directory the user launched from.
    $nodePath = $settings.node -replace '/', '\'
    if (-not [System.IO.Path]::IsPathRooted($nodePath)) { $nodePath = Join-Path $root $nodePath }
    if (-not (Test-Path -LiteralPath $nodePath)) { throw 'The app''s Node is missing: re-extract the download, or run Setup in a source checkout.' }
    & $nodePath (Join-Path $PSScriptRoot 'launch.mjs') @args
    exit $LASTEXITCODE
} catch {
    Write-Error -ErrorAction Continue $_
    exit 1
}

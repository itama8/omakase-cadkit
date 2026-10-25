# Windows entry: setup.cmd also works without Node installed.
param([switch]$Check, [switch]$LocalTools)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
function Test-Node([string]$Executable) {
    if (-not $Executable) { return $false }
    try { & $Executable -e 'process.exit(parseInt(process.versions.node)>=24?0:1)' 2>$null; return $LASTEXITCODE -eq 0 } catch { return $false }
}
try {
    $node = Join-Path $root '.tools\node\node.exe'
    if (-not (Test-Node $node) -or -not (Test-Path -LiteralPath (Join-Path $root '.tools\node\npm.cmd'))) {
        $system = Get-Command node.exe -ErrorAction SilentlyContinue
        $node = if ($system) { $system.Source } else { '' }
        if ($LocalTools -or -not (Test-Node $node) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
            if ($Check) { throw 'Node 24+ and npm are missing. Run setup.cmd without -Check.' }
            $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
            if ($arch -notin @('x64','arm64')) { throw 'Supported Windows architectures: x64, arm64.' }
            $tools = Join-Path $root '.tools'
            New-Item -ItemType Directory -Force $tools | Out-Null
            $temp = Join-Path $tools ('node-download-' + [Guid]::NewGuid())
            New-Item -ItemType Directory $temp | Out-Null
            try {
                $base = 'https://nodejs.org/dist/latest-v24.x'
                Write-Host 'Downloading Node 24 LTS from nodejs.org...'
                $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
                $entry = $sums -split "`n" | Where-Object { $_ -match "^[a-f0-9]{64}\s+node-v24\.\d+\.\d+-win-$arch\.zip\s*$" } | Select-Object -First 1
                if (-not $entry) { throw 'No matching Node download.' }
                $parts = $entry.Trim() -split '\s+'
                $archive = Join-Path $temp $parts[1]
                Invoke-WebRequest -UseBasicParsing "$base/$($parts[1])" -OutFile $archive
                if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $parts[0]) { throw 'Node checksum mismatch.' }
                $unpackedDir = Join-Path $temp 'unpacked'
                New-Item -ItemType Directory -Force $unpackedDir | Out-Null
                # tar.exe ships with Windows and leaves no open handles; Expand-Archive can.
                if (Get-Command tar.exe -ErrorAction SilentlyContinue) {
                    & tar.exe -xf $archive -C $unpackedDir
                    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the Node download.' }
                } else {
                    Expand-Archive -LiteralPath $archive -DestinationPath $unpackedDir
                }
                $unpacked = Get-ChildItem -Directory -LiteralPath $unpackedDir | Select-Object -First 1
                $target = Join-Path $tools 'node'
                if (Test-Path -LiteralPath $target) { Remove-Item -Recurse -Force -LiteralPath $target }
                # Move before running node.exe: an antivirus scan of a just-run image can hold
                # the directory open and fail the move with "Access to the path is denied".
                $moved = $false
                foreach ($attempt in 1..5) {
                    try { Move-Item -LiteralPath $unpacked.FullName -Destination $target; $moved = $true; break }
                    catch { if ($attempt -eq 5) { throw }; Start-Sleep -Seconds $attempt }
                }
                if (-not $moved) { throw 'Could not place the Node download.' }
                $node = Join-Path $target 'node.exe'
                if (-not (Test-Node $node)) { throw 'Downloaded Node cannot run on this OS.' }
            } finally { Remove-Item -Recurse -Force -LiteralPath $temp }
        }
    }
    $env:PATH = (Split-Path -Parent $node) + [IO.Path]::PathSeparator + $env:PATH
    $arguments = @((Join-Path $root 'scripts\bootstrap.mjs'))
    if ($Check) { $arguments += '--check' }
    if ($LocalTools) { $arguments += '--local-tools' }
    & $node @arguments
    exit $LASTEXITCODE
} catch {
    Write-Error -ErrorAction Continue $_
    exit 1
}

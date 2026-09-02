$ErrorActionPreference = "Stop"

$managerRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path (Join-Path $managerRoot "..\..")).Path
$manifest = Join-Path $repoRoot "Cargo.toml"

$rustcDetails = & rustc -vV
if ($LASTEXITCODE -ne 0) {
    throw "rustc failed while determining the host target triple"
}
$hostLine = $rustcDetails | Where-Object { $_ -match '^host:\s+(.+)$' } | Select-Object -First 1
if ($null -eq $hostLine -or $hostLine -notmatch '^host:\s+([^\s]+)\s*$') {
    throw "rustc did not report a valid host target triple"
}
$hostTriple = $Matches[1]

Write-Output "[manager] building tronhawk-core for $hostTriple"
& cargo build --manifest-path $manifest --package tronhawk-core --release
if ($LASTEXITCODE -ne 0) {
    throw "tronhawk-core release build failed with exit code $LASTEXITCODE"
}

$extension = if ($IsWindows) { ".exe" } else { "" }
$source = Join-Path $repoRoot ("target\release\tronhawk-core" + $extension)
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "tronhawk-core release build did not produce the expected host executable"
}

$binaries = Join-Path $managerRoot "src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $binaries | Out-Null
$destination = Join-Path $binaries ("tronhawk-core-" + $hostTriple + $extension)
Copy-Item -LiteralPath $source -Destination $destination -Force

if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
    throw "failed to stage the tronhawk-core sidecar"
}
Write-Output "[manager] staged tronhawk-core sidecar for Tauri"

# Integration test: launch test-app via the injector and verify the hello-world CSS plugin.
# Usage: pwsh tests/integration.ps1
$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$bin = Join-Path $repo "target\debug"
$poc = Join-Path $env:TEMP "tronhawk-it"
New-Item -ItemType Directory -Force -Path $poc | Out-Null

# 1. Package the test-app (skip if already present).
$packagedExe = Join-Path $poc "test-app-packaged-win32-x64\test-app-packaged.exe"
if (-not (Test-Path -LiteralPath $packagedExe)) {
    Write-Output "[it] packaging test-app"
    bunx @electron/packager "$repo\apps\test-app" test-app-packaged --platform=win32 --arch=x64 --asar --out $poc 2>&1 | Out-Null
}

# 2. Copy injector assets next to the built binaries.
Copy-Item "$repo\crates\injector\assets\bootstrap.js" "$bin\bootstrap.js" -Force
Copy-Item "$repo\crates\injector\assets\runtime.js" "$bin\runtime.js" -Force

# 3. Start Core.
$env:TRONHAWK_IPC_PORT = "17777"
$env:TRONHAWK_IPC_SECRET = "integration-test-secret"
$core = Start-Process -FilePath "$bin\tronhawk-core.exe" -ArgumentList "$repo\plugins\hello-world" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2

$rlog = Join-Path $env:TEMP "tronhawk-runtime.log"
Remove-Item -LiteralPath $rlog -Force -ErrorAction SilentlyContinue

try {
    # 4. Launch test-app through the injector.
    $launcher = "$bin\tronhawk-injector-launcher.exe"
    & $launcher $packagedExe 2>&1 | Out-Null

    # 5. Poll for the CSS-injection marker.
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if ((Test-Path -LiteralPath $rlog) -and ((Get-Content -LiteralPath $rlog -Raw) -match "css injected for com.example.hello-world")) {
            $ok = $true
            break
        }
    }

    if ($ok) {
        Write-Output "[it] PASS: hello-world CSS injected"
        exit 0
    } else {
        $content = if (Test-Path -LiteralPath $rlog) { Get-Content -LiteralPath $rlog -Raw } else { "<no runtime log>" }
        Write-Output "[it] FAIL: no CSS injection; runtime log: $content"
        exit 1
    }
}
finally {
    Stop-Process -Name "test-app-packaged" -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $core.Id -Force -ErrorAction SilentlyContinue
}

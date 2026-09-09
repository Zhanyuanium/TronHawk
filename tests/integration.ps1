# Integration test: configure Core, launch test-app through the injector, and verify durable logs.
# Usage: pwsh tests/integration.ps1
$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$bin = Join-Path $repo "target\debug"
$poc = Join-Path $env:TEMP "tronhawk-it"
$storageRoot = Join-Path $env:TEMP ("tronhawk-it-storage-" + [guid]::NewGuid().ToString("N"))
$pluginSource = Join-Path $storageRoot "logger-plugin-source"
$pluginPackage = Join-Path $storageRoot "logger-plugin.thx"
$fixturePluginId = "com.example.integration-logger"
$fixtureMarker = "integration plugin logger marker"
$cssPluginId = "com.example.integration-css"
$core = $null
$existingTestAppIds = @()
$rpcId = 0

# IPC frame cap in bytes (UTF-8, newline excluded). Keep in sync with MAX_FRAME_SIZE
# in crates/ipc/src/lib.rs and MAX_FRAME_BYTES in crates/injector/assets/bootstrap.js.
$maxFrameBytes = 1024 * 1024

$priorPort = [Environment]::GetEnvironmentVariable("TRONHAWK_IPC_PORT", "Process")
$priorRoot = [Environment]::GetEnvironmentVariable("TRONHAWK_STORAGE_ROOT", "Process")
$priorSecret = [Environment]::GetEnvironmentVariable("TRONHAWK_IPC_SECRET", "Process")

function Restore-ProcessEnvironment([string]$Name, [string]$Value) {
    [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
}

function Get-AvailableLoopbackPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}

function Invoke-CoreRpc {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)]$Params,
        [Parameter(Mandatory = $true)][string]$ControlToken,
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutMilliseconds = 5000
    )

    $script:rpcId++
    $requestId = $script:rpcId
    $request = @{
        version = "0.1"
        id = $requestId
        method = $Method
        params = $Params
        secret = $ControlToken
    }
    $encoded = ($request | ConvertTo-Json -Compress -Depth 20) + "`n"
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $client = $null

    while ([DateTime]::UtcNow -lt $deadline) {
        $candidate = [System.Net.Sockets.TcpClient]::new()
        try {
            $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
            $connect = $candidate.ConnectAsync("127.0.0.1", $Port)
            if ($connect.Wait([Math]::Min($remaining, 500))) {
                $connect.GetAwaiter().GetResult()
                $client = $candidate
                break
            }
        } catch {
            # Core may still be between creating its token and binding the socket.
        }
        $candidate.Dispose()
        Start-Sleep -Milliseconds 100
    }

    if ($null -eq $client) {
        throw "Core RPC '$Method' could not connect to the test port within ${TimeoutMilliseconds}ms"
    }

    try {
        $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        $client.ReceiveTimeout = $remaining
        $client.SendTimeout = $remaining
        $stream = $client.GetStream()
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($encoded)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()

        $reader = [System.IO.StreamReader]::new($stream, [System.Text.UTF8Encoding]::new($false), $false, 4096, $true)
        try {
            $read = $reader.ReadLineAsync()
            $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
            if (-not $read.Wait($remaining)) {
                throw "Core RPC '$Method' timed out waiting for a response"
            }
            $line = $read.GetAwaiter().GetResult()
        } finally {
            $reader.Dispose()
        }

        if ($null -eq $line) {
            throw "Core RPC '$Method' closed without a response"
        }
        if ([System.Text.Encoding]::UTF8.GetByteCount($line) -gt $maxFrameBytes) {
            throw "Core RPC '$Method' response exceeded $maxFrameBytes bytes"
        }
        try {
            $response = $line | ConvertFrom-Json -Depth 20
        } catch {
            throw "Core RPC '$Method' returned malformed JSON"
        }
        if ($response.version -ne "0.1") {
            throw "Core RPC '$Method' returned an unsupported protocol version"
        }
        if ([long]$response.id -ne $requestId) {
            throw "Core RPC '$Method' returned a mismatched response id"
        }
        if ($null -ne $response.error) {
            throw "Core RPC '$Method' failed with code $($response.error.code): $($response.error.message)"
        }
        if ($null -eq $response.PSObject.Properties["result"]) {
            throw "Core RPC '$Method' returned no result"
        }
        return $response.result
    } finally {
        $client.Dispose()
    }
}

try {
    New-Item -ItemType Directory -Force -Path $poc | Out-Null
    New-Item -ItemType Directory -Force -Path $storageRoot | Out-Null

    # 1. Package the test app (skip if already present).
    $packagedExe = Join-Path $poc "test-app-packaged-win32-x64\test-app-packaged.exe"
    if (-not (Test-Path -LiteralPath $packagedExe)) {
        Write-Output "[it] packaging test-app"
        $packOut = bunx @electron/packager "$repo\apps\test-app" test-app-packaged --platform=win32 --arch=x64 --asar --out $poc 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Electron test-app packaging failed with exit code $LASTEXITCODE : $packOut"
        }
    }

    # 2. Build the current daemon/injector/package tooling and the runtime bundle (embeds QuickJS),
    # then copy runtime assets next to the binaries.
    Write-Output "[it] building Rust prerequisites"
    & cargo build --package tronhawk-core --package tronhawk-injector --package tronhawk-package 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Rust prerequisite build failed with exit code $LASTEXITCODE"
    }

    Push-Location (Join-Path $repo "crates\runtime\js")
    try {
        New-Item -ItemType Directory -Force -Path (Join-Path $repo "crates\runtime\assets") | Out-Null
        bun install 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "runtime dependency installation failed with exit code $LASTEXITCODE" }
        bun run build 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "runtime bundle build failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    $coreExe = Join-Path $bin "tronhawk-core.exe"
    $launcher = Join-Path $bin "tronhawk-injector-launcher.exe"
    $injectorDll = Join-Path $bin "tronhawk_injector.dll"
    foreach ($required in @($coreExe, $launcher, $injectorDll)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "required debug artifact is missing after the Rust build: $required"
        }
    }
    Copy-Item "$repo\crates\injector\assets\bootstrap.js" "$bin\bootstrap.js" -Force
    Copy-Item "$repo\crates\runtime\assets\runtime.js" "$bin\runtime.js" -Force

    # 3. Start the current Core daemon with isolated storage and no legacy plugin argument.
    $testPort = Get-AvailableLoopbackPort
    $env:TRONHAWK_STORAGE_ROOT = $storageRoot
    $env:TRONHAWK_IPC_PORT = $testPort.ToString()
    Remove-Item Env:TRONHAWK_IPC_SECRET -ErrorAction SilentlyContinue
    $core = Start-Process -FilePath $coreExe -PassThru -WindowStyle Hidden

    $tokenPath = Join-Path $storageRoot "config\control.token"
    $tokenDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
        if ($core.HasExited) {
            throw "Core exited before creating its control credential (exit code $($core.ExitCode))"
        }
        if ([DateTime]::UtcNow -ge $tokenDeadline) {
            throw "Core did not create its control credential within 10 seconds"
        }
        Start-Sleep -Milliseconds 100
        $core.Refresh()
    }
    $controlToken = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
    if ($controlToken -notmatch '^[0-9A-Fa-f]{64}$') {
        throw "Core created an invalid control credential"
    }

    # 4. Register the app, package/install a minimal QuickJS logger fixture, and grant only the
    # implemented renderer capability it needs to execute.
    Write-Output "[it] configuring Core"
    $registered = Invoke-CoreRpc -Method "registerApplication" -Params @{
        executablePath = $packagedExe
        supportLevel = 2
    } -ControlToken $controlToken -Port $testPort
    if ([string]::IsNullOrWhiteSpace([string]$registered.applicationId)) {
        throw "registerApplication returned no application id"
    }

    New-Item -ItemType Directory -Force -Path $pluginSource | Out-Null
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $fixtureManifest = @{
        id = $fixturePluginId
        name = "Integration Logger"
        version = "1.0.0"
        author = "Integration Test"
        tronhawk = "^0.1"
        entry = @{ renderer = "renderer.js" }
        permissions = @("renderer.script")
    } | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText((Join-Path $pluginSource "manifest.json"), $fixtureManifest, $utf8)
    [System.IO.File]::WriteAllText(
        (Join-Path $pluginSource "renderer.js"),
        'module.exports = { activate(ctx) { ctx.logger.info("integration plugin logger marker"); } };',
        $utf8
    )
    & cargo run --quiet --package tronhawk-package --bin pack -- $pluginSource $pluginPackage 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pluginPackage -PathType Leaf)) {
        throw "logger fixture .thx packaging failed with exit code $LASTEXITCODE"
    }

    $installed = Invoke-CoreRpc -Method "installPlugin" -Params @{ path = $pluginPackage } -ControlToken $controlToken -Port $testPort
    if ($installed.id -ne $fixturePluginId) {
        throw "installPlugin returned an unexpected plugin id"
    }
    $null = Invoke-CoreRpc -Method "setApplicationPluginPolicy" -Params @{
        applicationId = $registered.applicationId
        pluginId = $fixturePluginId
        enabled = $true
        grants = @("renderer.script")
    } -ControlToken $controlToken -Port $testPort

    # CSS fixture (Path A): a CSS-only plugin whose stylesheet the runtime injects once the renderer
    # gate fires on the test-app's late-mounted #late-root. Asserts the renderer.css path works
    # *with* the gate seam (not just renderer.script).
    $cssSource = Join-Path $storageRoot "css-plugin-source"
    $cssPackage = Join-Path $storageRoot "css-plugin.thx"
    New-Item -ItemType Directory -Force -Path $cssSource | Out-Null
    $cssManifest = @{
        id = $cssPluginId
        name = "Integration CSS"
        version = "1.0.0"
        author = "Integration Test"
        tronhawk = "^0.1"
        css = "#late-root { outline: 3px solid #00ff00; }"
        permissions = @("renderer.css")
    } | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText((Join-Path $cssSource "manifest.json"), $cssManifest, $utf8)
    & cargo run --quiet --package tronhawk-package --bin pack -- $cssSource $cssPackage 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $cssPackage -PathType Leaf)) {
        throw "css fixture .thx packaging failed with exit code $LASTEXITCODE"
    }
    $cssInstalled = Invoke-CoreRpc -Method "installPlugin" -Params @{ path = $cssPackage } -ControlToken $controlToken -Port $testPort
    if ($cssInstalled.id -ne $cssPluginId) {
        throw "installPlugin returned an unexpected css plugin id"
    }
    $null = Invoke-CoreRpc -Method "setApplicationPluginPolicy" -Params @{
        applicationId = $registered.applicationId
        pluginId = $cssPluginId
        enabled = $true
        grants = @("renderer.css")
    } -ControlToken $controlToken -Port $testPort

    # 5. Launch through the injector. The parent deliberately has no IPC secret; the launcher
    # obtains a short-lived createLaunchSession credential from Core for the child.
    $existingTestAppIds = @(Get-Process -Name "test-app-packaged" -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    Write-Output "[it] launching test-app through injector"
    if (Test-Path Env:TRONHAWK_IPC_SECRET) {
        throw "parent IPC secret must remain unset before injector launch"
    }
    & $launcher $packagedExe 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "injector launcher failed with exit code $LASTEXITCODE"
    }

    # 6. Poll Core's durable ledger for Core, Runtime, and attributed Plugin events.
    $coreEvent = $null
    $runtimeEvent = $null
    $pluginEvent = $null
    $cssEvent = $null
    $lastEvents = @()
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        $queried = Invoke-CoreRpc -Method "queryLogs" -Params @{
            applicationId = $registered.applicationId
            limit = 20
        } -ControlToken $controlToken -Port $testPort
        $encodedLogs = $queried | ConvertTo-Json -Compress -Depth 20
        if ($encodedLogs -match '(?i)"(?:executablePath|secret|token|source|main|renderer|css)"\s*:') {
            throw "queryLogs exposed a forbidden path, credential, or plugin-source field"
        }
        if ($encodedLogs -match '(?i):\s*"[0-9a-f]{64}"') {
            throw "queryLogs exposed a token-like 64-hex value"
        }

        $lastEvents = @($queried.events)
        $coreEvent = $lastEvents | Where-Object {
            $_.stream -eq "core" -and
            $_.applicationId -eq $registered.applicationId -and
            $_.code -in @("core.application.registered", "core.policy.updated", "core.launch_session.created")
        } | Select-Object -First 1
        $runtimeEvent = $lastEvents | Where-Object {
            $_.stream -eq "runtime" -and
            $_.applicationId -eq $registered.applicationId -and
            $_.message -like "injected; electron=*"
        } | Select-Object -First 1
        $pluginEvent = $lastEvents | Where-Object {
            $_.stream -eq "plugin" -and
            $_.applicationId -eq $registered.applicationId -and
            $_.pluginId -eq $fixturePluginId -and
            $_.message -eq $fixtureMarker
        } | Select-Object -First 1
        $cssEvent = $lastEvents | Where-Object {
            $_.stream -eq "plugin" -and
            $_.applicationId -eq $registered.applicationId -and
            $_.pluginId -eq $cssPluginId -and
            $_.message -eq "CSS injected"
        } | Select-Object -First 1
        if ($null -ne $coreEvent -and $null -ne $runtimeEvent -and $null -ne $pluginEvent -and $null -ne $cssEvent) {
            break
        }
    }
    if ($null -eq $coreEvent -or $null -eq $runtimeEvent -or $null -eq $pluginEvent -or $null -eq $cssEvent) {
        $observed = @($lastEvents | ForEach-Object { "$($_.stream):$($_.code)" }) -join ", "
        $missing = @()
        if ($null -eq $coreEvent) { $missing += "core lifecycle" }
        if ($null -eq $runtimeEvent) { $missing += "runtime lifecycle" }
        if ($null -eq $pluginEvent) { $missing += "attributed plugin marker" }
        if ($null -eq $cssEvent) { $missing += "renderer.css injection event" }
        throw "durable log polling timed out; missing $($missing -join ', '); observed event kinds: $observed"
    }

    Write-Output "[it] PASS: Core, Runtime, plugin marker, and renderer.css injection persisted through launch-session handoff"

    # 7. DUR-1 restart-reconnect: kill Core, restart it on the SAME storage root and SAME port,
    # and confirm the still-running target reconnects without being relaunched. Launch tokens are
    # self-contained (signed, not an in-memory session), so the ORIGINAL token still verifies after
    # the restart; the Runtime's plan poll fails while Core is down and logs "Core reconnected"
    # (runtime stream) once the first valid plan response arrives after Core returns.
    $preRestart = Invoke-CoreRpc -Method "queryLogs" -Params @{
        applicationId = $registered.applicationId
        limit = 20
    } -ControlToken $controlToken -Port $testPort
    $preMaxSequence = [long]0
    foreach ($event in @($preRestart.events)) {
        if ($event.stream -eq "runtime" -and $null -ne $event.sequence -and [long]$event.sequence -gt $preMaxSequence) {
            $preMaxSequence = [long]$event.sequence
        }
    }
    Write-Output "[it] stopping Core for restart-reconnect (pre-restart max runtime sequence: $preMaxSequence)"
    if ($null -ne $core -and -not $core.HasExited) {
        Stop-Process -Id $core.Id -Force -ErrorAction SilentlyContinue
        $null = $core.WaitForExit(10000)
    }
    # Hold Core down across at least two of the Runtime's 2s plan-poll cycles so the target
    # observes a poll failure; the Runtime then logs "Core reconnected" once the first valid plan
    # response arrives after Core returns (it only reports recovery when a poll previously failed).
    Start-Sleep -Seconds 5
    Write-Output "[it] restarting Core on the same root and port"
    $core = Start-Process -FilePath $coreExe -PassThru -WindowStyle Hidden

    $reconnected = $false
    $reconnectEvidence = $null
    $newSeen = @{}
    $stablePolls = 0
    $restartDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $restartDeadline -and $stablePolls -lt 4) {
        Start-Sleep -Seconds 1
        $queried = $null
        try {
            $queried = Invoke-CoreRpc -Method "queryLogs" -Params @{
                applicationId = $registered.applicationId
                limit = 20
            } -ControlToken $controlToken -Port $testPort -TimeoutMilliseconds 2000
        } catch {
            # Core may still be starting up; keep polling until the deadline.
            if ($_.Exception.Message -notlike "*could not connect*") {
                throw
            }
            continue
        }
        $encodedLogs = $queried | ConvertTo-Json -Compress -Depth 20
        if ($encodedLogs -match '(?i)"(?:executablePath|secret|token|source|main|renderer|css)"\s*:') {
            throw "queryLogs (post-restart) exposed a forbidden path, credential, or plugin-source field"
        }
        if ($encodedLogs -match '(?i):\s*"[0-9a-f]{64}"') {
            throw "queryLogs (post-restart) exposed a token-like 64-hex value"
        }

        # Collect every event recorded strictly after the pre-restart snapshot. Any such event
        # proves the still-running target produced new ledger entries through the restarted Core.
        $added = $false
        foreach ($event in @($queried.events)) {
            if ($event.applicationId -ne $registered.applicationId) { continue }
            if ($null -eq $event.sequence) { continue }
            $sequence = [long]$event.sequence
            if ($sequence -gt $preMaxSequence -and -not $newSeen.ContainsKey($sequence)) {
                $newSeen[$sequence] = $event
                $added = $true
            }
        }
        if ($added) {
            $stablePolls = 0
        } else {
            $stablePolls++
        }
    }
    if ($newSeen.Count -eq 0) {
        $observed = @($newSeen.Keys | Sort-Object) -join ", "
        throw "DUR-1 reconnect not observed within 30s after Core restart; no event recorded after pre-restart max sequence $preMaxSequence (new events seen: $observed)"
    }

    # Prefer the Runtime's explicit "Core reconnected" marker, then a freshly-triggered plugin
    # marker, then any newer Core/Runtime event for the same application.
    $ordered = @($newSeen.Keys | Sort-Object)
    $reconnectMarker = $null
    $pluginMarker = $null
    $anyNewer = $null
    foreach ($sequence in $ordered) {
        $event = $newSeen[$sequence]
        if ($event.stream -eq "runtime" -and $event.message -like "Core reconnected*") {
            $reconnectMarker = $event
        } elseif ($event.stream -eq "plugin" -and
            $event.pluginId -eq $fixturePluginId -and $event.message -eq $fixtureMarker) {
            $pluginMarker = $event
        }
        if ($null -eq $anyNewer) { $anyNewer = $event }
    }
    if ($null -ne $reconnectMarker) {
        $reconnectEvidence = "runtime 'Core reconnected' marker (seq $($reconnectMarker.sequence))"
    } elseif ($null -ne $pluginMarker) {
        $reconnectEvidence = "fresh plugin marker (seq $($pluginMarker.sequence))"
    } else {
        $reconnectEvidence = "newer $($anyNewer.stream) event (seq $($anyNewer.sequence), code $($anyNewer.code), message '$($anyNewer.message)')"
    }
    $summary = @($ordered | ForEach-Object {
        $event = $newSeen[$_]
        "$($_):$($event.stream)/$($event.level)/$($event.code) '$($event.message)'"
    }) -join " | "
    Write-Output "[it] post-restart new events: $summary"
    Write-Output "[it] DUR-1 reconnect observed: $reconnectEvidence (pre-restart max sequence $preMaxSequence)"

    Write-Output "[it] PASS: DUR-1 Core restart-reconnect — target re-authenticated and resumed without relaunch"
} finally {
    Get-Process -Name "test-app-packaged" -ErrorAction SilentlyContinue |
        Where-Object { $existingTestAppIds -notcontains $_.Id } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    if ($null -ne $core -and -not $core.HasExited) {
        Stop-Process -Id $core.Id -Force -ErrorAction SilentlyContinue
    }
    Restore-ProcessEnvironment "TRONHAWK_IPC_PORT" $priorPort
    Restore-ProcessEnvironment "TRONHAWK_STORAGE_ROOT" $priorRoot
    Restore-ProcessEnvironment "TRONHAWK_IPC_SECRET" $priorSecret
    Remove-Item -LiteralPath $storageRoot -Recurse -Force -ErrorAction SilentlyContinue
}

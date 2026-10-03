# Works with Windows PowerShell 5.1 and PowerShell 7.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Read-Default([string]$Prompt, [string]$Default) {
    $answer = Read-Host "$Prompt [$Default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim()
}
function Select-Menu([string]$Title, [string[]]$Options) {
    Write-Host "`n$Title"
    for ($i = 0; $i -lt $Options.Count; $i++) { Write-Host "  $($i + 1). $($Options[$i])" }
    while ($true) {
        $value = 0
        $answer = Read-Default 'Choose' '1'
        if ([int]::TryParse($answer, [ref]$value) -and $value -ge 1 -and $value -le $Options.Count) { return $value - 1 }
    }
}
function Read-Port([string]$Prompt, [int]$Default) {
    while ($true) {
        $value = 0
        if ([int]::TryParse((Read-Default $Prompt "$Default"), [ref]$value) -and $value -ge 1 -and $value -le 65535) { return $value }
    }
}
function Get-CdpVersion([int]$Port) {
    # Explicitly bypass proxies; PowerShell 5.1 lacks Invoke-RestMethod -NoProxy.
    try {
        $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/json/version")
        $request.Proxy = $null
        $request.Timeout = 1000
        $request.ReadWriteTimeout = 1000
        $response = $request.GetResponse()
        try {
            $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
            try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
        } finally { $response.Dispose() }
    } catch { return $null }
}
function Test-Listening([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.ConnectAsync('127.0.0.1', $Port)
        if ($pending.Wait(1000)) { return $client.Connected }
        return $false
    } catch { return $false } finally { $client.Dispose() }
}

try {
    if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) { throw 'Install Windows OpenSSH Client first.' }
    Write-Host 'Chrome CDP launcher - choose browser, site and tunnel destination.'
    $origin = Read-Default 'Website origin (scheme + host + optional port)' 'https://'
    if ($origin -notmatch '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?/?$|^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?/?$') {
        throw 'Use an HTTPS origin, or loopback HTTP, without credentials, path or query.'
    }
    $origin = $origin.TrimEnd('/')
    $sshConfig = Join-Path $env:USERPROFILE '.ssh\config'
    $aliases = @()
    if (Test-Path -LiteralPath $sshConfig) {
        $aliases = @(Get-Content -LiteralPath $sshConfig | ForEach-Object {
            if ($_ -match '^\s*Host\s+(.+)$') {
                ($Matches[1] -split '#', 2)[0] -split '\s+' | Where-Object { $_ -and $_ -notmatch '[*?!]' }
            }
        } | Sort-Object -Unique)
    }
    $options = @($aliases) + @('Enter another SSH destination')
    $choice = Select-Menu 'SSH destination (aliases from your .ssh/config)' $options
    $destination = $options[$choice]
    if ($destination -eq 'Enter another SSH destination') { $destination = Read-Default 'SSH alias or user@host' '' }
    if ($destination -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$') { throw 'Invalid SSH destination. Use a named SSH alias for complex options.' }

    $browsers = @()
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if (-not $root) { continue }
        foreach ($relative in @('Google\Chrome\Application\chrome.exe', 'Google\Chrome Beta\Application\chrome.exe', 'Google\Chrome Dev\Application\chrome.exe', 'Google\Chrome SxS\Application\chrome.exe', 'Google\Chrome for Testing\Application\chrome.exe', 'Chromium\Application\chrome.exe')) {
            $path = Join-Path $root $relative
            if (Test-Path -LiteralPath $path -PathType Leaf) { $browsers += $path }
        }
    }
    $browsers = @($browsers | Select-Object -Unique)
    $options = @($browsers) + @('Enter another executable')
    $choice = Select-Menu 'Local Chrome/Chromium executable' $options
    $browser = $options[$choice]
    if ($browser -eq 'Enter another executable') { $browser = Read-Default 'Full path to chrome.exe' '' }
    if (-not (Test-Path -LiteralPath $browser -PathType Leaf)) { throw "Browser executable not found: $browser" }
    $browser = (Resolve-Path -LiteralPath $browser).Path
    $localPort = Read-Port 'Local Chrome debugging port (9222 or 9333, for example)' 9222
    $remotePort = Read-Port 'Remote agent-host tunnel port (independent of the browser port)' 9778
    $profileName = Read-Default 'Dedicated profile name (retains this session login)' 'audit'
    if ($profileName -notmatch '^[A-Za-z0-9_-]+$') { throw 'Profile names may contain letters, digits, hyphens and underscores.' }
    $profileDir = Join-Path $env:USERPROFILE ".chrome-cdp\profiles\$profileName-$localPort"
    if (Test-Listening $localPort) { throw "Port $localPort is occupied. Choose another local port or close the dedicated browser using it." }
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    Write-Host "`nOpening $browser`nProfile: $profileDir`nWebsite: $origin"
    $arguments = @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$localPort", "--user-data-dir=`"$profileDir`"", '--no-first-run', '--no-default-browser-check', '--new-window', "`"$origin/`"")
    Start-Process -FilePath $browser -ArgumentList $arguments | Out-Null
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $version = Get-CdpVersion $localPort
        if ($null -ne $version -and $version.PSObject.Properties['Browser'] -and $version.PSObject.Properties['webSocketDebuggerUrl']) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw 'Chrome did not open CDP. Close only the dedicated profile using this directory and retry.' }
    $descriptor = @{ version = 1; port = $remotePort; approvedOrigin = $origin } | ConvertTo-Json -Compress
    $descriptor64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($descriptor))
    $remoteSetup = "umask 077; mkdir -p ~/.config/chrome-cdp; printf '%s' '$descriptor64' | base64 -d > ~/.config/chrome-cdp/forwarded.json.tmp && chmod 600 ~/.config/chrome-cdp/forwarded.json.tmp && mv ~/.config/chrome-cdp/forwarded.json.tmp ~/.config/chrome-cdp/forwarded.json"
    Write-Host "`nInstalling the approved connection descriptor on $destination."
    & ssh.exe -T $destination $remoteSetup
    if ($LASTEXITCODE -ne 0) { throw "Could not install the remote connection descriptor (SSH exit $LASTEXITCODE)." }
    Write-Host "`nChrome is ready. Sign in manually in the new window."
    Write-Host "Tunnel: $destination 127.0.0.1:$remotePort -> this computer 127.0.0.1:$localPort"
    Write-Host "Agent endpoint: http://127.0.0.1:$remotePort`nApproved origin: $origin"
    Write-Host 'Keep this terminal open. Ctrl+C stops the tunnel; Chrome stays open.'
    & ssh.exe -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R "127.0.0.1:${remotePort}:127.0.0.1:${localPort}" $destination
    if ($LASTEXITCODE -ne 0) { throw "SSH tunnel stopped with exit code $LASTEXITCODE. Check SSH authentication and whether server port $remotePort is already occupied." }
} catch {
    Write-Host "`nError: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

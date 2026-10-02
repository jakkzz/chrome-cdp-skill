# Run normally to launch Chrome. Use -ConfigureNetwork in an Administrator
# PowerShell to configure the WSL-only portproxy/firewall (without launching Chrome).
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 9778,
    [string]$ChromePath = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    [string]$Profile = "$env:LOCALAPPDATA\ChromeCDPDebug",
    [switch]$ConfigureNetwork,
    [string]$WindowsHost,
    [string]$WslAddress
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

if ($ConfigureNetwork) {
    if (-not $isAdmin) { throw 'Open PowerShell with Run as administrator for -ConfigureNetwork.' }
    foreach ($address in @($WindowsHost, $WslAddress)) {
        $parsed = $null
        if (-not [Net.IPAddress]::TryParse($address, [ref]$parsed) -or
            $parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
            $address -in @('0.0.0.0', '255.255.255.255', '127.0.0.1')) {
            throw 'Supply specific IPv4 -WindowsHost and -WslAddress values from the WSL interface.'
        }
    }
    if (-not (Get-NetIPAddress -AddressFamily IPv4 -IPAddress $WindowsHost -ErrorAction SilentlyContinue)) {
        throw "Windows does not own $WindowsHost. Recheck the WSL gateway address."
    }
    # Never bind on all interfaces; only the supplied WSL-facing Windows address.
    & netsh interface portproxy add v4tov4 "listenaddress=$WindowsHost" "listenport=$Port" 'connectaddress=127.0.0.1' "connectport=$Port"
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure portproxy.' }
    $name = "Chrome-CDP-WSL-$Port"
    $rule = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
    if ($rule) {
        Set-NetFirewallRule -Name $name -Enabled True -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $WindowsHost -LocalPort $Port -RemoteAddress $WslAddress | Out-Null
    } else {
        New-NetFirewallRule -Name $name -DisplayName "Chrome CDP WSL $Port" -Enabled True -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $WindowsHost -LocalPort $Port -RemoteAddress $WslAddress | Out-Null
    }
    Write-Output "Forwarded ${WindowsHost}:${Port} to Windows localhost; allowed only WSL $WslAddress."
    Write-Output 'Now launch this script without -ConfigureNetwork in a non-administrator PowerShell.'
    return
}

if ($isAdmin) { throw 'Launch Chrome from a non-administrator PowerShell, not elevated.' }
if (-not (Test-Path -LiteralPath $ChromePath -PathType Leaf)) { throw "Browser not found: $ChromePath" }
if ($Profile.Contains('"')) { throw 'Profile paths must not contain double quotes.' }
Start-Process -FilePath $ChromePath -ArgumentList "--remote-debugging-port=$Port --user-data-dir=`"$Profile`" --no-first-run --no-default-browser-check --new-window about:blank"
Write-Output "Started Windows Chrome on port $Port using dedicated profile $Profile."
Write-Output 'Confirm the window is visible. Do not use your everyday browser profile.'

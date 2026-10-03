import { readFile, access } from 'node:fs/promises';
import { homedir, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const SETUP_URL = 'chrome://inspect/#remote-debugging';

export function environment(env = process.env) {
  return {
    platform: platform(),
    wsl: Boolean(env.WSL_DISTRO_NAME || /microsoft/i.test(release())),
    herdr: { detected: env.HERDR_ENV === '1' },
    setupUrl: SETUP_URL,
  };
}

export function tailscaleCandidates(env = process.env, os = platform(), home = homedir()) {
  const candidates = ['tailscale'];
  if (os === 'darwin') candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale', resolve(home, 'Applications/Tailscale.app/Contents/MacOS/Tailscale'));
  if (os === 'win32' && env.ProgramFiles) candidates.push(resolve(env.ProgramFiles, 'Tailscale/tailscale.exe'));
  if (os === 'linux' && env.WSL_DISTRO_NAME) candidates.push('tailscale.exe');
  return candidates;
}

export async function tailscaleStatus() {
  for (const executable of tailscaleCandidates()) {
    try {
      const { stdout } = await exec(executable, ['status', '--json'], {
        timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      const status = JSON.parse(stdout);
      return {
        available: true,
        connected: status.BackendState === 'Running' && status.Self?.Online === true,
        state: status.BackendState ?? null,
        addresses: status.TailscaleIPs ?? [],
        source: executable === 'tailscale.exe' ? 'Windows host CLI via WSL interop' : 'browser-host CLI',
      };
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      return { available: true, connected: false, reason: 'Tailscale status unavailable' };
    }
  }
  return { available: false, connected: false, reason: 'Tailscale CLI not found. Install it or add it to PATH; a GUI-only or host-only installation may still exist.' };
}

export function portFileCandidates(home = homedir(), env = process.env, os = platform()) {
  const profiles = os === 'darwin'
    ? ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome for Testing', 'Chromium',
      'BraveSoftware/Brave-Browser', 'Microsoft Edge', 'Vivaldi']
      .map(name => resolve(home, 'Library/Application Support', name))
    : os === 'win32'
      ? ['Google/Chrome', 'Google/Chrome Beta', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft/Edge', 'Vivaldi']
        .map(name => resolve(env.LOCALAPPDATA || resolve(home, 'AppData/Local'), name, 'User Data'))
      : ['google-chrome', 'google-chrome-beta', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge', 'vivaldi']
        .map(name => resolve(env.XDG_CONFIG_HOME || resolve(home, '.config'), name));
  if (os === 'linux') {
    for (const [app, browser] of [['org.chromium.Chromium', 'chromium'], ['com.google.Chrome', 'google-chrome'],
      ['com.brave.Browser', 'BraveSoftware/Brave-Browser'], ['com.microsoft.Edge', 'microsoft-edge'], ['com.vivaldi.Vivaldi', 'vivaldi']]) {
      profiles.push(resolve(home, '.var/app', app, 'config', browser));
    }
  }
  return profiles.flatMap(base => [resolve(base, 'DevToolsActivePort'), resolve(base, 'Default/DevToolsActivePort')]);
}

export function validatePort(value) {
  if (!/^\d+$/.test(String(value))) throw new Error('Port must be an integer between 1 and 65535');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer between 1 and 65535');
  return port;
}

export function parsePortFile(text) {
  const [rawPort, path] = text.trim().split(/\r?\n/);
  const port = validatePort(rawPort);
  if (!/^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(path ?? '')) throw new Error('Invalid browser path in DevToolsActivePort');
  return `ws://127.0.0.1:${port}${path}`;
}

export function validateEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash
    || !/^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(url.pathname)) {
    throw new Error('CDP must use a loopback browser WebSocket. For remote browsers use SSH-host mode.');
  }
  return url.href;
}

export function forwardedEndpoint(value, port) {
  const endpoint = new URL(validateEndpoint(value));
  endpoint.hostname = '127.0.0.1';
  endpoint.port = String(validatePort(port));
  return endpoint.href;
}

export async function discoverEndpoint({ portFile, port } = {}) {
  if (portFile && port) throw new Error('Choose either --port-file or --port');
  if (port) {
    const response = await fetch(`http://127.0.0.1:${validatePort(port)}/json/version`, {
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Chrome endpoint returned HTTP ${response.status}`);
    return forwardedEndpoint((await response.json()).webSocketDebuggerUrl, port);
  }
  if (portFile) return parsePortFile(await readFile(resolve(portFile), 'utf8'));
  for (const candidate of portFileCandidates()) {
    try { await access(candidate); } catch { continue; }
    // Do not silently choose another browser when a discovered file is malformed.
    return parsePortFile(await readFile(candidate, 'utf8'));
  }
  throw new Error(`No Chrome debugging endpoint found. On the browser host, open ${SETUP_URL}, enable debugging and approve the connection. For a custom profile supply --port-file.`);
}

export function shellQuote(value) {
  if (!value || /[\r\n\0]/.test(value)) throw new Error('SSH command arguments cannot be empty or contain control characters');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sshArgs(options) {
  const { sshHost, sshUser, remoteEntry, remoteNode = 'node', sshPort, identityFile,
    remoteShell = 'posix', port, portFile, allowEvaluate = false, herdr = false } = options;
  if (!sshHost || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(sshHost)) throw new Error('Invalid SSH host');
  if (sshUser && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(sshUser)) throw new Error('Invalid SSH username');
  if (!remoteEntry) throw new Error('Remote mode requires --remote-entry: the installed cli.mjs path on the browser host');
  if (!['posix', 'powershell'].includes(remoteShell)) throw new Error('Remote shell must be posix or powershell');
  const command = [remoteNode, remoteEntry, 'serve'];
  if (port) command.push('--port', String(validatePort(port)));
  if (portFile) command.push('--port-file', portFile);
  if (allowEvaluate) command.push('--allow-evaluate');
  if (herdr) command.push('--herdr-context');
  const quote = remoteShell === 'posix' ? shellQuote : value => {
    if (!value || /[\r\n\0]/.test(value)) throw new Error('Invalid PowerShell argument');
    return `'${value.replaceAll("'", "''")}'`;
  };
  // Explicit PowerShell mode works even when Windows OpenSSH defaults to cmd.exe.
  const remote = remoteShell === 'posix' ? command.map(quote).join(' ')
    : `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`& ${command.map(quote).join(' ')}; exit $LASTEXITCODE`, 'utf16le').toString('base64')}`;
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2'];
  if (sshUser) args.push('-l', sshUser);
  if (sshPort) args.push('-p', String(validatePort(sshPort)));
  if (identityFile) args.push('-i', resolve(identityFile));
  args.push(sshHost, remote);
  return args;
}

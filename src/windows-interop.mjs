import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, win32 } from 'node:path';

import { validatePort } from './connector.mjs';

const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

function executableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolvePowerShell({ env = process.env, available = executableFile } = {}) {
  const candidates = (env.PATH ?? '').split(delimiter)
    .filter((directory) => isAbsolute(directory))
    .map((directory) => join(directory, 'powershell.exe'));
  candidates.push(WSL_POWERSHELL);
  const executable = candidates.find((candidate) => available(candidate));
  if (!executable) {
    throw new Error('Windows PowerShell was not found on PATH or in the standard WSL Windows mount. Check Windows drive mounts and WSL interop, or add its directory to the launcher PATH before starting Pi.');
  }
  return executable;
}

function safePowerShellArgument(value, label) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} cannot be empty or contain control characters`);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsPath(value, label) {
  if (!win32.isAbsolute(value) || !/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value)) {
    throw new Error(`${label} must be an absolute Windows path, for example C:\\Users\\me\\chrome-cdp-skill\\src\\cli.mjs`);
  }
  return value;
}

export function windowsServerCommand(options) {
  const {
    windowsEntry,
    windowsNode = 'node.exe',
    port,
    portFile,
    allowEvaluate = false,
    herdr = false,
  } = options;
  if (!windowsEntry) throw new Error('Windows interop requires --windows-entry');
  safePowerShellArgument(windowsEntry, '--windows-entry');
  safePowerShellArgument(windowsNode, '--windows-node');
  windowsPath(windowsEntry, '--windows-entry');
  if (/[/\\]/.test(windowsNode)) windowsPath(windowsNode, '--windows-node');
  if (portFile) {
    safePowerShellArgument(portFile, '--port-file in Windows mode');
    windowsPath(portFile, '--port-file in Windows mode');
  }

  const command = [windowsNode, windowsEntry, 'serve', '--browser-host', 'native'];
  if (port) command.push('--port', String(validatePort(port)));
  if (portFile) command.push('--port-file', portFile);
  if (allowEvaluate) command.push('--allow-evaluate');
  if (herdr) command.push('--herdr-context');
  return command;
}

export function encodedPowerShell(command) {
  const script = `& ${command.map((value) => safePowerShellArgument(value, 'PowerShell argument')).join(' ')}; exit $LASTEXITCODE`;
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function windowsInteropSpec(options, discovery = {}) {
  const command = windowsServerCommand(options);
  return {
    executable: resolvePowerShell(discovery),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(command)],
    command,
  };
}

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';

import { SETUP_URL, environment } from './connector.mjs';
import { resolvePowerShell } from './windows-interop.mjs';

const exec = promisify(execFile);
const INSTALL_ROOT = 'pi-chrome-cdp';
const MARKER = '.runtime-fingerprint';

function powershellQuote(value) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) {
    throw new Error('PowerShell values cannot be empty or contain control characters');
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export function encodedPowerShellScript(script) {
  if (typeof script !== 'string' || !script || /\0/.test(script)) throw new Error('PowerShell script is invalid');
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function powershellArgs(script) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShellScript(script)];
}

export function windowsDiscoveryScript() {
  return `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) { throw 'Node.js 22+ and npm are required on Windows.' }
$nodeVersion = & $node.Source -p 'process.versions.node'
if ([int]($nodeVersion.Split('.')[0]) -lt 22) { throw "Windows Node.js 22+ is required; found $nodeVersion." }
$candidates = @()
if ($env:ProgramFiles) { $candidates += [IO.Path]::Combine($env:ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') }
if (\${env:ProgramFiles(x86)}) { $candidates += [IO.Path]::Combine(\${env:ProgramFiles(x86)}, 'Google', 'Chrome', 'Application', 'chrome.exe') }
if ($env:LOCALAPPDATA) { $candidates += [IO.Path]::Combine($env:LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') }
$chrome = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Google Chrome was not found in a standard Windows installation location.' }
[pscustomobject]@{
  localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  nodePath = $node.Source
  nodeVersion = $nodeVersion
  npmPath = $npm.Source
  chromePath = $chrome
} | ConvertTo-Json -Compress`;
}

function requireWindowsPath(value, label) {
  if (typeof value !== 'string' || !win32.isAbsolute(value) || !/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value)) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return value;
}

export function parseWindowsDiscovery(stdout) {
  let value;
  try {
    value = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim());
  } catch {
    throw new Error('Windows prerequisite discovery returned invalid output');
  }
  const nodeVersion = String(value.nodeVersion ?? '');
  if (!/^\d+\.\d+\.\d+/.test(nodeVersion) || Number(nodeVersion.split('.')[0]) < 22) {
    throw new Error(`Windows Node.js 22+ is required; found ${nodeVersion || 'an unknown version'}`);
  }
  return {
    localAppData: requireWindowsPath(value.localAppData, 'Windows LocalAppData'),
    nodePath: requireWindowsPath(value.nodePath, 'Windows Node.js'),
    nodeVersion,
    npmPath: requireWindowsPath(value.npmPath, 'Windows npm'),
    chromePath: requireWindowsPath(value.chromePath, 'Windows Chrome'),
  };
}

async function hashTree(hash, root, relative) {
  const absolute = resolve(root, relative);
  const info = await stat(absolute);
  if (info.isDirectory()) {
    const entries = await readdir(absolute);
    entries.sort();
    for (const entry of entries) await hashTree(hash, root, `${relative}/${entry}`);
    return;
  }
  if (!info.isFile()) return;
  hash.update(relative);
  hash.update('\0');
  hash.update(await readFile(absolute));
  hash.update('\0');
}

export async function runtimeFingerprint(packageRoot) {
  const hash = createHash('sha256');
  await hashTree(hash, packageRoot, 'package.json');
  try { await hashTree(hash, packageRoot, 'package-lock.json'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await hashTree(hash, packageRoot, 'src');
  return hash.digest('hex').slice(0, 16);
}

export function windowsRuntimeDirectory(localAppData, fingerprint) {
  requireWindowsPath(localAppData, 'Windows LocalAppData');
  if (!/^[a-f0-9]{16}$/.test(fingerprint)) throw new Error('Runtime fingerprint is invalid');
  return win32.join(localAppData, INSTALL_ROOT, `runtime-${fingerprint}`);
}

export async function run(executable, args, options = {}) {
  try {
    return await exec(executable, args, {
      timeout: 120_000,
      // WSL interop can ignore SIGTERM; bound the owned bridge process as well.
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      ...options,
    });
  } catch (error) {
    if (error.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error(`${basename(executable)} timed out; the owned command was stopped. Check WSL interop in a native WSL terminal before retrying. Any Windows-side setup may have partially completed.`, { cause: error });
    }
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(detail || `${basename(executable)} failed`);
  }
}

async function toWslPath(windowsPath) {
  const { stdout } = await run('wslpath', ['-u', windowsPath], { timeout: 10_000 });
  const converted = stdout.trim();
  if (!converted.startsWith('/')) throw new Error('Could not map the Windows runtime directory into WSL');
  return converted;
}

async function installWindowsRuntime(packageRoot, windowsDirectory, fingerprint, npmPath, onProgress, powershell) {
  const wslDirectory = await toWslPath(windowsDirectory);
  const markerPath = resolve(wslDirectory, MARKER);
  try {
    if ((await readFile(markerPath, 'utf8')).trim() === fingerprint) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  onProgress?.('Copying the reviewed Chrome MCP runtime to Windows…');
  await rm(wslDirectory, { recursive: true, force: true });
  await mkdir(wslDirectory, { recursive: true });
  await cp(resolve(packageRoot, 'src'), resolve(wslDirectory, 'src'), { recursive: true });
  await cp(resolve(packageRoot, 'package.json'), resolve(wslDirectory, 'package.json'));

  let hasLock = true;
  try { await cp(resolve(packageRoot, 'package-lock.json'), resolve(wslDirectory, 'package-lock.json')); }
  catch (error) {
    if (error.code === 'ENOENT') hasLock = false;
    else throw error;
  }

  onProgress?.('Installing Windows-side runtime dependencies…');
  const npmCommand = hasLock ? 'ci' : 'install';
  const installScript = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Set-Location -LiteralPath ${powershellQuote(windowsDirectory)}
& ${powershellQuote(npmPath)} '${npmCommand}' '--omit=dev' '--no-audit' '--no-fund'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
  await run(powershell, powershellArgs(installScript));
  await writeFile(markerPath, `${fingerprint}\n`, 'utf8');
}

async function openWindowsChrome(chromePath, powershell) {
  const openScript = `$ErrorActionPreference = 'Stop'
Start-Process -FilePath ${powershellQuote(chromePath)} -ArgumentList @('--new-window', ${powershellQuote(SETUP_URL)})`;
  await run(powershell, powershellArgs(openScript), { timeout: 15_000 });
}

export async function prepareWindowsChrome({ packageRoot, onProgress, runtime = environment() }) {
  if (runtime.platform !== 'linux' || !runtime.wsl) {
    throw new Error('/chrome-windows must run inside WSL2 with Windows interop enabled');
  }

  onProgress?.('Checking Windows Node.js and Chrome…');
  const powershell = resolvePowerShell();
  const discovered = parseWindowsDiscovery((await run(powershell, powershellArgs(windowsDiscoveryScript()), { timeout: 30_000 })).stdout);
  const fingerprint = await runtimeFingerprint(packageRoot);
  const runtimeDirectory = windowsRuntimeDirectory(discovered.localAppData, fingerprint);
  await installWindowsRuntime(packageRoot, runtimeDirectory, fingerprint, discovered.npmPath, onProgress, powershell);

  onProgress?.('Opening Chrome remote-debugging setup on Windows…');
  await openWindowsChrome(discovered.chromePath, powershell);

  return {
    ...discovered,
    runtimeDirectory,
    windowsEntry: win32.join(runtimeDirectory, 'src', 'cli.mjs'),
  };
}

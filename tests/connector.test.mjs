import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environment, parsePortFile, portFileCandidates, validateEndpoint, validatePort, shellQuote, sshArgs, tailscaleCandidates } from '../src/connector.mjs';
import { browserHostMode, parseOptions } from '../src/cli.mjs';
import { encodedPowerShell, windowsInteropSpec, windowsServerCommand } from '../src/windows-interop.mjs';

test('port files support CRLF and validate browser paths', () => {
  assert.equal(parsePortFile('9222\r\n/devtools/browser/test-id\r\n'), 'ws://127.0.0.1:9222/devtools/browser/test-id');
  for (const text of ['0\n/devtools/browser/test', '65536\n/devtools/browser/test', '9222\n/devtools/page/test', '9222\n/devtools/browser/test?x=1', 'bad']) assert.throws(() => parsePortFile(text));
});

test('discovery honors each platform and configured directories', () => {
  assert.ok(portFileCandidates('/runtime-home', {}, 'darwin').some(path => path.replaceAll('\\', '/').includes('Library/Application Support/Google/Chrome/DevToolsActivePort')));
  assert.ok(portFileCandidates('/runtime-home', { LOCALAPPDATA: '/runtime-local' }, 'win32').some(path => path.includes('runtime-local')));
  assert.ok(portFileCandidates('/runtime-home', { XDG_CONFIG_HOME: '/runtime-config' }, 'linux').some(path => path.includes('runtime-config')));
  assert.ok(portFileCandidates('/runtime-home', {}, 'linux').some(path => path.includes('.var/app')));
});

test('CDP rejects remote, credentialed and redirected endpoint shapes', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) assert.equal(validateEndpoint(`ws://${host}:9222/devtools/browser/test`), `ws://${host}:9222/devtools/browser/test`);
  for (const url of ['ws://host.test:9222/devtools/browser/test', 'wss://localhost/devtools/browser/test', 'ws://user@localhost/devtools/browser/test', 'ws://localhost/devtools/page/test', 'ws://localhost/devtools/browser/test?x=1']) assert.throws(() => validateEndpoint(url));
});

test('ports and CLI options fail closed', () => {
  for (const value of ['1.1', '1e3', '-1', 0, 65536, ' ']) assert.throws(() => validatePort(value));
  assert.equal(validatePort('22'), 22);
  assert.throws(() => parseOptions(['serve', '--port', '9222', '--port-file', '/runtime/file']));
  assert.throws(() => parseOptions(['serve', '--remote-entry', '/runtime/cli.mjs']));
  assert.throws(() => parseOptions(['doctor', '--ssh-host', 'host.test']));
  assert.throws(() => parseOptions(['serve', '--open']));
  assert.throws(() => parseOptions(['serve', 'unexpected']));
  assert.equal(parseOptions(['serve', '--ssh-host', 'host.test', '--ssh-user', 'runtime-user', '--remote-entry', '/runtime/cli.mjs']).sshUser, 'runtime-user');
});

test('browser-host selection treats native Windows and WSL as different runtimes', () => {
  assert.equal(browserHostMode({}, { platform: 'win32', wsl: false }), 'native');
  assert.equal(browserHostMode({}, { platform: 'darwin', wsl: false }), 'native');
  assert.equal(browserHostMode({ browserHost: 'native' }, { platform: 'linux', wsl: true }), 'native');
  assert.equal(browserHostMode({ browserHost: 'windows', windowsEntry: 'C:\\runtime\\src\\cli.mjs' }, { platform: 'linux', wsl: true }), 'windows');
  assert.equal(browserHostMode({ windowsEntry: 'C:\\runtime\\src\\cli.mjs' }, { platform: 'linux', wsl: true }), 'windows');
  assert.equal(browserHostMode({ sshHost: 'host.test' }, { platform: 'linux', wsl: true }), 'ssh');
  assert.throws(() => browserHostMode({}, { platform: 'linux', wsl: true }), /WSL detected/);
  assert.throws(() => browserHostMode({ browserHost: 'windows' }, { platform: 'darwin', wsl: false }), /only on native Windows or WSL/);
});

test('Windows interop launches a Windows-side native MCP over encoded PowerShell stdio', () => {
  const options = {
    windowsEntry: "C:\\runtime path\\it's\\src\\cli.mjs",
    windowsNode: 'C:\\Program Files\\nodejs\\node.exe',
    port: 9222,
    allowEvaluate: true,
    herdr: true,
  };
  assert.deepEqual(windowsServerCommand(options), [
    'C:\\Program Files\\nodejs\\node.exe', "C:\\runtime path\\it's\\src\\cli.mjs", 'serve',
    '--browser-host', 'native', '--port', '9222', '--allow-evaluate', '--herdr-context',
  ]);
  const spec = windowsInteropSpec(options);
  assert.equal(spec.executable, 'powershell.exe');
  assert.deepEqual(spec.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const decoded = Buffer.from(spec.args.at(-1), 'base64').toString('utf16le');
  assert.equal(decoded, "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\runtime path\\it''s\\src\\cli.mjs' 'serve' '--browser-host' 'native' '--port' '9222' '--allow-evaluate' '--herdr-context'; exit $LASTEXITCODE");
  assert.equal(Buffer.from(encodedPowerShell(['node.exe', 'C:\\runtime\\src\\cli.mjs']), 'base64').toString('utf16le'), "& 'node.exe' 'C:\\runtime\\src\\cli.mjs'; exit $LASTEXITCODE");
  assert.throws(() => windowsServerCommand({ windowsEntry: '/home/runtime/src/cli.mjs' }), /absolute Windows path/);
  assert.throws(() => windowsServerCommand({ windowsEntry: 'C:\\runtime\\src\\cli.mjs', windowsNode: 'node.exe\nwhoami' }), /control characters/);
});

test('SSH uses strict host checking, batch auth and safely quoted runtime inputs', () => {
  const args = sshArgs({ sshHost: 'host.test', sshUser: 'runtime-user', remoteEntry: "/runtime path/it's/cli.mjs", port: 9222 });
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.equal(args[args.length - 2], 'host.test');
  assert.equal(args.at(-1), "'node' '/runtime path/it'\\''s/cli.mjs' 'serve' '--port' '9222'");
  assert.equal(shellQuote('$(touch injected)'), "'$(touch injected)'");
  for (const sshHost of ['-oProxyCommand=x', 'host;whoami', 'host\nname']) assert.throws(() => sshArgs({ sshHost, remoteEntry: '/runtime/cli.mjs' }));
  assert.throws(() => sshArgs({ sshHost: 'host.test' }));
  assert.throws(() => sshArgs({ sshHost: 'host.test', remoteEntry: '/runtime/cli.mjs\nwhoami' }));
});

test('Windows remote command is encoded PowerShell, not cmd interpolation', () => {
  const args = sshArgs({ sshHost: 'host.test', remoteShell: 'powershell', remoteEntry: "C:\\runtime path\\it's\\cli.mjs", remoteNode: 'C:\\node\\node.exe' });
  const remote = args.at(-1);
  assert.match(remote, /^powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand /);
  const decoded = Buffer.from(remote.split(' ').at(-1), 'base64').toString('utf16le');
  assert.equal(decoded, "& 'C:\\node\\node.exe' 'C:\\runtime path\\it''s\\cli.mjs' 'serve'; exit $LASTEXITCODE");
});

test('Tailscale discovery checks CLI and conventional platform installation paths', () => {
  assert.ok(tailscaleCandidates({}, 'darwin', '/runtime-home').some(path => path.startsWith('/Applications/')));
  assert.ok(tailscaleCandidates({ ProgramFiles: '/runtime-programs' }, 'win32', '/runtime-home').some(path => path.includes('runtime-programs')));
  assert.ok(tailscaleCandidates({ WSL_DISTRO_NAME: 'runtime-wsl' }, 'linux').includes('tailscale.exe'));
  assert.deepEqual(tailscaleCandidates({}, 'linux'), ['tailscale']);
});
test('herdr detection is optional and never used as authorization', () => {
  assert.equal(environment({ HERDR_ENV: '1' }).herdr.detected, true);
  assert.equal(environment({ HERDR_ENV: '0' }).herdr.detected, false);
});

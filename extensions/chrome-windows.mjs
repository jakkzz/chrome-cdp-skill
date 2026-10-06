import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareWindowsChrome } from '../src/windows-bootstrap.mjs';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_ENTRY = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const SERVER_NAME = 'chrome-windows';
const STATUS_KEY = 'chrome-windows';
const DOCTOR_TOOL = 'mcp__chrome_windows__chrome_doctor';
const CONNECT_TOOL = 'mcp__chrome_windows__chrome_connect';

function connectionResultStatus(event) {
  if (event.toolName !== DOCTOR_TOOL && event.toolName !== CONNECT_TOOL) return undefined;
  const isDoctor = event.toolName === DOCTOR_TOOL;
  if (event.isError) {
    return isDoctor ? 'Windows Chrome · status check failed' : 'Windows Chrome · connection failed';
  }
  let result = event.structuredContent;
  if (result === undefined) {
    try {
      result = JSON.parse((event.content ?? []).filter((block) => block.type === 'text')
        .map((block) => block.text).join('\n'));
    } catch {
      return 'Windows Chrome · status unavailable';
    }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return 'Windows Chrome · status unavailable';
  }
  if (isDoctor && result.platform !== 'win32') {
    return typeof result.platform === 'string'
      ? 'Windows Chrome · wrong host' : 'Windows Chrome · status unavailable';
  }
  const connected = isDoctor ? result.debugging?.connected : result.connected;
  if (connected === true) return 'Windows Chrome · connected';
  if (connected === false) return 'Windows Chrome · not connected';
  return 'Windows Chrome · status unavailable';
}

function connectionRequest(action) {
  const steps = action === 'connect'
    ? `Call ${DOCTOR_TOOL} once. If it fails or reports a platform other than win32, stop and report the error or wrong host. Otherwise call ${CONNECT_TOOL} once through the normal tool pipeline. Let the user approve Chrome's prompt if it appears. Report the actual connected result or failure; do not infer approval-needed solely from a timeout.`
    : `Call ${DOCTOR_TOOL} once. Report the returned platform, debugging discovery and connected state. If the host is not win32, report a wrong-host configuration. This status check does not perform a fresh CDP handshake; do not call chrome_connect.`;
  return `Windows Chrome ${action} check requested by the user: ${steps} Use only the chrome-windows MCP server in this Pi session. Do not list, claim, inspect or modify tabs. Do not use another browser, launch a separate client, reinstall, re-register, change configuration, or retry automatically. If tools are unavailable, report that and suggest /mcp. Keep the response concise.`;
}

export function createChromeWindowsExtension({ prepare = prepareWindowsChrome } = {}) {
  return function chromeWindowsExtension(pi) {
    let registeredConfig;
    let preparing = false;
    // Observe real tool outcomes, including calls made outside these commands.
    // These handlers only change the footer, never permissions or tool results.
    pi.on('tool_call', (event, ctx) => {
      if (event.toolName === CONNECT_TOOL) ctx.ui.setStatus(STATUS_KEY, 'Windows Chrome · connecting…');
      if (event.toolName === DOCTOR_TOOL) ctx.ui.setStatus(STATUS_KEY, 'Windows Chrome · checking status…');
    });
    pi.on('tool_result', (event, ctx) => {
      const status = connectionResultStatus(event);
      if (status !== undefined) ctx.ui.setStatus(STATUS_KEY, status);
    });
    pi.registerCommand('chrome-windows', {
      description: 'Windows Chrome: setup, connect, status, or config for persistent MCP settings',
      handler: async (args, ctx) => {
        const action = args.trim();
        if (action === 'connect' || action === 'status') {
          if (preparing) {
            ctx.ui.notify('Windows Chrome setup is still running. Try again after registration finishes.', 'warning');
            return;
          }
          const required = action === 'connect' ? [DOCTOR_TOOL, CONNECT_TOOL] : [DOCTOR_TOOL];
          const available = new Set(pi.getAllTools()
            .filter((tool) => tool.exposure !== 'hidden').map((tool) => tool.name));
          if (!required.every((name) => available.has(name))) {
            ctx.ui.setStatus(STATUS_KEY, 'Windows Chrome · MCP tools unavailable');
            ctx.ui.notify(`Windows Chrome MCP tools are not available in this Pi session. Registration requested by this extension: ${registeredConfig ? 'yes' : 'no'}. Check /mcp for disabled, overridden or connecting servers; run /chrome-windows if no Windows target is configured.`, 'warning');
            return;
          }
          if (!ctx.isIdle()) {
            ctx.ui.notify('Agent is busy. Run this command again when idle; no browser request was queued.', 'warning');
            return;
          }
          // Command contexts cannot execute tools directly. An ordinary agent turn
          // keeps the existing MCP transport, permission hooks and visible results.
          pi.sendUserMessage(connectionRequest(action));
          return;
        }
        if (action === 'config') {
          if (!registeredConfig) {
            ctx.ui.notify('Run /chrome-windows successfully in this Pi session first; no Windows paths will be guessed.', 'warning');
            return;
          }
          ctx.ui.notify(
            'Merge this entry into your Pi user-level mcp.json, preserving other servers, then /reload once. No settings have been written. A file-configured chrome-windows entry takes precedence over session registration.\n' +
              JSON.stringify({ mcpServers: { [SERVER_NAME]: registeredConfig } }, null, 2),
            'info',
          );
          return;
        }
        if (action) {
          ctx.ui.notify('Usage: /chrome-windows [connect|status|config]', 'warning');
          return;
        }
        if (preparing) {
          ctx.ui.notify('Windows Chrome setup is already running in this session.', 'warning');
          return;
        }
        if (registeredConfig) {
          ctx.ui.notify('Windows Chrome is already registered in this extension runtime. Use /chrome-windows connect to verify the handshake, /chrome-windows status for current host/status, or /mcp to inspect server configuration. Use /chrome-windows config for persistent settings.', 'info');
          return;
        }

        preparing = true;
        const progress = (message) => ctx.ui.setStatus(STATUS_KEY, message);
        try {
          const setup = await prepare({ packageRoot: PACKAGE_ROOT, onProgress: progress });
          progress('Registering Windows Chrome MCP…');
          const config = {
            command: process.execPath,
            args: [
              CLI_ENTRY,
              'serve',
              '--browser-host',
              'windows',
              '--windows-node',
              setup.nodePath,
              '--windows-entry',
              setup.windowsEntry,
            ],
            exposure: 'direct',
            description: 'Control explicitly selected Windows Chrome through WSL interop; not the Mac or a WSL-native browser.',
          };
          pi.registerMcpServer(SERVER_NAME, config);
          registeredConfig = config;
          ctx.ui.setStatus(STATUS_KEY, 'Windows MCP registered · connection not verified');
          ctx.ui.notify(
            `Opened ${setup.chromePath}. Enable remote debugging in the visible Chrome page and approve Chrome's prompt. Registration is session-only, not a verified connection. In THIS Pi session, run /chrome-windows connect to verify the handshake or /chrome-windows status to inspect host/status. Check /mcp for connection errors or a file-config override. Use /chrome-windows config to show persistent settings.`,
            'info',
          );
        } catch (error) {
          ctx.ui.setStatus(STATUS_KEY, undefined);
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        } finally {
          preparing = false;
        }
      },
    });
  };
}

export default createChromeWindowsExtension();

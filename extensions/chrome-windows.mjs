import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareWindowsChrome } from '../src/windows-bootstrap.mjs';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_ENTRY = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const SERVER_NAME = 'chrome-windows';
const STATUS_KEY = 'chrome-windows';

export function createChromeWindowsExtension({ prepare = prepareWindowsChrome } = {}) {
  return function chromeWindowsExtension(pi) {
    pi.registerCommand('chrome-windows', {
      description: 'Prepare Windows Chrome from WSL2 and attach it as an MCP browser target',
      handler: async (args, ctx) => {
        if (args.trim()) {
          ctx.ui.notify('Usage: /chrome-windows', 'warning');
          return;
        }

        const progress = (message) => ctx.ui.setStatus(STATUS_KEY, message);
        try {
          const setup = await prepare({ packageRoot: PACKAGE_ROOT, onProgress: progress });
          progress('Registering Windows Chrome MCP…');
          pi.registerMcpServer(SERVER_NAME, {
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
            description: 'Control the explicitly selected Windows Chrome browser from this WSL2 Pi session.',
          });
          ctx.ui.setStatus(STATUS_KEY, 'Windows Chrome MCP registered');
          ctx.ui.notify(
            `Opened ${setup.chromePath}. Enable remote debugging in the visible Chrome page and approve Chrome's prompt; Windows browser tools are connecting now.`,
            'info',
          );
        } catch (error) {
          ctx.ui.setStatus(STATUS_KEY, undefined);
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
      },
    });
  };
}

export default createChromeWindowsExtension();

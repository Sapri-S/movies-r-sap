import { packager } from '@electron/packager';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await stat(resolve(root, 'desktop/main.mjs'));
const output = await packager({
  dir: root,
  name: 'Movies R Sap',
  executableName: 'Movies R Sap',
  appBundleId: 'com.moviesrsap.desktop',
  appVersion: '1.0.0',
  buildVersion: '1.0.0',
  platform: 'win32',
  arch: 'x64',
  electronVersion: '45.0.0',
  out: resolve(root, 'release'),
  overwrite: true,
  asar: true,
  prune: true,
  icon: resolve(root, 'desktop/icon.ico'),
  ignore: [
    /^\/(?:node_modules|data|tests|prototypes|docs|scripts|release|\.openai|\.test-data|\.git)(?:\/|$)/,
    /\.(?:log|cmd|md)$/i,
    /^\/package-lock\.json$/,
  ],
  win32metadata: {
    CompanyName: 'Movies R Sap',
    FileDescription: 'Your personal cinema',
    ProductName: 'Movies R Sap',
    InternalName: 'Movies R Sap',
    OriginalFilename: 'Movies R Sap.exe',
  },
});
console.log(`\nWindows desktop app ready:\n${resolve(output[0], 'Movies R Sap.exe')}\n`);
console.log('Keep the entire application folder together. Your library is stored separately in your Windows profile.');

import { packager } from '@electron/packager';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat, mkdir, copyFile } from 'node:fs/promises';
import ffmpegPath from 'ffmpeg-static';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await stat(resolve(root, 'desktop/main.mjs'));
await stat(ffmpegPath);
// Executables run outside app.asar. Only the engine and its notices are copied;
// development dependencies and personal libraries stay outside the package.
const converterResources = resolve(root, '.test-data/packaging-resources/ffmpeg');
await mkdir(converterResources, { recursive: true });
for (const [from, to] of [
  [ffmpegPath, 'ffmpeg.exe'],
  [`${ffmpegPath}.LICENSE`, 'LICENSE.txt'],
  [`${ffmpegPath}.README`, 'BUILD-README.txt'],
  [resolve(root, 'THIRD_PARTY_NOTICES.md'), 'THIRD_PARTY_NOTICES.md'],
]) await copyFile(from, join(converterResources, to));
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
  out: process.env.MOVIES_PACKAGE_OUTPUT ? resolve(process.env.MOVIES_PACKAGE_OUTPUT) : resolve(root, 'release'),
  overwrite: true,
  asar: true,
  prune: true,
  icon: resolve(root, 'desktop/icon.ico'),
  extraResource: [converterResources],
  ignore: [
    /^\/(?:node_modules|data|catalog-imports|tests|prototypes|docs|scripts|release|\.openai|\.test-data|\.git)(?:\/|$)/,
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

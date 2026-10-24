import { app, BrowserWindow, Menu, dialog } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const APP_NAME = 'Movies R Sap';
const smokeTest = process.argv.includes('--smoke-test');
const smokeArgument = process.argv.find((argument) => argument.startsWith('--smoke-data-dir='));
let argumentError = null;
let smokeRoot = null;

app.setName(APP_NAME);
app.setAppUserModelId('com.moviesrsap.desktop');

// Only trusted launch arguments can select a test directory. Nothing in the
// renderer has Node access, a preload bridge, or an IPC path to these settings.
if (smokeTest) {
  const candidate = smokeArgument?.slice('--smoke-data-dir='.length);
  if (!candidate || !path.isAbsolute(candidate)) {
    argumentError = new Error('A desktop smoke test requires --smoke-data-dir=<absolute isolated test directory>.');
  } else {
    smokeRoot = path.resolve(candidate);
    const profile = path.join(smokeRoot, 'profile');
    const sessionPath = path.join(profile, 'session');
    try {
      mkdirSync(sessionPath, { recursive: true });
      app.setPath('userData', profile);
      app.setPath('sessionData', sessionPath);
      app.setAppLogsPath(path.join(smokeRoot, 'logs'));
    } catch (error) { argumentError = error; }
  }
} else if (smokeArgument) {
  argumentError = new Error('--smoke-data-dir is accepted only together with --smoke-test.');
}

let mainWindow = null;
let backend = null;
let backendPromise = null;
let ownOrigin = null;
let shuttingDown = false;
let finalQuit = false;
let shutdownPromise = null;
let exitCode = 0;
let startupFailureShown = false;

function isOwnOrigin(value) {
  try { return ownOrigin !== null && new URL(value).origin === ownOrigin; } catch { return false; }
}

function focusWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || smokeTest) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function shutdown(code = 0) {
  exitCode = Math.max(exitCode, code);
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    // createApp may still be opening SQLite when an OS quit request arrives.
    const runningBackend = backend || await backendPromise?.catch(() => null);
    try { await runningBackend?.close(); } catch (error) {
      exitCode = 1;
      console.error('Desktop library shutdown failed:', error.message);
    }
    finalQuit = true;
    if (exitCode) app.exit(exitCode);
    else app.quit();
  })();
  return shutdownPromise;
}

async function fatalStartup(error) {
  if (!startupFailureShown) {
    startupFailureShown = true;
    console.error('DESKTOP_STARTUP_ERROR', error?.stack || error);
    if (!smokeTest) dialog.showErrorBox(`${APP_NAME} could not start`, `${error?.message || String(error)}\n\nYour saved library has not been removed. Close another copy of the app if one is already using this library, then try again.`);
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  await shutdown(1);
}

function installSessionPolicy(window) {
  const session = window.webContents.session;
  // File pickers and ordinary video playback do not need camera/microphone,
  // filesystem, location, notifications, or other website permissions.
  const allowFullscreen = (contents, permission, origin) => permission === 'fullscreen' &&
    contents === mainWindow?.webContents && isOwnOrigin(origin);
  session.setPermissionCheckHandler((contents, permission, origin) => allowFullscreen(contents, permission, origin));
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowFullscreen(contents, permission, details.requestingUrl || contents.getURL()));
  });
  session.on('will-download', (event, item, contents) => {
    let url;
    try { url = new URL(item.getURL()); } catch { event.preventDefault(); return; }
    const catalogTemplate = url.pathname === '/assets/catalog-template.csv';
    if (contents !== mainWindow?.webContents || !isOwnOrigin(url.href) || (url.pathname !== '/api/export' && !catalogTemplate)) {
      event.preventDefault();
      return;
    }
    // Leaving savePath unset lets Electron show the native save dialog. Export
    // remains an intentional user choice rather than a silent disk write.
    item.setSaveDialogOptions({
      title: catalogTemplate ? 'Save movie catalog template' : 'Export library metadata',
      defaultPath: path.join(app.getPath('documents'), catalogTemplate ? 'catalog-template.csv' : 'movies-r-sap-library.json'),
      filters: catalogTemplate ? [{ name: 'Movie catalog (CSV)', extensions: ['csv'] }] : [{ name: 'Library metadata (JSON)', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    item.once('done', (_event, state) => {
      if (state === 'interrupted' && !shuttingDown && !smokeTest) {
        void dialog.showMessageBox(mainWindow || undefined, { type: 'error', title: 'Export interrupted',
          message: 'The metadata export could not be saved.', detail: 'Choose another location and try exporting again.' });
      }
    });
  });
}

function installWindowPolicy(window) {
  const contents = window.webContents;
  const blockForeignNavigation = (event, legacyUrl) => {
    if (!isOwnOrigin(event.url || legacyUrl)) event.preventDefault();
  };
  contents.on('will-navigate', blockForeignNavigation);
  contents.on('will-frame-navigate', blockForeignNavigation);
  contents.on('will-redirect', blockForeignNavigation);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-prevent-unload', (event) => {
    if (shuttingDown || smokeTest) { event.preventDefault(); return; }
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question', title: 'Close Movies R Sap?', message: 'A video is still being added.',
      detail: 'Closing cancels unfinished uploads and MP4 conversions. Original videos and completed copies stay saved.',
      buttons: ['Keep app open', 'Close app'], defaultId: 0, cancelId: 0, noLink: true,
    });
    // Electron's event override permits the unload after explicit confirmation.
    if (choice === 1) event.preventDefault();
  });
  contents.on('render-process-gone', (_event, details) => {
    if (!shuttingDown) void fatalStartup(new Error(`The app window stopped unexpectedly (${details.reason}). Restart Movies R Sap to reopen your library.`));
  });
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '&File', submenu: [{ label: 'E&xit', accelerator: 'Alt+F4', click: () => app.quit() }] },
    { label: '&View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: '&Help', submenu: [{ label: `About ${APP_NAME}`, click: () => {
      void dialog.showMessageBox(mainWindow || undefined, { type: 'info', title: `About ${APP_NAME}`,
        message: APP_NAME, detail: `Version ${app.getVersion()}\nYour movies. Your own universe.\n\nYour private library stays on this PC. DVD importing and home-server access are planned features.`,
        buttons: ['OK'] });
    } }] },
  ]));
}

async function createWindow() {
  const icon = path.join(app.getAppPath(), 'desktop', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 980, minHeight: 680,
    title: APP_NAME, backgroundColor: '#101112', autoHideMenuBar: true,
    show: false, ...(existsSync(icon) ? { icon } : {}),
    webPreferences: {
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
      allowRunningInsecureContent: false, navigateOnDragDrop: false,
    },
  });
  const window = mainWindow;
  installSessionPolicy(window);
  installWindowPolicy(window);
  window.once('ready-to-show', () => { if (!smokeTest && !shuttingDown) focusWindow(); });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
    void shutdown();
  });
  await window.loadURL(`${ownOrigin}/`);
  return window;
}

async function runSmokeTest(window, dataDir) {
  const deadline = Date.now() + 15000;
  let snapshot;
  while (Date.now() < deadline && !window.isDestroyed()) {
    // This test only reads the real page and performs GETs. It neither injects
    // app functionality nor bypasses sandboxing through a preload/IPC bridge.
    snapshot = await window.webContents.executeJavaScript(`(async () => {
      const response = await fetch('/api/health');
      const health = await response.json();
      const titlesResponse = await fetch('/api/titles');
      const titles = await titlesResponse.json();
      const converterResponse = await fetch('/api/conversion');
      const converter = await converterResponse.json();
      const catalogResponse = await fetch('/api/catalog');
      const catalog = await catalogResponse.json();
      const templateResponse = await fetch('/assets/catalog-template.csv');
      const catalogTemplate = await templateResponse.text();
      return {
        title: document.title,
        readyState: document.readyState,
        hasNavigation: !!document.querySelector('nav[aria-label="Main navigation"]'),
        hasUpload: !!document.querySelector('[data-action="upload"]'),
        hasCollection: !!document.querySelector('#collection'),
        artworkCards: document.querySelectorAll('#poster-grid .poster-card').length,
        loading: !!document.querySelector('#movie-grid .loading-state'),
        connected: document.querySelector('#connection-banner')?.hidden === true,
        health: response.ok && health.ok === true,
        converterAvailable: converterResponse.ok && converter.available === true,
        catalogAvailable: catalogResponse.ok && catalog.localOnly === true && Number.isInteger(catalog.totalTitles),
        catalogTemplateAvailable: templateResponse.ok && catalogTemplate.startsWith('id,title,year,'),
        titleCount: titlesResponse.ok && Array.isArray(titles) ? titles.length : null,
        rendererHasNode: typeof process !== 'undefined' || typeof require !== 'undefined'
      };
    })()`, false);
    if (snapshot.health && snapshot.connected && !snapshot.loading && snapshot.artworkCards > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const preferences = window.webContents.getLastWebPreferences();
  const secure = preferences.nodeIntegration === false && preferences.contextIsolation === true &&
    preferences.sandbox === true && preferences.webSecurity === true && preferences.webviewTag === false;
  if (!snapshot || !snapshot.title.includes(APP_NAME) || !snapshot.hasNavigation || !snapshot.hasUpload ||
      !snapshot.hasCollection || !snapshot.artworkCards || snapshot.loading || !snapshot.connected ||
      !snapshot.health || !snapshot.converterAvailable || !snapshot.catalogAvailable || !snapshot.catalogTemplateAvailable ||
      snapshot.titleCount === null || snapshot.rendererHasNode || !secure) {
    throw new Error(`Desktop smoke test failed: ${JSON.stringify({ snapshot, secure })}`);
  }
  console.log('DESKTOP_SMOKE_OK', JSON.stringify({ ...snapshot, secure, electron: process.versions.electron,
    node: process.versions.node, url: ownOrigin, dataDir }));
  window.destroy();
  await shutdown();
}

const ownsInstanceLock = app.requestSingleInstanceLock();
if (!ownsInstanceLock) {
  finalQuit = true;
  app.quit();
} else {
  app.on('second-instance', focusWindow);
  app.on('activate', focusWindow);
  app.on('before-quit', (event) => {
    if (finalQuit) return;
    event.preventDefault();
    // Close the renderer first so its existing unload handler can persist the
    // final watch position. A pending upload gets the native confirmation above.
    if (mainWindow && !mainWindow.isDestroyed() && !shuttingDown) mainWindow.close();
    else void shutdown();
  });
  app.on('window-all-closed', () => { void shutdown(); });

  void app.whenReady().then(async () => {
    if (argumentError) throw argumentError;
    const dataDir = smokeTest ? path.join(smokeRoot, 'library') : path.join(app.getPath('userData'), 'library');
    // Dynamic import catches unsupported runtime modules as a normal startup
    // error. Database and video writes always remain outside packaged app.asar.
    backendPromise = import('../apps/server/app.mjs').then(({ createApp }) => createApp({
      dataDir, webDir: path.join(app.getAppPath(), 'dist'),
      conversion: app.isPackaged ? { ffmpegPath: path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe') } : {},
    }));
    backend = await backendPromise;
    if (shuttingDown) return;
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      backend.server.once('error', onError);
      backend.server.listen(0, '127.0.0.1', () => { backend.server.removeListener('error', onError); resolve(); });
    });
    if (shuttingDown) return;
    ownOrigin = `http://127.0.0.1:${backend.server.address().port}`;
    backend.server.on('error', (error) => { void fatalStartup(error); });
    console.log('DESKTOP_RUNTIME', JSON.stringify({ electron: process.versions.electron, node: process.versions.node,
      chromium: process.versions.chrome, url: ownOrigin, dataDir, packaged: app.isPackaged, smokeTest }));
    installMenu();
    const window = await createWindow();
    if (smokeTest) await runSmokeTest(window, dataDir);
  }).catch(fatalStartup);
}

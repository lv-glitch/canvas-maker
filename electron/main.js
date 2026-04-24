import { app, BrowserWindow, shell, Menu } from 'electron';
import electronUpdater from 'electron-updater';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startServer } from '../src/server.js';

const { autoUpdater } = electronUpdater;
const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_TITLE = '55 Music Canvas Generator';

let mainWindow;
let serverHandle;

async function createWindow() {
  // Start the Express server on a random localhost port so multiple app instances
  // can coexist. The renderer loads this URL — same code as the web version.
  serverHandle = await startServer({ port: 0, host: '127.0.0.1' });

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 780,
    minWidth: 640,
    minHeight: 560,
    title: APP_TITLE,
    backgroundColor: '#0a0a0a',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: process.platform === 'linux' ? join(__dirname, '..', 'build', 'icon.png') : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // External http/https links open in the user's default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  await mainWindow.loadURL(serverHandle.url);
}

function buildMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  // Keep the default macOS menu (Edit/View/Window/Help) but set the app name
  const template = [
    {
      label: APP_TITLE,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => autoUpdater.checkForUpdates().catch(() => {}),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function wireUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (err) => {
    // Swallow "no update feed configured" errors silently until release pipeline
    // is set up. All other errors get logged.
    if (!/ENOENT|404|ERR_INVALID_URL|unable to find/i.test(String(err))) {
      console.error('auto-update error:', err);
    }
  });
  // Will be a no-op until `publish` config in package.json points at a real feed.
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

app.whenReady().then(async () => {
  buildMenu();
  await createWindow();
  wireUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverHandle?.server) serverHandle.server.close();
});

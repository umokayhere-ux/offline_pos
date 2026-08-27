'use strict';

const path = require('path');
const { app, BrowserWindow, Menu, shell, dialog, session: electronSession } = require('electron');

const logger = require('./logger');
const connection = require('./database/connection');
const { seedReferenceData } = require('./database/seed');
const { registerIpcHandlers } = require('./ipc');
const backup = require('./backup/backup.service');
const settings = require('./services/settings.service');
const appSession = require('./security/session');

/**
 * Electron main process.
 *
 * Security posture:
 *   - context isolation on, node integration off, sandboxed renderer
 *   - the renderer loads only local files; navigation and new windows are blocked
 *   - a Content-Security-Policy that permits no remote origin at all, which is
 *     also what makes the application genuinely offline
 */

const isDevelopment = process.env.NODE_ENV === 'development';
let mainWindow = null;
let sessionTimer = null;

// A single instance only: two copies writing to one SQLite file is asking for
// trouble on a shop counter.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function databasePath() {
  return path.join(app.getPath('userData'), 'data', 'shop.db');
}

function bootstrapDatabase() {
  const file = databasePath();
  logger.info(`Opening database at ${file}`);
  const db = connection.initDatabase(file);
  seedReferenceData(db);
  backup.setDefaultDirectory(path.join(app.getPath('userData'), 'backups'));
  appSession.setTimeoutMinutes(settings.get('security.session_timeout_minutes', 30));
  return db;
}

function applyContentSecurityPolicy() {
  electronSession.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; "
          + "script-src 'self'; "
          + "style-src 'self' 'unsafe-inline'; "
          + "img-src 'self' data:; "
          + "font-src 'self'; "
          + "connect-src 'self'; "
          + "object-src 'none'; "
          + "base-uri 'none'; "
          + "form-action 'none'; "
          + "frame-ancestors 'none'"
        ]
      }
    });
  });

  // Deny every permission request: the POS needs no camera, microphone or
  // geolocation, and a compromised page should not be able to ask.
  electronSession.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    logger.warn(`Blocked permission request: ${permission}`);
    callback(false);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0f172a',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    title: 'iTtEk POS',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      devTools: isDevelopment
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
    if (isDevelopment) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // No navigation away from the bundled application, and no popup windows.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    if (target.protocol !== 'file:') {
      event.preventDefault();
      logger.warn(`Blocked navigation to ${url}`);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    logger.warn(`Blocked window open for ${url}`);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logger.error('Renderer process gone', details);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'New Sale', accelerator: 'CmdOrCtrl+N', click: () => send('shortcut', 'pos.new') },
        { label: 'Print Receipt', accelerator: 'CmdOrCtrl+P', click: () => send('shortcut', 'print') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: '&Go',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => send('shortcut', 'go:dashboard') },
        { label: 'Point of Sale', accelerator: 'CmdOrCtrl+2', click: () => send('shortcut', 'go:pos') },
        { label: 'Products', accelerator: 'CmdOrCtrl+3', click: () => send('shortcut', 'go:products') },
        { label: 'Reports', accelerator: 'CmdOrCtrl+4', click: () => send('shortcut', 'go:reports') }
      ]
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' }, { role: 'forcereload' }, { type: 'separator' },
        { role: 'resetzoom' }, { role: 'zoomin' }, { role: 'zoomout' },
        { type: 'separator' }, { role: 'togglefullscreen' },
        ...(isDevelopment ? [{ role: 'toggledevtools' }] : [])
      ]
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Keyboard shortcuts',
            message: 'Point of Sale shortcuts',
            detail: [
              'F2  Search products',
              'F3  Search customer',
              'F4  Hold the current sale',
              'F5  Take payment',
              'F6  View held sales',
              'F8  Clear the cart',
              'Ctrl+P  Print the last receipt',
              'Esc  Close the open dialog'
            ].join('\n')
          })
        },
        {
          label: 'Open Log Folder',
          click: () => shell.showItemInFolder(logger.getLogFile() || app.getPath('userData'))
        },
        {
          label: 'About iTtEk POS',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'About',
            message: `iTtEk POS ${app.getVersion()}`,
            detail: 'Offline shop management and point of sale.\n'
              + 'All amounts are in Ghana Cedis (GHS).\n'
              + 'This application works without an internet connection.'
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/** Tell the renderer as soon as an idle session lapses, so the UI locks itself. */
function startSessionWatcher() {
  sessionTimer = setInterval(() => {
    if (appSession.isExpired()) {
      appSession.end();
      send('session.expired', { reason: 'timeout' });
    }
  }, 30000);
}

app.whenReady().then(async () => {
  logger.configure(path.join(app.getPath('userData'), 'logs'));
  logger.info(`iTtEk POS ${app.getVersion()} starting on ${process.platform}`);

  try {
    applyContentSecurityPolicy();
    bootstrapDatabase();
    registerIpcHandlers();
    buildMenu();
    createWindow();
    startSessionWatcher();

    // An automatic backup runs after the window is up so it never delays start-up.
    setTimeout(() => {
      backup.runAutomaticBackupIfDue().then((row) => {
        if (row) send('app.notice', { type: 'success', message: `Automatic backup saved: ${row.filename}` });
      });
    }, 5000);
  } catch (error) {
    logger.error('Startup failed', error);
    dialog.showErrorBox(
      'iTtEk POS could not start',
      `${error.message}\n\nIf this keeps happening, restore your most recent backup.`
    );
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (sessionTimer) clearInterval(sessionTimer);
  try {
    connection.closeDatabase();
    logger.info('Database closed cleanly');
  } catch (error) {
    logger.error('Failed to close the database cleanly', error);
  }
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception in the main process', error);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection in the main process', reason);
});

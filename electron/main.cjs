const { app, BrowserWindow, Menu, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.PORT || (app.isPackaged ? 3108 : 3001);
const APP_TOKEN = crypto.randomBytes(16).toString('hex');
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const ROOT_DIR = path.join(__dirname, '..');
const ICON_PNG = path.join(__dirname, 'assets', 'icon.png');

let mainWindow = null;
let serverProc = null;

try {
  const userData = app.getPath('userData');
  process.env.LICENSE_FILE = path.join(userData, 'license.json');
} catch {}

function waitForServer(timeoutMs = 45000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${SERVER_URL}/api/health`, { timeout: 2000 }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (res.statusCode === 200 && data && data.token === APP_TOKEN) return resolve(true);
          } catch {}
          retry();
        });
        res.resume();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
      function retry() {
        if (serverProc && serverProc.exitCode !== null) return reject(new Error('Server berhenti'));
        if (Date.now() - start > timeoutMs) return reject(new Error('Server timeout'));
        setTimeout(tick, 800);
      }
    };
    tick();
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const serverJs = path.join(ROOT_DIR, 'server.js');
    if (!fs.existsSync(serverJs)) return reject(new Error('server.js tidak ditemukan'));
    serverProc = spawn(process.execPath, [serverJs], {
      env: {
        ...process.env,
        PORT: String(PORT),
        GMST_TOKEN: APP_TOKEN,
        ELECTRON_RUN_AS_NODE: '1'
      },
      stdio: 'ignore',
      windowsHide: true
    });
    serverProc.on('error', reject);
    waitForServer().then(resolve).catch(reject);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1024,
    minHeight: 640,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL(SERVER_URL);
  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('window-control', (_evt, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === 'close') mainWindow.close();
});

ipcMain.handle('open-external', async (_evt, url) => {
  try {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return { success: true };
    }
    return { success: false, error: 'URL tidak valid' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// POPUP LOGIN INSTAGRAM & AMBIL COOKIE SESI OTOMATIS
ipcMain.handle('connect-instagram', async () => {
  return new Promise((resolve) => {
    const authWindow = new BrowserWindow({
      width: 480,
      height: 680,
      title: 'Login Instagram',
      parent: mainWindow,
      modal: true,
      autoHideMenuBar: true
    });

    authWindow.loadURL('https://www.instagram.com/accounts/login/');

    const checkCookies = async () => {
      try {
        const ses = authWindow.webContents.session;
        const cookies = await ses.cookies.get({ domain: '.instagram.com' });
        const sessionId = cookies.find(c => c.name === 'sessionid')?.value;
        const csrfToken = cookies.find(c => c.name === 'csrftoken')?.value;
        const userId = cookies.find(c => c.name === 'ds_user_id')?.value;

        if (sessionId) {
          authWindow.close();
          resolve({ success: true, session: { sessionId, csrfToken, userId } });
        }
      } catch {}
    };

    authWindow.webContents.on('did-finish-load', checkCookies);
    authWindow.on('closed', () => resolve({ success: false, error: 'Login dibatalkan' }));
  });
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    await startServer();
  } catch (err) {
    dialog.showErrorBox('Gagal memulai server', err.message);
    app.quit();
    return;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProc && serverProc.exitCode === null) {
    try { serverProc.kill(); } catch {}
  }
  if (process.platform !== 'darwin') app.quit();
});

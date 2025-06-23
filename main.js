const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const pty = require('node-pty');
const os = require('os');

let mainWindow;
let ptyProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#2d2d2d',
    show: false
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    if (ptyProcess) {
      ptyProcess.kill();
    }
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Terminal handling
ipcMain.on('terminal-start', (event) => {
  const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
  
  ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env
  });

  ptyProcess.onData((data) => {
    event.reply('terminal-data', data);
  });

  ptyProcess.onExit(() => {
    event.reply('terminal-exit');
  });
});

ipcMain.on('terminal-input', (event, data) => {
  if (ptyProcess) {
    ptyProcess.write(data);
  }
});

ipcMain.on('terminal-resize', (event, cols, rows) => {
  if (ptyProcess) {
    ptyProcess.resize(cols, rows);
  }
}); 
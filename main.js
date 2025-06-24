const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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

app.whenReady().then(() => {
  createWindow();
  
  // Register IPC handlers after app is ready
  setupIpcHandlers();
});

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

function setupIpcHandlers() {
  // Terminal handling
  ipcMain.on('terminal-start', (event, startDirectory = null) => {
    const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
    const cwd = startDirectory || process.cwd();
    
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: cwd,
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

  // Change terminal working directory
  ipcMain.handle('change-terminal-directory', async (event, newPath) => {
    try {
      // Store current terminal size
      let cols = 80, rows = 24;
      if (ptyProcess) {
        cols = ptyProcess.cols || 80;
        rows = ptyProcess.rows || 24;
        // Kill existing process
        ptyProcess.kill();
      }
      
      // Start new process in the new directory
      const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
      
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: cols,
        rows: rows,
        cwd: newPath,
        env: process.env
      });

      ptyProcess.onData((data) => {
        // Send data to all renderer processes
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal-data', data);
        }
      });

      ptyProcess.onExit(() => {
        // Send exit event to all renderer processes
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal-exit');
        }
      });
      
      return { success: true };
    } catch (error) {
      console.error('Error changing terminal directory:', error);
      return { success: false, error: error.message };
    }
  });

  // Directory dialog handling
  ipcMain.handle('show-directory-dialog', async (event, currentPath) => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        defaultPath: currentPath,
        title: 'Select Directory'
      });
      
      return result;
    } catch (error) {
      console.error('Error in show-directory-dialog handler:', error);
      throw error;
    }
  });
} 
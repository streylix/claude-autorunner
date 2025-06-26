const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const pty = require('node-pty');
const os = require('os');
const fs = require('fs').promises;

let mainWindow;
let ptyProcess;

// macOS priority mode settings
function configureMacOSPriorityMode() {
  if (process.platform === 'darwin') {
    // Prevent App Nap to ensure continuous operation
    app.setAppUserModelId('com.terminalgui.priority');
    
    // Configure app to run in background
    app.dock.hide(); // Hide from dock initially
    app.on('before-quit', (event) => {
      // Prevent quit unless explicitly requested
      if (!app.isQuiting) {
        event.preventDefault();
        if (mainWindow) {
          mainWindow.hide();
        }
      }
    });
    
    // Handle window close to minimize instead of quit
    app.on('window-all-closed', () => {
      // On macOS, keep app running even when all windows are closed
      // This ensures background processing continues
      return false;
    });
    
    // Configure app to prevent automatic termination
    if (app.setUserTasks) {
      app.setUserTasks([]);
    }
    
    // Ensure app stays active
    app.setLoginItemSettings({
      openAtLogin: false, // User can enable this manually
      openAsHidden: true
    });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      backgroundThrottling: false // Prevent background throttling
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#2d2d2d',
    show: false,
    // macOS specific settings for priority mode
    ...(process.platform === 'darwin' && {
      minimizable: true,
      closable: true,
      alwaysOnTop: false, // Don't force always on top
      skipTaskbar: false, // Show in taskbar
      hasShadow: true,
      transparent: false,
      vibrancy: 'dark',
      titleBarOverlay: false
    })
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    
    // macOS: Show dock icon when window is shown
    if (process.platform === 'darwin') {
      app.dock.show();
    }
  });

  mainWindow.on('closed', () => {
    if (ptyProcess) {
      ptyProcess.kill();
    }
    mainWindow = null;
  });
  
  // macOS: Handle window minimize/hide to continue background processing
  mainWindow.on('minimize', () => {
    if (process.platform === 'darwin') {
      app.dock.hide();
    }
  });
  
  mainWindow.on('restore', () => {
    if (process.platform === 'darwin') {
      app.dock.show();
    }
  });
  
  // Handle close button to minimize instead of quit
  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
      app.dock.hide();
    }
  });
}

// Configure priority mode before app ready
if (process.platform === 'darwin') {
  configureMacOSPriorityMode();
}

app.whenReady().then(() => {
  createWindow();
  
  // Register IPC handlers after app is ready
  setupIpcHandlers();
  
  // macOS: Configure additional priority settings after app is ready
  if (process.platform === 'darwin') {
    // Prevent system sleep while app is running
    const { powerSaveBlocker } = require('electron');
    const id = powerSaveBlocker.start('prevent-app-suspension');
    console.log('Power save blocker started:', id);
    
    // Handle system lock/unlock events
    const { systemPreferences } = require('electron');
    if (systemPreferences.subscribeNotification) {
      systemPreferences.subscribeNotification(
        'com.apple.screenIsLocked',
        () => {
          console.log('Screen locked - continuing background operation');
        }
      );
      
      systemPreferences.subscribeNotification(
        'com.apple.screenIsUnlocked',
        () => {
          console.log('Screen unlocked');
        }
      );
    }
  }
});

// macOS: Handle dock icon click to restore window
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow) {
    mainWindow.show();
    if (process.platform === 'darwin') {
      app.dock.show();
    }
  }
});

// Add IPC handler for quitting app
ipcMain.handle('quit-app', () => {
  app.isQuiting = true;
  app.quit();
});

// Add IPC handler for hiding app
ipcMain.handle('hide-app', () => {
  if (mainWindow) {
    mainWindow.hide();
    if (process.platform === 'darwin') {
      app.dock.hide();
    }
  }
});

// Add IPC handler for toggling auto-start
ipcMain.handle('toggle-auto-start', (event, enabled) => {
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true
    });
    return app.getLoginItemSettings().openAtLogin;
  }
  return false;
});

// Add IPC handler for getting auto-start status
ipcMain.handle('get-auto-start-status', () => {
  if (process.platform === 'darwin') {
    return app.getLoginItemSettings().openAtLogin;
  }
  return false;
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

  // File handling for drag & drop
  ipcMain.handle('handle-file-drop', async (event, files) => {
    try {
      const results = [];
      const importedDir = path.join(__dirname, 'imported-files');
      
      // Ensure imported-files directory exists
      try {
        await fs.access(importedDir);
      } catch {
        await fs.mkdir(importedDir, { recursive: true });
      }
      
      for (const file of files) {
        const fileName = path.basename(file.path);
        const fileExt = path.extname(fileName);
        const baseName = path.basename(fileName, fileExt);
        const timestamp = Date.now();
        const uniqueName = `${baseName}_${timestamp}${fileExt}`;
        const destinationPath = path.join(importedDir, uniqueName);
        
        // Copy file to imported directory
        await fs.copyFile(file.path, destinationPath);
        
        results.push({
          originalName: fileName,
          newName: uniqueName,
          destinationPath: destinationPath,
          relativePath: `./imported-files/${uniqueName}`,
          size: file.size,
          type: file.type
        });
      }
      
      return { success: true, files: results };
    } catch (error) {
      console.error('Error handling file drop:', error);
      return { success: false, error: error.message };
    }
  });

  // Save screenshot from clipboard
  ipcMain.handle('save-screenshot', async (event, imageData) => {
    try {
      const importedDir = path.join(__dirname, 'imported-files');
      
      // Ensure imported-files directory exists
      try {
        await fs.access(importedDir);
      } catch {
        await fs.mkdir(importedDir, { recursive: true });
      }
      
      const timestamp = Date.now();
      const fileName = `screenshot_${timestamp}.png`;
      const filePath = path.join(importedDir, fileName);
      
      // Convert base64 to buffer and save
      const buffer = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      await fs.writeFile(filePath, buffer);
      
      return {
        success: true,
        fileName: fileName,
        filePath: filePath,
        relativePath: `./imported-files/${fileName}`
      };
    } catch (error) {
      console.error('Error saving screenshot:', error);
      return { success: false, error: error.message };
    }
  });

  // Get file information
  ipcMain.handle('get-file-info', async (event, filePath) => {
    try {
      const stats = await fs.stat(filePath);
      const fileName = path.basename(filePath);
      
      return {
        success: true,
        name: fileName,
        size: stats.size,
        modified: stats.mtime,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory()
      };
    } catch (error) {
      console.error('Error getting file info:', error);
      return { success: false, error: error.message };
    }
  });

  // Get sound effects files
  ipcMain.handle('get-sound-effects', async () => {
    try {
      const soundEffectsDir = path.join(__dirname, 'soundeffects');
      const files = await fs.readdir(soundEffectsDir);
      
      // Filter for audio files only
      const audioFiles = files.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.wav', '.mp3', '.ogg', '.m4a', '.aac'].includes(ext);
      });
      
      return { success: true, files: audioFiles };
    } catch (error) {
      console.error('Error reading sound effects directory:', error);
      return { success: false, error: error.message, files: [] };
    }
  });
} 
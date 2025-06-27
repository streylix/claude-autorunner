const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const pty = require('node-pty');
const os = require('os');
const fs = require('fs').promises;

let mainWindow;
let ptyProcess;

function getIcon() {
  const fs = require('fs');
  
  // Try different icon formats based on platform
  const iconOptions = [];
  
  if (process.platform === 'darwin') {
    iconOptions.push('icon.png', 'icon.icns');
  } else if (process.platform === 'win32') {
    iconOptions.push('icon.ico', 'icon.png');
  } else {
    iconOptions.push('icon.png', 'icon.icns');
  }
  
  for (const iconFile of iconOptions) {
    const iconPath = path.join(__dirname, iconFile);
    try {
      if (fs.existsSync(iconPath)) {
        console.log('Using icon:', iconPath);
        return iconPath;
      }
    } catch (error) {
      console.warn('Error checking icon:', iconPath, error.message);
    }
  }
  
  console.warn('No suitable icon found, using default');
  return undefined;
}


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      backgroundThrottling: false
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#2d2d2d',
    show: false,
    icon: getIcon(),
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
  
  // Set dock icon (macOS specific)
  if (process.platform === 'darwin') {
    try {
      const pngIconPath = path.join(__dirname, 'icon.png');
      console.log('Setting dock icon from:', pngIconPath);
      app.dock.setIcon(pngIconPath);
    } catch (error) {
      console.error('Failed to set PNG dock icon:', error);
      // Fallback to ICNS if PNG fails
      try {
        const icnsIconPath = path.join(__dirname, 'icon.icns');
        console.log('Fallback to ICNS icon:', icnsIconPath);
        app.dock.setIcon(icnsIconPath);
      } catch (icnsError) {
        console.error('Failed to set ICNS dock icon:', icnsError);
      }
    }
  }
  
  // Register IPC handlers after app is ready
  setupIpcHandlers();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow) {
    mainWindow.show();
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

  // Backup localStorage to desktop
  ipcMain.handle('backup-localstorage', async (event, localStorageData) => {
    try {
      const desktopPath = path.join(os.homedir(), 'Desktop');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFileName = `terminal-gui-backup-${timestamp}.json`;
      const backupPath = path.join(desktopPath, backupFileName);
      
      const backupData = {
        timestamp: new Date().toISOString(),
        localStorage: localStorageData
      };
      
      await fs.writeFile(backupPath, JSON.stringify(backupData, null, 2));
      
      return { success: true, filePath: backupPath };
    } catch (error) {
      console.error('Error creating localStorage backup:', error);
      return { success: false, error: error.message };
    }
  });

  // Restore localStorage from backup file
  ipcMain.handle('restore-localstorage', async (event) => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select localStorage Backup File',
        defaultPath: path.join(os.homedir(), 'Desktop'),
        filters: [
          { name: 'JSON Files', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
      });
      
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      
      const backupPath = result.filePaths[0];
      const backupContent = await fs.readFile(backupPath, 'utf8');
      const backupData = JSON.parse(backupContent);
      
      return { success: true, data: backupData };
    } catch (error) {
      console.error('Error restoring localStorage backup:', error);
      return { success: false, error: error.message };
    }
  });
} 
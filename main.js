const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, powerSaveBlocker, Notification } = require('electron');
const path = require('path');
const pty = require('node-pty');
const os = require('os');
const fs = require('fs').promises;

let mainWindow;
let ptyProcess;
let dataFilePath;
let tray = null;
let powerSaveBlockerId = null;
let isQuitting = false;


function getIcon() {
  const fs = require('fs');
  
  // Try different icon formats based on platform
  const iconOptions = [];
  
  if (process.platform === 'darwin') {
    iconOptions.push('logo.png', 'icon.icns');
  } else if (process.platform === 'win32') {
    iconOptions.push('icon.ico', 'logo.png');
  } else {
    iconOptions.push('logo.png', 'icon.icns');
  }
  
  for (const iconFile of iconOptions) {
    const iconPath = path.join(__dirname, iconFile);
    try {
      if (fs.existsSync(iconPath)) {
        try { console.log('Using icon:', iconPath); } catch (e) { /* ignore */ }
        return iconPath;
      }
    } catch (error) {
      try { console.warn('Error checking icon:', iconPath, error.message); } catch (e) { /* ignore */ }
    }
  }
  
  try { console.warn('No suitable icon found, using default'); } catch (e) { /* ignore */ }
  return undefined;
}

function initDataStorage() {
  try {
    // Create data file in app data directory for persistence
    const userDataPath = app.getPath('userData');
    dataFilePath = path.join(userDataPath, 'auto-injector-data.json');
    
    try { console.log('Data storage initialized at:', dataFilePath); } catch (e) { /* ignore */ }
  } catch (error) {
    try { console.error('Failed to initialize data storage:', error); } catch (e) { /* ignore */ }
  }
}

async function readDataFile() {
  try {
    const data = await fs.readFile(dataFilePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // File doesn't exist or is invalid, return default structure
    return {
      settings: {},
      messages: [],
      messageHistory: [],
      appState: {}
    };
  }
}

async function writeDataFile(data) {
  try {
    await fs.writeFile(dataFilePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    try { console.error('Failed to write data file:', error); } catch (e) { /* ignore */ }
    return false;
  }
}


function createTray() {
  const iconPath = getIcon() || path.join(__dirname, 'logo.png');
  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide Window',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isVisible()) {
            mainWindow.hide();
          } else {
            mainWindow.show();
            mainWindow.focus();
          }
        } else {
          createWindow();
        }
      }
    },
    {
      type: 'separator'
    },
    {
      label: 'Start Injection',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('tray-start-injection');
        }
      }
    },
    {
      label: 'Stop Injection',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('tray-stop-injection');
        }
      }
    },
    {
      type: 'separator'
    },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip('Auto-Injector');

  // Handle tray click (show/hide window)
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      createWindow();
    }
  });
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
  
  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Handle window close - minimize to tray instead of quit
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      
      // Show notification on first minimize to tray
      showNotification('Auto-Injector', 'App minimized to system tray. Click the tray icon to restore.');
    }
  });

  mainWindow.on('closed', () => {
    if (ptyProcess) {
      ptyProcess.kill();
    }
    mainWindow = null;
  });
}


function showNotification(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: title,
        body: body,
        icon: getIcon()
      }).show();
    }
  } catch (error) {
    try { console.error('Error showing notification:', error); } catch (e) { /* ignore */ }
  }
}

app.whenReady().then(() => {
  initDataStorage();
  createTray();
  createWindow();
  
  // Set dock icon (macOS specific)
  if (process.platform === 'darwin') {
    try {
      const logoIconPath = path.join(__dirname, 'logo.png');
      try { console.log('Setting dock icon from:', logoIconPath); } catch (e) { /* ignore */ }
      app.dock.setIcon(logoIconPath);
    } catch (error) {
      try { console.error('Failed to set logo dock icon:', error); } catch (e) { /* ignore */ }
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
    try { console.log('Received terminal-start request, startDirectory:', startDirectory); } catch (e) { /* ignore */ }
    const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
    const cwd = startDirectory || process.cwd();
    try { console.log('Starting terminal with shell:', shell, 'cwd:', cwd); } catch (e) { /* ignore */ }
    
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: cwd,
      env: process.env
    });
    try { console.log('Terminal process spawned successfully'); } catch (e) { /* ignore */ }

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

  // Get current working directory
  ipcMain.on('get-cwd', (event) => {
    event.reply('cwd-response', process.cwd());
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
      try { console.error('Error changing terminal directory:', error); } catch (e) { /* ignore */ }
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
      try { console.error('Error in show-directory-dialog handler:', error); } catch (e) { /* ignore */ }
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
      try { console.error('Error handling file drop:', error); } catch (e) { /* ignore */ }
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
      try { console.error('Error saving screenshot:', error); } catch (e) { /* ignore */ }
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
      try { console.error('Error getting file info:', error); } catch (e) { /* ignore */ }
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
      try { console.error('Error reading sound effects directory:', error); } catch (e) { /* ignore */ }
      return { success: false, error: error.message, files: [] };
    }
  });

  // Backup localStorage to desktop
  ipcMain.handle('backup-localstorage', async (event, localStorageData) => {
    try {
      const desktopPath = path.join(os.homedir(), 'Desktop');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFileName = `auto-injector-backup-${timestamp}.json`;
      const backupPath = path.join(desktopPath, backupFileName);
      
      const backupData = {
        timestamp: new Date().toISOString(),
        localStorage: localStorageData
      };
      
      await fs.writeFile(backupPath, JSON.stringify(backupData, null, 2));
      
      return { success: true, filePath: backupPath };
    } catch (error) {
      try { console.error('Error creating localStorage backup:', error); } catch (e) { /* ignore */ }
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
      try { console.error('Error restoring localStorage backup:', error); } catch (e) { /* ignore */ }
      return { success: false, error: error.message };
    }
  });

  // Data file operations
  ipcMain.handle('db-get-setting', async (event, key) => {
    try {
      const data = await readDataFile();
      return data.settings[key] || null;
    } catch (error) {
      try { console.error('Error getting setting:', error); } catch (e) { /* ignore */ }
      return null;
    }
  });

  ipcMain.handle('db-set-setting', async (event, key, value) => {
    try {
      const data = await readDataFile();
      data.settings[key] = value;
      return await writeDataFile(data);
    } catch (error) {
      try { console.error('Error setting setting:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  ipcMain.handle('db-get-all-settings', async () => {
    try {
      const data = await readDataFile();
      return data.settings;
    } catch (error) {
      try { console.error('Error getting all settings:', error); } catch (e) { /* ignore */ }
      return {};
    }
  });

  ipcMain.handle('db-get-messages', async () => {
    try {
      const data = await readDataFile();
      return data.messages || [];
    } catch (error) {
      try { console.error('Error getting messages:', error); } catch (e) { /* ignore */ }
      return [];
    }
  });

  ipcMain.handle('db-save-message', async (event, message) => {
    try {
      const data = await readDataFile();
      // Remove existing message with same ID if it exists
      data.messages = data.messages.filter(m => m.message_id !== message.id);
      // Add the message
      data.messages.push({
        message_id: message.id,
        content: message.content,
        processed_content: message.processedContent,
        execute_at: message.executeAt,
        created_at: message.createdAt,
        status: message.status || 'pending'
      });
      return await writeDataFile(data);
    } catch (error) {
      try { console.error('Error saving message:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  ipcMain.handle('db-delete-message', async (event, messageId) => {
    try {
      const data = await readDataFile();
      data.messages = data.messages.filter(m => m.message_id !== messageId);
      return await writeDataFile(data);
    } catch (error) {
      try { console.error('Error deleting message:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  ipcMain.handle('db-clear-messages', async () => {
    try {
      const data = await readDataFile();
      data.messages = [];
      return await writeDataFile(data);
    } catch (error) {
      try { console.error('Error clearing messages:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  // Atomic message queue save - replaces entire message array
  ipcMain.handle('db-save-message-queue', async (event, messages) => {
    try {
      const data = await readDataFile();
      // Atomically replace entire message queue
      data.messages = messages.map(message => ({
        message_id: message.id,
        content: message.content,
        processed_content: message.processedContent,
        execute_at: message.executeAt,
        created_at: message.createdAt,
        status: message.status || 'pending'
      }));
      return await writeDataFile(data);
    } catch (error) {
      try { console.error('Error saving message queue:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  ipcMain.handle('db-save-message-history', async (event, historyItem) => {
    try {
      const data = await readDataFile();
      data.messageHistory.unshift(historyItem);
      // Keep only last 100 items
      if (data.messageHistory.length > 100) {
        data.messageHistory = data.messageHistory.slice(0, 100);
      }
      return await writeDataFile(data);
    } catch (error) {
      try { console.error('Error saving message history:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  ipcMain.handle('db-get-message-history', async () => {
    try {
      const data = await readDataFile();
      return data.messageHistory || [];
    } catch (error) {
      try { console.error('Error getting message history:', error); } catch (e) { /* ignore */ }
      return [];
    }
  });

  ipcMain.handle('db-get-app-state', async (event, key) => {
    try {
      const data = await readDataFile();
      return data.appState[key] || null;
    } catch (error) {
      try { console.error('Error getting app state:', error); } catch (e) { /* ignore */ }
      return null;
    }
  });

  ipcMain.handle('db-set-app-state', async (event, key, value) => {
    try {
      const data = await readDataFile();
      data.appState[key] = value;
      return await writeDataFile(data);
    } catch (error) {
      try { console.error('Error setting app state:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  // Migration helper
  ipcMain.handle('db-migrate-localstorage', async (event, localStorageData) => {
    try {
      const data = await readDataFile();
      
      // Migrate preferences
      if (localStorageData.terminalGUIPreferences) {
        const preferences = JSON.parse(localStorageData.terminalGUIPreferences);
        
        // Migrate settings
        Object.keys(preferences).forEach(key => {
          if (key === 'messageQueue' || key === 'messageHistory') return; // Handle separately
          data.settings[key] = JSON.stringify(preferences[key]);
        });
        
        // Migrate message queue
        if (preferences.messageQueue && Array.isArray(preferences.messageQueue)) {
          data.messages = preferences.messageQueue.map(message => ({
            message_id: message.id,
            content: message.content,
            processed_content: message.processedContent || message.content,
            execute_at: message.executeAt,
            created_at: message.createdAt || message.timestamp,
            status: 'pending'
          }));
        }
        
        // Migrate message history
        if (preferences.messageHistory && Array.isArray(preferences.messageHistory)) {
          data.messageHistory = preferences.messageHistory;
        }
      }
      
      // Migrate other localStorage items
      Object.keys(localStorageData).forEach(key => {
        if (key !== 'terminalGUIPreferences') {
          data.appState[key] = localStorageData[key];
        }
      });
      
      const success = await writeDataFile(data);
      return { success };
    } catch (error) {
      try { console.error('Error migrating localStorage:', error); } catch (e) { /* ignore */ }
      return { success: false, error: error.message };
    }
  });

  // Power management IPC handlers
  ipcMain.handle('start-power-save-blocker', async () => {
    try {
      if (powerSaveBlockerId === null) {
        powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
        try { console.log('Power save blocker started:', powerSaveBlockerId); } catch (e) { /* ignore */ }
        return { success: true, id: powerSaveBlockerId };
      }
      return { success: true, id: powerSaveBlockerId };
    } catch (error) {
      try { console.error('Error starting power save blocker:', error); } catch (e) { /* ignore */ }
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('stop-power-save-blocker', async () => {
    try {
      if (powerSaveBlockerId !== null) {
        powerSaveBlocker.stop(powerSaveBlockerId);
        try { console.log('Power save blocker stopped:', powerSaveBlockerId); } catch (e) { /* ignore */ }
        powerSaveBlockerId = null;
        return { success: true };
      }
      return { success: true };
    } catch (error) {
      try { console.error('Error stopping power save blocker:', error); } catch (e) { /* ignore */ }
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('is-power-save-blocker-active', async () => {
    try {
      const isActive = powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId);
      return { success: true, active: isActive };
    } catch (error) {
      try { console.error('Error checking power save blocker status:', error); } catch (e) { /* ignore */ }
      return { success: false, error: error.message };
    }
  });

  // Notification IPC handlers
  ipcMain.handle('show-notification', async (event, title, body, options = {}) => {
    try {
      showNotification(title, body);
      return { success: true };
    } catch (error) {
      try { console.error('Error showing notification:', error); } catch (e) { /* ignore */ }
      return { success: false, error: error.message };
    }
  });

  // Tray badge update (macOS/Windows)
  ipcMain.handle('update-tray-badge', async (event, count) => {
    try {
      if (process.platform === 'darwin' && app.dock) {
        if (count > 0) {
          app.dock.setBadge(count.toString());
        } else {
          app.dock.setBadge('');
        }
      }
      // Update tray tooltip with queue count
      if (tray) {
        const tooltip = count > 0 ? `Auto-Injector (${count} queued)` : 'Auto-Injector';
        tray.setToolTip(tooltip);
      }
      return { success: true };
    } catch (error) {
      try { console.error('Error updating tray badge:', error); } catch (e) { /* ignore */ }
      return { success: false, error: error.message };
    }
  });

}

// App event handlers
app.whenReady().then(() => {
  initDataStorage();
  createWindow();
  
});

app.on('window-all-closed', () => {
  // Don't quit when all windows are closed - keep running in tray
  // Only quit if the user explicitly quits via tray menu
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  
  // Clean up power save blocker
  if (powerSaveBlockerId !== null) {
    try {
      powerSaveBlocker.stop(powerSaveBlockerId);
      powerSaveBlockerId = null;
    } catch (error) {
      try { console.error('Error stopping power save blocker on quit:', error); } catch (e) { /* ignore */ }
    }
  }
});

 
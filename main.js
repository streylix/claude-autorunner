const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, powerSaveBlocker, Notification, shell } = require('electron');
const path = require('path');
const pty = require('node-pty');
const os = require('os');
const fs = require('fs').promises;
// @xenova/transformers will be dynamically imported in the transcription handler

// Import unified storage system
const unifiedStore = require('./src/storage/unified-store');
const MigrationHelper = require('./src/storage/migration-helper');

let mainWindow;
let ptyProcess; // Legacy single process support
const ptyProcesses = new Map(); // Map of terminal ID to pty process
let dataFilePath;
let tray = null;
let powerSaveBlockerId = null;
let isQuitting = false;

/**
 * Properly cleanup PTY processes to prevent memory leaks
 * Uses SIGTERM first, then SIGKILL if process doesn't respond
 */
async function cleanupPtyProcesses() {
  console.log('[Main] Starting PTY process cleanup...');
  
  const cleanupPromises = [];
  
  // Cleanup all processes in the map
  for (const [terminalId, ptyProcess] of ptyProcesses) {
    if (ptyProcess && !ptyProcess.killed) {
      const cleanupPromise = cleanupSinglePtyProcess(ptyProcess, terminalId);
      cleanupPromises.push(cleanupPromise);
    }
  }
  
  // Cleanup legacy single process
  if (ptyProcess && !ptyProcess.killed) {
    const cleanupPromise = cleanupSinglePtyProcess(ptyProcess, 'legacy');
    cleanupPromises.push(cleanupPromise);
  }
  
  // Wait for all cleanup operations to complete
  await Promise.allSettled(cleanupPromises);
  
  // Clear the map
  ptyProcesses.clear();
  ptyProcess = null;
  
  console.log('[Main] PTY process cleanup completed');
}

/**
 * Cleanup a single PTY process with proper SIGTERM/SIGKILL handling
 */
async function cleanupSinglePtyProcess(process, identifier) {
  return new Promise((resolve) => {
    if (!process || process.killed) {
      resolve();
      return;
    }
    
    console.log(`[Main] Cleaning up PTY process ${identifier} (PID: ${process.pid})`);
    
    let cleaned = false;
    
    // Try graceful shutdown first with SIGTERM
    try {
      process.kill('SIGTERM');
      console.log(`[Main] Sent SIGTERM to PTY process ${identifier}`);
    } catch (error) {
      console.warn(`[Main] Failed to send SIGTERM to PTY process ${identifier}:`, error.message);
      // Force kill immediately if SIGTERM fails
      try {
        process.kill('SIGKILL');
        console.log(`[Main] Sent SIGKILL to PTY process ${identifier}`);
      } catch (killError) {
        console.error(`[Main] Failed to kill PTY process ${identifier}:`, killError.message);
      }
      cleaned = true;
      resolve();
      return;
    }
    
    // Set up timeout to force kill if SIGTERM doesn't work within 3 seconds
    const forceKillTimeout = setTimeout(() => {
      if (!cleaned) {
        try {
          console.log(`[Main] PTY process ${identifier} didn't respond to SIGTERM, sending SIGKILL`);
          process.kill('SIGKILL');
        } catch (killError) {
          console.error(`[Main] Failed to force kill PTY process ${identifier}:`, killError.message);
        }
        cleaned = true;
        resolve();
      }
    }, 3000);
    
    // Listen for process exit
    const onExit = () => {
      if (!cleaned) {
        console.log(`[Main] PTY process ${identifier} exited gracefully`);
        clearTimeout(forceKillTimeout);
        cleaned = true;
        resolve();
      }
    };
    
    process.once('exit', onExit);
    process.once('close', onExit);
  });
}

// Safe logging function that handles EPIPE errors
function safeLog(...args) {
  try {
    if (process.stdout.writable && !process.stdout.destroyed) {
      console.log(...args);
    }
  } catch (e) {
    // Ignore logging errors
  }
}

// Global error handlers
process.on('uncaughtException', (error) => {
  if (error.code === 'EPIPE') {
    // Ignore EPIPE errors - they occur when stdout is closed
    return;
  }
  // Log other errors to stderr if possible
  try {
    if (process.stderr.writable) {
      console.error('Uncaught Exception:', error);
    }
  } catch (e) {
    // Even stderr might be closed
  }
});

process.on('unhandledRejection', (reason, promise) => {
  try {
    if (process.stderr.writable) {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    }
  } catch (e) {
    // Ignore
  }
});


function getIcon() {
  const fs = require('fs');
  
  // Try different icon formats based on platform
  const iconOptions = [];
  
  if (process.platform === 'darwin') {
    iconOptions.push('assets/icons/logo.png', 'assets/icons/icon.icns');
  } else if (process.platform === 'win32') {
    iconOptions.push('assets/icons/icon.ico', 'assets/icons/logo.png');
  } else {
    iconOptions.push('assets/icons/logo.png', 'assets/icons/icon.icns');
  }
  
  for (const iconFile of iconOptions) {
    const iconPath = path.join(__dirname, iconFile);
    try {
      if (fs.existsSync(iconPath)) {
        safeLog('Using icon:', iconPath);
        return iconPath;
      }
    } catch (error) {
      try { console.warn('Error checking icon:', iconPath, error.message); } catch (e) { /* ignore */ }
    }
  }
  
  try { console.warn('No suitable icon found, using default'); } catch (e) { /* ignore */ }
  return undefined;
}

async function initUnifiedStorage() {
  try {
    safeLog('🔄 Initializing unified storage system...');
    
    // Run migration from legacy storage
    const migrationSuccess = await MigrationHelper.migrateLegacyData();
    
    if (migrationSuccess) {
      safeLog('✅ Storage migration completed successfully');
    } else {
      safeLog('⚠️ Storage migration had issues, using defaults');
    }
    
    // Validate store health
    const isHealthy = unifiedStore.validateStore();
    if (!isHealthy) {
      throw new Error('Store validation failed');
    }
    
    // Log storage stats
    const stats = unifiedStore.getStats();
    safeLog('📊 Storage initialized:', {
      path: stats.path,
      size: `${Math.round(stats.size / 1024)}KB`,
      messages: stats.messageCount,
      history: stats.historyCount,
      healthy: stats.isHealthy
    });
    
    return true;
  } catch (error) {
    try { 
      console.error('❌ Failed to initialize unified storage:', error); 
      // Attempt recovery
      safeLog('🚑 Attempting storage recovery...');
      unifiedStore.clear(); // Start fresh if corrupted
      return false;
    } catch (e) { 
      /* ignore */ 
    }
  }
}

// Legacy functions kept for compatibility during transition
async function readDataFile() {
  // Redirect to unified store
  return {
    settings: await unifiedStore.getAllSettings(),
    messages: await unifiedStore.getMessages(),
    messageHistory: await unifiedStore.getMessageHistory(),
    appState: await unifiedStore.getAppState()
  };
}

async function writeDataFile(data) {
  // Redirect to unified store with atomic operations
  try {
    if (data.settings) await unifiedStore.saveAllSettings(data.settings);
    if (data.messages) await unifiedStore.saveMessages(data.messages);
    if (data.messageHistory) {
      // Clear and repopulate history
      await unifiedStore.clearHistory();
      for (const item of data.messageHistory) {
        await unifiedStore.addToHistory(item);
      }
    }
    if (data.appState) await unifiedStore.saveAppState(data.appState);
    return true;
  } catch (error) {
    try { console.error('❌ Failed to write via unified store:', error); } catch (e) { /* ignore */ }
    return false;
  }
}


function createTray() {
  const iconPath = getIcon() || path.join(__dirname, 'assets/icons/logo.png');
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

  // Prevent new windows from opening - instead open links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log('Intercepting window open request for:', url);
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle navigation requests - prevent navigation away from the app
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    const currentUrl = mainWindow.webContents.getURL();
    
    // Allow navigation within the same origin or to local files
    if (navigationUrl.startsWith('file://') || navigationUrl === currentUrl) {
      return;
    }
    
    // External links - open in default browser instead
    console.log('Intercepting navigation to:', navigationUrl);
    event.preventDefault();
    shell.openExternal(navigationUrl);
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

  mainWindow.on('closed', async () => {
    // Proper cleanup of all terminal processes
    await cleanupPtyProcesses();
    mainWindow = null;
  });
}


function showNotification(title, body) {
  try {
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: title,
        body: body,
        icon: getIcon(),
        silent: false,
        urgency: 'normal'
      });
      
      // On macOS, we need to ensure the notification shows even when app is focused
      if (process.platform === 'darwin') {
        notification.show();
        
        // Also show in notification center
        if (app.isReady()) {
          app.dock.bounce('informational');
        }
      } else {
        notification.show();
      }
    }
  } catch (error) {
    try { console.error('Error showing notification:', error); } catch (e) { /* ignore */ }
  }
}

app.whenReady().then(async () => {
  await initUnifiedStorage();
  createTray();
  createWindow();
  
  // Set dock icon (macOS specific)
  if (process.platform === 'darwin') {
    try {
      const logoIconPath = path.join(__dirname, 'assets/icons/logo.png');
      safeLog('Setting dock icon from:', logoIconPath);
      app.dock.setIcon(logoIconPath);
    } catch (error) {
      try { console.error('Failed to set logo dock icon:', error); } catch (e) { /* ignore */ }
    }
  }
  
  // Request notification permissions on macOS
  if (process.platform === 'darwin') {
    try {
      // Notification permission is automatic on macOS for signed apps
      // But we can check if they're supported
      if (Notification.isSupported()) {
        safeLog('System notifications are supported');
      }
    } catch (error) {
      try { console.error('Error checking notification support:', error); } catch (e) { /* ignore */ }
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

// Terminal state functionality removed - terminals now created fresh on each startup

function setupIpcHandlers() {
  // Terminal handling
  ipcMain.on('terminal-start', (event, options = {}) => {
    const terminalId = options.terminalId || 1;
    const startDirectory = options.directory || null;
    
    safeLog('Received terminal-start request, terminalId:', terminalId, 'directory:', startDirectory);
    
    // Validate directory exists and is accessible
    let validatedCwd = process.cwd();
    let directoryValidationResult = 'default';
    
    if (startDirectory) {
      try {
        const dirStat = fs.statSync(startDirectory);
        if (dirStat.isDirectory()) {
          // Additional check - verify we can access the directory
          fs.accessSync(startDirectory, fs.constants.R_OK);
          validatedCwd = startDirectory;
          directoryValidationResult = 'valid';
          safeLog('Terminal', terminalId, 'validated directory:', startDirectory);
        } else {
          safeLog('Terminal', terminalId, 'directory validation failed - not a directory:', startDirectory);
          directoryValidationResult = 'not_directory';
        }
      } catch (dirError) {
        safeLog('Terminal', terminalId, 'directory validation failed:', dirError.message, 'using default:', validatedCwd);
        directoryValidationResult = 'invalid';
        
        // Directory validation failed - using default directory
      }
    }
    
    // Platform-specific shell configuration
    let shell, shellArgs = [];
    if (os.platform() === 'win32') {
      // Better Windows shell detection
      if (process.env.PSModulePath && process.env.PSModulePath.length > 0) {
        // PowerShell is available
        shell = 'powershell.exe';
        shellArgs = ['-NoLogo', '-NoExit'];
      } else if (process.env.WT_SESSION) {
        // Windows Terminal is running, prefer cmd
        shell = process.env.COMSPEC || 'cmd.exe';
        shellArgs = [];
      } else {
        // Default to cmd.exe which is most reliable
        shell = process.env.COMSPEC || 'cmd.exe';
        shellArgs = [];
      }
      
      safeLog('Windows shell detection:', {
        PSModulePath: !!process.env.PSModulePath,
        WT_SESSION: !!process.env.WT_SESSION,
        COMSPEC: process.env.COMSPEC,
        selectedShell: shell
      });
    } else {
      shell = process.env.SHELL || '/bin/zsh';
    }
    
    safeLog('Starting terminal', terminalId, 'with shell:', shell, 'args:', shellArgs, 'validated cwd:', validatedCwd, 'directory validation:', directoryValidationResult);
    
    try {
      const terminalProcess = pty.spawn(shell, shellArgs, {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: validatedCwd,
        env: process.env,
        useConpty: os.platform() === 'win32' // Use ConPTY on Windows for better compatibility
      });
      safeLog('Terminal', terminalId, 'process spawned successfully');

      // Store in map
      ptyProcesses.set(terminalId, terminalProcess);
      
      // Legacy support for terminal 1
      if (terminalId === 1) {
        ptyProcess = terminalProcess;
      }

      terminalProcess.onData((data) => {
        event.reply('terminal-data', { terminalId, content: data });
      });

      terminalProcess.onExit((exitCode, signal) => {
        safeLog('Terminal', terminalId, 'process exited with code:', exitCode, 'signal:', signal);
        event.reply('terminal-exit', { terminalId, exitCode, signal });
        ptyProcesses.delete(terminalId);
        if (terminalId === 1) {
          ptyProcess = null;
        }
      });
      
      // Windows-specific: send initial ready signal after short delay
      if (os.platform() === 'win32') {
        setTimeout(() => {
          event.reply('terminal-ready', { terminalId });
        }, 500); // Give Windows terminal time to fully initialize
      } else {
        event.reply('terminal-ready', { terminalId });
      }
    } catch (error) {
      safeLog('Failed to spawn terminal', terminalId, 'Error:', error.message);
      // Try fallback approaches
      try {
        let fallbackShell, fallbackArgs = [];
        let fallbackEnv;
        
        if (os.platform() === 'win32') {
          // Windows fallbacks
          fallbackShell = 'cmd.exe';
          fallbackArgs = [];
          fallbackEnv = {
            PATH: process.env.PATH,
            USERPROFILE: process.env.USERPROFILE,
            USERNAME: process.env.USERNAME,
            COMSPEC: process.env.COMSPEC,
            SYSTEMROOT: process.env.SYSTEMROOT,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP
          };
        } else {
          // Unix fallbacks
          fallbackShell = '/bin/bash';
          fallbackArgs = [];
          fallbackEnv = {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            USER: process.env.USER
          };
        }
        
        const terminalProcess = pty.spawn(fallbackShell, fallbackArgs, {
          name: 'xterm-color',
          cols: 80,
          rows: 24,
          cwd: validatedCwd,
          env: fallbackEnv,
          useConpty: os.platform() === 'win32'
        });
        safeLog('Terminal', terminalId, 'spawned successfully with fallback shell:', fallbackShell);
        ptyProcesses.set(terminalId, terminalProcess);
        if (terminalId === 1) {
          ptyProcess = terminalProcess;
        }
        terminalProcess.onData((data) => {
          event.reply('terminal-data', { terminalId, content: data });
        });
        terminalProcess.onExit((exitCode, signal) => {
          safeLog('Terminal', terminalId, 'fallback process exited with code:', exitCode, 'signal:', signal);
          event.reply('terminal-exit', { terminalId, exitCode, signal });
          ptyProcesses.delete(terminalId);
          if (terminalId === 1) {
            ptyProcess = null;
          }
        });
        
        // Send ready signal for fallback terminal too
        if (os.platform() === 'win32') {
          setTimeout(() => {
            event.reply('terminal-ready', { terminalId });
          }, 500);
        } else {
          event.reply('terminal-ready', { terminalId });
        }
      } catch (fallbackError) {
        safeLog('Fallback terminal spawn also failed:', fallbackError.message);
        safeLog('Terminal', terminalId, 'exhausted all spawn attempts');
        
        // Send enhanced error with recovery information
        event.reply('terminal-error', { 
          terminalId, 
          error: fallbackError.message,
          directoryValidation: directoryValidationResult,
          recoveryAction: 'cleared_state'
        });
      }
    }
  });

  ipcMain.on('terminal-input', (event, options) => {
    // Support both legacy format (string) and new format (object with terminalId)
    if (typeof options === 'string') {
      // Legacy format - use terminal 1
      if (ptyProcess) {
        ptyProcess.write(options);
      }
    } else {
      // New format with terminal ID
      const terminalId = options.terminalId || 1;
      const data = options.data || '';
      const terminalProcess = ptyProcesses.get(terminalId);
      if (terminalProcess) {
        terminalProcess.write(data);
      }
    }
  });

  ipcMain.on('terminal-resize', (event, options) => {
    // Support both legacy format and new format with terminalId
    if (typeof options === 'object' && options.terminalId) {
      const { terminalId, cols, rows } = options;
      const terminalProcess = ptyProcesses.get(terminalId);
      if (terminalProcess) {
        terminalProcess.resize(cols, rows);
      }
    } else {
      // Legacy format
      const cols = arguments[1];
      const rows = arguments[2];
      if (ptyProcess) {
        ptyProcess.resize(cols, rows);
      }
    }
  });

  ipcMain.on('terminal-close', (event, options) => {
    const terminalId = options.terminalId;
    const terminalProcess = ptyProcesses.get(terminalId);
    
    if (terminalProcess) {
      terminalProcess.kill();
      ptyProcesses.delete(terminalId);
      
      // Clear legacy reference if it's terminal 1
      if (terminalId === 1) {
        ptyProcess = null;
      }
      
      safeLog('Terminal', terminalId, 'process closed');
    }
  });

  // Get current working directory
  ipcMain.on('get-cwd', (event, options = {}) => {
    const terminalId = options.terminalId || 1;
    event.reply('cwd-response', { terminalId, cwd: process.cwd() });
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

  // Handle opening external links
  ipcMain.handle('open-external-link', async (event, url) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error('Failed to open external link:', error);
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

  // Set up file watcher for addmsg sync triggers
  const syncTriggerPath = '/tmp/claude-code-addmsg-trigger';
  let syncTriggerWatcher = null;
  
  // Set up file watcher for clear queue triggers
  const clearTriggerPath = '/tmp/claude-code-clear-trigger';
  let clearTriggerWatcher = null;
  
  const setupSyncWatcher = () => {
    try {
      // Create the trigger file if it doesn't exist
      const fs_sync = require('fs');
      if (!fs_sync.existsSync(syncTriggerPath)) {
        fs_sync.writeFileSync(syncTriggerPath, 'init');
      }
      
      // Watch for changes to the sync trigger file
      syncTriggerWatcher = fs_sync.watch(syncTriggerPath, (eventType, filename) => {
        console.log('[Main] File watcher triggered - Event:', eventType, 'File:', filename);
        if ((eventType === 'change' || eventType === 'rename') && mainWindow && !mainWindow.isDestroyed()) {
          try {
            // Read the trigger file to get message content
            const triggerContent = fs_sync.readFileSync(syncTriggerPath, 'utf8').trim();
            console.log('[Main] Addmsg trigger content:', triggerContent);
            
            // Parse trigger content: timestamp:addmsg:content:terminal_id
            const parts = triggerContent.split(':');
            if (parts.length >= 3 && parts[1] === 'addmsg') {
              const content = parts.slice(2, -1).join(':'); // Rejoin in case content had colons
              const terminalId = parts[parts.length - 1];
              
              console.log('[Main] Sending message to frontend:', { content, terminalId });
              mainWindow.webContents.send('addmsg-message', { content, terminalId });
            } else {
              // Fallback to old behavior
              console.log('[Main] Using fallback sync trigger');
              mainWindow.webContents.send('addmsg-sync-trigger');
            }
          } catch (error) {
            console.log('[Main] Error reading trigger file:', error.message);
            // Fallback to old behavior
            mainWindow.webContents.send('addmsg-sync-trigger');
          }
        }
      });
      
      syncTriggerWatcher.on('error', (error) => {
        console.log('[Main] Sync trigger watcher error:', error.message);
        // Try to recreate the watcher after a short delay
        setTimeout(setupSyncWatcher, 1000);
      });
      
      console.log('[Main] Addmsg sync trigger watcher started');
    } catch (error) {
      console.log('[Main] Could not start sync trigger watcher:', error.message);
      // Try again after a delay
      setTimeout(setupSyncWatcher, 5000);
    }
  };
  
  setupSyncWatcher();
  
  // Set up clear queue trigger watcher
  const setupClearWatcher = () => {
    try {
      // Create the clear trigger file if it doesn't exist
      const fs_sync = require('fs');
      if (!fs_sync.existsSync(clearTriggerPath)) {
        fs_sync.writeFileSync(clearTriggerPath, 'init');
      }
      
      // Watch for changes to the clear trigger file
      clearTriggerWatcher = fs_sync.watch(clearTriggerPath, (eventType, filename) => {
        console.log('[Main] Clear trigger watcher activated - Event:', eventType, 'File:', filename);
        if ((eventType === 'change' || eventType === 'rename') && mainWindow && !mainWindow.isDestroyed()) {
          try {
            // Read the trigger file to get any additional context
            const triggerContent = fs_sync.readFileSync(clearTriggerPath, 'utf8').trim();
            console.log('[Main] Clear trigger content:', triggerContent);
            
            // Send clear-queue IPC event to renderer
            console.log('[Main] Sending clear-queue event to frontend');
            mainWindow.webContents.send('clear-queue', { source: 'backend' });
          } catch (error) {
            console.log('[Main] Error reading clear trigger file:', error.message);
            // Still send the clear event even if reading fails
            mainWindow.webContents.send('clear-queue', { source: 'backend' });
          }
        }
      });
      
      clearTriggerWatcher.on('error', (error) => {
        console.log('[Main] Clear trigger watcher error:', error.message);
        // Try to recreate the watcher after a short delay
        setTimeout(setupClearWatcher, 1000);
      });
      
      console.log('[Main] Clear queue trigger watcher started');
    } catch (error) {
      console.log('[Main] Could not start clear trigger watcher:', error.message);
      // Try again after a delay
      setTimeout(setupClearWatcher, 5000);
    }
  };
  
  setupClearWatcher();
  
  // Set up file watcher for terminal status requests
  const terminalStatusTriggerPath = '/tmp/claude-code-terminal-status-trigger';
  const terminalStatusResponsePath = '/tmp/claude-code-terminal-status-response';
  let terminalStatusWatcher = null;
  
  const setupTerminalStatusWatcher = () => {
    try {
      const fs_sync = require('fs');
      
      // Watch for terminal status request trigger
      if (fs_sync.existsSync(terminalStatusTriggerPath)) {
        fs_sync.unlinkSync(terminalStatusTriggerPath);
      }
      
      // Create a watcher for the directory instead of the file
      const triggerDir = path.dirname(terminalStatusTriggerPath);
      terminalStatusWatcher = fs_sync.watch(triggerDir, (eventType, filename) => {
        if (filename === 'claude-code-terminal-status-trigger' && mainWindow && !mainWindow.isDestroyed()) {
          console.log('[Main] Terminal status request detected');
          
          // Request terminal status from renderer
          mainWindow.webContents.send('request-terminal-status');
          
          // Set up a one-time listener for the response
          ipcMain.once('terminal-status-response', (event, terminalData) => {
            console.log('[Main] Received terminal status from renderer:', terminalData);
            
            // Add process information to each terminal
            if (terminalData.terminals) {
              for (const [termId, termInfo] of Object.entries(terminalData.terminals)) {
                const ptyProc = ptyProcesses.get(parseInt(termId));
                if (ptyProc) {
                  termInfo.has_process = true;
                  termInfo.pid = ptyProc.pid || null;
                } else {
                  termInfo.has_process = false;
                  termInfo.pid = null;
                }
              }
            }
            
            // Write response to file for backend to read
            try {
              fs_sync.writeFileSync(terminalStatusResponsePath, JSON.stringify(terminalData));
              console.log('[Main] Wrote terminal status response to file');
            } catch (error) {
              console.error('[Main] Error writing terminal status response:', error);
            }
          });
        }
      });
      
      console.log('[Main] Terminal status watcher started');
    } catch (error) {
      console.log('[Main] Could not start terminal status watcher:', error.message);
      setTimeout(setupTerminalStatusWatcher, 5000);
    }
  };
  
  setupTerminalStatusWatcher();
  
  // Note: Trigger watchers cleanup moved to main before-quit handler

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
      const soundEffectsDir = path.join(__dirname, 'assets', 'soundeffects');
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
      return await unifiedStore.getSetting(key);
    } catch (error) {
      try { console.error('Error getting setting:', error); } catch (e) { /* ignore */ }
      return null;
    }
  });

  ipcMain.handle('db-set-setting', async (event, key, value) => {
    try {
      await unifiedStore.setSetting(key, value);
      return true;
    } catch (error) {
      try { console.error('Error setting setting:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  ipcMain.handle('db-get-all-settings', async () => {
    try {
      return await unifiedStore.getAllSettings();
    } catch (error) {
      try { console.error('Error getting all settings:', error); } catch (e) { /* ignore */ }
      return {};
    }
  });

  // Alias for db-get-all-settings
  ipcMain.handle('db-get-settings', async () => {
    try {
      return await unifiedStore.getAllSettings();
    } catch (error) {
      try { console.error('Error getting all settings:', error); } catch (e) { /* ignore */ }
      return {};
    }
  });

  // Alias for db-set-setting
  ipcMain.handle('db-save-setting', async (event, key, value) => {
    try {
      await unifiedStore.setSetting(key, value);
      return true;
    } catch (error) {
      try { console.error('Error setting setting:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });
  
  // Missing handler that renderer calls
  ipcMain.handle('db-save-all-settings', async (event, settings) => {
    try {
      await unifiedStore.saveAllSettings(settings);
      return true;
    } catch (error) {
      try { console.error('Error saving all settings:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  ipcMain.handle('db-get-messages', async () => {
    try {
      return await unifiedStore.getMessages();
    } catch (error) {
      try { console.error('Error getting messages:', error); } catch (e) { /* ignore */ }
      return [];
    }
  });

  ipcMain.handle('db-save-message', async (event, message) => {
    try {
      await unifiedStore.addMessage({
        id: message.id,
        content: message.content,
        processedContent: message.processedContent,
        executeAt: message.executeAt,
        createdAt: message.createdAt,
        status: message.status || 'pending'
      });
      return true;
    } catch (error) {
      try { console.error('Error saving message:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  ipcMain.handle('db-delete-message', async (event, messageId) => {
    try {
      return await unifiedStore.removeMessage(messageId);
    } catch (error) {
      try { console.error('Error deleting message:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  ipcMain.handle('db-clear-messages', async () => {
    try {
      await unifiedStore.saveMessages([]);
      return true;
    } catch (error) {
      try { console.error('Error clearing messages:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  // Terminal state functionality removed

  // Atomic message queue save - replaces entire message array
  ipcMain.handle('db-save-message-queue', async (event, messages) => {
    try {
      const formattedMessages = messages.map(message => ({
        id: message.id,
        content: message.content,
        processedContent: message.processedContent,
        executeAt: message.executeAt,
        createdAt: message.createdAt,
        status: message.status || 'pending'
      }));
      await unifiedStore.saveMessages(formattedMessages);
      return true;
    } catch (error) {
      try { console.error('Error saving message queue:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  ipcMain.handle('db-save-message-history', async (event, historyItem) => {
    try {
      await unifiedStore.addToHistory(historyItem);
      return true;
    } catch (error) {
      try { console.error('Error saving message history:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  ipcMain.handle('db-get-message-history', async () => {
    try {
      return await unifiedStore.getMessageHistory();
    } catch (error) {
      try { console.error('Error getting message history:', error); } catch (e) { /* ignore */ }
      return [];
    }
  });

  ipcMain.handle('db-get-app-state', async (event, key) => {
    try {
      const appState = await unifiedStore.getAppState();
      return appState[key] || null;
    } catch (error) {
      try { console.error('Error getting app state:', error); } catch (e) { /* ignore */ }
      return null;
    }
  });

  ipcMain.handle('db-set-app-state', async (event, key, value) => {
    try {
      await unifiedStore.setAppState(key, value);
      return true;
    } catch (error) {
      try { console.error('Error setting app state:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });

  // Terminal state handlers removed - functionality discontinued
  
  ipcMain.handle('db-check-migration-needed', async () => {
    try {
      // Always return false since we've already migrated
      return false;
    } catch (error) {
      try { console.error('Error checking migration:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });
  
  ipcMain.handle('db-migrate-from-localStorage', async (event, data) => {
    try {
      // Already handled by unified storage initialization
      return true;
    } catch (error) {
      try { console.error('Error migrating from localStorage:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });
  
  ipcMain.handle('db-load-message-queue', async () => {
    try {
      return await unifiedStore.getMessages();
    } catch (error) {
      try { console.error('Error loading message queue:', error); } catch (e) { /* ignore */ }
      return [];
    }
  });
  
  ipcMain.handle('db-load-message-history', async () => {
    try {
      return await unifiedStore.getMessageHistory();
    } catch (error) {
      try { console.error('Error loading message history:', error); } catch (e) { /* ignore */ }
      return [];
    }
  });
  
  ipcMain.handle('db-clear-message-history', async () => {
    try {
      await unifiedStore.clearHistory();
      return true;
    } catch (error) {
      try { console.error('Error clearing message history:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });
  
  ipcMain.handle('db-save-preferences', async (event, preferences) => {
    try {
      await unifiedStore.saveAllSettings(preferences);
      return true;
    } catch (error) {
      try { console.error('Error saving preferences:', error); } catch (e) { /* ignore */ }
      return false;
    }
  });
  
  ipcMain.handle('db-load-preferences', async () => {
    try {
      return await unifiedStore.getAllSettings();
    } catch (error) {
      try { console.error('Error loading preferences:', error); } catch (e) { /* ignore */ }
      return {};
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
        safeLog('Power save blocker started:', powerSaveBlockerId);
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
        safeLog('Power save blocker stopped:', powerSaveBlockerId);
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

// Duplicate app.whenReady() removed - handled above in main initialization

app.on('window-all-closed', () => {
  // Don't quit when all windows are closed - keep running in tray
  // Only quit if the user explicitly quits via tray menu
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  // Check if we're already in the process of cleaning up to prevent infinite loop
  if (isQuitting) {
    // Already handled, let the app quit normally
    return;
  }
  
  isQuitting = true;
  
  // Prevent immediate quit to allow proper cleanup
  event.preventDefault();
  
  try {
    // Clean up file watchers first
    if (syncTriggerWatcher) {
      syncTriggerWatcher.close();
      syncTriggerWatcher = null;
    }
    if (clearTriggerWatcher) {
      clearTriggerWatcher.close();
      clearTriggerWatcher = null;
    }
    if (terminalStatusWatcher) {
      terminalStatusWatcher.close();
      terminalStatusWatcher = null;
    }
    
    // Proper cleanup of all terminal processes
    await cleanupPtyProcesses();
    
    // Clean up power save blocker
    if (powerSaveBlockerId !== null) {
      try {
        powerSaveBlocker.stop(powerSaveBlockerId);
        powerSaveBlockerId = null;
      } catch (error) {
        console.error('[Main] Error stopping power save blocker:', error);
      }
    }
    
    console.log('[Main] All cleanup completed, quitting app');
  } catch (error) {
    console.error('[Main] Error during cleanup:', error);
  } finally {
    // Use setImmediate to break out of the event handler before quitting
    // This prevents the before-quit event from being triggered again immediately
    setImmediate(() => {
      app.exit(0); // Use exit instead of quit to avoid triggering before-quit again
    });
  }
});
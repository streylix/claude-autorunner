/**
 * Main Process Entry Point - Refactored Version
 * Uses modular architecture with extracted components
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const pty = require('node-pty');
const os = require('os');

// Import extracted modules
const { DataManager } = require('./src/storage/data-manager');
const { SystemIntegration } = require('./src/features/system-integration');
const { PowerManagement } = require('./src/features/power-management');
const { VoiceTranscription } = require('./src/features/voice-transcription');
const { FileManagement } = require('./src/features/file-management');

// Global state
let mainWindow;
let ptyProcess; // Legacy single process support
const ptyProcesses = new Map(); // Map of terminal ID to pty process

// Module instances
let dataManager;
let systemIntegration;
let powerManagement;
let voiceTranscription;
let fileManagement;

// Initialize all modules
function initializeModules() {
    try {
        // Initialize data manager first
        dataManager = new DataManager();
        dataManager.init();
        
        // Initialize other modules
        systemIntegration = new SystemIntegration();
        powerManagement = new PowerManagement();
        voiceTranscription = new VoiceTranscription();
        fileManagement = new FileManagement();
        
        console.log('All modules initialized successfully');
        return true;
    } catch (error) {
        console.error('Failed to initialize modules:', error);
        return false;
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
            backgroundThrottling: false
        },
        titleBarStyle: 'hiddenInset',
        backgroundColor: '#2d2d2d',
        show: false,
        icon: systemIntegration.getIcon(),
    });

    mainWindow.loadFile('index.html');
    
    // Open DevTools in development
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Set window reference in modules that need it
    systemIntegration.setMainWindow(mainWindow);
    fileManagement.setMainWindow(mainWindow);

    // Handle window events using system integration module
    mainWindow.on('close', (event) => {
        systemIntegration.handleWindowClose(event);
    });

    mainWindow.on('minimize', () => {
        systemIntegration.handleWindowMinimize();
    });

    mainWindow.on('closed', () => {
        // Kill all terminal processes
        ptyProcesses.forEach((process) => {
            try {
                process.kill();
            } catch (error) {
                console.warn('Error killing pty process:', error);
            }
        });
        ptyProcesses.clear();
        
        // Kill legacy process if exists
        if (ptyProcess) {
            try {
                ptyProcess.kill();
                ptyProcess = null;
            } catch (error) {
                console.warn('Error killing legacy pty process:', error);
            }
        }
        
        mainWindow = null;
    });

    console.log('Main window created successfully');
}

// Setup terminal IPC handlers
function setupTerminalIpcHandlers() {
    // Terminal process management
    ipcMain.on('terminal-start', (event, { terminalId, directory }) => {
        try {
            const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
            const cwd = directory || process.cwd();
            
            console.log(`Starting terminal ${terminalId} with shell: ${shell}, cwd: ${cwd}`);
            
            const ptyInstance = pty.spawn(shell, [], {
                name: 'xterm-color',
                cols: 80,
                rows: 24,
                cwd: cwd,
                env: process.env
            });

            ptyProcesses.set(terminalId, ptyInstance);

            ptyInstance.on('data', (data) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('terminal-data', { terminalId, data });
                }
            });

            ptyInstance.on('exit', (code, signal) => {
                console.log(`Terminal ${terminalId} exited with code: ${code}, signal: ${signal}`);
                ptyProcesses.delete(terminalId);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('terminal-exit', { terminalId, code, signal });
                }
            });

            // For legacy compatibility
            if (terminalId === 1 && !ptyProcess) {
                ptyProcess = ptyInstance;
            }

            console.log(`Terminal ${terminalId} started successfully`);
        } catch (error) {
            console.error(`Failed to start terminal ${terminalId}:`, error);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('terminal-error', { 
                    terminalId, 
                    error: error.message 
                });
            }
        }
    });

    ipcMain.on('terminal-input', (event, { terminalId, data }) => {
        const ptyInstance = ptyProcesses.get(terminalId) || ptyProcess;
        if (ptyInstance) {
            try {
                ptyInstance.write(data);
            } catch (error) {
                console.error(`Error writing to terminal ${terminalId}:`, error);
            }
        } else {
            console.warn(`Terminal ${terminalId} not found for input`);
        }
    });

    ipcMain.on('terminal-resize', (event, { terminalId, cols, rows }) => {
        const ptyInstance = ptyProcesses.get(terminalId) || ptyProcess;
        if (ptyInstance) {
            try {
                ptyInstance.resize(cols, rows);
            } catch (error) {
                console.error(`Error resizing terminal ${terminalId}:`, error);
            }
        }
    });

    ipcMain.on('terminal-close', (event, { terminalId }) => {
        const ptyInstance = ptyProcesses.get(terminalId);
        if (ptyInstance) {
            try {
                ptyInstance.kill();
                ptyProcesses.delete(terminalId);
                console.log(`Terminal ${terminalId} closed`);
            } catch (error) {
                console.error(`Error closing terminal ${terminalId}:`, error);
            }
        }
    });

    // Directory management
    ipcMain.handle('get-cwd', async () => {
        return process.cwd();
    });

    ipcMain.handle('change-terminal-directory', async (event, { terminalId, directory }) => {
        try {
            // We can't change the directory of an existing terminal process,
            // but we can track it for future terminal creation
            console.log(`Terminal ${terminalId} directory changed to: ${directory}`);
            return { success: true, directory };
        } catch (error) {
            console.error('Error changing terminal directory:', error);
            return { success: false, error: error.message };
        }
    });
}

// App event handlers
app.whenReady().then(() => {
    console.log('App ready, initializing...');
    
    // Initialize all modules
    if (!initializeModules()) {
        console.error('Failed to initialize modules, exiting...');
        app.quit();
        return;
    }

    // Create main window
    createWindow();
    
    // Setup terminal IPC handlers
    setupTerminalIpcHandlers();
    
    // Create system tray
    systemIntegration.createTray();
    systemIntegration.setupTrayEventListeners();
    
    // Handle power management events
    powerManagement.onAppReady();
    
    console.log('Application initialization complete');
});

app.on('window-all-closed', () => {
    // On macOS, keep app running even when all windows are closed
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('before-quit', () => {
    systemIntegration.setIsQuitting(true);
    powerManagement.onAppWillQuit();
});

app.on('will-quit', () => {
    // Clean up all modules
    if (dataManager) dataManager.destroy();
    if (systemIntegration) systemIntegration.destroy();
    if (powerManagement) powerManagement.cleanup();
    if (voiceTranscription) voiceTranscription.destroy();
    if (fileManagement) fileManagement.destroy();
    
    console.log('Application cleanup complete');
});

// Handle protocol for deep linking if needed
app.setAsDefaultProtocolClient('terminal-gui');

// Security: Prevent new window creation
app.on('web-contents-created', (event, contents) => {
    contents.on('new-window', (event, navigationUrl) => {
        event.preventDefault();
        console.warn('Blocked new window creation:', navigationUrl);
    });
});

// Handle certificate errors
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    // Prevent default behavior and handle certificate errors appropriately
    event.preventDefault();
    console.warn('Certificate error for:', url, error);
    callback(false); // Reject certificate
});

// Export for testing if needed
module.exports = {
    dataManager,
    systemIntegration,
    powerManagement,
    voiceTranscription,
    fileManagement,
    createWindow,
    getMainWindow: () => mainWindow
};
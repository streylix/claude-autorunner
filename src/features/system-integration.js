/**
 * System Integration Module
 * Handles system tray, notifications, and OS-level integrations
 */

const { app, Tray, Menu, Notification, ipcMain } = require('electron');
const path = require('path');

class SystemIntegration {
    constructor() {
        this.tray = null;
        this.mainWindow = null;
        this.isQuitting = false;
        this.setupIpcHandlers();
    }

    setMainWindow(window) {
        this.mainWindow = window;
    }

    getIcon() {
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
            const iconPath = path.join(__dirname, '..', '..', iconFile);
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

    createTray() {
        const iconPath = this.getIcon() || path.join(__dirname, '..', '..', 'logo.png');
        this.tray = new Tray(iconPath);

        const contextMenu = Menu.buildFromTemplate([
            {
                label: 'Show/Hide Window',
                click: () => {
                    if (this.mainWindow) {
                        if (this.mainWindow.isVisible()) {
                            this.mainWindow.hide();
                        } else {
                            this.mainWindow.show();
                            this.mainWindow.focus();
                        }
                    }
                }
            },
            {
                type: 'separator'
            },
            {
                label: 'Quit Application',
                click: () => {
                    this.isQuitting = true;
                    app.quit();
                }
            }
        ]);

        this.tray.setContextMenu(contextMenu);
        this.tray.setToolTip('Terminal GUI - Auto Injector');

        // Handle tray click events
        this.tray.on('click', () => {
            if (this.mainWindow) {
                if (this.mainWindow.isVisible()) {
                    this.mainWindow.focus();
                } else {
                    this.mainWindow.show();
                    this.mainWindow.focus();
                }
            }
        });

        this.tray.on('double-click', () => {
            if (this.mainWindow) {
                this.mainWindow.show();
                this.mainWindow.focus();
            }
        });

        console.log('System tray created successfully');
        return this.tray;
    }

    setupTrayEventListeners() {
        if (!this.tray) return;

        // Additional tray event listeners if needed
        this.tray.on('right-click', () => {
            // Right-click already handled by context menu
        });

        this.tray.on('balloon-click', () => {
            if (this.mainWindow) {
                this.mainWindow.show();
                this.mainWindow.focus();
            }
        });
    }

    updateTrayBadge(count) {
        if (this.tray) {
            if (count > 0) {
                // On macOS, we can set badge count
                if (process.platform === 'darwin') {
                    app.setBadgeCount(count);
                }
                
                // Update tooltip to show queue count
                this.tray.setToolTip(`Terminal GUI - ${count} message(s) in queue`);
                
                // On Windows/Linux, we could change the icon to indicate messages
                // For now, just update the tooltip
            } else {
                if (process.platform === 'darwin') {
                    app.setBadgeCount(0);
                }
                this.tray.setToolTip('Terminal GUI - Auto Injector');
            }
        }
    }

    showNotification(title, body, options = {}) {
        try {
            if (Notification.isSupported()) {
                const notification = new Notification({
                    title: title || 'Terminal GUI',
                    body: body || '',
                    icon: this.getIcon(),
                    silent: options.silent || false,
                    urgency: options.urgency || 'normal'
                });

                notification.on('click', () => {
                    if (this.mainWindow) {
                        this.mainWindow.show();
                        this.mainWindow.focus();
                    }
                });

                notification.show();
                
                console.log('System notification shown:', title);
                return true;
            } else {
                console.warn('System notifications not supported');
                return false;
            }
        } catch (error) {
            console.error('Failed to show notification:', error);
            return false;
        }
    }

    // Window management helpers
    handleWindowClose(event) {
        if (!this.isQuitting && this.mainWindow) {
            event.preventDefault();
            this.mainWindow.hide();
            
            // Show notification on first hide
            if (process.platform === 'darwin') {
                this.showNotification(
                    'Terminal GUI',
                    'Application was minimized to tray',
                    { silent: true }
                );
            }
        }
    }

    handleWindowMinimize() {
        // Optional: Hide to tray on minimize
        if (this.mainWindow) {
            this.mainWindow.hide();
        }
    }

    // Dock/taskbar management (macOS specific)
    setDockVisibility(visible) {
        if (process.platform === 'darwin') {
            if (visible) {
                app.dock.show();
            } else {
                app.dock.hide();
            }
        }
    }

    // App badge management
    setBadgeCount(count) {
        if (process.platform === 'darwin') {
            app.setBadgeCount(count);
        }
    }

    // IPC handlers setup
    setupIpcHandlers() {
        ipcMain.handle('show-notification', async (event, title, body, options) => {
            return this.showNotification(title, body, options);
        });

        ipcMain.handle('update-tray-badge', async (event, count) => {
            this.updateTrayBadge(count);
            return true;
        });

        ipcMain.handle('set-badge-count', async (event, count) => {
            this.setBadgeCount(count);
            return true;
        });

        ipcMain.handle('show-window', async (event) => {
            if (this.mainWindow) {
                this.mainWindow.show();
                this.mainWindow.focus();
                return true;
            }
            return false;
        });

        ipcMain.handle('hide-window', async (event) => {
            if (this.mainWindow) {
                this.mainWindow.hide();
                return true;
            }
            return false;
        });

        ipcMain.handle('minimize-window', async (event) => {
            if (this.mainWindow) {
                this.mainWindow.minimize();
                return true;
            }
            return false;
        });

        ipcMain.handle('quit-app', async (event) => {
            this.isQuitting = true;
            app.quit();
        });
    }

    // Cleanup method
    destroy() {
        if (this.tray) {
            this.tray.destroy();
            this.tray = null;
        }
        
        if (process.platform === 'darwin') {
            app.setBadgeCount(0);
        }
        
        this.isQuitting = false;
    }

    // Getters
    getTray() {
        return this.tray;
    }

    getIsQuitting() {
        return this.isQuitting;
    }

    setIsQuitting(quitting) {
        this.isQuitting = quitting;
    }
}

module.exports = { SystemIntegration };
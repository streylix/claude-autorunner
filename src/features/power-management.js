/**
 * Power Management Module
 * Handles power save blocking and system power state management
 */

const { powerSaveBlocker, ipcMain } = require('electron');

class PowerManagement {
    constructor() {
        this.powerSaveBlockerId = null;
        this.isActive = false;
        this.setupIpcHandlers();
    }

    startPowerSaveBlocker() {
        try {
            if (this.powerSaveBlockerId !== null) {
                console.warn('Power save blocker already active');
                return { success: true, id: this.powerSaveBlockerId };
            }

            this.powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
            this.isActive = true;
            
            console.log('Power save blocker started with ID:', this.powerSaveBlockerId);
            return { 
                success: true, 
                id: this.powerSaveBlockerId,
                message: 'Screen sleep prevention enabled'
            };
        } catch (error) {
            console.error('Failed to start power save blocker:', error);
            return { 
                success: false, 
                error: error.message 
            };
        }
    }

    stopPowerSaveBlocker() {
        try {
            if (this.powerSaveBlockerId === null) {
                console.warn('Power save blocker not active');
                return { success: true, message: 'Power save blocker was not active' };
            }

            const result = powerSaveBlocker.stop(this.powerSaveBlockerId);
            
            if (result) {
                console.log('Power save blocker stopped successfully');
                this.powerSaveBlockerId = null;
                this.isActive = false;
                return { 
                    success: true,
                    message: 'Screen sleep prevention disabled'
                };
            } else {
                console.warn('Failed to stop power save blocker - invalid ID');
                // Reset state anyway
                this.powerSaveBlockerId = null;
                this.isActive = false;
                return { 
                    success: false, 
                    error: 'Invalid power save blocker ID' 
                };
            }
        } catch (error) {
            console.error('Error stopping power save blocker:', error);
            this.powerSaveBlockerId = null;
            this.isActive = false;
            return { 
                success: false, 
                error: error.message 
            };
        }
    }

    isPowerSaveBlockerActive() {
        try {
            if (this.powerSaveBlockerId === null) {
                return { active: false };
            }

            const isActive = powerSaveBlocker.isStarted(this.powerSaveBlockerId);
            
            // Update internal state if it's out of sync
            if (!isActive && this.isActive) {
                this.powerSaveBlockerId = null;
                this.isActive = false;
            }
            
            return {
                active: isActive,
                id: this.powerSaveBlockerId
            };
        } catch (error) {
            console.error('Error checking power save blocker status:', error);
            
            // Reset state on error
            this.powerSaveBlockerId = null;
            this.isActive = false;
            
            return {
                active: false,
                error: error.message
            };
        }
    }

    togglePowerSaveBlocker() {
        const status = this.isPowerSaveBlockerActive();
        
        if (status.active) {
            return this.stopPowerSaveBlocker();
        } else {
            return this.startPowerSaveBlocker();
        }
    }

    // Get power state information
    getPowerState() {
        const status = this.isPowerSaveBlockerActive();
        
        return {
            powerSaveBlocker: {
                active: status.active,
                id: this.powerSaveBlockerId,
                error: status.error
            },
            // Could add more power state info here if needed
            // battery: getBatteryInfo(), // If we want to track battery
            // powerSource: getPowerSource(), // AC vs battery
        };
    }

    // Cleanup method for app shutdown
    cleanup() {
        if (this.isActive && this.powerSaveBlockerId !== null) {
            console.log('Cleaning up power save blocker on shutdown');
            this.stopPowerSaveBlocker();
        }
    }

    // IPC handlers setup
    setupIpcHandlers() {
        ipcMain.handle('start-power-save-blocker', async (event) => {
            return this.startPowerSaveBlocker();
        });

        ipcMain.handle('stop-power-save-blocker', async (event) => {
            return this.stopPowerSaveBlocker();
        });

        ipcMain.handle('is-power-save-blocker-active', async (event) => {
            return this.isPowerSaveBlockerActive();
        });

        ipcMain.handle('toggle-power-save-blocker', async (event) => {
            return this.togglePowerSaveBlocker();
        });

        ipcMain.handle('get-power-state', async (event) => {
            return this.getPowerState();
        });
    }

    // Auto-start power save blocker based on preferences
    async autoStartIfEnabled(preferences = {}) {
        if (preferences.keepScreenAwake) {
            console.log('Auto-starting power save blocker based on preferences');
            return this.startPowerSaveBlocker();
        }
        return { success: true, message: 'Auto-start disabled in preferences' };
    }

    // Handle app events
    onAppReady() {
        console.log('Power management ready');
        // Could auto-start here if needed
    }

    onAppWillQuit() {
        console.log('App quitting - cleaning up power management');
        this.cleanup();
    }

    onAppSuspend() {
        // System is going to sleep
        console.log('System suspending - power save blocker will be cleared by system');
        // Reset state since the blocker will be cleared by the system
        this.powerSaveBlockerId = null;
        this.isActive = false;
    }

    onAppResume() {
        // System woke up
        console.log('System resumed');
        // Note: If we want to auto-restart the blocker after system wake,
        // we would need to track whether it was active before suspend
    }
}

module.exports = { PowerManagement };
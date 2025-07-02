/**
 * Data Manager Module
 * Handles file-based data persistence, settings, and app state management
 */

const { app, ipcMain } = require('electron');
const fs = require('fs').promises;
const path = require('path');

class DataManager {
    constructor() {
        this.dataFilePath = null;
        this.initialized = false;
        this.setupIpcHandlers();
    }

    init() {
        if (this.initialized) return;
        
        try {
            // Create data file in app data directory for persistence
            const userDataPath = app.getPath('userData');
            this.dataFilePath = path.join(userDataPath, 'auto-injector-data.json');
            
            console.log('Data storage initialized at:', this.dataFilePath);
            this.initialized = true;
        } catch (error) {
            console.error('Failed to initialize data storage:', error);
            throw error;
        }
    }

    async readDataFile() {
        if (!this.dataFilePath) {
            this.init();
        }
        
        try {
            const data = await fs.readFile(this.dataFilePath, 'utf8');
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

    async writeDataFile(data) {
        if (!this.dataFilePath) {
            this.init();
        }
        
        try {
            await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2), 'utf8');
            return true;
        } catch (error) {
            console.error('Failed to write data file:', error);
            return false;
        }
    }

    // Settings management
    async getSetting(key) {
        try {
            const data = await this.readDataFile();
            return data.settings[key];
        } catch (error) {
            console.error('Failed to get setting:', key, error);
            return null;
        }
    }

    async setSetting(key, value) {
        try {
            const data = await this.readDataFile();
            data.settings[key] = value;
            await this.writeDataFile(data);
            return true;
        } catch (error) {
            console.error('Failed to set setting:', key, error);
            return false;
        }
    }

    async getAllSettings() {
        try {
            const data = await this.readDataFile();
            return data.settings || {};
        } catch (error) {
            console.error('Failed to get all settings:', error);
            return {};
        }
    }

    // Message queue management
    async getMessages() {
        try {
            const data = await this.readDataFile();
            return data.messages || [];
        } catch (error) {
            console.error('Failed to get messages:', error);
            return [];
        }
    }

    async saveMessages(messages) {
        try {
            const data = await this.readDataFile();
            data.messages = messages || [];
            await this.writeDataFile(data);
            return true;
        } catch (error) {
            console.error('Failed to save messages:', error);
            return false;
        }
    }

    async saveMessage(message) {
        try {
            const data = await this.readDataFile();
            if (!data.messages) data.messages = [];
            data.messages.push(message);
            await this.writeDataFile(data);
            return true;
        } catch (error) {
            console.error('Failed to save message:', error);
            return false;
        }
    }

    async deleteMessage(messageId) {
        try {
            const data = await this.readDataFile();
            if (!data.messages) return true;
            
            data.messages = data.messages.filter(m => m.id !== messageId);
            await this.writeDataFile(data);
            return true;
        } catch (error) {
            console.error('Failed to delete message:', error);
            return false;
        }
    }

    async clearMessages() {
        try {
            const data = await this.readDataFile();
            data.messages = [];
            await this.writeDataFile(data);
            return true;
        } catch (error) {
            console.error('Failed to clear messages:', error);
            return false;
        }
    }

    // Message history management
    async getMessageHistory() {
        try {
            const data = await this.readDataFile();
            return data.messageHistory || [];
        } catch (error) {
            console.error('Failed to get message history:', error);
            return [];
        }
    }

    async saveMessageHistory(history) {
        try {
            const data = await this.readDataFile();
            data.messageHistory = history || [];
            await this.writeDataFile(data);
            return true;
        } catch (error) {
            console.error('Failed to save message history:', error);
            return false;
        }
    }

    // App state management
    async getAppState(key) {
        try {
            const data = await this.readDataFile();
            return data.appState[key];
        } catch (error) {
            console.error('Failed to get app state:', key, error);
            return null;
        }
    }

    async setAppState(key, value) {
        try {
            const data = await this.readDataFile();
            if (!data.appState) data.appState = {};
            data.appState[key] = value;
            await this.writeDataFile(data);
            return true;
        } catch (error) {
            console.error('Failed to set app state:', key, error);
            return false;
        }
    }

    // Migration utilities
    async migrateFromLocalStorage(localStorageData) {
        try {
            const data = await this.readDataFile();
            
            // Migrate settings
            if (localStorageData.preferences) {
                Object.assign(data.settings, localStorageData.preferences);
            }
            
            // Migrate messages
            if (localStorageData.messageQueue) {
                data.messages = localStorageData.messageQueue;
            }
            
            // Migrate message history
            if (localStorageData.messageHistory) {
                data.messageHistory = localStorageData.messageHistory;
            }
            
            await this.writeDataFile(data);
            return true;
        } catch (error) {
            console.error('Failed to migrate from localStorage:', error);
            return false;
        }
    }

    // Backup utilities
    async createBackup() {
        try {
            const data = await this.readDataFile();
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = this.dataFilePath.replace('.json', `_backup_${timestamp}.json`);
            
            await fs.writeFile(backupPath, JSON.stringify(data, null, 2), 'utf8');
            return backupPath;
        } catch (error) {
            console.error('Failed to create backup:', error);
            return null;
        }
    }

    async restoreFromBackup(backupPath) {
        try {
            const backupData = await fs.readFile(backupPath, 'utf8');
            const data = JSON.parse(backupData);
            await this.writeDataFile(data);
            return true;
        } catch (error) {
            console.error('Failed to restore from backup:', error);
            return false;
        }
    }

    // IPC handlers setup
    setupIpcHandlers() {
        // Settings IPC handlers
        ipcMain.handle('db-get-setting', async (event, key) => {
            return await this.getSetting(key);
        });

        ipcMain.handle('db-set-setting', async (event, key, value) => {
            return await this.setSetting(key, value);
        });

        ipcMain.handle('db-get-all-settings', async (event) => {
            return await this.getAllSettings();
        });

        // Message queue IPC handlers
        ipcMain.handle('db-get-messages', async (event) => {
            return await this.getMessages();
        });

        ipcMain.handle('db-save-messages', async (event, messages) => {
            return await this.saveMessages(messages);
        });

        ipcMain.handle('db-save-message', async (event, message) => {
            return await this.saveMessage(message);
        });

        ipcMain.handle('db-delete-message', async (event, messageId) => {
            return await this.deleteMessage(messageId);
        });

        ipcMain.handle('db-clear-messages', async (event) => {
            return await this.clearMessages();
        });

        // Message history IPC handlers
        ipcMain.handle('db-get-message-history', async (event) => {
            return await this.getMessageHistory();
        });

        ipcMain.handle('db-save-message-history', async (event, history) => {
            return await this.saveMessageHistory(history);
        });

        // App state IPC handlers
        ipcMain.handle('db-get-app-state', async (event, key) => {
            return await this.getAppState(key);
        });

        ipcMain.handle('db-set-app-state', async (event, key, value) => {
            return await this.setAppState(key, value);
        });

        // Migration IPC handlers
        ipcMain.handle('db-migrate-localstorage', async (event, localStorageData) => {
            return await this.migrateFromLocalStorage(localStorageData);
        });

        // Backup and restore IPC handlers
        ipcMain.handle('backup-localstorage', async (event) => {
            return await this.createBackup();
        });

        ipcMain.handle('restore-localstorage', async (event, backupPath) => {
            return await this.restoreFromBackup(backupPath);
        });
    }

    // Cleanup method
    destroy() {
        // Clean up any resources if needed
        this.initialized = false;
    }
}

module.exports = { DataManager };
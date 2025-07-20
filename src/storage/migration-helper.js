/**
 * Migration Helper for Unified Storage
 * Safely migrates from legacy storage systems to electron-store
 */

const fs = require('fs');
const path = require('path');
const unifiedStore = require('./unified-store');

class MigrationHelper {
  
  static async migrateLegacyData() {
    console.log('🔄 Starting legacy data migration...');
    
    try {
      // 1. Migrate from old JSON file
      await this.migrateFromJsonFile();
      
      // 2. Migrate localStorage data (if any exists)
      await this.migrateFromLocalStorage();
      
      // 3. Validate migration
      const isValid = this.validateMigration();
      
      if (isValid) {
        console.log('✅ Migration completed successfully');
        // Create backup of successful migration
        unifiedStore.backup();
        return true;
      } else {
        console.error('❌ Migration validation failed');
        return false;
      }
      
    } catch (error) {
      console.error('❌ Migration failed:', error);
      return false;
    }
  }
  
  static async migrateFromJsonFile() {
    const legacyPath = path.join(
      require('electron').app.getPath('userData'), 
      'auto-injector-data.json'
    );
    
    if (!fs.existsSync(legacyPath)) {
      console.log('📁 No legacy JSON file found, skipping...');
      return;
    }
    
    try {
      const rawData = fs.readFileSync(legacyPath, 'utf8');
      
      // Handle empty file
      if (!rawData.trim()) {
        console.log('📄 Legacy file is empty, using defaults');
        return;
      }
      
      const legacyData = JSON.parse(rawData);
      console.log('📖 Legacy data loaded');
      
      // Fix the dreaded double JSON encoding
      if (legacyData.settings) {
        for (const [key, value] of Object.entries(legacyData.settings)) {
          if (typeof value === 'string' && this.isJsonString(value)) {
            try {
              legacyData.settings[key] = JSON.parse(value);
              console.log(`🔧 Fixed double encoding for: ${key}`);
            } catch (e) {
              console.warn(`⚠️ Could not parse ${key}, keeping as string`);
            }
          }
        }
      }
      
      // Migrate each section
      if (legacyData.settings) {
        console.log('📦 Migrating settings...');
        unifiedStore.saveAllSettings(legacyData.settings);
      }
      
      if (legacyData.messages && Array.isArray(legacyData.messages)) {
        console.log(`📨 Migrating ${legacyData.messages.length} messages...`);
        unifiedStore.saveMessages(legacyData.messages);
      }
      
      if (legacyData.messageHistory && Array.isArray(legacyData.messageHistory)) {
        console.log(`📚 Migrating ${legacyData.messageHistory.length} history items...`);
        // Add to history one by one to ensure proper formatting
        legacyData.messageHistory.forEach(item => {
          unifiedStore.addToHistory(item);
        });
      }
      
      if (legacyData.appState) {
        console.log('🔧 Migrating app state...');
        unifiedStore.saveAppState(legacyData.appState);
      }
      
      // Backup original file before removal
      const backupPath = `${legacyPath}.migrated.${Date.now()}`;
      fs.copyFileSync(legacyPath, backupPath);
      console.log(`💾 Original file backed up to: ${backupPath}`);
      
      // Remove original to prevent confusion
      fs.unlinkSync(legacyPath);
      console.log('🗑️ Legacy file removed');
      
    } catch (error) {
      console.error('❌ JSON file migration failed:', error.message);
      
      // If JSON is corrupted, try to salvage what we can
      if (error.message.includes('JSON')) {
        console.log('🚑 Attempting to salvage corrupted data...');
        await this.salvageCorruptedData(legacyPath);
      }
    }
  }
  
  static async migrateFromLocalStorage() {
    // This would need to be called from renderer process
    // For now, we'll handle this through IPC in the main process
    console.log('📱 localStorage migration handled by renderer process');
  }
  
  static async salvageCorruptedData(filePath) {
    try {
      const rawData = fs.readFileSync(filePath, 'utf8');
      
      // Try to extract settings from corrupted JSON
      const settingsMatch = rawData.match(/"settings":\s*{([^}]+)}/);
      if (settingsMatch) {
        // Basic key-value extraction
        const keyValuePairs = settingsMatch[1].match(/"([^"]+)":\s*"([^"]+)"/g);
        if (keyValuePairs) {
          const salvaged = {};
          keyValuePairs.forEach(pair => {
            const [key, value] = pair.split(':').map(s => s.replace(/"/g, '').trim());
            salvaged[key] = value;
          });
          
          console.log('🚑 Salvaged settings:', Object.keys(salvaged));
          unifiedStore.saveAllSettings(salvaged);
        }
      }
      
    } catch (error) {
      console.error('💀 Data salvage failed:', error.message);
    }
  }
  
  static isJsonString(str) {
    try {
      JSON.parse(str);
      return true;
    } catch (e) {
      return false;
    }
  }
  
  static validateMigration() {
    try {
      // Check if we can read basic data
      const settings = unifiedStore.getAllSettings();
      const messages = unifiedStore.getMessages();
      const history = unifiedStore.getMessageHistory();
      const appState = unifiedStore.getAppState();
      
      // Validate terminal state (the main culprit)
      const terminalState = unifiedStore.getTerminalState();
      
      const isValid = (
        typeof settings === 'object' &&
        Array.isArray(messages) &&
        Array.isArray(history) &&
        typeof appState === 'object' &&
        typeof terminalState === 'object' &&
        typeof terminalState.activeTerminalId === 'number'
      );
      
      console.log('✅ Migration validation:', {
        settings: typeof settings,
        messages: `array[${messages.length}]`,
        history: `array[${history.length}]`,
        appState: typeof appState,
        terminalState: typeof terminalState,
        isValid
      });
      
      return isValid;
      
    } catch (error) {
      console.error('❌ Validation error:', error.message);
      return false;
    }
  }
  
  static async cleanupLegacyFiles() {
    const userDataPath = require('electron').app.getPath('userData');
    const patterns = [
      'auto-injector-data.json.backup.*',
      'auto-injector-data.json.migrated.*'
    ];
    
    // Keep only the 5 most recent backup files
    patterns.forEach(pattern => {
      const files = fs.readdirSync(userDataPath)
        .filter(file => file.match(pattern))
        .map(file => ({
          name: file,
          path: path.join(userDataPath, file),
          mtime: fs.statSync(path.join(userDataPath, file)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);
      
      // Remove old backups, keep 5 most recent
      files.slice(5).forEach(file => {
        fs.unlinkSync(file.path);
        console.log(`🗑️ Cleaned up old backup: ${file.name}`);
      });
    });
  }
  
  static getStorageStats() {
    const storePath = unifiedStore.getStorePath();
    const stats = unifiedStore.getStats();
    
    return {
      ...stats,
      migrationComplete: fs.existsSync(storePath),
      legacyFileExists: fs.existsSync(
        path.join(require('electron').app.getPath('userData'), 'auto-injector-data.json')
      )
    };
  }
}

module.exports = MigrationHelper;
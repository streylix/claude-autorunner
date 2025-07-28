/**
 * Unified Persistence Layer using electron-store
 * Replaces broken JSON file system with atomic operations
 * 
 * Fixes:
 * - Double JSON encoding corruption
 * - Data loss during app crashes
 * - Race conditions in concurrent access
 * - No schema validation
 */

const AtomicStore = require('./atomic-store');
const path = require('path');
const fs = require('fs');

// Schema definition to prevent corruption
const schema = {
  settings: {
    type: 'object',
    properties: {
      terminalState: {
        type: 'object',
        properties: {
          activeTerminalId: { type: 'number' },
          terminalIdCounter: { type: 'number' },
          terminals: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                name: { type: 'string' },
                color: { type: 'string' },
                directory: { type: 'string' }
              }
            }
          }
        },
        default: {
          activeTerminalId: 1,
          terminalIdCounter: 1,
          terminals: [{
            id: 1,
            name: 'Terminal 1',
            color: '#007acc',
            directory: process.cwd()
          }]
        }
      },
      autoContinueEnabled: { type: 'boolean', default: false },
      theme: { type: 'string', default: 'dark' },
      keywordRules: { type: 'array', default: [] },
      timerHours: { type: 'number', default: 0 },
      timerMinutes: { type: 'number', default: 0 },
      timerSeconds: { type: 'number', default: 5 },
      soundEffects: { type: 'boolean', default: true },
      backgroundService: { type: 'boolean', default: false },
      currentDirectory: { type: 'string', default: process.cwd() }
    },
    default: {}
  },
  messages: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        content: { type: 'string' },
        timestamp: { type: 'number' },
        status: { type: 'string' },
        retryCount: { type: 'number' }
      }
    },
    default: []
  },
  messageHistory: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        content: { type: 'string' },
        timestamp: { type: 'number' },
        result: { type: 'string' }
      }
    },
    default: []
  },
  appState: {
    type: 'object',
    properties: {
      currentlyInjectingMessages: { type: 'boolean', default: false },
      messageSequenceCounter: { type: 'number', default: 0 },
      usageLimitResetTime: { type: 'number' },
      usageLimitTimerLastResetTime: { type: 'number' },
      usageLimitTimerOriginalValues: { type: 'object', default: {} }
    },
    default: {}
  }
};

// Migration functions to fix existing data corruption
const migrations = {
  '1.0.0': store => {
    console.log('🔄 Migrating from legacy JSON storage...');
    
    // Try to recover from old corrupted data file
    const legacyPath = path.join(require('electron').app.getPath('userData'), 'auto-injector-data.json');
    
    try {
      if (fs.existsSync(legacyPath)) {
        const legacyData = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        
        // Fix double JSON encoding issue
        if (legacyData.settings && typeof legacyData.settings.terminalState === 'string') {
          try {
            legacyData.settings.terminalState = JSON.parse(legacyData.settings.terminalState);
            console.log('✅ Fixed terminalState double encoding');
          } catch (e) {
            console.warn('⚠️ Could not parse terminalState, using defaults');
            legacyData.settings.terminalState = schema.settings.properties.terminalState.default;
          }
        }
        
        // Migrate each section safely
        if (legacyData.settings) store.set('settings', legacyData.settings);
        if (legacyData.messages) store.set('messages', legacyData.messages);
        if (legacyData.messageHistory) store.set('messageHistory', legacyData.messageHistory);
        if (legacyData.appState) store.set('appState', legacyData.appState);
        
        // Backup original before removal
        const backupPath = `${legacyPath}.backup.${Date.now()}`;
        fs.copyFileSync(legacyPath, backupPath);
        console.log(`📦 Legacy data backed up to: ${backupPath}`);
        
        console.log('✅ Migration completed successfully');
      }
    } catch (error) {
      console.error('❌ Migration failed, using defaults:', error.message);
    }
  }
};

// Initialize atomic store
const store = new AtomicStore({
  name: 'auto-injector'
});

/**
 * Unified Storage API
 * Replaces all the scattered storage methods with atomic operations
 */
class UnifiedStore {
  constructor() {
    // Debounce settings writes to prevent lock contention
    this.settingsBuffer = new Map();
    this.settingsWriteTimer = null;
    this.writeDelay = 100; // 100ms debounce
  }
  
  // Settings Management
  async getSetting(key) {
    return await store.get(`settings.${key}`);
  }
  
  async setSetting(key, value) {
    // Buffer the write and debounce
    this.settingsBuffer.set(key, value);
    
    if (this.settingsWriteTimer) {
      clearTimeout(this.settingsWriteTimer);
    }
    
    this.settingsWriteTimer = setTimeout(async () => {
      try {
        // Write all buffered settings at once
        const settings = await this.getAllSettings();
        for (const [bufferedKey, bufferedValue] of this.settingsBuffer) {
          settings[bufferedKey] = bufferedValue;
        }
        
        await store.set('settings', settings);
        this.settingsBuffer.clear();
      } catch (error) {
        console.error('Error setting setting:', error);
        throw error;
      }
    }, this.writeDelay);
  }
  
  async getAllSettings() {
    return await store.get('settings', {});
  }
  
  async saveAllSettings(settings) {
    await store.set('settings', settings);
  }
  
  // Terminal State Management (fixes the double encoding issue)
  async getTerminalState() {
    return await store.get('settings.terminalState', schema.settings.properties.terminalState.default);
  }
  
  async setTerminalState(terminalState) {
    // Use the same debounced mechanism for terminal state
    await this.setSetting('terminalState', terminalState);
  }
  
  // Terminal State Validation and Recovery
  async validateTerminalState() {
    const fs = require('fs');
    const terminalState = await this.getTerminalState();
    let hasInvalidDirectories = false;
    const validatedTerminals = [];
    
    if (terminalState && terminalState.terminals) {
      for (const terminal of terminalState.terminals) {
        let isValid = true;
        
        // Validate directory exists
        if (terminal.directory) {
          try {
            const dirStat = fs.statSync(terminal.directory);
            if (!dirStat.isDirectory()) {
              console.warn('Terminal', terminal.id, 'directory is not a directory:', terminal.directory);
              isValid = false;
              hasInvalidDirectories = true;
            } else {
              // Check if we can access the directory
              fs.accessSync(terminal.directory, fs.constants.R_OK);
            }
          } catch (error) {
            console.warn('Terminal', terminal.id, 'directory validation failed:', error.message);
            isValid = false;
            hasInvalidDirectories = true;
          }
        }
        
        if (isValid) {
          validatedTerminals.push(terminal);
        } else {
          // Fix the terminal by setting a valid directory
          const fixedTerminal = {
            ...terminal,
            directory: process.cwd()
          };
          validatedTerminals.push(fixedTerminal);
          console.log('Fixed terminal', terminal.id, 'directory from', terminal.directory, 'to', process.cwd());
        }
      }
    }
    
    // If we found invalid directories, update the state
    if (hasInvalidDirectories) {
      const fixedState = {
        ...terminalState,
        terminals: validatedTerminals
      };
      
      // Ensure we have at least one terminal
      if (fixedState.terminals.length === 0) {
        fixedState.terminals = [{
          id: 1,
          name: 'Terminal 1',
          color: '#007acc',
          directory: process.cwd()
        }];
        fixedState.activeTerminalId = 1;
        fixedState.terminalIdCounter = 2;
      }
      
      await this.setTerminalState(fixedState);
      console.log('Terminal state validation completed. Fixed', 
        terminalState.terminals.length - validatedTerminals.length, 'invalid directories');
      
      return { fixed: true, invalidCount: terminalState.terminals.length - validatedTerminals.length };
    }
    
    return { fixed: false, invalidCount: 0 };
  }
  
  async resetTerminalStateToDefaults() {
    const defaultState = {
      activeTerminalId: 1,
      terminalIdCounter: 2,
      terminals: [{
        id: 1,
        name: 'Terminal 1',
        color: '#007acc',
        directory: process.cwd()
      }]
    };
    
    await this.setTerminalState(defaultState);
    console.log('Terminal state reset to defaults');
    return defaultState;
  }
  
  // Message Queue Management
  async getMessages() {
    return await store.get('messages', []);
  }
  
  async saveMessages(messages) {
    await store.set('messages', messages);
  }
  
  async addMessage(message) {
    const messages = await this.getMessages();
    messages.push({
      ...message,
      id: message.id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: message.timestamp || Date.now()
    });
    await this.saveMessages(messages);
  }
  
  async removeMessage(messageId) {
    const messages = await this.getMessages();
    const filtered = messages.filter(msg => msg.id !== messageId);
    await this.saveMessages(filtered);
    return filtered.length !== messages.length;
  }
  
  // Message History Management
  async getMessageHistory() {
    return await store.get('messageHistory', []);
  }
  
  async addToHistory(historyItem) {
    const history = await this.getMessageHistory();
    history.push({
      ...historyItem,
      id: historyItem.id || `hist_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: historyItem.timestamp || Date.now()
    });
    
    // Keep only last 1000 history items to prevent bloat
    if (history.length > 1000) {
      history.splice(0, history.length - 1000);
    }
    
    await store.set('messageHistory', history);
  }
  
  async clearHistory() {
    await store.set('messageHistory', []);
  }
  
  // App State Management
  async getAppState() {
    return await store.get('appState', {});
  }
  
  async setAppState(key, value) {
    await store.set(`appState.${key}`, value);
  }
  
  async saveAppState(appState) {
    await store.set('appState', appState);
  }
  
  // Utility Methods
  async clear() {
    await store.clear();
  }
  
  async backup() {
    const backupData = {
      settings: await this.getAllSettings(),
      messages: await this.getMessages(),
      messageHistory: await this.getMessageHistory(),
      appState: await this.getAppState(),
      timestamp: Date.now(),
      version: '1.0.0'
    };
    
    return await store.createBackup();
  }
  
  async restore(backupPath) {
    try {
      const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      
      if (backupData.settings) await this.saveAllSettings(backupData.settings);
      if (backupData.messages) await this.saveMessages(backupData.messages);
      if (backupData.messageHistory) await store.set('messageHistory', backupData.messageHistory);
      if (backupData.appState) await this.saveAppState(backupData.appState);
      
      console.log('✅ Data restored from backup');
      return true;
    } catch (error) {
      console.error('❌ Restore failed:', error.message);
      return false;
    }
  }
  
  // Health Check
  async validateStore() {
    return await store.validateStore();
  }
  
  async getStorePath() {
    return store.storePath;
  }
  
  async getStats() {
    return await store.getStats();
  }
}

// Export singleton instance
const unifiedStore = new UnifiedStore();

module.exports = unifiedStore;
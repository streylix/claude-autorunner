/**
 * Atomic JSON Storage System
 * Industry-standard atomic writes + schema validation without ESM issues
 * 
 * Fixes:
 * - Double JSON encoding corruption
 * - Data loss during app crashes  
 * - Race conditions in concurrent access
 * - No schema validation
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

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
          terminals: { type: 'array' }
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
      timerSeconds: { type: 'number', default: 5 }
    },
    default: {}
  },
  messages: { type: 'array', default: [] },
  messageHistory: { type: 'array', default: [] },
  appState: { type: 'object', default: {} }
};

class AtomicStore {
  constructor(options = {}) {
    this.name = options.name || 'app-data';
    this.userDataPath = require('electron').app.getPath('userData');
    this.storePath = path.join(this.userDataPath, `${this.name}.json`);
    this.tempPath = `${this.storePath}.tmp`;
    this.lockPath = `${this.storePath}.lock`;
    this.backupPath = path.join(this.userDataPath, 'backups');
    
    // Ensure backup directory exists
    this.ensureBackupDir();
    
    // In-memory cache for performance
    this.cache = null;
    this.dirty = false;
    
    // Write queue to prevent lock contention
    this.writeQueue = [];
    this.isProcessingQueue = false;
    
    // Backup throttling - only backup once per 5 minutes
    this.lastBackupTime = 0;
    this.backupThrottle = 300000; // 5 minutes
    
    console.log(`🏪 AtomicStore initialized: ${this.storePath}`);
  }
  
  ensureBackupDir() {
    try {
      if (!fsSync.existsSync(this.backupPath)) {
        fsSync.mkdirSync(this.backupPath, { recursive: true });
      }
    } catch (error) {
      console.warn('⚠️ Could not create backup directory:', error.message);
    }
  }
  
  // Atomic write with temp file + rename (industry standard)
  async atomicWrite(data) {
    const lockId = crypto.randomBytes(8).toString('hex');
    
    try {
      // 1. Acquire write lock
      await this.acquireLock(lockId);
      
      // 2. Write to temp file first
      const jsonData = JSON.stringify(data, null, 2);
      await fs.writeFile(this.tempPath, jsonData, 'utf8');
      
      // 3. Atomic rename (this is the magic - either fully succeeds or fails)
      await fs.rename(this.tempPath, this.storePath);
      
      // 4. Update cache
      this.cache = data;
      this.dirty = false;
      
      console.log(`💾 Atomic write completed: ${Object.keys(data).join(', ')}`);
      return true;
      
    } catch (error) {
      console.error('❌ Atomic write failed:', error.message);
      
      // Cleanup temp file if it exists
      try {
        await fs.unlink(this.tempPath);
      } catch (e) { /* ignore */ }
      
      return false;
    } finally {
      // 5. Release lock
      await this.releaseLock(lockId);
    }
  }
  
  async acquireLock(lockId, timeout = 15000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        // Try to create lock file exclusively
        await fs.writeFile(this.lockPath, lockId, { flag: 'wx' });
        return true; // Lock acquired
      } catch (error) {
        if (error.code === 'EEXIST') {
          // Lock exists, wait and retry
          await new Promise(resolve => setTimeout(resolve, 10));
          continue;
        }
        throw error;
      }
    }
    
    throw new Error('Failed to acquire write lock - timeout');
  }
  
  async releaseLock(lockId) {
    try {
      const existingLock = await fs.readFile(this.lockPath, 'utf8');
      if (existingLock === lockId) {
        await fs.unlink(this.lockPath);
      }
    } catch (error) {
      // Lock file might not exist, ignore
    }
  }
  
  // Schema validation and data fixing
  validateAndFix(data) {
    const fixed = { ...data };
    
    // Fix double JSON encoding issues
    if (fixed.settings && typeof fixed.settings === 'object') {
      for (const [key, value] of Object.entries(fixed.settings)) {
        if (typeof value === 'string' && this.isJsonString(value)) {
          try {
            fixed.settings[key] = JSON.parse(value);
            console.log(`🔧 Fixed double encoding for: ${key}`);
          } catch (e) {
            console.warn(`⚠️ Could not parse ${key}, keeping as string`);
          }
        }
      }
    }
    
    // Apply schema defaults
    for (const [section, sectionSchema] of Object.entries(schema)) {
      if (!fixed[section]) {
        fixed[section] = sectionSchema.default;
      }
    }
    
    // Ensure terminalState is always an object, not a string
    if (fixed.settings && fixed.settings.terminalState) {
      if (typeof fixed.settings.terminalState === 'string') {
        try {
          fixed.settings.terminalState = JSON.parse(fixed.settings.terminalState);
          console.log('🔧 Fixed terminalState string encoding');
        } catch (e) {
          // If parsing fails, use default
          fixed.settings.terminalState = schema.settings.properties.terminalState.default;
          console.warn('⚠️ terminalState corrupted, using default');
        }
      }
    }
    
    return fixed;
  }
  
  isJsonString(str) {
    try {
      const parsed = JSON.parse(str);
      return typeof parsed === 'object' || Array.isArray(parsed);
    } catch (e) {
      return false;
    }
  }
  
  async read() {
    // Return cache if available and clean
    if (this.cache && !this.dirty) {
      return this.cache;
    }
    
    try {
      const rawData = await fs.readFile(this.storePath, 'utf8');
      
      if (!rawData.trim()) {
        console.log('📄 Store file is empty, using defaults');
        return this.getDefaults();
      }
      
      const data = JSON.parse(rawData);
      const validatedData = this.validateAndFix(data);
      
      // Update cache
      this.cache = validatedData;
      this.dirty = false;
      
      return validatedData;
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('📁 Store file not found, creating with defaults');
        return this.getDefaults();
      }
      
      console.error('❌ Failed to read store:', error.message);
      
      // Try to recover from backup
      const recovered = await this.recoverFromBackup();
      if (recovered) {
        return recovered;
      }
      
      // Last resort: return defaults
      return this.getDefaults();
    }
  }
  
  getDefaults() {
    const defaults = {};
    for (const [section, sectionSchema] of Object.entries(schema)) {
      defaults[section] = sectionSchema.default;
    }
    return defaults;
  }
  
  async write(data) {
    const validatedData = this.validateAndFix(data);
    
    // Add to queue and process
    return new Promise((resolve, reject) => {
      this.writeQueue.push({
        data: validatedData,
        resolve,
        reject
      });
      
      this.processQueue();
    });
  }
  
  async processQueue() {
    if (this.isProcessingQueue || this.writeQueue.length === 0) {
      return;
    }
    
    this.isProcessingQueue = true;
    
    while (this.writeQueue.length > 0) {
      const { data, resolve, reject } = this.writeQueue.shift();
      
      try {
        // Create backup before writing
        await this.createBackup();
        
        // Perform atomic write
        const success = await this.atomicWrite(data);
        
        if (!success) {
          throw new Error('Atomic write failed');
        }
        
        resolve(true);
      } catch (error) {
        reject(error);
      }
    }
    
    this.isProcessingQueue = false;
  }
  
  async createBackup() {
    try {
      if (!fsSync.existsSync(this.storePath)) {
        return; // No file to backup
      }
      
      // Throttle backups to prevent excessive I/O
      const now = Date.now();
      if (now - this.lastBackupTime < this.backupThrottle) {
        return; // Skip backup, too soon
      }
      this.lastBackupTime = now;
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(this.backupPath, `${this.name}-${timestamp}.json`);
      
      await fs.copyFile(this.storePath, backupFile);
      
      // Keep only last 10 backups
      await this.cleanupOldBackups();
      
      console.log(`📦 Backup created: ${path.basename(backupFile)}`);
    } catch (error) {
      console.warn('⚠️ Backup creation failed:', error.message);
    }
  }
  
  async cleanupOldBackups() {
    try {
      const files = await fs.readdir(this.backupPath);
      const backupFiles = files
        .filter(file => file.startsWith(this.name) && file.endsWith('.json'))
        .map(file => ({
          name: file,
          path: path.join(this.backupPath, file),
          mtime: fsSync.statSync(path.join(this.backupPath, file)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);
      
      // Remove old backups, keep 10 most recent
      for (const file of backupFiles.slice(10)) {
        await fs.unlink(file.path);
        console.log(`🗑️ Cleaned old backup: ${file.name}`);
      }
    } catch (error) {
      console.warn('⚠️ Backup cleanup failed:', error.message);
    }
  }
  
  async recoverFromBackup() {
    try {
      const files = await fs.readdir(this.backupPath);
      const backupFiles = files
        .filter(file => file.startsWith(this.name) && file.endsWith('.json'))
        .map(file => ({
          name: file,
          path: path.join(this.backupPath, file),
          mtime: fsSync.statSync(path.join(this.backupPath, file)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);
      
      for (const backup of backupFiles) {
        try {
          const data = await fs.readFile(backup.path, 'utf8');
          const parsed = JSON.parse(data);
          console.log(`🚑 Recovered from backup: ${backup.name}`);
          return this.validateAndFix(parsed);
        } catch (e) {
          console.warn(`⚠️ Backup corrupted: ${backup.name}`);
        }
      }
    } catch (error) {
      console.warn('⚠️ Recovery failed:', error.message);
    }
    
    return null;
  }
  
  // High-level API methods
  async get(key, defaultValue = undefined) {
    const data = await this.read();
    const keys = key.split('.');
    let current = data;
    
    for (const k of keys) {
      if (current && typeof current === 'object' && k in current) {
        current = current[k];
      } else {
        return defaultValue;
      }
    }
    
    return current;
  }
  
  async set(key, value) {
    const data = await this.read();
    const keys = key.split('.');
    let current = data;
    
    // Navigate to parent
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!current[k] || typeof current[k] !== 'object') {
        current[k] = {};
      }
      current = current[k];
    }
    
    // Set value
    current[keys[keys.length - 1]] = value;
    
    // Write back
    await this.write(data);
    
    console.log(`💾 Set ${key} = ${typeof value}`);
  }
  
  async getAll() {
    return await this.read();
  }
  
  async clear() {
    const defaults = this.getDefaults();
    await this.write(defaults);
    console.log('🗑️ Store cleared to defaults');
  }
  
  async getStats() {
    try {
      const stats = fsSync.statSync(this.storePath);
      const data = await this.read();
      
      return {
        path: this.storePath,
        size: stats.size,
        modified: stats.mtime,
        isHealthy: await this.validateStore(),
        messageCount: data.messages?.length || 0,
        historyCount: data.messageHistory?.length || 0,
        settingsKeys: Object.keys(data.settings || {}).length
      };
    } catch (error) {
      return {
        path: this.storePath,
        size: 0,
        modified: null,
        isHealthy: false,
        messageCount: 0,
        historyCount: 0,
        settingsKeys: 0
      };
    }
  }
  
  async validateStore() {
    try {
      const data = await this.read();
      const testKey = 'health_check_' + Date.now();
      
      await this.set(testKey, { test: true });
      const testValue = await this.get(testKey);
      await this.set(testKey, undefined); // Remove test key
      
      return testValue && testValue.test === true;
    } catch (error) {
      console.error('❌ Store validation failed:', error.message);
      return false;
    }
  }
}

module.exports = AtomicStore;
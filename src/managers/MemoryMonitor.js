/**
 * MemoryMonitor - Monitor application memory usage and trigger cleanup when thresholds are exceeded
 */
class MemoryMonitor {
    constructor() {
        this.monitoringInterval = null;
        this.memoryThreshold = 500 * 1024 * 1024; // 500MB in bytes
        this.checkInterval = 30000; // Check every 30 seconds
        this.cleanupInterval = 5 * 60 * 1000; // Cleanup every 5 minutes
        this.lastCleanup = Date.now();
        this.memoryHistory = [];
        this.maxHistorySize = 100;
        this.cleanupCallbacks = new Set();
        this.warningThreshold = 0.8; // Warn at 80% of threshold
        this.criticalThreshold = 0.95; // Critical at 95% of threshold
    }

    /**
     * Start monitoring memory usage
     */
    startMonitoring() {
        if (this.monitoringInterval) {
            return; // Already monitoring
        }

        console.log('Starting memory monitoring...');
        
        // Initial check
        this.checkMemory();

        // Set up periodic checks
        this.monitoringInterval = setInterval(() => {
            this.checkMemory();
        }, this.checkInterval);

        // Set up periodic cleanup
        this.schedulePeriodicCleanup();
    }

    /**
     * Stop monitoring memory usage
     */
    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        console.log('Stopped memory monitoring');
    }

    /**
     * Check current memory usage
     */
    async checkMemory() {
        try {
            const memoryInfo = await this.getMemoryInfo();
            
            // Store in history
            this.memoryHistory.push({
                timestamp: Date.now(),
                ...memoryInfo
            });

            // Trim history if needed
            if (this.memoryHistory.length > this.maxHistorySize) {
                this.memoryHistory.shift();
            }

            // Check thresholds
            const usageRatio = memoryInfo.usedJSHeapSize / this.memoryThreshold;

            if (usageRatio >= this.criticalThreshold) {
                console.error('Critical memory usage:', this.formatBytes(memoryInfo.usedJSHeapSize));
                this.triggerCleanup('critical');
            } else if (usageRatio >= this.warningThreshold) {
                console.warn('High memory usage:', this.formatBytes(memoryInfo.usedJSHeapSize));
                this.triggerCleanup('warning');
            }

            return memoryInfo;
        } catch (error) {
            console.error('Error checking memory:', error);
        }
    }

    /**
     * Get memory information
     */
    async getMemoryInfo() {
        if (performance && performance.memory) {
            return {
                usedJSHeapSize: performance.memory.usedJSHeapSize,
                totalJSHeapSize: performance.memory.totalJSHeapSize,
                jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
            };
        }
        
        // Fallback for environments without performance.memory
        return {
            usedJSHeapSize: 0,
            totalJSHeapSize: 0,
            jsHeapSizeLimit: 0
        };
    }

    /**
     * Register a cleanup callback
     * @param {Function} callback - Function to call during cleanup
     */
    registerCleanupCallback(callback) {
        this.cleanupCallbacks.add(callback);
    }

    /**
     * Unregister a cleanup callback
     * @param {Function} callback - Function to remove
     */
    unregisterCleanupCallback(callback) {
        this.cleanupCallbacks.delete(callback);
    }

    /**
     * Trigger cleanup routines
     * @param {string} severity - 'warning', 'critical', or 'periodic'
     */
    triggerCleanup(severity = 'periodic') {
        console.log(`Triggering ${severity} cleanup...`);
        const startTime = Date.now();

        // Call all registered cleanup callbacks
        for (const callback of this.cleanupCallbacks) {
            try {
                callback(severity);
            } catch (error) {
                console.error('Cleanup callback error:', error);
            }
        }

        // Force garbage collection if available (Electron exposes this)
        if (global.gc) {
            global.gc();
            console.log('Forced garbage collection');
        }

        this.lastCleanup = Date.now();
        const duration = Date.now() - startTime;
        console.log(`Cleanup completed in ${duration}ms`);

        // Check memory after cleanup
        setTimeout(() => {
            this.checkMemory().then(memoryInfo => {
                if (memoryInfo) {
                    console.log('Memory after cleanup:', this.formatBytes(memoryInfo.usedJSHeapSize));
                }
            });
        }, 1000);
    }

    /**
     * Schedule periodic cleanup
     */
    schedulePeriodicCleanup() {
        this.cleanupTimer = setInterval(() => {
            const timeSinceLastCleanup = Date.now() - this.lastCleanup;
            if (timeSinceLastCleanup >= this.cleanupInterval) {
                this.triggerCleanup('periodic');
            }
        }, this.cleanupInterval);
    }

    /**
     * Get memory statistics
     */
    getStatistics() {
        if (this.memoryHistory.length === 0) {
            return null;
        }

        const recent = this.memoryHistory.slice(-10);
        const totalUsed = recent.reduce((sum, entry) => sum + entry.usedJSHeapSize, 0);
        const avgUsed = totalUsed / recent.length;

        const current = this.memoryHistory[this.memoryHistory.length - 1];

        return {
            current: {
                used: this.formatBytes(current.usedJSHeapSize),
                total: this.formatBytes(current.totalJSHeapSize),
                limit: this.formatBytes(current.jsHeapSizeLimit),
                percentage: ((current.usedJSHeapSize / this.memoryThreshold) * 100).toFixed(1)
            },
            average: {
                used: this.formatBytes(avgUsed),
                trend: this.calculateTrend()
            },
            threshold: this.formatBytes(this.memoryThreshold),
            lastCleanup: new Date(this.lastCleanup).toLocaleTimeString()
        };
    }

    /**
     * Calculate memory usage trend
     */
    calculateTrend() {
        if (this.memoryHistory.length < 2) {
            return 'stable';
        }

        const recent = this.memoryHistory.slice(-5);
        const firstValue = recent[0].usedJSHeapSize;
        const lastValue = recent[recent.length - 1].usedJSHeapSize;
        const change = ((lastValue - firstValue) / firstValue) * 100;

        if (change > 10) return 'increasing';
        if (change < -10) return 'decreasing';
        return 'stable';
    }

    /**
     * Format bytes to human readable format
     */
    formatBytes(bytes) {
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        if (bytes === 0) return '0 Bytes';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
    }

    /**
     * Set memory threshold
     * @param {number} megabytes - Threshold in megabytes
     */
    setThreshold(megabytes) {
        this.memoryThreshold = megabytes * 1024 * 1024;
        console.log('Memory threshold set to:', this.formatBytes(this.memoryThreshold));
    }

    /**
     * Get memory usage report
     */
    getReport() {
        const stats = this.getStatistics();
        if (!stats) {
            return 'No memory statistics available yet';
        }

        return `
Memory Usage Report:
- Current: ${stats.current.used} / ${stats.threshold} (${stats.current.percentage}%)
- Average: ${stats.average.used} (${stats.average.trend})
- JS Heap Limit: ${stats.current.limit}
- Last Cleanup: ${stats.lastCleanup}
- Active Monitors: ${this.cleanupCallbacks.size}
        `.trim();
    }
}

module.exports = MemoryMonitor;
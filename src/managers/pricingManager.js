/**
 * Pricing Manager Module
 * 
 * Handles pricing data fetching, display, and terminal status monitoring for automatic ccusage execution
 */

class PricingManager {
    constructor(apiClient, logAction) {
        this.apiClient = apiClient;
        this.logAction = logAction || console.log;
        
        // Pricing data state
        this.pricingData = null;
        this.lastUpdated = null;
        this.isLoading = false;
        this.refreshInterval = null;
        
        // Terminal monitoring for automatic ccusage execution
        this.terminalMonitoringInterval = null;
        this.terminalStatusMap = new Map(); // Track terminal status changes
        this.statusChangeTimers = new Map(); // Track 5-second stability timers
        
        // Settings
        this.autoRefreshEnabled = true;
        this.autoRefreshInterval = 5 * 60 * 1000; // 5 minutes
        this.statusChangeDelay = 5000; // 5 seconds
        
        // Event listener references for proper cleanup
        this.eventListeners = new Map();
    }

    /**
     * Initialize the pricing manager
     */
    async initialize() {
        try {
            this.setupEventListeners();
            this.startTerminalMonitoring();
            
            // Load initial pricing data
            await this.loadPricingData();
            
            // Setup auto-refresh
            if (this.autoRefreshEnabled) {
                this.startAutoRefresh();
            }
            
            this.logAction('Pricing manager initialized successfully', 'info');
        } catch (error) {
            this.logAction(`Failed to initialize pricing manager: ${error.message}`, 'error');
        }
    }

    /**
     * Setup event listeners for pricing view
     */
    setupEventListeners() {
        // Manual refresh button
        const refreshBtn = document.getElementById('pricing-refresh-btn');
        if (refreshBtn) {
            const refreshHandler = () => {
                this.loadPricingData(true);
            };
            refreshBtn.addEventListener('click', refreshHandler);
            this.eventListeners.set('refresh-btn', { element: refreshBtn, event: 'click', handler: refreshHandler });
        }

        // Error retry button
        const retryBtn = document.getElementById('pricing-retry-btn');
        if (retryBtn) {
            const retryHandler = () => {
                this.loadPricingData(true);
            };
            retryBtn.addEventListener('click', retryHandler);
            this.eventListeners.set('retry-btn', { element: retryBtn, event: 'click', handler: retryHandler });
        }
        
        // Listen for window resize to update responsive formatting
        const resizeHandler = () => {
            this.applyResponsiveClasses();
        };
        window.addEventListener('resize', resizeHandler);
        this.eventListeners.set('window-resize', { element: window, event: 'resize', handler: resizeHandler });
    }

    /**
     * Start monitoring terminal status changes
     */
    startTerminalMonitoring() {
        if (this.terminalMonitoringInterval) return;

        // Start with faster checking, then optimize based on activity
        this.terminalMonitoringInterval = setInterval(() => {
            this.checkTerminalStatusChanges();
        }, 1000); // Check every second

        this.logAction('Started terminal status monitoring for pricing updates (1s interval)', 'info');

        // Add window focus/blur optimization
        if (typeof window !== 'undefined') {
            const focusHandler = () => {
                if (!this.terminalMonitoringInterval) {
                    this.startTerminalMonitoring();
                }
            };
            const blurHandler = () => {
                // Keep monitoring but could reduce frequency when window not focused
                // For now, maintain same frequency for reliability
            };
            
            window.addEventListener('focus', focusHandler);
            window.addEventListener('blur', blurHandler);
            
            // Store references for cleanup
            this.eventListeners.set('window-focus', { element: window, event: 'focus', handler: focusHandler });
            this.eventListeners.set('window-blur', { element: window, event: 'blur', handler: blurHandler });
        }
    }

    /**
     * Stop terminal status monitoring
     */
    stopTerminalMonitoring() {
        if (this.terminalMonitoringInterval) {
            clearInterval(this.terminalMonitoringInterval);
            this.terminalMonitoringInterval = null;
        }

        // Clear all status change timers
        this.statusChangeTimers.forEach(timer => {
            clearTimeout(timer);
        });
        this.statusChangeTimers.clear();

        this.logAction('Stopped terminal status monitoring', 'info');
    }

    /**
     * Check terminal status changes and trigger ccusage when needed
     */
    checkTerminalStatusChanges() {
        // Enhanced terminal status checking with proper integration
        if (typeof window !== 'undefined' && window.terminalGUI) {
            // Use the main TerminalGUI instance instead of terminalManager
            const terminals = window.terminalGUI.terminals;
            
            if (!terminals || terminals.size === 0) {
                return; // No terminals available
            }
            
            terminals.forEach((terminal, terminalId) => {
                try {
                    const currentStatus = this.getTerminalDisplayStatus(terminalId);
                    const previousStatus = this.terminalStatusMap.get(terminalId);
                    
                    // Debug logging for status changes
                    if (currentStatus !== previousStatus) {
                        this.logAction(`Terminal ${terminalId} status change: ${previousStatus} → ${currentStatus}`, 'debug');
                    }
                    
                    // Check for status change from 'running' to '...' (ready/idle)
                    if (previousStatus === 'running' && currentStatus === '...') {
                        this.handleTerminalStatusChange(terminalId);
                    }
                    
                    // Update status map
                    this.terminalStatusMap.set(terminalId, currentStatus);
                } catch (error) {
                    // Log error but continue monitoring other terminals
                    console.warn(`Error checking status for terminal ${terminalId}:`, error);
                }
            });
        } else {
            // Fallback: try to check terminals directly from DOM
            this.checkTerminalStatusFromDOM();
        }
    }

    /**
     * Fallback method to check terminal status directly from DOM
     */
    checkTerminalStatusFromDOM() {
        const statusElements = document.querySelectorAll('[data-terminal-status]');
        
        statusElements.forEach(element => {
            const terminalId = element.getAttribute('data-terminal-status');
            if (!terminalId) return;
            
            try {
                const currentStatus = this.getTerminalDisplayStatusFromElement(element);
                const previousStatus = this.terminalStatusMap.get(terminalId);
                
                // Check for status change from 'running' to '...' (ready/idle)
                if (previousStatus === 'running' && currentStatus === '...') {
                    this.handleTerminalStatusChange(terminalId);
                }
                
                this.terminalStatusMap.set(terminalId, currentStatus);
            } catch (error) {
                console.warn(`Error checking DOM status for terminal ${terminalId}:`, error);
            }
        });
    }

    /**
     * Get terminal status directly from DOM element
     * @param {Element} element - The status element
     * @returns {string} Terminal status
     */
    getTerminalDisplayStatusFromElement(element) {
        const statusText = element.textContent.trim();
        const className = element.className;
        
        if (statusText.includes('Running') || className.includes('running')) {
            return 'running';
        } else if (statusText.includes('Injecting') || className.includes('injecting')) {
            return 'injecting';
        } else if (statusText === '...' || statusText === '') {
            return '...';  // Ready/idle state
        }
        
        return '...'; // Default to ready state
    }

    /**
     * Handle terminal status change from running to ready
     * @param {string} terminalId - Terminal identifier
     */
    handleTerminalStatusChange(terminalId) {
        const terminalNumber = this.getTerminalNumber(terminalId);
        this.logAction(`Terminal ${terminalNumber} status changed from running to ready - starting stability timer`, 'info');

        // Clear existing timer if any
        const existingTimer = this.statusChangeTimers.get(terminalId);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.logAction(`Terminal ${terminalNumber} clearing previous stability timer`, 'debug');
        }

        // Set 5-second stability timer with additional validation
        const timer = setTimeout(() => {
            this.validateAndHandleStableTerminal(terminalId);
        }, this.statusChangeDelay);

        this.statusChangeTimers.set(terminalId, timer);
        this.logAction(`Terminal ${terminalNumber} stability timer started (${this.statusChangeDelay}ms)`, 'debug');
    }

    /**
     * Validate terminal stability before triggering pricing refresh
     * @param {string} terminalId - Terminal identifier
     */
    validateAndHandleStableTerminal(terminalId) {
        const terminalNumber = this.getTerminalNumber(terminalId);
        
        try {
            // Double-check that terminal is still in ready state
            const currentStatus = this.getTerminalDisplayStatus(terminalId);
            
            if (currentStatus !== '...') {
                this.logAction(`Terminal ${terminalNumber} became active again (${currentStatus}) - canceling auto-refresh`, 'info');
                this.statusChangeTimers.delete(terminalId);
                return;
            }

            // Additional stability checks
            if (!this.isTerminalStillReady(terminalId)) {
                this.logAction(`Terminal ${terminalNumber} stability check failed - canceling auto-refresh`, 'info');
                this.statusChangeTimers.delete(terminalId);
                return;
            }

            // Terminal is confirmed stable, proceed with refresh
            this.handleStableTerminal(terminalId);
        } catch (error) {
            this.logAction(`Error validating terminal ${terminalNumber} stability: ${error.message}`, 'error');
            this.statusChangeTimers.delete(terminalId);
        }
    }

    /**
     * Additional stability checks for terminal state
     * @param {string} terminalId - Terminal identifier
     * @returns {boolean} Whether terminal is stable and ready
     */
    isTerminalStillReady(terminalId) {
        try {
            // Check if terminal still exists
            if (typeof window !== 'undefined' && window.terminalGUI) {
                const terminals = window.terminalGUI.terminals;
                if (!terminals || !terminals.has(terminalId)) {
                    return false; // Terminal no longer exists
                }
                
                const terminalData = terminals.get(terminalId);
                if (terminalData && terminalData.isClosing) {
                    return false; // Terminal is being closed
                }
            }

            // Check DOM element still exists and has correct status
            const statusElement = document.querySelector(`[data-terminal-status="${terminalId}"]`);
            if (!statusElement) {
                return false; // Status element no longer exists
            }

            return true;
        } catch (error) {
            console.warn(`Error checking terminal ${terminalId} stability:`, error);
            return false;
        }
    }

    /**
     * Handle terminal that has been stable for 5 seconds
     * @param {string} terminalId - Terminal identifier
     */
    async handleStableTerminal(terminalId) {
        const terminalNumber = this.getTerminalNumber(terminalId);
        const currentStatus = this.getTerminalDisplayStatus(terminalId);

        // Check if terminal is still in ready state
        if (currentStatus !== '...') {
            this.logAction(`Terminal ${terminalNumber} became active again - canceling auto-refresh`, 'info');
            return;
        }

        this.logAction(`Terminal ${terminalNumber} stable for 5 seconds - refreshing pricing data`, 'info');
        
        // Trigger pricing data refresh
        await this.loadPricingData(true);
        
        // Clean up timer
        this.statusChangeTimers.delete(terminalId);
    }

    /**
     * Get terminal display status with fallback mechanisms
     * @param {string} terminalId - Terminal identifier
     * @returns {string} Terminal status
     */
    getTerminalDisplayStatus(terminalId) {
        // First try: Check via window.terminalGUI method (injected during initialization)
        if (typeof window !== 'undefined' && window.terminalGUI && 
            typeof window.terminalGUI.getTerminalDisplayStatus === 'function') {
            try {
                const guiResult = window.terminalGUI.getTerminalDisplayStatus(terminalId);
                if (guiResult && guiResult !== 'unknown') {
                    return guiResult;
                }
            } catch (error) {
                console.warn('Error using window.terminalGUI.getTerminalDisplayStatus:', error);
            }
        }
        
        // Second try: Use stored reference to injected function
        if (this._injectedGetTerminalDisplayStatus && 
            typeof this._injectedGetTerminalDisplayStatus === 'function') {
            try {
                const injectedResult = this._injectedGetTerminalDisplayStatus(terminalId);
                if (injectedResult && injectedResult !== 'unknown') {
                    return injectedResult;
                }
            } catch (error) {
                console.warn('Error using injected getTerminalDisplayStatus:', error);
            }
        }
        
        // Third try: Direct DOM query (fallback)
        if (typeof window !== 'undefined') {
            try {
                const statusElement = document.querySelector(`[data-terminal-status="${terminalId}"]`);
                if (statusElement) {
                    return this.getTerminalDisplayStatusFromElement(statusElement);
                }
            } catch (error) {
                console.warn('Error querying DOM for terminal status:', error);
            }
        }
        
        return 'unknown';
    }

    /**
     * Set the injected terminal status function (called during initialization)
     * @param {Function} getStatusFunc - Function to get terminal status
     */
    setTerminalStatusFunction(getStatusFunc) {
        this._injectedGetTerminalDisplayStatus = getStatusFunc;
    }

    /**
     * Get terminal number for display
     * @param {string} terminalId - Terminal identifier
     * @returns {string} Terminal number
     */
    getTerminalNumber(terminalId) {
        return terminalId; // This should be replaced with actual terminal number mapping
    }

    /**
     * Load pricing data from backend
     * @param {boolean} forceRefresh - Force refresh even if loading
     */
    async loadPricingData(forceRefresh = false) {
        if (this.isLoading && !forceRefresh) return;

        this.isLoading = true;
        
        // Only show full loading state if no existing data
        if (!this.pricingData) {
            this.showLoadingState();
        } else {
            // Show button loading indicator for refresh
            this.showButtonLoadingState();
        }

        try {
            // Use the API client if available, fallback to direct fetch
            let result;
            
            if (this.apiClient && typeof this.apiClient.executeCCUsage === 'function') {
                // Use the proper API client
                result = await this.apiClient.executeCCUsage(this.getSessionId());
            } else {
                // Fallback to creating a temporary API client
                if (typeof window !== 'undefined' && window.BackendAPIClient) {
                    const tempApiClient = new window.BackendAPIClient();
                    result = await tempApiClient.executeCCUsage(this.getSessionId());
                } else {
                    throw new Error('BackendAPIClient not available');
                }
            }

            if (result.success) {
                this.pricingData = result.data;
                this.lastUpdated = new Date(result.timestamp);
                this.displayPricingData();
                this.logAction('Pricing data updated successfully', 'success');
            } else {
                throw new Error(result.error || 'Failed to fetch pricing data');
            }

        } catch (error) {
            this.logAction(`Failed to load pricing data: ${error.message}`, 'error');
            this.showErrorState(error.message);
            
            // Try fallback endpoint
            try {
                this.logAction('Trying fallback endpoint...', 'info');
                await this.loadPricingDataFallback();
            } catch (fallbackError) {
                this.logAction(`Fallback also failed: ${fallbackError.message}`, 'error');
            }
        } finally {
            this.isLoading = false;
            this.hideButtonLoadingState();
        }
    }

    /**
     * Fallback method using simple ccusage endpoint
     */
    async loadPricingDataFallback() {
        try {
            // Try the simple endpoint
            const response = await fetch('http://127.0.0.1:8001/api/ccusage/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    session_id: this.getSessionId()
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();

            if (result.success) {
                // Parse the raw output for fallback
                const parsedData = this.parseRawCCUsageOutput(result.output);
                this.pricingData = parsedData;
                this.lastUpdated = new Date(result.timestamp);
                this.displayPricingData();
                this.logAction('Pricing data updated via fallback endpoint', 'success');
            } else {
                throw new Error(result.error || 'Fallback endpoint failed');
            }
        } catch (error) {
            throw new Error(`Fallback failed: ${error.message}`);
        }
    }

    /**
     * Parse raw ccusage output for fallback
     * @param {string} rawOutput - Raw ccusage output
     * @returns {Object} Parsed pricing data
     */
    parseRawCCUsageOutput(rawOutput) {
        // Simple parsing logic for the raw output
        const data = {
            daily_entries: [],
            total_cost: 0,
            weekly_cost: 0,
            monthly_cost: 0,
            last_updated: new Date().toISOString()
        };

        try {
            // Extract cost values from the output using regex
            const costMatches = rawOutput.match(/\$(\d+\.?\d*)/g);
            if (costMatches && costMatches.length > 0) {
                // Get the last cost as total (usually the total line)
                const totalMatch = costMatches[costMatches.length - 1];
                data.total_cost = parseFloat(totalMatch.replace('$', ''));
                
                // Create dummy daily entries for display
                costMatches.slice(0, -1).forEach((cost, index) => {
                    data.daily_entries.push({
                        date: `Day ${index + 1}`,
                        model: 'mixed',
                        cost: parseFloat(cost.replace('$', ''))
                    });
                });
            }
        } catch (parseError) {
            this.logAction(`Failed to parse raw output: ${parseError.message}`, 'warn');
        }

        return data;
    }

    /**
     * Display pricing data in the UI
     */
    displayPricingData() {
        if (!this.pricingData) return;

        // Hide loading/error states
        this.hideLoadingState();
        this.hideErrorState();

        // Show data container
        const dataContainer = document.getElementById('pricing-data');
        if (dataContainer) {
            dataContainer.style.display = 'block';
        }

        // Update cost summary cards
        this.updateCostSummary();

        // Update receipt
        this.updateReceiptDisplay();

        // Update status
        this.updateStatusDisplay();
    }

    /**
     * Update cost summary cards
     */
    updateCostSummary() {
        const { daily_cost, weekly_cost, monthly_cost, total_cost } = this.pricingData;

        // Update display with properly calculated costs from backend
        this.updateElement('daily-cost', `$${(daily_cost || 0).toFixed(2)}`);
        this.updateElement('weekly-cost', `$${(weekly_cost || 0).toFixed(2)}`);
        this.updateElement('total-cost', `$${(total_cost || 0).toFixed(2)}`);
    }

    /**
     * Update receipt display
     */
    updateReceiptDisplay() {
        // Update receipt body with daily entries
        const receiptBody = document.getElementById('receipt-body');
        if (receiptBody && this.pricingData.daily_entries) {
            receiptBody.innerHTML = '';
            
            // Entries should already be sorted by backend (most recent first)
            // But ensure proper sorting if needed
            const sortedEntries = [...this.pricingData.daily_entries].sort((a, b) => {
                // Parse dates for comparison - "2025 07-26" format
                const parseDate = (dateStr) => {
                    try {
                        const yearMatch = dateStr.match(/(\d{4})/);
                        const dateMatch = dateStr.match(/(\d{2})-(\d{2})/);
                        if (yearMatch && dateMatch) {
                            return new Date(yearMatch[1], dateMatch[1] - 1, dateMatch[2]);
                        }
                        return new Date(0);
                    } catch {
                        return new Date(0);
                    }
                };
                
                return parseDate(b.date) - parseDate(a.date); // Most recent first
            });
            
            sortedEntries.forEach(entry => {
                const entryElement = document.createElement('div');
                entryElement.className = 'receipt-entry';
                entryElement.innerHTML = `
                    <div class="receipt-entry-date">${this.formatDateForWidth(entry.date)}</div>
                    <div class="receipt-entry-model">${entry.model}</div>
                    <div class="receipt-entry-cost">$${entry.cost.toFixed(2)}</div>
                `;
                receiptBody.appendChild(entryElement);
            });
        }

        // Update receipt total
        this.updateElement('receipt-total-cost', `$${(this.pricingData.total_cost || 0).toFixed(2)}`);
        
        // Apply responsive classes after rendering
        this.applyResponsiveClasses();
    }

    /**
     * Update status display
     */
    updateStatusDisplay() {
        const statusText = document.querySelector('#pricing-status .status-text');
        if (statusText && this.lastUpdated) {
            const timeAgo = this.getTimeAgo(this.lastUpdated);
            statusText.textContent = `Last updated: ${timeAgo}`;
        }
    }

    /**
     * Format date based on sidebar width for responsive display
     */
    formatDateForWidth(dateString) {
        if (!dateString) return '';
        
        // Apply responsive classes based on sidebar width
        this.applyResponsiveClasses();
        
        // The CSS will handle hiding dates when narrow, so just return the original
        return dateString;
    }

    /**
     * Apply responsive classes based on actual sidebar width
     */
    applyResponsiveClasses() {
        const sidebar = document.querySelector('.action-log-sidebar');
        const pricingContent = document.getElementById('pricing-content');
        
        if (!sidebar || !pricingContent) return;
        
        const sidebarWidth = sidebar.offsetWidth;
        
        // Remove existing responsive classes
        pricingContent.classList.remove('narrow', 'very-narrow');
        
        // Apply classes based on width - more aggressive thresholds
        if (sidebarWidth < 240) {
            pricingContent.classList.add('narrow', 'very-narrow');
        } else if (sidebarWidth < 290) {
            pricingContent.classList.add('narrow');
        }
    }

    /**
     * Show loading state (only when no existing data)
     */
    showLoadingState() {
        this.hideErrorState();
        this.hideDataState();
        
        const loadingElement = document.getElementById('pricing-loading');
        if (loadingElement) {
            loadingElement.style.display = 'flex';
        }
    }

    /**
     * Show title loading indicator (when refreshing existing data)
     */
    showButtonLoadingState() {
        const loadingIndicator = document.getElementById('pricing-loading-indicator');
        const refreshBtn = document.getElementById('pricing-refresh-btn');
        
        if (loadingIndicator) {
            loadingIndicator.style.display = 'flex';
            this.logAction('Showing loading indicator next to title', 'debug');
        }
        
        if (refreshBtn) {
            refreshBtn.disabled = true;
            this.logAction('Disabled refresh button during loading', 'debug');
        } else {
            this.logAction('Refresh button not found', 'warn');
        }
    }

    /**
     * Hide title loading indicator
     */
    hideButtonLoadingState() {
        const loadingIndicator = document.getElementById('pricing-loading-indicator');
        const refreshBtn = document.getElementById('pricing-refresh-btn');
        
        if (loadingIndicator) {
            loadingIndicator.style.display = 'none';
            this.logAction('Hiding loading indicator next to title', 'debug');
        }
        
        if (refreshBtn) {
            refreshBtn.disabled = false;
            this.logAction('Re-enabled refresh button after loading', 'debug');
        }
    }

    /**
     * Hide loading state
     */
    hideLoadingState() {
        const loadingElement = document.getElementById('pricing-loading');
        if (loadingElement) {
            loadingElement.style.display = 'none';
        }
    }

    /**
     * Show error state
     * @param {string} errorMessage - Error message to display
     */
    showErrorState(errorMessage) {
        this.hideLoadingState();
        this.hideDataState();

        const errorElement = document.getElementById('pricing-error');
        if (errorElement) {
            errorElement.style.display = 'flex';
            
            const errorText = errorElement.querySelector('.error-text');
            if (errorText) {
                errorText.textContent = errorMessage || 'Failed to load pricing data';
            }
        }
    }

    /**
     * Hide error state
     */
    hideErrorState() {
        const errorElement = document.getElementById('pricing-error');
        if (errorElement) {
            errorElement.style.display = 'none';
        }
    }

    /**
     * Hide data state
     */
    hideDataState() {
        const dataElement = document.getElementById('pricing-data');
        if (dataElement) {
            dataElement.style.display = 'none';
        }
    }

    /**
     * Start auto-refresh interval
     */
    startAutoRefresh() {
        if (this.refreshInterval) return;

        this.refreshInterval = setInterval(() => {
            this.loadPricingData();
        }, this.autoRefreshInterval);

        this.logAction(`Started auto-refresh with ${this.autoRefreshInterval / 1000}s interval`, 'info');
    }

    /**
     * Stop auto-refresh
     */
    stopAutoRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
            this.logAction('Stopped auto-refresh', 'info');
        }
    }

    /**
     * Utility method to update element text content
     * @param {string} elementId - Element ID
     * @param {string} content - Content to set
     */
    updateElement(elementId, content) {
        const element = document.getElementById(elementId);
        if (element) {
            element.textContent = content;
        }
    }

    /**
     * Get session ID for API calls
     * @returns {string} Session ID
     */
    getSessionId() {
        if (typeof window !== 'undefined' && window.terminalGUI) {
            return window.terminalGUI.sessionId || 'default';
        }
        return 'default';
    }

    /**
     * Get time ago string for last updated display
     * @param {Date} date - Date to compare
     * @returns {string} Time ago string
     */
    getTimeAgo(date) {
        const now = new Date();
        const diff = now - date;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (seconds < 60) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        return date.toLocaleDateString();
    }

    /**
     * Clean up monitoring for a specific terminal (called when terminal is closed)
     * @param {string} terminalId - Terminal identifier
     */
    cleanupTerminal(terminalId) {
        // Clear status tracking
        this.terminalStatusMap.delete(terminalId);
        
        // Clear any pending timers
        const timer = this.statusChangeTimers.get(terminalId);
        if (timer) {
            clearTimeout(timer);
            this.statusChangeTimers.delete(terminalId);
        }
        
        this.logAction(`Cleaned up pricing monitoring for terminal ${terminalId}`, 'debug');
    }

    /**
     * Get monitoring statistics for debugging
     * @returns {Object} Monitoring statistics
     */
    getMonitoringStats() {
        return {
            isMonitoring: !!this.terminalMonitoringInterval,
            trackedTerminals: this.terminalStatusMap.size,
            activeTimers: this.statusChangeTimers.size,
            autoRefreshEnabled: this.autoRefreshEnabled,
            statusChangeDelay: this.statusChangeDelay,
            lastPricingUpdate: this.lastUpdated
        };
    }

    /**
     * Destroy and cleanup
     */
    destroy() {
        // Stop all intervals and timers
        this.stopTerminalMonitoring();
        this.stopAutoRefresh();
        
        // Clear all status tracking data
        this.terminalStatusMap.clear();
        this.statusChangeTimers.forEach(timer => clearTimeout(timer));
        this.statusChangeTimers.clear();
        
        // Remove ALL event listeners using stored references
        this.eventListeners.forEach((listenerData, key) => {
            const { element, event, handler } = listenerData;
            if (element && handler) {
                try {
                    element.removeEventListener(event, handler);
                    this.logAction(`Removed event listener: ${key}`, 'debug');
                } catch (error) {
                    this.logAction(`Failed to remove event listener ${key}: ${error.message}`, 'warn');
                }
            }
        });
        this.eventListeners.clear();
        
        // Clear any injected function references
        this._injectedGetTerminalDisplayStatus = null;
        
        this.logAction('Pricing manager destroyed - all event listeners and intervals cleaned up', 'info');
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PricingManager;
} else if (typeof window !== 'undefined') {
    window.PricingManager = PricingManager;
}
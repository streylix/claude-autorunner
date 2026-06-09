/**
 * CompletionManager - Manages completion tracking and lifecycle
 * Handles creation, monitoring, and UI rendering of completion items
 */
class CompletionManager {
    constructor(eventBus, appStateStore, ipc = null) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;
        // ipc wrapper ({ invoke }) for persisting completions to the unified
        // store. Optional so existing callers/tests without ipc still work.
        this.ipc = ipc;
        this._persistTimer = null;

        // Completion tracking state
        this.completionItems = new Map(); // Map of completion ID to completion data
        this.completionIdCounter = 1; // Counter for unique completion IDs
        this.previousCompletionStrings = new Map(); // Track previous completion strings per terminal
        this.completionStabilityTimers = new Map(); // Track completion stability timers per terminal
        this.previousTerminalStatuses = new Map(); // Track previous terminal statuses for completion detection

        this.setupEventListeners();
    }

    // ======= PERSISTENCE ("to-dos" survive reload/restart) =======
    /** Plain, JSON-safe view of a completion item (drops timer handles). */
    _serializeCompletion(item) {
        return {
            id: item.id,
            terminalId: item.terminalId,
            status: item.status === 'in-progress' ? 'interrupted' : item.status,
            startTime: item.startTime || null,
            endTime: item.endTime || null,
            duration: item.duration ?? null,
            message: item.message || '',
            fullText: item.fullText || item.message || '',
            sessionId: item.sessionId || null,
            terminalColor: item.terminalColor || '#4CAF50',
            terminalName: item.terminalName || `Terminal ${item.terminalId}`,
            promptNumber: item.promptNumber || 0,
        };
    }

    /** Debounced save of all completion items to the unified store via ipc. */
    persistCompletions() {
        if (!this.ipc || typeof this.ipc.invoke !== 'function') return;
        if (this._persistTimer) clearTimeout(this._persistTimer);
        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            const arr = Array.from(this.completionItems.values()).map(i => this._serializeCompletion(i));
            Promise.resolve(this.ipc.invoke('db-save-completions', arr)).catch(err =>
                console.error('Failed to persist completions:', err));
        }, 250);
    }

    /** Load persisted completions on startup and render them (oldest-first so
     *  the newest ends up on top, matching renderCompletionItem's prepend). */
    async loadPersistedCompletions() {
        if (!this.ipc || typeof this.ipc.invoke !== 'function') return;
        let saved = [];
        try {
            saved = await this.ipc.invoke('db-get-completions');
        } catch (err) {
            console.error('Failed to load completions:', err);
            return;
        }
        if (!Array.isArray(saved) || !saved.length) return;

        saved.sort((a, b) => (a.id || 0) - (b.id || 0));
        let maxId = 0;
        for (const item of saved) {
            this.completionItems.set(item.id, item);
            if (item.id > maxId) maxId = item.id;
            try { this.renderCompletionItem(item); } catch (e) { /* ignore a bad row */ }
        }
        // Avoid id collisions with restored items.
        this.completionIdCounter = Math.max(this.completionIdCounter, maxId + 1);
    }
    
    setupEventListeners() {
        // Listen for terminal status changes
        this.eventBus.on('terminal:status:changed', ({ terminalId, status, previousStatus }) => {
            this.checkTerminalCompletionStatus(terminalId);
            // NOTE: completion SOUND is owned by SoundManager (it subscribes to
            // the same event via checkStatusChangeSounds). The old duplicate
            // path here used the wrong asset dir ('sounds/…' instead of
            // 'assets/soundeffects/…') and a setting key that is never set, so it
            // silently failed on every completion — removed.
        });
        
        // Listen for terminal data
        this.eventBus.on('terminal:data', ({ terminalId, data }) => {
            const previousStatus = this.previousTerminalStatuses.get(terminalId);
            const currentStatus = this.appStateStore.getTerminalStatus(terminalId);
            this.extractAndTrackCompletionText(data, terminalId, previousStatus);
            this.previousTerminalStatuses.set(terminalId, currentStatus);
        });
        
        // Listen for terminal removal
        this.eventBus.on('terminal:removed', ({ terminalId }) => {
            this.cleanupTerminalCompletions(terminalId);
        });

        // Hook-driven completions: Claude's last message read from the session
        // transcript (authoritative), forwarded by main on every Stop event.
        this.eventBus.on('completion:recorded', (data) => {
            this.recordHookCompletion(data);
        });
        this.eventBus.on('completion:summarized', ({ sessionId, summary }) => {
            this.applyCompletionSummary(sessionId, summary);
        });
    }

    /**
     * Record a completed Claude turn captured via the Stop hook transcript.
     * Unlike createCompletionItem (which monitors an in-progress prompt), this
     * arrives already finished - render it directly as a completed entry.
     */
    recordHookCompletion({ terminalId, text, directory, sessionId }) {
        if (!text) return;

        // Gated by the "Automatic todo generation" setting. Todos are a
        // per-terminal record of what Claude did, captured from the Stop hook;
        // default on (read synchronously via the preference bus, fail open).
        let enabled = true;
        this.eventBus.emit('preference:get', {
            key: 'generateTodoOnCompletion',
            callback: (v) => { if (typeof v === 'boolean') enabled = v; }
        });
        if (!enabled) return;

        const completionId = this.completionIdCounter++;
        const now = Date.now();

        let terminalData = null;
        this.eventBus.emit('completion:request:terminalData', {
            terminalId,
            callback: (data) => { terminalData = data; }
        });

        const projectName = directory ? directory.split('/').pop() : null;
        const completionItem = {
            id: completionId,
            terminalId,
            status: 'completed',
            startTime: now,
            endTime: now,
            duration: null,
            message: text,
            fullText: text,
            sessionId: sessionId || null,
            terminalColor: terminalData?.color || '#4CAF50',
            terminalName: projectName || terminalData?.name || `Terminal ${terminalId}`,
            promptNumber: terminalData?.promptCount || 0
        };

        this.completionItems.set(completionId, completionItem);
        if (sessionId) {
            if (!this.sessionCompletionIds) this.sessionCompletionIds = new Map();
            this.sessionCompletionIds.set(sessionId, completionId);
        }

        this.eventBus.emit('completion:created', completionItem);
        this.renderCompletionItem(completionItem);
        this.persistCompletions();
    }

    /**
     * Replace a hook completion's display text with the plain-English summary
     * produced by the opt-in headless Claude summarizer.
     */
    applyCompletionSummary(sessionId, summary) {
        if (!sessionId || !summary || !this.sessionCompletionIds) return;
        const completionId = this.sessionCompletionIds.get(sessionId);
        const item = this.completionItems.get(completionId);
        if (!item) return;

        item.message = summary; // keep item.fullText as the raw transcript text

        const element = document.querySelector(`[data-completion-id="${completionId}"] .completion-prompt`);
        if (element) {
            element.textContent = summary;
        }
        this.persistCompletions();
    }
    
    // Core creation and management
    createCompletionItem(message, terminalId) {
        
        if (!message) {
            throw new Error('Message is required to create completion item');
        }
        
        if (!terminalId) {
            throw new Error('Terminal ID is required to create completion item');
        }
        
        const completionId = this.completionIdCounter++;
        const now = Date.now();
        
        // Request terminal data through event bus (will be provided by renderer.js)
        let terminalData = null;
        this.eventBus.emit('completion:request:terminalData', { 
            terminalId, 
            callback: (data) => { terminalData = data; } 
        });
        
        const completionItem = {
            id: completionId,
            terminalId: terminalId,
            status: 'in-progress',
            startTime: now,
            endTime: null,
            duration: null,
            message: message.content || message.processedContent || message,
            terminalColor: terminalData?.color || '#4CAF50',
            terminalName: terminalData?.name || 'claudecodebot',
            promptNumber: terminalData?.promptCount || 0
        };
        
        // Store completion item
        this.completionItems.set(completionId, completionItem);
        
        // Emit event for creation
        this.eventBus.emit('completion:created', completionItem);
        
        // Add to DOM
        try {
            this.renderCompletionItem(completionItem);
        } catch (error) {
            console.error('[ERROR] Failed to render completion item:', error);
            throw new Error(`Failed to render completion item: ${error.message}`);
        }
        this.persistCompletions();

        // Start monitoring for completion
        try {
            this.startCompletionMonitoring(completionId, terminalId);
        } catch (error) {
            console.error('[ERROR] Failed to start completion monitoring:', error);
            // Don't throw here since the item was created successfully
        }
        
        return completionId;
    }
    
    updateCompletionStatus(completionId, status, endTime = null) {
        const completionItem = this.completionItems.get(completionId);
        if (!completionItem) return;
        
        const previousStatus = completionItem.status;
        completionItem.status = status;
        
        if (endTime) {
            completionItem.endTime = endTime;
            completionItem.duration = Math.floor((endTime - completionItem.startTime) / 1000);
        }
        
        // Update DOM element
        const element = document.querySelector(`[data-completion-id="${completionId}"]`);
        if (element) {
            element.classList.remove(previousStatus);
            element.classList.add(status);
            
            // Update timer display if completed
            if (status === 'completed' && completionItem.duration !== null) {
                const timerElement = element.querySelector('.completion-timer');
                if (timerElement) {
                    const minutes = Math.floor(completionItem.duration / 60);
                    const seconds = completionItem.duration % 60;
                    timerElement.textContent = `${minutes}m ${seconds}s`;
                }
            }
        }
        
        // Emit status change event
        this.eventBus.emit('completion:status:changed', {
            completionId,
            previousStatus,
            status,
            completionItem
        });
        
        console.log(`[COMPLETION] Status updated: ${completionId} from ${previousStatus} to ${status}`);
        this.persistCompletions();
    }
    
    // Text extraction and processing
    extractAndTrackCompletionText(data, terminalId, previousStatus = 'unknown') {
        try {
            // Get current terminal status
            const currentStatus = this.appStateStore.getTerminalStatus(terminalId);
            
            if (!currentStatus) {
                return;
            }
            
            // Only extract completion text on state transitions from 'running' to idle states
            const shouldExtract = this.shouldExtractCompletionText(previousStatus, currentStatus, terminalId);
            
            if (!shouldExtract) {
                return;
            }
            
            // Use getAllTextIn function to extract text between ⏺ and ╭
            const rawCompletionText = this.getAllTextIn(data, '⏺', '╭');
            
            if (rawCompletionText && rawCompletionText.trim()) {
                // Clean the completion text
                const cleanedText = this.cleanCompletionText(rawCompletionText);
                
                if (cleanedText && cleanedText.trim()) {
                    // Get the previous string for this terminal
                    const previousString = this.previousCompletionStrings.get(terminalId) || '';
                    
                    // Only process if different from previous
                    if (cleanedText !== previousString) {
                        // Update the stored previous string
                        this.previousCompletionStrings.set(terminalId, cleanedText);
                        
                        // Append to active completion item
                        this.appendToActiveCompletionItem(terminalId, cleanedText);
                        
                        console.log(`[Terminal ${terminalId}] Completion text extracted:`, cleanedText.substring(0, 100) + '...');
                    }
                }
            }
        } catch (error) {
            console.error('Error extracting completion text:', error);
        }
    }
    
    cleanCompletionText(rawText) {
        if (!rawText) return '';
        
        // Split into lines and filter out processing indicators
        const lines = rawText.split('\n');
        const cleanedLines = lines.filter(line => {
            // Remove empty lines and lines with only whitespace
            if (!line.trim()) return false;
            
            // Remove lines that are just ellipsis or dots (processing indicators)
            if (/^\.+$/.test(line.trim())) return false;
            
            // Remove lines that contain terminal control sequences
            if (line.includes('\x1b[') || line.includes('\u001b[')) return false;
            
            // Remove lines that are just prompts or indicators
            if (line.trim() === '>' || line.trim() === '...' || line.trim() === '⏺' || line.trim() === '╭') {
                return false;
            }
            
            // Keep lines that look like actual completion content
            return true;
        });
        
        // Join cleaned lines and trim excess whitespace
        const cleanedText = cleanedLines.join('\n').trim();
        
        // Final cleanup - remove any remaining control sequences
        return cleanedText.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
    }
    
    shouldExtractCompletionText(previousStatus, currentStatus, terminalId) {
        // Skip if terminal data is not available yet
        if (!previousStatus || !currentStatus) {
            return false;
        }
        
        // Extract when transitioning from 'running' to idle states
        const wasRunning = previousStatus === 'running';
        const isNowIdle = currentStatus === '...' || currentStatus === '';
        
        if (wasRunning && isNowIdle) {
            console.log(`[Terminal ${terminalId}] Status transition detected: ${previousStatus} -> ${currentStatus}`);
            return true;
        }
        
        return false;
    }
    
    appendToActiveCompletionItem(terminalId, text) {
        try {
            // Find completion item for this terminal that is currently "in-progress"
            const completionItems = document.querySelectorAll('.completion-item');
            let activeCompletionItem = null;
            
            // Look for in-progress item with matching terminal
            for (const item of completionItems) {
                const itemTerminalId = item.dataset.terminal;
                const isInProgress = item.classList.contains('in-progress');
                
                if (itemTerminalId == terminalId && isInProgress) {
                    activeCompletionItem = item;
                    break;
                }
            }
            
            // If no in-progress item found, look for the most recent item for this terminal
            if (!activeCompletionItem) {
                for (const item of completionItems) {
                    const itemTerminalId = item.dataset.terminal;
                    if (itemTerminalId == terminalId) {
                        activeCompletionItem = item;
                        break;
                    }
                }
            }
            
            if (activeCompletionItem) {
                // Find the completion prompt element
                const promptElement = activeCompletionItem.querySelector('.completion-prompt');
                if (promptElement) {
                    // Append the new text (truncate if very long)
                    const currentText = promptElement.textContent || '';
                    const newText = text.substring(0, 500); // Limit to 500 chars
                    promptElement.textContent = currentText ? `${currentText}\n${newText}` : newText;
                    
                    console.log(`[Terminal ${terminalId}] Appended to completion item:`, text);
                } else {
                    console.warn(`[Terminal ${terminalId}] No completion-prompt element found`);
                }
            } else {
                console.warn(`[Terminal ${terminalId}] No active completion item found`);
            }
        } catch (error) {
            console.error('Error appending to completion item:', error);
        }
    }
    
    // Completion monitoring and stability
    checkTerminalCompletionStatus(terminalId) {
        try {
            const currentStatus = this.appStateStore.getTerminalStatus(terminalId);
            const previousStatus = this.previousTerminalStatuses.get(terminalId);
            
            if (previousStatus && currentStatus) {
                // Check if transitioning from 'running' to idle state
                if (previousStatus === 'running' && (currentStatus === '...' || currentStatus === '')) {
                    console.log(`[Terminal ${terminalId}] Status changed from running to idle - waiting for stable state`);
                    this.waitForStableCompletionState(terminalId);
                }
                // If terminal becomes running again, cancel the completion timer
                else if (currentStatus === 'running' && this.completionStabilityTimers.has(terminalId)) {
                    console.log(`[Terminal ${terminalId}] Status changed back to running - canceling completion timer`);
                    this.cancelCompletionStabilityTimer(terminalId);
                }
            }
            
            // Update previous status
            this.previousTerminalStatuses.set(terminalId, currentStatus);
        } catch (error) {
            console.error('Error checking terminal completion status:', error);
        }
    }
    
    waitForStableCompletionState(terminalId) {
        // Use similar logic as injection system for stability duration
        const checkInterval = 500; // Check every 500ms
        const maxWaitTime = 60000; // Maximum 60 seconds
        
        // Check for plan mode delay
        let requiredStableDuration = 5000; // Default 5 seconds
        const injectionManager = window.injectionManager;
        if (injectionManager?.lastPlanModeCompletionTime) {
            const timeSinceLastPlanMode = Date.now() - injectionManager.lastPlanModeCompletionTime;
            if (timeSinceLastPlanMode < injectionManager.planModeDelay) {
                requiredStableDuration = 30000; // 30 seconds for plan mode
            }
        }
        
        const startTime = Date.now();
        let stableStartTime = null;
        
        const stabilityChecker = setInterval(() => {
            const elapsedTime = Date.now() - startTime;
            
            // Check for timeout
            if (elapsedTime > maxWaitTime) {
                console.log(`[Terminal ${terminalId}] Completion stability check TIMEOUT after ${elapsedTime}ms`);
                this.completeCompletionItem(terminalId);
                clearInterval(stabilityChecker);
                return;
            }
            
            const currentStatus = this.appStateStore.getTerminalStatus(terminalId);
            
            // Check if terminal is still idle
            if (currentStatus === '...' || currentStatus === '') {
                if (stableStartTime === null) {
                    stableStartTime = Date.now();
                    const delayType = requiredStableDuration === 30000 ? '30-second plan mode' : '5-second standard';
                    console.log(`[Terminal ${terminalId}] Terminal became stable - starting ${delayType} completion timer`);
                } else {
                    const stableDuration = Date.now() - stableStartTime;
                    if (stableDuration >= requiredStableDuration) {
                        const delayType = requiredStableDuration === 30000 ? '30-second plan mode' : '5-second standard';
                        console.log(`[Terminal ${terminalId}] Terminal stable for ${stableDuration}ms (${delayType} delay) - completing`);
                        this.completeCompletionItem(terminalId);
                        clearInterval(stabilityChecker);
                        return;
                    }
                }
            } else {
                // Terminal no longer stable
                if (stableStartTime !== null) {
                    console.log(`[Terminal ${terminalId}] Terminal no longer stable - resetting timer`);
                    stableStartTime = null;
                }
            }
        }, checkInterval);
        
        // Store the interval for cleanup
        this.completionStabilityTimers.set(terminalId, stabilityChecker);
    }
    
    startCompletionStabilityTimer(terminalId) {
        // Cancel any existing timer
        this.cancelCompletionStabilityTimer(terminalId);
        
        const timer = setTimeout(() => {
            console.log(`[Terminal ${terminalId}] Completion stability timer elapsed - completing`);
            this.completeCompletionItem(terminalId);
            this.completionStabilityTimers.delete(terminalId);
        }, 5000); // 5 seconds
        
        this.completionStabilityTimers.set(terminalId, timer);
        console.log(`[Terminal ${terminalId}] Started 5-second completion stability timer`);
    }
    
    cancelCompletionStabilityTimer(terminalId) {
        const timer = this.completionStabilityTimers.get(terminalId);
        if (timer) {
            clearTimeout(timer);
            clearInterval(timer); // Works for both timeout and interval
            this.completionStabilityTimers.delete(terminalId);
            console.log(`[Terminal ${terminalId}] Canceled completion stability timer`);
        }
    }
    
    completeCompletionItem(terminalId) {
        try {
            // Find the active completion item for this terminal
            const completionItems = document.querySelectorAll('.completion-item');
            let activeCompletionItem = null;
            
            // Look for in-progress item with matching terminal
            for (const item of completionItems) {
                const itemTerminalId = item.dataset.terminal;
                const isInProgress = item.classList.contains('in-progress');
                
                if (itemTerminalId == terminalId && isInProgress) {
                    activeCompletionItem = item;
                    break;
                }
            }
            
            if (activeCompletionItem) {
                const completionId = parseInt(activeCompletionItem.dataset.completionId);
                
                // Use completion timer manager if available
                if (typeof completionTimerManager !== 'undefined' && completionTimerManager) {
                    completionTimerManager.updateCompletionState(activeCompletionItem, 'completed');
                } else {
                    // Fallback to our own update method
                    this.updateCompletionStatus(completionId, 'completed', Date.now());
                }
                
                console.log(`[Terminal ${terminalId}] Completion item marked as completed`);
                
                // Emit completion event
                this.eventBus.emit('completion:auto:completed', {
                    terminalId,
                    completionId
                });
            } else {
                console.warn(`[Terminal ${terminalId}] No active completion item found to complete`);
            }
        } catch (error) {
            console.error('Error completing completion item:', error);
        }
    }
    
    // Monitoring
    startCompletionMonitoring(completionId, terminalId) {
        const completionItem = this.completionItems.get(completionId);
        if (!completionItem) return;
        
        // Start a timer to update the duration display
        const updateTimer = setInterval(() => {
            if (completionItem.status === 'in-progress') {
                const now = Date.now();
                const duration = Math.floor((now - completionItem.startTime) / 1000);
                
                // Update timer display
                const element = document.querySelector(`[data-completion-id="${completionId}"]`);
                if (element) {
                    const timerElement = element.querySelector('.completion-timer');
                    if (timerElement) {
                        const minutes = Math.floor(duration / 60);
                        const seconds = duration % 60;
                        timerElement.textContent = `${minutes}m ${seconds}s`;
                    }
                }
            } else {
                clearInterval(updateTimer);
            }
        }, 1000);
        
        // Store timer for cleanup
        completionItem.updateTimer = updateTimer;
        
        // Check for automatic completion conditions
        this.checkForAutoCompletion(completionId, terminalId);
    }
    
    checkForAutoCompletion(completionId, terminalId) {
        const completionItem = this.completionItems.get(completionId);
        if (!completionItem) return;
        
        // Smart completion with different timeouts based on plan mode
        const createSmartTimer = () => {
            let absoluteTimeout = 60000; // Default 60 seconds
            
            // Check for plan mode
            const injectionManager = window.injectionManager;
            if (injectionManager?.lastPlanModeCompletionTime) {
                const timeSinceLastPlanMode = Date.now() - injectionManager.lastPlanModeCompletionTime;
                if (timeSinceLastPlanMode < injectionManager.planModeDelay) {
                    absoluteTimeout = 120000; // 120 seconds for plan mode
                    console.log(`[COMPLETION] Using extended timeout for plan mode: ${absoluteTimeout/1000}s`);
                }
            }
            
            return setTimeout(() => {
                if (completionItem.status === 'in-progress') {
                    const terminalStatus = this.appStateStore.getTerminalStatus(terminalId);
                    
                    if (terminalStatus === 'running') {
                        console.log(`[COMPLETION] Item ${completionId} still running after ${absoluteTimeout/1000}s - waiting longer`);
                        completionItem.absoluteTimer = createSmartTimer();
                    } else {
                        console.log(`[COMPLETION] Auto-completing item ${completionId} after timeout`);
                        this.updateCompletionStatus(completionId, 'completed', Date.now());
                    }
                }
            }, absoluteTimeout);
        };
        
        const absoluteTimer = createSmartTimer();
        completionItem.absoluteTimer = absoluteTimer;
        
        // Check status periodically
        const statusCheck = () => {
            if (completionItem.status !== 'in-progress') {
                clearTimeout(completionItem.absoluteTimer);
                return;
            }
            
            const now = Date.now();
            const terminalData = this.appStateStore.getTerminalData(terminalId);
            
            // Check if newer completion exists
            let hasNewerCompletion = false;
            this.completionItems.forEach((item, id) => {
                if (item.terminalId === terminalId && 
                    id > completionId && 
                    item.startTime > completionItem.startTime) {
                    hasNewerCompletion = true;
                }
            });
            
            if (hasNewerCompletion) {
                console.log(`[COMPLETION] Auto-completing item ${completionId} - newer injection detected`);
                this.updateCompletionStatus(completionId, 'completed', now);
                clearTimeout(completionItem.absoluteTimer);
                return;
            }
            
            // Check terminal idle state
            const terminalStatus = this.appStateStore.getTerminalStatus(terminalId);
            const claudeOutput = terminalData?.lastOutput || '';
            
            const isInWaitingState = claudeOutput.includes('...') || 
                                     (!terminalStatus?.includes('running') && 
                                      !terminalStatus?.includes('prompting'));
            
            if (isInWaitingState) {
                const idleTime = now - (terminalData?.lastActivityTime || now);
                const requiredIdleTime = 5000; // 5 seconds
                
                if (idleTime >= requiredIdleTime) {
                    console.log(`[COMPLETION] Auto-completing item ${completionId} after ${requiredIdleTime/1000}s idle`);
                    this.updateCompletionStatus(completionId, 'completed', now);
                    clearTimeout(completionItem.absoluteTimer);
                    return;
                }
            }
            
            // Continue monitoring
            if (completionItem.status === 'in-progress') {
                setTimeout(statusCheck, 1000);
            }
        };
        
        // Start checking after initial delay
        setTimeout(statusCheck, 2000);
    }
    
    // UI Rendering
    renderCompletionItem(completionItem) {
        const todoList = document.getElementById('todo-list');
        if (!todoList) return;
        
        // Create completion item element
        const itemElement = document.createElement('div');
        itemElement.className = `completion-item ${completionItem.status}`;
        itemElement.dataset.terminal = completionItem.terminalId;
        itemElement.dataset.completionId = completionItem.id;
        
        // Create item content
        itemElement.innerHTML = `
            <div class="completion-header">
                <span class="completion-terminal" style="color: ${completionItem.terminalColor}">
                    ${completionItem.terminalName}
                </span>
                <span class="completion-prompt-number">#${completionItem.promptNumber}</span>
                <span class="completion-timer">0m 0s</span>
            </div>
            <div class="completion-prompt">${this.escapeHtml(completionItem.message)}</div>
            <div class="completion-status-indicator"></div>
        `;
        
        // Prepend to list (newest first)
        todoList.insertBefore(itemElement, todoList.firstChild);
        
        // Set up click handler for modal
        itemElement.addEventListener('click', () => {
            this.openCompletionModal(itemElement, 0);
        });
    }
    
    displayCompletionOutput(outputElement, terminalId) {
        // Request terminal data through event bus
        let terminalData = null;
        this.eventBus.emit('completion:request:terminalData', { 
            terminalId: parseInt(terminalId), 
            callback: (data) => { terminalData = data; } 
        });
        
        if (!terminalData || !outputElement) {
            outputElement.innerHTML = '<div class="no-output">No terminal output available</div>';
            return;
        }
        
        // Get the terminal's last output
        const terminalOutput = terminalData.lastOutput || '';
        
        // Find the section between ⏺ and ╭ (same as extraction logic)
        const extractedText = this.getAllTextIn(terminalOutput, '⏺', '╭');
        
        if (extractedText && extractedText.trim()) {
            // Clean and format the text
            const cleanedText = this.cleanCompletionText(extractedText);
            
            // Escape HTML and preserve formatting
            const escapedText = this.escapeHtml(cleanedText);
            const formattedText = escapedText.replace(/\n/g, '<br>');
            
            outputElement.innerHTML = `<div class="completion-output-text">${formattedText}</div>`;
        } else {
            outputElement.innerHTML = '<div class="no-output">No completion output captured yet</div>';
        }
    }
    
    // Modal handling
    openCompletionModal(completionItem, index) {
        const modal = document.getElementById('completion-details-modal');
        const modalTitle = document.getElementById('completion-modal-title');
        const modalPrompt = document.getElementById('completion-modal-prompt');
        const modalOutput = document.getElementById('completion-modal-output');
        
        if (!modal || !modalTitle || !modalPrompt || !modalOutput) return;
        
        // Get terminal information
        const terminalElement = completionItem.querySelector('.completion-terminal');
        const terminalName = terminalElement?.textContent || 'claudecodebot';
        const promptNumber = completionItem.querySelector('.completion-prompt-number')?.textContent || '#0';
        const terminalId = completionItem.dataset.terminal;
        
        // Get prompt text
        const promptText = completionItem.querySelector('.completion-prompt')?.textContent || 'No prompt available';
        
        // Update modal content
        modalTitle.textContent = `${terminalName} - Prompt ${promptNumber}`;
        modalPrompt.textContent = promptText;
        
        // Get and display completion output
        this.displayCompletionOutput(modalOutput, terminalId);
        
        // Show modal
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';
        
    }
    
    closeCompletionModal() {
        const modal = document.getElementById('completion-details-modal');
        if (!modal) return;
        
        modal.classList.remove('show');
        document.body.style.overflow = '';
        
    }
    
    setupCompletionModalHandlers() {
        const modal = document.getElementById('completion-details-modal');
        const closeBtn = document.getElementById('completion-modal-close');
        const modalContent = modal?.querySelector('.modal-content');
        
        // Close button handler
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeCompletionModal());
        }
        
        // Click outside modal to close
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeCompletionModal();
                }
            });
        }
        
        // Prevent modal close when clicking inside
        if (modalContent) {
            modalContent.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }
        
        // ESC key to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal?.classList.contains('show')) {
                this.closeCompletionModal();
            }
        });
    }
    
    setupCompletionContainerHandlers() {
        // Add click event listeners to all completion containers
        const completionItems = document.querySelectorAll('.completion-item');
        completionItems.forEach((item, index) => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openCompletionModal(item, index);
            });
        });
    }

    // Sound handling: intentionally none here. Completion/prompted/injection
    // sounds are centralized in SoundManager (assets/soundeffects/, settings.sound.*).
    // The former checkCompletionSoundTrigger/playCompletionSound/testCompletionSound
    // duplicated that with a broken asset path + dead setting key and were removed.

    // Cleanup
    cleanupTerminalCompletions(terminalId) {
        // Cancel any stability timers
        this.cancelCompletionStabilityTimer(terminalId);
        
        // Clean up tracking maps
        this.previousCompletionStrings.delete(terminalId);
        this.previousTerminalStatuses.delete(terminalId);
        
        // Mark any in-progress completions as interrupted
        this.completionItems.forEach((item, id) => {
            if (item.terminalId === terminalId && item.status === 'in-progress') {
                this.updateCompletionStatus(id, 'interrupted', Date.now());
            }
        });
    }
    
    // Utility functions
    getAllTextIn(str, startChar, endChar) {
        if (!str || !startChar || !endChar) return '';
        
        const startIndex = str.lastIndexOf(startChar);
        if (startIndex === -1) return '';
        
        const afterStart = str.substring(startIndex + startChar.length);
        const endIndex = afterStart.indexOf(endChar);
        
        if (endIndex === -1) {
            return afterStart;
        }
        
        return afterStart.substring(0, endIndex);
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Public API for backward compatibility
    getAllCompletions() {
        return Array.from(this.completionItems.values());
    }
    
    getCompletionById(completionId) {
        return this.completionItems.get(completionId);
    }
    
    getCompletionsForTerminal(terminalId) {
        return Array.from(this.completionItems.values())
            .filter(item => item.terminalId === terminalId);
    }
}

// Export for use in renderer.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CompletionManager;
}
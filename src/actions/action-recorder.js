/**
 * Action Recorder - Core action recording system with coordinate tracking
 * Records mouse clicks, drags, and gestures on device display with precise mapping
 */

const { EventEmitter } = require('events');

class ActionRecorder extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            // Recording settings
            enableCoordinateTracking: options.enableCoordinateTracking !== false,
            enableVisualFeedback: options.enableVisualFeedback !== false,
            enableSequenceManagement: options.enableSequenceManagement !== false,
            
            // Coordinate precision
            coordinatePrecision: options.coordinatePrecision || 2,
            scaleFactorPrecision: options.scaleFactorPrecision || 4,
            
            // Timing settings
            actionDebounceTime: options.actionDebounceTime || 100,
            maxActionSequenceLength: options.maxActionSequenceLength || 100,
            recordingTimeout: options.recordingTimeout || 30000,
            
            // Visual feedback settings
            feedbackDuration: options.feedbackDuration || 1500,
            feedbackFadeTime: options.feedbackFadeTime || 300,
            
            // Storage settings
            maxStoredSequences: options.maxStoredSequences || 10,
            autoSaveSequences: options.autoSaveSequences !== false,
            
            // Integration settings
            autoScreenshotAfterAction: options.autoScreenshotAfterAction || false,
            screenshotDelay: options.screenshotDelay || 500
        };
        
        this.state = {
            isRecording: false,
            isInitialized: false,
            currentSequence: null,
            recordingStartTime: null,
            lastActionTime: null,
            actionCount: 0,
            errors: []
        };
        
        // Action storage
        this.actionSequences = new Map(); // sequenceId -> sequence data
        this.currentActions = []; // Current recording session actions
        this.actionIdCounter = 1;
        this.sequenceIdCounter = 1;
        
        // Visual feedback storage
        this.activeVisualFeedbacks = new Map(); // actionId -> feedback element
        this.feedbackCleanupTimers = new Map(); // actionId -> timer
        
        // Device state
        this.deviceInfo = null;
        this.displayBounds = null;
        this.scaleFactor = 1;
        
        // Coordinate mapping
        this.coordinateMapper = null;
        
        // Bind methods
        this.handleMouseDown = this.handleMouseDown.bind(this);
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.handleMouseUp = this.handleMouseUp.bind(this);
        this.handleClick = this.handleClick.bind(this);
        this.handleDoubleClick = this.handleDoubleClick.bind(this);
        this.cleanup = this.cleanup.bind(this);
    }
    
    /**
     * Initialize the action recorder
     */
    async initialize(coordinateMapper, deviceInfo = null) {
        try {
            this.coordinateMapper = coordinateMapper;
            this.deviceInfo = deviceInfo;
            
            if (deviceInfo) {
                this.displayBounds = {
                    width: deviceInfo.displayWidth || 1080,
                    height: deviceInfo.displayHeight || 1920
                };
            }
            
            this.state.isInitialized = true;
            this.emit('initialized', { deviceInfo: this.deviceInfo });
            
            return true;
        } catch (error) {
            this.state.errors.push({
                timestamp: Date.now(),
                error: error.message,
                type: 'initialization'
            });
            this.emit('error', error);
            return false;
        }
    }
    
    /**
     * Start recording action sequence
     */
    startRecording(sequenceName = null) {
        if (this.state.isRecording) {
            throw new Error('Already recording. Stop current recording first.');
        }
        
        if (!this.state.isInitialized) {
            throw new Error('Action recorder not initialized');
        }
        
        const sequenceId = `sequence_${this.sequenceIdCounter++}`;
        const timestamp = Date.now();
        
        this.state.currentSequence = {
            id: sequenceId,
            name: sequenceName || `Recording ${new Date().toLocaleTimeString()}`,
            startTime: timestamp,
            endTime: null,
            actions: [],
            deviceInfo: this.deviceInfo,
            displayBounds: this.displayBounds,
            metadata: {
                version: '1.0.0',
                createdBy: 'action-recorder',
                deviceModel: this.deviceInfo?.model || 'unknown',
                screenResolution: this.displayBounds ? `${this.displayBounds.width}x${this.displayBounds.height}` : 'unknown'
            }
        };
        
        this.currentActions = [];
        this.state.isRecording = true;
        this.state.recordingStartTime = timestamp;
        this.state.lastActionTime = timestamp;
        this.state.actionCount = 0;
        
        this.emit('recordingStarted', {
            sequenceId,
            name: this.state.currentSequence.name,
            timestamp
        });
        
        return sequenceId;
    }
    
    /**
     * Stop recording action sequence
     */
    stopRecording() {
        if (!this.state.isRecording) {
            return null;
        }
        
        const timestamp = Date.now();
        const sequence = this.state.currentSequence;
        
        sequence.endTime = timestamp;
        sequence.duration = timestamp - sequence.startTime;
        sequence.actions = [...this.currentActions];
        sequence.actionCount = this.currentActions.length;
        
        // Store the completed sequence
        this.actionSequences.set(sequence.id, sequence);
        
        // Auto-save if enabled
        if (this.options.autoSaveSequences) {
            this.saveSequenceToStorage(sequence);
        }
        
        // Cleanup old sequences if limit exceeded
        if (this.actionSequences.size > this.options.maxStoredSequences) {
            this.cleanupOldSequences();
        }
        
        this.state.isRecording = false;
        this.state.currentSequence = null;
        this.currentActions = [];
        
        this.emit('recordingStopped', {
            sequence,
            duration: sequence.duration,
            actionCount: sequence.actionCount
        });
        
        return sequence;
    }
    
    /**
     * Record a click action
     */
    recordClick(clientX, clientY, elementInfo = {}) {
        if (!this.state.isRecording) {
            return null;
        }
        
        return this.recordAction('click', {
            clientX,
            clientY,
            elementInfo,
            timestamp: Date.now()
        });
    }
    
    /**
     * Record a double click action
     */
    recordDoubleClick(clientX, clientY, elementInfo = {}) {
        if (!this.state.isRecording) {
            return null;
        }
        
        return this.recordAction('doubleclick', {
            clientX,
            clientY,
            elementInfo,
            timestamp: Date.now()
        });
    }
    
    /**
     * Record a drag action
     */
    recordDrag(startX, startY, endX, endY, elementInfo = {}) {
        if (!this.state.isRecording) {
            return null;
        }
        
        return this.recordAction('drag', {
            startX,
            startY,
            endX,
            endY,
            elementInfo,
            timestamp: Date.now()
        });
    }
    
    /**
     * Record a swipe action
     */
    recordSwipe(startX, startY, endX, endY, direction = 'unknown', velocity = 0) {
        if (!this.state.isRecording) {
            return null;
        }
        
        return this.recordAction('swipe', {
            startX,
            startY,
            endX,
            endY,
            direction,
            velocity,
            timestamp: Date.now()
        });
    }
    
    /**
     * Record a long press action
     */
    recordLongPress(clientX, clientY, duration, elementInfo = {}) {
        if (!this.state.isRecording) {
            return null;
        }
        
        return this.recordAction('longpress', {
            clientX,
            clientY,
            duration,
            elementInfo,
            timestamp: Date.now()
        });
    }
    
    /**
     * Core action recording method
     */
    recordAction(type, actionData) {
        const actionId = `action_${this.actionIdCounter++}`;
        const timestamp = Date.now();
        const relativeTime = timestamp - this.state.recordingStartTime;
        
        // Map UI coordinates to device coordinates if coordinate mapper is available
        let deviceCoordinates = {};
        if (this.coordinateMapper && this.options.enableCoordinateTracking) {
            try {
                if (type === 'drag' || type === 'swipe') {
                    const startDevice = this.coordinateMapper.uiToDevice(actionData.startX, actionData.startY);
                    const endDevice = this.coordinateMapper.uiToDevice(actionData.endX, actionData.endY);
                    
                    deviceCoordinates = {
                        startX: parseFloat(startDevice.x.toFixed(this.options.coordinatePrecision)),
                        startY: parseFloat(startDevice.y.toFixed(this.options.coordinatePrecision)),
                        endX: parseFloat(endDevice.x.toFixed(this.options.coordinatePrecision)),
                        endY: parseFloat(endDevice.y.toFixed(this.options.coordinatePrecision))
                    };
                } else {
                    const deviceCoord = this.coordinateMapper.uiToDevice(
                        actionData.clientX || actionData.x, 
                        actionData.clientY || actionData.y
                    );
                    
                    deviceCoordinates = {
                        x: parseFloat(deviceCoord.x.toFixed(this.options.coordinatePrecision)),
                        y: parseFloat(deviceCoord.y.toFixed(this.options.coordinatePrecision))
                    };
                }
            } catch (error) {
                console.warn('Coordinate mapping failed:', error.message);
                deviceCoordinates = { error: 'mapping_failed' };
            }
        }
        
        const action = {
            id: actionId,
            type: type,
            timestamp: timestamp,
            relativeTime: relativeTime,
            uiCoordinates: {
                clientX: actionData.clientX || actionData.x || actionData.startX,
                clientY: actionData.clientY || actionData.y || actionData.startY,
                endX: actionData.endX,
                endY: actionData.endY
            },
            deviceCoordinates,
            elementInfo: actionData.elementInfo || {},
            metadata: {
                duration: actionData.duration || null,
                direction: actionData.direction || null,
                velocity: actionData.velocity || null,
                scaleFactor: this.scaleFactor,
                displayBounds: this.displayBounds
            },
            rawData: actionData
        };
        
        // Add action to current sequence
        this.currentActions.push(action);
        this.state.actionCount++;
        this.state.lastActionTime = timestamp;
        
        // Trigger visual feedback if enabled
        if (this.options.enableVisualFeedback) {
            this.showVisualFeedback(action);
        }
        
        // Trigger auto-screenshot if enabled
        if (this.options.autoScreenshotAfterAction) {
            setTimeout(() => {
                this.emit('requestScreenshot', { action, delay: this.options.screenshotDelay });
            }, this.options.screenshotDelay);
        }
        
        this.emit('actionRecorded', action);
        
        return action;
    }
    
    /**
     * Show visual feedback for recorded action
     */
    showVisualFeedback(action) {
        const feedbackId = `feedback_${action.id}`;
        
        const feedbackData = {
            id: feedbackId,
            actionId: action.id,
            type: action.type,
            x: action.uiCoordinates.clientX,
            y: action.uiCoordinates.clientY,
            endX: action.uiCoordinates.endX,
            endY: action.uiCoordinates.endY,
            timestamp: Date.now(),
            duration: this.options.feedbackDuration
        };
        
        this.activeVisualFeedbacks.set(feedbackId, feedbackData);
        
        // Schedule cleanup
        const cleanupTimer = setTimeout(() => {
            this.cleanupVisualFeedback(feedbackId);
        }, this.options.feedbackDuration);
        
        this.feedbackCleanupTimers.set(feedbackId, cleanupTimer);
        
        this.emit('showVisualFeedback', feedbackData);
    }
    
    /**
     * Cleanup visual feedback
     */
    cleanupVisualFeedback(feedbackId) {
        const feedback = this.activeVisualFeedbacks.get(feedbackId);
        if (feedback) {
            this.activeVisualFeedbacks.delete(feedbackId);
            this.emit('hideVisualFeedback', feedback);
        }
        
        const timer = this.feedbackCleanupTimers.get(feedbackId);
        if (timer) {
            clearTimeout(timer);
            this.feedbackCleanupTimers.delete(feedbackId);
        }
    }
    
    /**
     * Get all recorded action sequences
     */
    getAllSequences() {
        return Array.from(this.actionSequences.values())
            .sort((a, b) => b.startTime - a.startTime);
    }
    
    /**
     * Get specific action sequence
     */
    getSequence(sequenceId) {
        return this.actionSequences.get(sequenceId);
    }
    
    /**
     * Delete action sequence
     */
    deleteSequence(sequenceId) {
        const sequence = this.actionSequences.get(sequenceId);
        if (sequence) {
            this.actionSequences.delete(sequenceId);
            this.emit('sequenceDeleted', { sequenceId, sequence });
            return true;
        }
        return false;
    }
    
    /**
     * Edit action sequence
     */
    editSequence(sequenceId, updates) {
        const sequence = this.actionSequences.get(sequenceId);
        if (!sequence) {
            return null;
        }
        
        const updatedSequence = {
            ...sequence,
            ...updates,
            lastModified: Date.now()
        };
        
        this.actionSequences.set(sequenceId, updatedSequence);
        this.emit('sequenceUpdated', { sequenceId, sequence: updatedSequence });
        
        return updatedSequence;
    }
    
    /**
     * Export action sequence for preset integration
     */
    exportSequence(sequenceId, exportOptions = {}) {
        const sequence = this.getSequence(sequenceId);
        if (!sequence) {
            return null;
        }
        
        const exportData = {
            sequence: {
                id: sequence.id,
                name: sequence.name,
                actions: sequence.actions.map(action => ({
                    type: action.type,
                    deviceCoordinates: action.deviceCoordinates,
                    relativeTime: action.relativeTime,
                    metadata: action.metadata
                })),
                metadata: sequence.metadata,
                duration: sequence.duration,
                actionCount: sequence.actionCount
            },
            exportOptions,
            exportedAt: new Date().toISOString(),
            exportedBy: 'action-recorder'
        };
        
        if (exportOptions.includeUICoordinates) {
            exportData.sequence.actions.forEach((action, index) => {
                action.uiCoordinates = sequence.actions[index].uiCoordinates;
            });
        }
        
        if (exportOptions.includeRawData) {
            exportData.sequence.actions.forEach((action, index) => {
                action.rawData = sequence.actions[index].rawData;
            });
        }
        
        this.emit('sequenceExported', { sequenceId, exportData });
        
        return exportData;
    }
    
    /**
     * Save sequence to storage
     */
    saveSequenceToStorage(sequence) {
        // This would integrate with the app's storage system
        // For now, just emit an event for external handling
        this.emit('saveSequence', sequence);
    }
    
    /**
     * Cleanup old sequences
     */
    cleanupOldSequences() {
        const sequences = this.getAllSequences();
        const toDelete = sequences.slice(this.options.maxStoredSequences);
        
        for (const sequence of toDelete) {
            this.deleteSequence(sequence.id);
        }
        
        this.emit('sequencesCleanedUp', { deleted: toDelete.length });
    }
    
    /**
     * Get current recording state
     */
    getState() {
        return {
            ...this.state,
            sequenceCount: this.actionSequences.size,
            currentActionCount: this.currentActions.length,
            activeVisualFeedbacks: this.activeVisualFeedbacks.size,
            options: this.options
        };
    }
    
    /**
     * Handle mouse down event
     */
    handleMouseDown(event) {
        if (!this.state.isRecording) return;
        
        this.mouseDownStart = {
            x: event.clientX,
            y: event.clientY,
            timestamp: Date.now()
        };
    }
    
    /**
     * Handle mouse move event
     */
    handleMouseMove(event) {
        if (!this.state.isRecording || !this.mouseDownStart) return;
        
        // Track drag if significant movement
        const deltaX = Math.abs(event.clientX - this.mouseDownStart.x);
        const deltaY = Math.abs(event.clientY - this.mouseDownStart.y);
        
        if (deltaX > 5 || deltaY > 5) {
            this.isDragging = true;
        }
    }
    
    /**
     * Handle mouse up event
     */
    handleMouseUp(event) {
        if (!this.state.isRecording || !this.mouseDownStart) return;
        
        const duration = Date.now() - this.mouseDownStart.timestamp;
        
        if (this.isDragging) {
            // Record drag
            this.recordDrag(
                this.mouseDownStart.x,
                this.mouseDownStart.y,
                event.clientX,
                event.clientY
            );
        } else if (duration > 800) {
            // Record long press
            this.recordLongPress(
                event.clientX,
                event.clientY,
                duration
            );
        }
        
        this.mouseDownStart = null;
        this.isDragging = false;
    }
    
    /**
     * Handle click event
     */
    handleClick(event) {
        if (!this.state.isRecording) return;
        
        this.recordClick(event.clientX, event.clientY);
    }
    
    /**
     * Handle double click event
     */
    handleDoubleClick(event) {
        if (!this.state.isRecording) return;
        
        this.recordDoubleClick(event.clientX, event.clientY);
    }
    
    /**
     * Attach event listeners to element
     */
    attachTo(element) {
        if (!element) return;
        
        element.addEventListener('mousedown', this.handleMouseDown);
        element.addEventListener('mousemove', this.handleMouseMove);
        element.addEventListener('mouseup', this.handleMouseUp);
        element.addEventListener('click', this.handleClick);
        element.addEventListener('dblclick', this.handleDoubleClick);
        
        this.attachedElement = element;
        this.emit('attached', { element });
    }
    
    /**
     * Detach event listeners
     */
    detach() {
        if (!this.attachedElement) return;
        
        this.attachedElement.removeEventListener('mousedown', this.handleMouseDown);
        this.attachedElement.removeEventListener('mousemove', this.handleMouseMove);
        this.attachedElement.removeEventListener('mouseup', this.handleMouseUp);
        this.attachedElement.removeEventListener('click', this.handleClick);
        this.attachedElement.removeEventListener('dblclick', this.handleDoubleClick);
        
        this.attachedElement = null;
        this.emit('detached');
    }
    
    /**
     * Cleanup resources
     */
    cleanup() {
        // Stop recording if active
        if (this.state.isRecording) {
            this.stopRecording();
        }
        
        // Detach event listeners
        this.detach();
        
        // Clear visual feedback timers
        this.feedbackCleanupTimers.forEach(timer => clearTimeout(timer));
        this.feedbackCleanupTimers.clear();
        this.activeVisualFeedbacks.clear();
        
        // Clear data
        this.actionSequences.clear();
        this.currentActions = [];
        
        this.emit('cleanedUp');
    }
}

module.exports = ActionRecorder;
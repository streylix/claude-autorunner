/**
 * Recording View Integration - Integrates action recording with the device recording interface
 * Provides seamless integration between screenshot capture and action recording
 */

const ActionRecorder = require('./action-recorder.js');
const CoordinateMapper = require('./coordinate-mapper.js');
const VisualFeedback = require('./visual-feedback.js');

class RecordingViewIntegration {
    constructor(options = {}) {
        this.options = {
            // Integration settings
            enableActionRecording: options.enableActionRecording !== false,
            enableVisualFeedback: options.enableVisualFeedback !== false,
            enableAutoScreenshots: options.enableAutoScreenshots || false,
            
            // UI settings
            recordingButtonSelector: options.recordingButtonSelector || '.record-actions-btn',
            deviceDisplaySelector: options.deviceDisplaySelector || '.device-display img',
            controlPanelSelector: options.controlPanelSelector || '.recording-controls',
            
            // Coordinate mapping settings
            autoUpdateCoordinates: options.autoUpdateCoordinates !== false,
            coordinateUpdateInterval: options.coordinateUpdateInterval || 1000,
            
            // Visual feedback settings
            feedbackContainerId: options.feedbackContainerId || 'recording-feedback-overlay',
            
            // Export settings
            autoExportOnStop: options.autoExportOnStop || false,
            includeScreenshots: options.includeScreenshots !== false
        };
        
        this.state = {
            isInitialized: false,
            isRecording: false,
            currentDeviceInfo: null,
            currentSequence: null,
            integrationActive: false
        };
        
        // Component instances
        this.actionRecorder = null;
        this.coordinateMapper = null;
        this.visualFeedback = null;
        this.screenshotEngine = null;
        
        // UI elements
        this.recordingButton = null;
        this.deviceDisplay = null;
        this.controlPanel = null;
        this.statusIndicator = null;
        
        // Event listeners storage
        this.eventListeners = new Map();
        
        // Coordinate update timer
        this.coordinateUpdateTimer = null;
        
        // Bind methods
        this.handleRecordingToggle = this.handleRecordingToggle.bind(this);
        this.handleDeviceInteraction = this.handleDeviceInteraction.bind(this);
        this.handleScreenshotCaptured = this.handleScreenshotCaptured.bind(this);
        this.updateCoordinateMapping = this.updateCoordinateMapping.bind(this);
    }
    
    /**
     * Initialize the recording view integration
     */
    async initialize(screenshotEngine, deviceInfo = null) {
        try {
            this.screenshotEngine = screenshotEngine;
            this.state.currentDeviceInfo = deviceInfo;
            
            // Initialize components
            await this.initializeComponents();
            
            // Setup UI integration
            this.setupUIIntegration();
            
            // Setup event listeners
            this.setupEventListeners();
            
            // Start coordinate monitoring if enabled
            if (this.options.autoUpdateCoordinates) {
                this.startCoordinateMonitoring();
            }
            
            this.state.isInitialized = true;
            this.state.integrationActive = true;
            
            this.emit('initialized', { deviceInfo });
            
            return true;
        } catch (error) {
            console.error('RecordingViewIntegration initialization failed:', error);
            return false;
        }
    }
    
    /**
     * Initialize core components
     */
    async initializeComponents() {
        // Initialize action recorder
        this.actionRecorder = new ActionRecorder({
            enableCoordinateTracking: true,
            enableVisualFeedback: this.options.enableVisualFeedback,
            enableSequenceManagement: true,
            autoScreenshotAfterAction: this.options.enableAutoScreenshots
        });
        
        // Initialize coordinate mapper
        this.coordinateMapper = new CoordinateMapper({
            debugMode: false,
            maintainAspectRatio: true,
            scaleMethod: 'fit'
        });
        
        // Initialize visual feedback
        if (this.options.enableVisualFeedback) {
            this.visualFeedback = new VisualFeedback({
                containerId: this.options.feedbackContainerId,
                autoCreateContainer: true
            });
        }
        
        // Setup component relationships
        this.setupComponentIntegration();
    }
    
    /**
     * Setup integration between components
     */
    setupComponentIntegration() {
        // Connect action recorder events
        this.actionRecorder.on('actionRecorded', (action) => {
            this.handleActionRecorded(action);
        });
        
        this.actionRecorder.on('recordingStarted', (data) => {
            this.handleRecordingStarted(data);
        });
        
        this.actionRecorder.on('recordingStopped', (data) => {
            this.handleRecordingStopped(data);
        });
        
        this.actionRecorder.on('showVisualFeedback', (feedbackData) => {
            if (this.visualFeedback) {
                this.visualFeedback.showActionFeedback(feedbackData);
            }
        });
        
        this.actionRecorder.on('requestScreenshot', (data) => {
            this.handleScreenshotRequest(data);
        });
        
        // Connect screenshot engine events
        if (this.screenshotEngine) {
            this.screenshotEngine.on('screenshotCaptured', this.handleScreenshotCaptured);
        }
    }
    
    /**
     * Setup UI integration
     */
    setupUIIntegration() {
        // Find UI elements
        this.recordingButton = document.querySelector(this.options.recordingButtonSelector);
        this.deviceDisplay = document.querySelector(this.options.deviceDisplaySelector);
        this.controlPanel = document.querySelector(this.options.controlPanelSelector);
        
        // Create UI elements if they don't exist
        if (!this.recordingButton) {
            this.createRecordingButton();
        }
        
        // Create status indicator
        this.createStatusIndicator();
        
        // Setup device display interaction area
        this.setupDeviceInteractionArea();
        
        // Initialize visual feedback overlay
        if (this.visualFeedback) {
            this.visualFeedback.initialize(document.body);
        }
    }
    
    /**
     * Create recording button
     */
    createRecordingButton() {
        if (!this.controlPanel) return;
        
        const button = document.createElement('button');
        button.className = 'record-actions-btn btn-secondary';
        button.innerHTML = `
            <span class="btn-icon">⏺</span>
            <span class="btn-text">Record Actions</span>
        `;
        button.title = 'Start/Stop action recording';
        
        this.controlPanel.appendChild(button);
        this.recordingButton = button;
    }
    
    /**
     * Create status indicator
     */
    createStatusIndicator() {
        if (!this.controlPanel) return;
        
        const indicator = document.createElement('div');
        indicator.className = 'action-recording-status';
        indicator.innerHTML = `
            <div class="status-dot"></div>
            <span class="status-text">Ready</span>
        `;
        indicator.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            background: #f5f5f5;
            border-radius: 4px;
            font-size: 12px;
            color: #666;
        `;
        
        const dot = indicator.querySelector('.status-dot');
        dot.style.cssText = `
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #ccc;
        `;
        
        this.controlPanel.appendChild(indicator);
        this.statusIndicator = indicator;
    }
    
    /**
     * Setup device interaction area
     */
    setupDeviceInteractionArea() {
        if (!this.deviceDisplay) return;
        
        // Create interaction overlay
        const overlay = document.createElement('div');
        overlay.className = 'device-interaction-overlay';
        overlay.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 10;
        `;
        
        // Position relative to device display container
        const container = this.deviceDisplay.parentElement;
        if (container) {
            container.style.position = 'relative';
            container.appendChild(overlay);
        }
        
        // Initialize coordinate mapping
        this.updateCoordinateMapping();
        
        // Attach action recorder to device display
        this.actionRecorder.attachTo(this.deviceDisplay);
    }
    
    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Recording button click
        if (this.recordingButton) {
            const listener = this.handleRecordingToggle;
            this.recordingButton.addEventListener('click', listener);
            this.eventListeners.set('recordingButton', { element: this.recordingButton, event: 'click', listener });
        }
        
        // Device display interactions
        if (this.deviceDisplay) {
            const interactionListener = this.handleDeviceInteraction;
            this.deviceDisplay.addEventListener('click', interactionListener);
            this.eventListeners.set('deviceClick', { element: this.deviceDisplay, event: 'click', listener: interactionListener });
        }
        
        // Window resize for coordinate updates
        const resizeListener = () => {
            if (this.options.autoUpdateCoordinates) {
                this.updateCoordinateMapping();
            }
        };
        window.addEventListener('resize', resizeListener);
        this.eventListeners.set('windowResize', { element: window, event: 'resize', listener: resizeListener });
    }
    
    /**
     * Update coordinate mapping
     */
    updateCoordinateMapping() {
        if (!this.deviceDisplay || !this.state.currentDeviceInfo) return;
        
        try {
            // Initialize coordinate mapper with current device display
            const success = this.coordinateMapper.initialize(this.deviceDisplay, this.state.currentDeviceInfo);
            
            if (success) {
                // Update action recorder with new coordinate mapper
                this.actionRecorder.initialize(this.coordinateMapper, this.state.currentDeviceInfo);
                
                // Validate mapping accuracy
                const validation = this.coordinateMapper.validateMapping();
                if (!validation.valid) {
                    console.warn('Coordinate mapping validation failed:', validation.error);
                }
            }
        } catch (error) {
            console.error('Failed to update coordinate mapping:', error);
        }
    }
    
    /**
     * Start coordinate monitoring
     */
    startCoordinateMonitoring() {
        if (this.coordinateUpdateTimer) {
            clearInterval(this.coordinateUpdateTimer);
        }
        
        this.coordinateUpdateTimer = setInterval(() => {
            this.updateCoordinateMapping();
        }, this.options.coordinateUpdateInterval);
    }
    
    /**
     * Stop coordinate monitoring
     */
    stopCoordinateMonitoring() {
        if (this.coordinateUpdateTimer) {
            clearInterval(this.coordinateUpdateTimer);
            this.coordinateUpdateTimer = null;
        }
    }
    
    /**
     * Handle recording toggle
     */
    handleRecordingToggle() {
        if (this.state.isRecording) {
            this.stopRecording();
        } else {
            this.startRecording();
        }
    }
    
    /**
     * Start action recording
     */
    startRecording() {
        if (!this.state.isInitialized || this.state.isRecording) return;
        
        try {
            const sequenceId = this.actionRecorder.startRecording();
            this.state.isRecording = true;
            
            // Update UI
            this.updateRecordingButton(true);
            this.updateStatusIndicator('recording', 'Recording actions...');
            
            // Enable device interaction capturing
            if (this.deviceDisplay) {
                this.deviceDisplay.style.pointerEvents = 'auto';
            }
            
            this.emit('recordingStarted', { sequenceId });
            
        } catch (error) {
            console.error('Failed to start action recording:', error);
            this.emit('error', { error, action: 'start_recording' });
        }
    }
    
    /**
     * Stop action recording
     */
    stopRecording() {
        if (!this.state.isRecording) return;
        
        try {
            const sequence = this.actionRecorder.stopRecording();
            this.state.isRecording = false;
            this.state.currentSequence = sequence;
            
            // Update UI
            this.updateRecordingButton(false);
            this.updateStatusIndicator('ready', 'Ready');
            
            // Disable device interaction capturing
            if (this.deviceDisplay) {
                this.deviceDisplay.style.pointerEvents = 'none';
            }
            
            // Auto-export if enabled
            if (this.options.autoExportOnStop && sequence) {
                this.exportCurrentSequence();
            }
            
            this.emit('recordingStopped', { sequence });
            
        } catch (error) {
            console.error('Failed to stop action recording:', error);
            this.emit('error', { error, action: 'stop_recording' });
        }
    }
    
    /**
     * Update recording button appearance
     */
    updateRecordingButton(isRecording) {
        if (!this.recordingButton) return;
        
        const icon = this.recordingButton.querySelector('.btn-icon');
        const text = this.recordingButton.querySelector('.btn-text');
        
        if (isRecording) {
            icon.textContent = '⏹';
            text.textContent = 'Stop Recording';
            this.recordingButton.classList.add('recording');
            this.recordingButton.style.background = '#f44336';
            this.recordingButton.style.color = '#fff';
        } else {
            icon.textContent = '⏺';
            text.textContent = 'Record Actions';
            this.recordingButton.classList.remove('recording');
            this.recordingButton.style.background = '';
            this.recordingButton.style.color = '';
        }
    }
    
    /**
     * Update status indicator
     */
    updateStatusIndicator(status, text) {
        if (!this.statusIndicator) return;
        
        const dot = this.statusIndicator.querySelector('.status-dot');
        const statusText = this.statusIndicator.querySelector('.status-text');
        
        statusText.textContent = text;
        
        const colors = {
            ready: '#ccc',
            recording: '#f44336',
            processing: '#ff9800',
            error: '#f44336'
        };
        
        dot.style.background = colors[status] || colors.ready;
        
        if (status === 'recording') {
            dot.style.animation = 'pulse 1s infinite';
        } else {
            dot.style.animation = 'none';
        }
    }
    
    /**
     * Handle device interaction
     */
    handleDeviceInteraction(event) {
        // This is handled by the action recorder's event listeners
        // Additional processing can be added here if needed
        
        this.emit('deviceInteraction', {
            event: event,
            coordinates: {
                x: event.clientX,
                y: event.clientY
            }
        });
    }
    
    /**
     * Handle action recorded
     */
    handleActionRecorded(action) {
        // Update status
        this.updateStatusIndicator('recording', `Recorded ${action.type} action`);
        
        // Reset status after delay
        setTimeout(() => {
            if (this.state.isRecording) {
                this.updateStatusIndicator('recording', 'Recording actions...');
            }
        }, 1000);
        
        this.emit('actionRecorded', { action });
    }
    
    /**
     * Handle recording started
     */
    handleRecordingStarted(data) {
        this.emit('integrationRecordingStarted', data);
    }
    
    /**
     * Handle recording stopped
     */
    handleRecordingStopped(data) {
        this.emit('integrationRecordingStopped', data);
    }
    
    /**
     * Handle screenshot request
     */
    handleScreenshotRequest(data) {
        if (this.screenshotEngine && this.options.enableAutoScreenshots) {
            setTimeout(() => {
                this.screenshotEngine.capture('action-triggered');
            }, data.delay || 500);
        }
    }
    
    /**
     * Handle screenshot captured
     */
    handleScreenshotCaptured(screenshotData) {
        this.emit('screenshotCaptured', { screenshotData });
    }
    
    /**
     * Export current sequence
     */
    exportCurrentSequence() {
        if (!this.state.currentSequence) return null;
        
        const exportData = this.actionRecorder.exportSequence(
            this.state.currentSequence.id,
            {
                includeUICoordinates: true,
                includeRawData: false,
                includeScreenshots: this.options.includeScreenshots
            }
        );
        
        this.emit('sequenceExported', { exportData });
        
        return exportData;
    }
    
    /**
     * Get current recording state
     */
    getState() {
        return {
            ...this.state,
            actionRecorderState: this.actionRecorder?.getState(),
            coordinateMapperState: this.coordinateMapper?.getStatistics(),
            visualFeedbackState: this.visualFeedback?.getActiveFeedbackCount()
        };
    }
    
    /**
     * Update device information
     */
    updateDeviceInfo(deviceInfo) {
        this.state.currentDeviceInfo = deviceInfo;
        this.updateCoordinateMapping();
        
        this.emit('deviceInfoUpdated', { deviceInfo });
    }
    
    /**
     * Enable/disable visual feedback
     */
    setVisualFeedbackEnabled(enabled) {
        this.options.enableVisualFeedback = enabled;
        
        if (enabled && !this.visualFeedback) {
            this.visualFeedback = new VisualFeedback({
                containerId: this.options.feedbackContainerId,
                autoCreateContainer: true
            });
            this.visualFeedback.initialize(document.body);
        } else if (!enabled && this.visualFeedback) {
            this.visualFeedback.cleanup();
            this.visualFeedback = null;
        }
        
        this.emit('visualFeedbackToggled', { enabled });
    }
    
    /**
     * Enable/disable auto screenshots
     */
    setAutoScreenshotsEnabled(enabled) {
        this.options.enableAutoScreenshots = enabled;
        
        if (this.actionRecorder) {
            this.actionRecorder.options.autoScreenshotAfterAction = enabled;
        }
        
        this.emit('autoScreenshotsToggled', { enabled });
    }
    
    /**
     * Get all recorded sequences
     */
    getAllSequences() {
        return this.actionRecorder?.getAllSequences() || [];
    }
    
    /**
     * Clear all recorded sequences
     */
    clearAllSequences() {
        if (this.actionRecorder) {
            const sequences = this.actionRecorder.getAllSequences();
            sequences.forEach(seq => this.actionRecorder.deleteSequence(seq.id));
        }
        
        this.emit('allSequencesCleared');
    }
    
    /**
     * Event emitter helper
     */
    emit(eventName, data = {}) {
        // Emit custom event
        const event = new CustomEvent(`recordingIntegration:${eventName}`, {
            detail: data
        });
        document.dispatchEvent(event);
    }
    
    /**
     * Add event listener
     */
    on(eventName, handler) {
        document.addEventListener(`recordingIntegration:${eventName}`, handler);
    }
    
    /**
     * Remove event listener
     */
    off(eventName, handler) {
        document.removeEventListener(`recordingIntegration:${eventName}`, handler);
    }
    
    /**
     * Cleanup integration
     */
    cleanup() {
        // Stop recording if active
        if (this.state.isRecording) {
            this.stopRecording();
        }
        
        // Stop coordinate monitoring
        this.stopCoordinateMonitoring();
        
        // Remove event listeners
        this.eventListeners.forEach(({ element, event, listener }) => {
            element.removeEventListener(event, listener);
        });
        this.eventListeners.clear();
        
        // Cleanup components
        if (this.actionRecorder) {
            this.actionRecorder.cleanup();
        }
        
        if (this.coordinateMapper) {
            this.coordinateMapper.reset();
        }
        
        if (this.visualFeedback) {
            this.visualFeedback.cleanup();
        }
        
        // Remove UI elements
        if (this.statusIndicator) {
            this.statusIndicator.remove();
        }
        
        this.state.isInitialized = false;
        this.state.integrationActive = false;
        
        this.emit('cleanedUp');
    }
}

module.exports = RecordingViewIntegration;
/**
 * Action Recording System - Main export module
 * Provides a unified interface for all action recording functionality
 */

const ActionRecorder = require('./action-recorder.js');
const CoordinateMapper = require('./coordinate-mapper.js');
const VisualFeedback = require('./visual-feedback.js');
const ActionSequenceEditor = require('./action-sequence-editor.js');
const RecordingViewIntegration = require('./recording-view-integration.js');
const ActionExportIntegration = require('./action-export-integration.js');

/**
 * Main Action Recording System class
 * Orchestrates all components and provides a simple API
 */
class ActionRecordingSystem {
    constructor(options = {}) {
        this.options = {
            // System settings
            enableVisualFeedback: options.enableVisualFeedback !== false,
            enableSequenceEditor: options.enableSequenceEditor !== false,
            enableAutoScreenshots: options.enableAutoScreenshots || false,
            
            // Component options
            actionRecorderOptions: options.actionRecorderOptions || {},
            coordinateMapperOptions: options.coordinateMapperOptions || {},
            visualFeedbackOptions: options.visualFeedbackOptions || {},
            editorOptions: options.editorOptions || {},
            integrationOptions: options.integrationOptions || {},
            exportOptions: options.exportOptions || {}
        };
        
        this.state = {
            isInitialized: false,
            isRecording: false,
            currentSequence: null,
            deviceInfo: null
        };
        
        // Component instances
        this.actionRecorder = null;
        this.coordinateMapper = null;
        this.visualFeedback = null;
        this.sequenceEditor = null;
        this.recordingIntegration = null;
        this.exportIntegration = null;
        
        // Event handlers
        this.eventHandlers = new Map();
    }
    
    /**
     * Initialize the complete action recording system
     */
    async initialize(screenshotEngine, deviceInfo = null, uiContainer = null) {
        try {
            this.state.deviceInfo = deviceInfo;
            
            // Initialize core components
            await this.initializeComponents(screenshotEngine, deviceInfo, uiContainer);
            
            // Setup component integrations
            this.setupComponentIntegrations();
            
            this.state.isInitialized = true;
            this.emit('systemInitialized', { deviceInfo });
            
            return true;
        } catch (error) {
            console.error('ActionRecordingSystem initialization failed:', error);
            this.emit('systemError', { error, phase: 'initialization' });
            return false;
        }
    }
    
    /**
     * Initialize all components
     */
    async initializeComponents(screenshotEngine, deviceInfo, uiContainer) {
        // Initialize action recorder
        this.actionRecorder = new ActionRecorder(this.options.actionRecorderOptions);
        
        // Initialize coordinate mapper
        this.coordinateMapper = new CoordinateMapper(this.options.coordinateMapperOptions);
        
        // Initialize visual feedback if enabled
        if (this.options.enableVisualFeedback) {
            this.visualFeedback = new VisualFeedback(this.options.visualFeedbackOptions);
            this.visualFeedback.initialize(document.body);
        }
        
        // Initialize sequence editor if enabled and container provided
        if (this.options.enableSequenceEditor && uiContainer) {
            this.sequenceEditor = new ActionSequenceEditor(this.options.editorOptions);
            
            // Create editor container
            const editorContainer = document.createElement('div');
            editorContainer.className = 'action-sequence-editor-container';
            editorContainer.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                width: 400px;
                height: 600px;
                background: white;
                border: 1px solid #ccc;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                z-index: 1000;
                display: none;
            `;
            
            document.body.appendChild(editorContainer);
            this.sequenceEditor.initialize(editorContainer);
        }
        
        // Initialize recording view integration
        this.recordingIntegration = new RecordingViewIntegration(this.options.integrationOptions);
        await this.recordingIntegration.initialize(screenshotEngine, deviceInfo);
        
        // Initialize export integration
        this.exportIntegration = new ActionExportIntegration(this.options.exportOptions);
    }
    
    /**
     * Setup integrations between components
     */
    setupComponentIntegrations() {
        // Connect recording integration events
        this.recordingIntegration.on('actionRecorded', (data) => {
            this.emit('actionRecorded', data);
        });
        
        this.recordingIntegration.on('integrationRecordingStarted', (data) => {
            this.state.isRecording = true;
            this.emit('recordingStarted', data);
        });
        
        this.recordingIntegration.on('integrationRecordingStopped', (data) => {
            this.state.isRecording = false;
            this.state.currentSequence = data.sequence;
            
            // Update sequence editor if available
            if (this.sequenceEditor) {
                const sequences = new Map();
                sequences.set(data.sequence.id, data.sequence);
                this.sequenceEditor.loadSequences(sequences);
            }
            
            this.emit('recordingStopped', data);
        });
        
        this.recordingIntegration.on('sequenceExported', (data) => {
            this.emit('sequenceExported', data);
        });
        
        // Connect sequence editor events if available
        if (this.sequenceEditor) {
            this.sequenceEditor.on('sequenceUpdated', (data) => {
                this.emit('sequenceUpdated', data);
            });
            
            this.sequenceEditor.on('sequenceExported', (data) => {
                this.emit('sequenceExported', data);
            });
        }
    }
    
    /**
     * Start recording actions
     */
    startRecording(sequenceName = null) {
        if (!this.state.isInitialized) {
            throw new Error('System not initialized');
        }
        
        if (this.state.isRecording) {
            throw new Error('Already recording');
        }
        
        return this.recordingIntegration.startRecording(sequenceName);
    }
    
    /**
     * Stop recording actions
     */
    stopRecording() {
        if (!this.state.isRecording) {
            return null;
        }
        
        return this.recordingIntegration.stopRecording();
    }
    
    /**
     * Get current recording state
     */
    getRecordingState() {
        return {
            ...this.state,
            integrationState: this.recordingIntegration?.getState(),
            editorState: this.sequenceEditor ? {
                isInitialized: this.sequenceEditor.state.isInitialized,
                currentSequence: this.sequenceEditor.state.currentSequence?.id,
                hasUnsavedChanges: this.sequenceEditor.state.hasUnsavedChanges
            } : null
        };
    }
    
    /**
     * Get all recorded sequences
     */
    getAllSequences() {
        return this.recordingIntegration?.getAllSequences() || [];
    }
    
    /**
     * Get specific sequence
     */
    getSequence(sequenceId) {
        const sequences = this.getAllSequences();
        return sequences.find(seq => seq.id === sequenceId);
    }
    
    /**
     * Export sequence with full integration
     */
    exportSequence(sequenceId, format = 'json', exportOptions = {}) {
        const sequence = this.getSequence(sequenceId);
        if (!sequence) {
            throw new Error(`Sequence not found: ${sequenceId}`);
        }
        
        // Use export integration for comprehensive export
        const exportResult = this.exportIntegration.exportForPreset(
            [sequence],
            {
                name: sequence.name,
                description: `Exported sequence: ${sequence.name}`
            },
            { ...this.options.exportOptions, ...exportOptions, exportFormat: format }
        );
        
        if (exportResult.success) {
            // Generate file content based on format
            const template = this.exportIntegration.templates.get(format);
            if (template) {
                const fileResult = template.generator(exportResult.data, exportOptions);
                
                // Trigger download in browser
                if (typeof window !== 'undefined') {
                    this.exportIntegration.exportToFile(exportResult.data, format, exportOptions);
                }
                
                return {
                    success: true,
                    exportData: exportResult.data,
                    fileContent: fileResult.content,
                    filename: fileResult.filename,
                    format: format
                };
            }
        }
        
        return exportResult;
    }
    
    /**
     * Export all sequences
     */
    exportAllSequences(format = 'json', exportOptions = {}) {
        const sequences = this.getAllSequences();
        if (sequences.length === 0) {
            throw new Error('No sequences to export');
        }
        
        return this.exportIntegration.exportForPreset(
            sequences,
            {
                name: 'All Recorded Sequences',
                description: `Export of all ${sequences.length} recorded sequences`
            },
            { ...this.options.exportOptions, ...exportOptions, exportFormat: format }
        );
    }
    
    /**
     * Show/hide sequence editor
     */
    toggleSequenceEditor(show = null) {
        if (!this.sequenceEditor) {
            console.warn('Sequence editor not initialized');
            return false;
        }
        
        const container = document.querySelector('.action-sequence-editor-container');
        if (!container) return false;
        
        const isVisible = container.style.display !== 'none';
        const shouldShow = show !== null ? show : !isVisible;
        
        container.style.display = shouldShow ? 'block' : 'none';
        
        if (shouldShow) {
            // Load current sequences
            const sequences = new Map();
            this.getAllSequences().forEach(seq => sequences.set(seq.id, seq));
            this.sequenceEditor.loadSequences(sequences);
        }
        
        this.emit('editorToggled', { visible: shouldShow });
        
        return shouldShow;
    }
    
    /**
     * Update device information
     */
    updateDeviceInfo(deviceInfo) {
        this.state.deviceInfo = deviceInfo;
        
        if (this.recordingIntegration) {
            this.recordingIntegration.updateDeviceInfo(deviceInfo);
        }
        
        this.emit('deviceInfoUpdated', { deviceInfo });
    }
    
    /**
     * Enable/disable visual feedback
     */
    setVisualFeedbackEnabled(enabled) {
        if (this.recordingIntegration) {
            this.recordingIntegration.setVisualFeedbackEnabled(enabled);
        }
        
        this.options.enableVisualFeedback = enabled;
        this.emit('visualFeedbackToggled', { enabled });
    }
    
    /**
     * Enable/disable auto screenshots
     */
    setAutoScreenshotsEnabled(enabled) {
        if (this.recordingIntegration) {
            this.recordingIntegration.setAutoScreenshotsEnabled(enabled);
        }
        
        this.options.enableAutoScreenshots = enabled;
        this.emit('autoScreenshotsToggled', { enabled });
    }
    
    /**
     * Get system statistics
     */
    getSystemStatistics() {
        const sequences = this.getAllSequences();
        const totalActions = sequences.reduce((sum, seq) => sum + (seq.actions?.length || 0), 0);
        
        return {
            isInitialized: this.state.isInitialized,
            isRecording: this.state.isRecording,
            sequenceCount: sequences.length,
            totalActions: totalActions,
            currentSequence: this.state.currentSequence?.id,
            componentStats: {
                actionRecorder: this.actionRecorder?.getState(),
                coordinateMapper: this.coordinateMapper?.getStatistics(),
                visualFeedback: this.visualFeedback?.getActiveFeedbackCount(),
                sequenceEditor: this.sequenceEditor?.getState(),
                recordingIntegration: this.recordingIntegration?.getState(),
                exportIntegration: this.exportIntegration?.getStatistics()
            }
        };
    }
    
    /**
     * Event emitter
     */
    emit(eventName, data = {}) {
        const handlers = this.eventHandlers.get(eventName) || [];
        handlers.forEach(handler => {
            try {
                handler(data);
            } catch (error) {
                console.error(`Error in event handler for ${eventName}:`, error);
            }
        });
        
        // Also emit as DOM event
        if (typeof document !== 'undefined') {
            const event = new CustomEvent(`actionRecordingSystem:${eventName}`, {
                detail: data
            });
            document.dispatchEvent(event);
        }
    }
    
    /**
     * Add event listener
     */
    on(eventName, handler) {
        if (!this.eventHandlers.has(eventName)) {
            this.eventHandlers.set(eventName, []);
        }
        this.eventHandlers.get(eventName).push(handler);
    }
    
    /**
     * Remove event listener
     */
    off(eventName, handler) {
        const handlers = this.eventHandlers.get(eventName);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index > -1) {
                handlers.splice(index, 1);
            }
        }
    }
    
    /**
     * Cleanup system
     */
    cleanup() {
        // Stop recording if active
        if (this.state.isRecording) {
            this.stopRecording();
        }
        
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
        
        if (this.sequenceEditor) {
            this.sequenceEditor.cleanup();
        }
        
        if (this.recordingIntegration) {
            this.recordingIntegration.cleanup();
        }
        
        if (this.exportIntegration) {
            this.exportIntegration.cleanup();
        }
        
        // Remove editor container
        const editorContainer = document.querySelector('.action-sequence-editor-container');
        if (editorContainer) {
            editorContainer.remove();
        }
        
        // Clear event handlers
        this.eventHandlers.clear();
        
        this.state.isInitialized = false;
        this.emit('systemCleanedUp');
    }
}

// Export all components and main system
module.exports = {
    // Main system
    ActionRecordingSystem,
    
    // Individual components
    ActionRecorder,
    CoordinateMapper,
    VisualFeedback,
    ActionSequenceEditor,
    RecordingViewIntegration,
    ActionExportIntegration,
    
    // Convenience function for quick setup
    createActionRecordingSystem: (options = {}) => new ActionRecordingSystem(options)
};
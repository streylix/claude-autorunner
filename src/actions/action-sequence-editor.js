/**
 * Action Sequence Editor - Interface for editing and managing recorded action sequences
 * Provides tools for sequence manipulation, action editing, and preview functionality
 */

class ActionSequenceEditor {
    constructor(options = {}) {
        this.options = {
            // Editor settings
            enableReordering: options.enableReordering !== false,
            enableEditing: options.enableEditing !== false,
            enablePreview: options.enablePreview !== false,
            
            // UI settings
            showTimestamps: options.showTimestamps !== false,
            showCoordinates: options.showCoordinates !== false,
            showDeviceMapping: options.showDeviceMapping || false,
            
            // Validation settings
            validateCoordinates: options.validateCoordinates !== false,
            validateTiming: options.validateTiming !== false,
            
            // Animation settings
            previewAnimationSpeed: options.previewAnimationSpeed || 1,
            highlightDuration: options.highlightDuration || 1000,
            
            // Export settings
            includeMetadata: options.includeMetadata !== false,
            prettifyJSON: options.prettifyJSON !== false
        };
        
        this.state = {
            isInitialized: false,
            currentSequence: null,
            selectedAction: null,
            isEditing: false,
            isPlaying: false,
            playbackProgress: 0,
            hasUnsavedChanges: false
        };
        
        // Editor components
        this.container = null;
        this.sequenceList = null;
        this.actionList = null;
        this.actionEditor = null;
        this.previewContainer = null;
        
        // Data storage
        this.sequences = new Map();
        this.editHistory = [];
        this.maxHistorySize = 50;
        
        // Event handlers
        this.eventHandlers = new Map();
        
        // Bind methods
        this.handleSequenceSelect = this.handleSequenceSelect.bind(this);
        this.handleActionSelect = this.handleActionSelect.bind(this);
        this.handleActionEdit = this.handleActionEdit.bind(this);
        this.handleSequenceReorder = this.handleSequenceReorder.bind(this);
        this.handlePreviewPlay = this.handlePreviewPlay.bind(this);
    }
    
    /**
     * Initialize the sequence editor
     */
    initialize(containerElement) {
        try {
            this.container = containerElement;
            this.createEditorUI();
            this.attachEventListeners();
            
            this.state.isInitialized = true;
            this.emit('initialized');
            
            return true;
        } catch (error) {
            console.error('ActionSequenceEditor initialization failed:', error);
            return false;
        }
    }
    
    /**
     * Create the editor UI
     */
    createEditorUI() {
        this.container.innerHTML = `
            <div class="action-sequence-editor">
                <div class="editor-header">
                    <h3>Action Sequence Editor</h3>
                    <div class="editor-controls">
                        <button class="btn-save" title="Save Changes">💾</button>
                        <button class="btn-undo" title="Undo">↶</button>
                        <button class="btn-redo" title="Redo">↷</button>
                        <button class="btn-preview" title="Preview Sequence">▶️</button>
                        <button class="btn-export" title="Export Sequence">📤</button>
                    </div>
                </div>
                
                <div class="editor-content">
                    <div class="sequence-panel">
                        <div class="panel-header">
                            <h4>Sequences</h4>
                            <button class="btn-new-sequence">+ New</button>
                        </div>
                        <div class="sequence-list"></div>
                    </div>
                    
                    <div class="action-panel">
                        <div class="panel-header">
                            <h4>Actions</h4>
                            <div class="action-controls">
                                <button class="btn-add-action">+ Add</button>
                                <button class="btn-delete-action">🗑️</button>
                                <button class="btn-duplicate-action">📋</button>
                            </div>
                        </div>
                        <div class="action-list"></div>
                    </div>
                    
                    <div class="property-panel">
                        <div class="panel-header">
                            <h4>Properties</h4>
                        </div>
                        <div class="action-editor"></div>
                    </div>
                </div>
                
                <div class="preview-container" style="display: none;">
                    <div class="preview-header">
                        <h4>Preview</h4>
                        <div class="preview-controls">
                            <button class="btn-play-pause">▶️</button>
                            <button class="btn-stop">⏹️</button>
                            <input type="range" class="preview-progress" min="0" max="100" value="0">
                            <select class="preview-speed">
                                <option value="0.5">0.5x</option>
                                <option value="1" selected>1x</option>
                                <option value="2">2x</option>
                                <option value="4">4x</option>
                            </select>
                        </div>
                    </div>
                    <div class="preview-display"></div>
                </div>
            </div>
        `;
        
        // Get references to UI elements
        this.sequenceList = this.container.querySelector('.sequence-list');
        this.actionList = this.container.querySelector('.action-list');
        this.actionEditor = this.container.querySelector('.action-editor');
        this.previewContainer = this.container.querySelector('.preview-container');
        
        // Inject CSS styles
        this.injectStyles();
    }
    
    /**
     * Inject CSS styles for the editor
     */
    injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .action-sequence-editor {
                display: flex;
                flex-direction: column;
                height: 100%;
                background: #f5f5f5;
                border-radius: 8px;
                overflow: hidden;
            }
            
            .editor-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                background: #fff;
                border-bottom: 1px solid #e0e0e0;
                box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            }
            
            .editor-header h3 {
                margin: 0;
                color: #333;
                font-size: 16px;
            }
            
            .editor-controls {
                display: flex;
                gap: 8px;
            }
            
            .editor-controls button {
                padding: 6px 12px;
                border: 1px solid #ddd;
                background: #fff;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                transition: all 0.2s ease;
            }
            
            .editor-controls button:hover {
                background: #f0f0f0;
                border-color: #bbb;
            }
            
            .editor-controls button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            
            .editor-content {
                display: flex;
                flex: 1;
                min-height: 0;
            }
            
            .sequence-panel,
            .action-panel,
            .property-panel {
                display: flex;
                flex-direction: column;
                background: #fff;
                border-right: 1px solid #e0e0e0;
            }
            
            .sequence-panel {
                flex: 0 0 250px;
            }
            
            .action-panel {
                flex: 0 0 300px;
            }
            
            .property-panel {
                flex: 1;
                border-right: none;
            }
            
            .panel-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                background: #fafafa;
                border-bottom: 1px solid #e0e0e0;
            }
            
            .panel-header h4 {
                margin: 0;
                color: #555;
                font-size: 14px;
                font-weight: 600;
            }
            
            .sequence-list,
            .action-list {
                flex: 1;
                overflow-y: auto;
                padding: 8px;
            }
            
            .sequence-item,
            .action-item {
                padding: 12px;
                margin-bottom: 4px;
                background: #f9f9f9;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            
            .sequence-item:hover,
            .action-item:hover {
                background: #f0f0f0;
                border-color: #ccc;
            }
            
            .sequence-item.selected,
            .action-item.selected {
                background: #e3f2fd;
                border-color: #2196f3;
                box-shadow: 0 1px 3px rgba(33, 150, 243, 0.3);
            }
            
            .sequence-item-name {
                font-weight: 600;
                color: #333;
                margin-bottom: 4px;
            }
            
            .sequence-item-info {
                font-size: 12px;
                color: #666;
            }
            
            .action-item-type {
                font-weight: 600;
                color: #333;
                text-transform: capitalize;
            }
            
            .action-item-coords {
                font-size: 12px;
                color: #666;
                font-family: monospace;
            }
            
            .action-item-time {
                font-size: 11px;
                color: #999;
            }
            
            .action-editor {
                flex: 1;
                overflow-y: auto;
                padding: 16px;
            }
            
            .property-group {
                margin-bottom: 16px;
            }
            
            .property-group h5 {
                margin: 0 0 8px 0;
                color: #555;
                font-size: 14px;
                font-weight: 600;
            }
            
            .property-field {
                margin-bottom: 8px;
            }
            
            .property-field label {
                display: block;
                margin-bottom: 4px;
                color: #666;
                font-size: 12px;
                font-weight: 500;
            }
            
            .property-field input,
            .property-field select,
            .property-field textarea {
                width: 100%;
                padding: 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
                font-size: 14px;
            }
            
            .property-field input:focus,
            .property-field select:focus,
            .property-field textarea:focus {
                outline: none;
                border-color: #2196f3;
                box-shadow: 0 0 3px rgba(33, 150, 243, 0.3);
            }
            
            .preview-container {
                background: #fff;
                border-top: 1px solid #e0e0e0;
                min-height: 200px;
            }
            
            .preview-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                background: #fafafa;
                border-bottom: 1px solid #e0e0e0;
            }
            
            .preview-controls {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .preview-progress {
                width: 200px;
            }
            
            .preview-display {
                padding: 16px;
                min-height: 150px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #666;
            }
            
            .btn-new-sequence,
            .action-controls button {
                padding: 4px 8px;
                border: 1px solid #ddd;
                background: #fff;
                border-radius: 3px;
                cursor: pointer;
                font-size: 12px;
            }
            
            .btn-new-sequence:hover,
            .action-controls button:hover {
                background: #f0f0f0;
            }
            
            .action-controls {
                display: flex;
                gap: 4px;
            }
            
            .sortable-ghost {
                opacity: 0.5;
            }
            
            .sortable-chosen {
                background: #e3f2fd !important;
            }
        `;
        
        if (!document.querySelector('#action-sequence-editor-styles')) {
            style.id = 'action-sequence-editor-styles';
            document.head.appendChild(style);
        }
    }
    
    /**
     * Attach event listeners
     */
    attachEventListeners() {
        // Sequence controls
        this.container.querySelector('.btn-new-sequence').addEventListener('click', () => {
            this.createNewSequence();
        });
        
        // Editor controls
        this.container.querySelector('.btn-save').addEventListener('click', () => {
            this.saveChanges();
        });
        
        this.container.querySelector('.btn-undo').addEventListener('click', () => {
            this.undo();
        });
        
        this.container.querySelector('.btn-redo').addEventListener('click', () => {
            this.redo();
        });
        
        this.container.querySelector('.btn-preview').addEventListener('click', () => {
            this.togglePreview();
        });
        
        this.container.querySelector('.btn-export').addEventListener('click', () => {
            this.exportSequence();
        });
        
        // Action controls
        this.container.querySelector('.btn-add-action').addEventListener('click', () => {
            this.addNewAction();
        });
        
        this.container.querySelector('.btn-delete-action').addEventListener('click', () => {
            this.deleteSelectedAction();
        });
        
        this.container.querySelector('.btn-duplicate-action').addEventListener('click', () => {
            this.duplicateSelectedAction();
        });
        
        // Preview controls
        this.container.querySelector('.btn-play-pause').addEventListener('click', () => {
            this.togglePlayback();
        });
        
        this.container.querySelector('.btn-stop').addEventListener('click', () => {
            this.stopPlayback();
        });
        
        this.container.querySelector('.preview-speed').addEventListener('change', (e) => {
            this.setPlaybackSpeed(parseFloat(e.target.value));
        });
    }
    
    /**
     * Load sequence data into editor
     */
    loadSequences(sequenceMap) {
        this.sequences = new Map(sequenceMap);
        this.refreshSequenceList();
        this.emit('sequencesLoaded', { count: this.sequences.size });
    }
    
    /**
     * Refresh sequence list display
     */
    refreshSequenceList() {
        if (!this.sequenceList) return;
        
        this.sequenceList.innerHTML = '';
        
        const sequences = Array.from(this.sequences.values())
            .sort((a, b) => b.startTime - a.startTime);
        
        sequences.forEach(sequence => {
            const item = document.createElement('div');
            item.className = 'sequence-item';
            item.dataset.sequenceId = sequence.id;
            
            const duration = sequence.duration ? `${(sequence.duration / 1000).toFixed(1)}s` : 'Unknown';
            const actionCount = sequence.actions ? sequence.actions.length : 0;
            
            item.innerHTML = `
                <div class="sequence-item-name">${sequence.name}</div>
                <div class="sequence-item-info">
                    ${actionCount} actions • ${duration}
                </div>
            `;
            
            item.addEventListener('click', () => {
                this.selectSequence(sequence.id);
            });
            
            this.sequenceList.appendChild(item);
        });
    }
    
    /**
     * Select sequence for editing
     */
    selectSequence(sequenceId) {
        const sequence = this.sequences.get(sequenceId);
        if (!sequence) return;
        
        // Update selected state
        this.sequenceList.querySelectorAll('.sequence-item').forEach(item => {
            item.classList.toggle('selected', item.dataset.sequenceId === sequenceId);
        });
        
        this.state.currentSequence = sequence;
        this.refreshActionList();
        this.clearActionEditor();
        
        this.emit('sequenceSelected', { sequence });
    }
    
    /**
     * Refresh action list display
     */
    refreshActionList() {
        if (!this.actionList || !this.state.currentSequence) return;
        
        this.actionList.innerHTML = '';
        
        const actions = this.state.currentSequence.actions || [];
        
        actions.forEach((action, index) => {
            const item = document.createElement('div');
            item.className = 'action-item';
            item.dataset.actionIndex = index;
            
            const coords = action.deviceCoordinates?.x !== undefined ?
                `(${action.deviceCoordinates.x}, ${action.deviceCoordinates.y})` :
                `(${action.uiCoordinates.clientX}, ${action.uiCoordinates.clientY})`;
            
            const time = action.relativeTime ? `+${action.relativeTime}ms` : '';
            
            item.innerHTML = `
                <div class="action-item-type">${action.type}</div>
                <div class="action-item-coords">${coords}</div>
                <div class="action-item-time">${time}</div>
            `;
            
            item.addEventListener('click', () => {
                this.selectAction(index);
            });
            
            this.actionList.appendChild(item);
        });
        
        // Enable drag-and-drop reordering if enabled
        if (this.options.enableReordering) {
            this.enableActionReordering();
        }
    }
    
    /**
     * Select action for editing
     */
    selectAction(actionIndex) {
        if (!this.state.currentSequence || !this.state.currentSequence.actions[actionIndex]) return;
        
        // Update selected state
        this.actionList.querySelectorAll('.action-item').forEach((item, index) => {
            item.classList.toggle('selected', index === actionIndex);
        });
        
        this.state.selectedAction = this.state.currentSequence.actions[actionIndex];
        this.state.selectedActionIndex = actionIndex;
        this.refreshActionEditor();
        
        this.emit('actionSelected', { action: this.state.selectedAction, index: actionIndex });
    }
    
    /**
     * Refresh action editor display
     */
    refreshActionEditor() {
        if (!this.actionEditor || !this.state.selectedAction) {
            this.clearActionEditor();
            return;
        }
        
        const action = this.state.selectedAction;
        
        this.actionEditor.innerHTML = `
            <div class="property-group">
                <h5>Basic Properties</h5>
                <div class="property-field">
                    <label>Action Type</label>
                    <select class="edit-type">
                        <option value="click" ${action.type === 'click' ? 'selected' : ''}>Click</option>
                        <option value="doubleclick" ${action.type === 'doubleclick' ? 'selected' : ''}>Double Click</option>
                        <option value="drag" ${action.type === 'drag' ? 'selected' : ''}>Drag</option>
                        <option value="swipe" ${action.type === 'swipe' ? 'selected' : ''}>Swipe</option>
                        <option value="longpress" ${action.type === 'longpress' ? 'selected' : ''}>Long Press</option>
                    </select>
                </div>
                <div class="property-field">
                    <label>Relative Time (ms)</label>
                    <input type="number" class="edit-time" value="${action.relativeTime || 0}" min="0">
                </div>
            </div>
            
            <div class="property-group">
                <h5>Coordinates</h5>
                <div class="property-field">
                    <label>UI X</label>
                    <input type="number" class="edit-ui-x" value="${action.uiCoordinates.clientX || 0}" step="0.01">
                </div>
                <div class="property-field">
                    <label>UI Y</label>
                    <input type="number" class="edit-ui-y" value="${action.uiCoordinates.clientY || 0}" step="0.01">
                </div>
                ${action.deviceCoordinates?.x !== undefined ? `
                <div class="property-field">
                    <label>Device X</label>
                    <input type="number" class="edit-device-x" value="${action.deviceCoordinates.x}" step="0.01">
                </div>
                <div class="property-field">
                    <label>Device Y</label>
                    <input type="number" class="edit-device-y" value="${action.deviceCoordinates.y}" step="0.01">
                </div>
                ` : ''}
                ${action.uiCoordinates.endX !== undefined ? `
                <div class="property-field">
                    <label>End X</label>
                    <input type="number" class="edit-end-x" value="${action.uiCoordinates.endX}" step="0.01">
                </div>
                <div class="property-field">
                    <label>End Y</label>
                    <input type="number" class="edit-end-y" value="${action.uiCoordinates.endY}" step="0.01">
                </div>
                ` : ''}
            </div>
            
            <div class="property-group">
                <h5>Metadata</h5>
                <div class="property-field">
                    <label>Duration (ms)</label>
                    <input type="number" class="edit-duration" value="${action.metadata?.duration || ''}" min="0">
                </div>
                <div class="property-field">
                    <label>Direction</label>
                    <input type="text" class="edit-direction" value="${action.metadata?.direction || ''}">
                </div>
                <div class="property-field">
                    <label>Velocity</label>
                    <input type="number" class="edit-velocity" value="${action.metadata?.velocity || ''}" step="0.01">
                </div>
            </div>
            
            <div class="property-group">
                <h5>Actions</h5>
                <button class="btn-apply-changes">Apply Changes</button>
                <button class="btn-reset-changes">Reset</button>
            </div>
        `;
        
        // Add event listeners for property changes
        this.actionEditor.querySelector('.btn-apply-changes').addEventListener('click', () => {
            this.applyActionChanges();
        });
        
        this.actionEditor.querySelector('.btn-reset-changes').addEventListener('click', () => {
            this.refreshActionEditor();
        });
    }
    
    /**
     * Clear action editor
     */
    clearActionEditor() {
        if (this.actionEditor) {
            this.actionEditor.innerHTML = '<div class="preview-display">Select an action to edit its properties</div>';
        }
    }
    
    /**
     * Apply changes to selected action
     */
    applyActionChanges() {
        if (!this.state.selectedAction || !this.state.currentSequence) return;
        
        const action = this.state.selectedAction;
        const index = this.state.selectedActionIndex;
        
        // Save current state for undo
        this.saveToHistory();
        
        // Update action properties
        action.type = this.actionEditor.querySelector('.edit-type').value;
        action.relativeTime = parseInt(this.actionEditor.querySelector('.edit-time').value) || 0;
        
        // Update coordinates
        action.uiCoordinates.clientX = parseFloat(this.actionEditor.querySelector('.edit-ui-x').value) || 0;
        action.uiCoordinates.clientY = parseFloat(this.actionEditor.querySelector('.edit-ui-y').value) || 0;
        
        const deviceXInput = this.actionEditor.querySelector('.edit-device-x');
        const deviceYInput = this.actionEditor.querySelector('.edit-device-y');
        if (deviceXInput && deviceYInput) {
            action.deviceCoordinates.x = parseFloat(deviceXInput.value) || 0;
            action.deviceCoordinates.y = parseFloat(deviceYInput.value) || 0;
        }
        
        const endXInput = this.actionEditor.querySelector('.edit-end-x');
        const endYInput = this.actionEditor.querySelector('.edit-end-y');
        if (endXInput && endYInput) {
            action.uiCoordinates.endX = parseFloat(endXInput.value) || 0;
            action.uiCoordinates.endY = parseFloat(endYInput.value) || 0;
        }
        
        // Update metadata
        const duration = this.actionEditor.querySelector('.edit-duration').value;
        const direction = this.actionEditor.querySelector('.edit-direction').value;
        const velocity = this.actionEditor.querySelector('.edit-velocity').value;
        
        if (!action.metadata) action.metadata = {};
        action.metadata.duration = duration ? parseInt(duration) : null;
        action.metadata.direction = direction || null;
        action.metadata.velocity = velocity ? parseFloat(velocity) : null;
        
        // Update the sequence
        this.state.currentSequence.actions[index] = action;
        this.state.hasUnsavedChanges = true;
        
        // Refresh displays
        this.refreshActionList();
        this.selectAction(index);
        
        this.emit('actionUpdated', { action, index });
    }
    
    /**
     * Create new sequence
     */
    createNewSequence() {
        const name = prompt('Enter sequence name:');
        if (!name) return;
        
        const sequence = {
            id: `sequence_${Date.now()}`,
            name: name,
            startTime: Date.now(),
            endTime: null,
            duration: 0,
            actions: [],
            metadata: {
                version: '1.0.0',
                createdBy: 'action-sequence-editor'
            }
        };
        
        this.sequences.set(sequence.id, sequence);
        this.refreshSequenceList();
        this.selectSequence(sequence.id);
        
        this.emit('sequenceCreated', { sequence });
    }
    
    /**
     * Add new action to current sequence
     */
    addNewAction() {
        if (!this.state.currentSequence) return;
        
        const action = {
            id: `action_${Date.now()}`,
            type: 'click',
            timestamp: Date.now(),
            relativeTime: 0,
            uiCoordinates: {
                clientX: 100,
                clientY: 100
            },
            deviceCoordinates: {
                x: 100,
                y: 100
            },
            metadata: {}
        };
        
        this.saveToHistory();
        this.state.currentSequence.actions.push(action);
        this.state.hasUnsavedChanges = true;
        
        this.refreshActionList();
        this.selectAction(this.state.currentSequence.actions.length - 1);
        
        this.emit('actionAdded', { action });
    }
    
    /**
     * Delete selected action
     */
    deleteSelectedAction() {
        if (!this.state.currentSequence || this.state.selectedActionIndex === undefined) return;
        
        if (confirm('Delete this action?')) {
            this.saveToHistory();
            
            const deletedAction = this.state.currentSequence.actions.splice(this.state.selectedActionIndex, 1)[0];
            this.state.hasUnsavedChanges = true;
            
            this.refreshActionList();
            this.clearActionEditor();
            
            this.emit('actionDeleted', { action: deletedAction });
        }
    }
    
    /**
     * Duplicate selected action
     */
    duplicateSelectedAction() {
        if (!this.state.selectedAction) return;
        
        const duplicatedAction = {
            ...JSON.parse(JSON.stringify(this.state.selectedAction)),
            id: `action_${Date.now()}`,
            relativeTime: this.state.selectedAction.relativeTime + 100
        };
        
        this.saveToHistory();
        this.state.currentSequence.actions.splice(this.state.selectedActionIndex + 1, 0, duplicatedAction);
        this.state.hasUnsavedChanges = true;
        
        this.refreshActionList();
        this.selectAction(this.state.selectedActionIndex + 1);
        
        this.emit('actionDuplicated', { action: duplicatedAction });
    }
    
    /**
     * Enable drag-and-drop reordering for actions
     */
    enableActionReordering() {
        // This would integrate with a drag-and-drop library like Sortable.js
        // For now, just emit events for external handling
        this.emit('reorderingEnabled');
    }
    
    /**
     * Toggle preview panel
     */
    togglePreview() {
        const isVisible = this.previewContainer.style.display !== 'none';
        this.previewContainer.style.display = isVisible ? 'none' : 'block';
        
        if (!isVisible && this.state.currentSequence) {
            this.preparePreview();
        }
    }
    
    /**
     * Prepare preview for current sequence
     */
    preparePreview() {
        if (!this.state.currentSequence) return;
        
        const previewDisplay = this.previewContainer.querySelector('.preview-display');
        previewDisplay.innerHTML = `
            <div>
                <h5>${this.state.currentSequence.name}</h5>
                <p>${this.state.currentSequence.actions.length} actions</p>
                <p>Duration: ${((this.state.currentSequence.duration || 0) / 1000).toFixed(1)}s</p>
            </div>
        `;
    }
    
    /**
     * Toggle playback
     */
    togglePlayback() {
        if (this.state.isPlaying) {
            this.pausePlayback();
        } else {
            this.startPlayback();
        }
    }
    
    /**
     * Start playback
     */
    startPlayback() {
        if (!this.state.currentSequence || this.state.currentSequence.actions.length === 0) return;
        
        this.state.isPlaying = true;
        this.container.querySelector('.btn-play-pause').textContent = '⏸️';
        
        this.emit('playbackStarted');
        
        // Implement playback logic here
        // This would animate through the actions with proper timing
    }
    
    /**
     * Pause playback
     */
    pausePlayback() {
        this.state.isPlaying = false;
        this.container.querySelector('.btn-play-pause').textContent = '▶️';
        
        this.emit('playbackPaused');
    }
    
    /**
     * Stop playback
     */
    stopPlayback() {
        this.state.isPlaying = false;
        this.state.playbackProgress = 0;
        this.container.querySelector('.btn-play-pause').textContent = '▶️';
        this.container.querySelector('.preview-progress').value = 0;
        
        this.emit('playbackStopped');
    }
    
    /**
     * Set playback speed
     */
    setPlaybackSpeed(speed) {
        this.options.previewAnimationSpeed = speed;
        this.emit('playbackSpeedChanged', { speed });
    }
    
    /**
     * Export current sequence
     */
    exportSequence() {
        if (!this.state.currentSequence) return;
        
        const exportData = {
            sequence: this.state.currentSequence,
            exportedAt: new Date().toISOString(),
            exportedBy: 'action-sequence-editor'
        };
        
        const jsonString = this.options.prettifyJSON ? 
            JSON.stringify(exportData, null, 2) : 
            JSON.stringify(exportData);
        
        // Create download
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.state.currentSequence.name.replace(/[^a-z0-9]/gi, '_')}.json`;
        a.click();
        
        URL.revokeObjectURL(url);
        
        this.emit('sequenceExported', { sequence: this.state.currentSequence });
    }
    
    /**
     * Save changes
     */
    saveChanges() {
        this.state.hasUnsavedChanges = false;
        this.emit('changesSaved');
    }
    
    /**
     * Save current state to history for undo/redo
     */
    saveToHistory() {
        if (!this.state.currentSequence) return;
        
        const state = JSON.parse(JSON.stringify(this.state.currentSequence));
        this.editHistory.push(state);
        
        // Limit history size
        if (this.editHistory.length > this.maxHistorySize) {
            this.editHistory.shift();
        }
    }
    
    /**
     * Undo last change
     */
    undo() {
        if (this.editHistory.length === 0) return;
        
        const previousState = this.editHistory.pop();
        this.sequences.set(previousState.id, previousState);
        this.state.currentSequence = previousState;
        
        this.refreshActionList();
        this.clearActionEditor();
        
        this.emit('undoPerformed');
    }
    
    /**
     * Redo last undone change
     */
    redo() {
        // Implement redo functionality
        this.emit('redoPerformed');
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
     * Cleanup
     */
    cleanup() {
        this.eventHandlers.clear();
        this.editHistory = [];
        this.state.currentSequence = null;
        this.state.selectedAction = null;
    }
}

// Export for both browser and Node.js environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ActionSequenceEditor;
} else if (typeof window !== 'undefined') {
    window.ActionSequenceEditor = ActionSequenceEditor;
}
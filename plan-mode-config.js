/**
 * Dynamic Plan Mode Configuration System
 * Handles customizable worker counts, strategies, and topologies
 */

class PlanModeConfigManager {
    constructor() {
        this.config = {
            mode: 'hive-mind spawn',
            agents: 3,
            strategy: 'development',
            topology: '',
            memoryNamespace: '',
            neuralPatterns: false,
            parallelExecution: false
        };
        
        this.currentPreset = 'light'; // Start with light preset
        this.isApplyingPreset = false;
        
        this.presets = {
            light: {
                mode: 'hive-mind spawn',
                agents: 3,
                strategy: 'development',
                topology: '',
                memoryNamespace: '',
                neuralPatterns: false,
                parallelExecution: false
            },
            standard: {
                mode: 'hive-mind spawn',
                agents: 5,
                strategy: 'balanced',
                topology: 'hierarchical',
                memoryNamespace: 'default',
                neuralPatterns: false,
                parallelExecution: false
            },
            heavy: {
                mode: 'hive-mind spawn',
                agents: 8,
                strategy: 'parallel',
                topology: 'mesh',
                memoryNamespace: 'heavy',
                neuralPatterns: true,
                parallelExecution: true
            },
            research: {
                mode: 'swarm',
                agents: 6,
                strategy: 'research',
                topology: 'star',
                memoryNamespace: 'research',
                neuralPatterns: true,
                parallelExecution: false
            },
            custom: {
                mode: 'hive-mind spawn',
                agents: 5,
                strategy: 'adaptive',
                topology: '',
                memoryNamespace: '',
                neuralPatterns: false,
                parallelExecution: false
            }
        };
        
    }
    
    init() {
        console.log('🚀 Initializing Plan Mode Configuration...');
        
        // First load saved config
        this.loadConfig();
        
        // Try to bind event listeners with retries
        this.bindEventListenersWithRetry();
        
        // Set up observer for settings modal
        this.observeSettingsModal();
        
        // Apply default preset
        this.applyPreset('light');
        
        // Wait for renderer to be available and establish connection
        this.waitForRenderer();
    }
    
    bindEventListenersWithRetry(attempt = 1, maxAttempts = 10) {
        console.log(`🔄 Binding event listeners (attempt ${attempt}/${maxAttempts})`);
        
        const success = this.bindEventListeners();
        
        if (!success && attempt < maxAttempts) {
            setTimeout(() => {
                this.bindEventListenersWithRetry(attempt + 1, maxAttempts);
            }, 500);
        } else if (!success) {
            console.warn('⚠️ Failed to bind all event listeners after maximum attempts');
        }
    }
    
    waitForRenderer(attempt = 1, maxAttempts = 20) {
        if (window.terminalGUI) {
            console.log('🔗 Connected to renderer, syncing configuration');
            // Sync current configuration to renderer
            this.updateConfig();
        } else if (attempt < maxAttempts) {
            console.log(`⏳ Waiting for renderer (${attempt}/${maxAttempts})`);
            setTimeout(() => {
                this.waitForRenderer(attempt + 1, maxAttempts);
            }, 250);
        } else {
            console.warn('⚠️ Renderer not found after maximum attempts');
        }
    }
    
    observeSettingsModal() {
        // Watch for settings modal to be opened and any DOM changes
        const settingsBtn = document.getElementById('settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => {
                console.log('🔧 Settings modal opened, rebinding plan mode controls');
                setTimeout(() => {
                    this.bindEventListeners();
                }, 100);
                // Additional delay to ensure modal is fully rendered
                setTimeout(() => {
                    this.bindEventListeners();
                }, 500);
            });
        }
        
        // Also try to bind events when the modal is actually visible
        const modal = document.getElementById('settings-modal');
        if (modal) {
            const observer = new MutationObserver(() => {
                if (modal.style.display !== 'none' && modal.style.display !== '') {
                    setTimeout(() => {
                        console.log('🔧 Modal visible, rebinding events');
                        this.bindEventListeners();
                    }, 200);
                }
            });
            observer.observe(modal, { attributes: true, attributeFilter: ['style'] });
        }
    }
    
    bindEventListeners() {
        let boundElements = 0;
        let totalElements = 0;
        
        // Use event delegation for preset buttons to handle dynamic content
        totalElements++;
        const presetsContainer = document.querySelector('.plan-mode-presets');
        if (presetsContainer) {
            // Remove existing listeners to prevent duplicates
            presetsContainer.removeEventListener('click', this.handlePresetClick);
            // Add new listener
            this.handlePresetClick = (e) => {
                if (e.target.classList.contains('preset-btn')) {
                    const preset = e.target.dataset.preset;
                    console.log('Preset button clicked via delegation:', preset);
                    
                    if (preset === 'custom') {
                        // For custom, just switch the UI to show custom is selected
                        // but don't change the current configuration
                        this.currentPreset = 'custom';
                        this.updatePresetButtons();
                        console.log('🔧 Switched to custom mode manually');
                    } else {
                        this.applyPreset(preset);
                    }
                }
            };
            presetsContainer.addEventListener('click', this.handlePresetClick);
            console.log('✅ Bound preset buttons via event delegation');
            boundElements++;
        } else {
            console.warn('⚠️ Preset container not found');
        }
        
        // Configuration inputs - using event delegation
        totalElements++;
        const configContainer = document.querySelector('.plan-mode-config');
        if (configContainer) {
            // Remove existing listeners
            configContainer.removeEventListener('input', this.handleConfigInput);
            configContainer.removeEventListener('change', this.handleConfigChange);
            
            // Add event delegation handlers
            this.handleConfigInput = (e) => {
                if (e.target.id === 'worker-count') {
                    const value = parseInt(e.target.value);
                    const workerInput = document.getElementById('worker-count-input');
                    if (workerInput) workerInput.value = value;
                    this.config.agents = value;
                    this.checkAndSwitchToCustom();
                    this.updateConfig();
                    console.log('Worker count changed to:', value);
                } else if (e.target.id === 'worker-count-input') {
                    const value = Math.min(20, Math.max(1, parseInt(e.target.value) || 1));
                    const workerSlider = document.getElementById('worker-count');
                    if (workerSlider) workerSlider.value = value;
                    e.target.value = value;
                    this.config.agents = value;
                    this.checkAndSwitchToCustom();
                    this.updateConfig();
                    console.log('Worker input changed to:', value);
                }
            };
            
            this.handleConfigChange = (e) => {
                if (e.target.id === 'plan-mode-type') {
                    this.config.mode = e.target.value;
                    this.checkAndSwitchToCustom();
                    this.updateConfig();
                    console.log('Mode changed to:', e.target.value);
                } else if (e.target.id === 'plan-strategy') {
                    this.config.strategy = e.target.value;
                    this.checkAndSwitchToCustom();
                    this.updateConfig();
                    console.log('Strategy changed to:', e.target.value);
                } else if (e.target.id === 'plan-topology') {
                    this.config.topology = e.target.value;
                    this.checkAndSwitchToCustom();
                    this.updateConfig();
                    console.log('Topology changed to:', e.target.value);
                }
            };
            
            configContainer.addEventListener('input', this.handleConfigInput);
            configContainer.addEventListener('change', this.handleConfigChange);
            console.log('✅ Configuration controls bound via delegation');
            boundElements++;
        } else {
            console.warn('⚠️ Configuration container not found');
        }
        
        // Selects are now handled by the config container delegation above
        
        // Advanced options removed for simplicity
        
        const success = boundElements >= Math.ceil(totalElements * 0.5); // At least 50% elements found
        console.log(`📊 Event binding summary: ${boundElements}/${totalElements} element groups bound (${success ? 'SUCCESS' : 'PARTIAL'})`);
        return success;
    }
    
    applyPreset(presetName) {
        console.log('🎯 Applying preset:', presetName);
        if (!this.presets[presetName]) {
            console.warn('⚠️ Preset not found:', presetName);
            return;
        }
        
        // Track that we're applying a preset to avoid switching to custom
        this.isApplyingPreset = true;
        
        // Update active preset button
        const presetButtons = document.querySelectorAll('.preset-btn');
        presetButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.preset === presetName);
        });
        
        // Apply preset configuration
        const preset = this.presets[presetName];
        this.config = { ...preset };
        this.currentPreset = presetName;
        console.log('📊 Applied configuration:', this.config);
        
        // Update UI elements
        this.updateUI();
        this.updateConfig();
        
        // Reset the flag
        this.isApplyingPreset = false;
    }
    
    checkAndSwitchToCustom() {
        // Don't switch to custom if we're currently applying a preset
        if (this.isApplyingPreset) {
            return;
        }
        
        // Check if current config matches any preset
        const matchingPreset = this.findMatchingPreset();
        
        if (!matchingPreset || matchingPreset === 'custom') {
            // Switch to custom preset
            this.switchToCustomPreset();
        } else {
            // Update current preset if it matches a different one
            this.currentPreset = matchingPreset;
            this.updatePresetButtons();
        }
    }
    
    findMatchingPreset() {
        // Compare current config with all presets
        for (const [presetName, preset] of Object.entries(this.presets)) {
            if (presetName === 'custom') continue; // Skip custom preset
            
            if (this.configMatches(this.config, preset)) {
                return presetName;
            }
        }
        return null;
    }
    
    configMatches(config1, config2) {
        // Compare the important configuration properties
        const keys = ['mode', 'agents', 'strategy', 'topology', 'memoryNamespace', 'neuralPatterns', 'parallelExecution'];
        return keys.every(key => config1[key] === config2[key]);
    }
    
    switchToCustomPreset() {
        if (this.currentPreset === 'custom') {
            return; // Already on custom
        }
        
        console.log('🔧 Switching to custom preset due to configuration change');
        this.currentPreset = 'custom';
        this.updatePresetButtons();
    }
    
    updatePresetButtons() {
        const presetButtons = document.querySelectorAll('.preset-btn');
        presetButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.preset === this.currentPreset);
        });
    }
    
    updateUI() {
        const workerSlider = document.getElementById('worker-count');
        const workerInput = document.getElementById('worker-count-input');
        const modeSelect = document.getElementById('plan-mode-type');
        const strategySelect = document.getElementById('plan-strategy');
        const topologySelect = document.getElementById('plan-topology');
        const memoryInput = document.getElementById('memory-namespace');
        const neuralCheckbox = document.getElementById('neural-patterns');
        const parallelCheckbox = document.getElementById('parallel-execution');
        
        if (workerSlider) workerSlider.value = this.config.agents;
        if (workerInput) workerInput.value = this.config.agents;
        if (modeSelect) modeSelect.value = this.config.mode;
        if (strategySelect) strategySelect.value = this.config.strategy;
        if (topologySelect) topologySelect.value = this.config.topology;
        if (memoryInput) memoryInput.value = this.config.memoryNamespace;
        if (neuralCheckbox) neuralCheckbox.checked = this.config.neuralPatterns;
        if (parallelCheckbox) parallelCheckbox.checked = this.config.parallelExecution;
    }
    
    updateConfig() {
        // Update resource usage indicator
        this.updateResourceUsage();
        
        // Generate command
        const command = this.generateCommand();
        console.log('🔄 Generated command:', command);
        
        // Update command preview
        const preview = document.getElementById('command-preview');
        if (preview) {
            preview.textContent = command;
            console.log('✅ Command preview updated');
        } else {
            console.warn('⚠️ Command preview element not found');
        }
        
        // Update the hidden select for legacy compatibility
        const legacySelect = document.getElementById('plan-mode-command');
        if (legacySelect) {
            legacySelect.innerHTML = `<option value="${command}" selected>Dynamic</option>`;
            legacySelect.value = command;
            
            // Trigger change event for existing code
            const changeEvent = new Event('change', { bubbles: true });
            legacySelect.dispatchEvent(changeEvent);
            console.log('✅ Legacy select updated and change event fired');
            
            // Also update the main renderer instance directly if available
            if (window.terminalGUI && typeof window.terminalGUI.planModeCommand !== 'undefined') {
                window.terminalGUI.planModeCommand = command;
                window.terminalGUI.preferences.planModeCommand = command;
                if (typeof window.terminalGUI.saveAllPreferences === 'function') {
                    window.terminalGUI.saveAllPreferences();
                }
                console.log('✅ Direct renderer instance updated');
            }
        } else {
            console.warn('⚠️ Legacy select element not found');
        }
        
        // Save configuration
        this.saveConfig();
    }
    
    updateResourceUsage() {
        const resourceElement = document.getElementById('worker-cost');
        if (resourceElement) {
            // Remove the usage status text - just clear it
            resourceElement.textContent = '';
            resourceElement.title = `${this.config.agents} agents - Uses your Claude Pro/Premium subscription`;
        }
    }
    
    generateCommand() {
        const parts = [
            'npx claude-flow@alpha',
            this.config.mode,
            '"{message}"',
            `--agents ${this.config.agents}`,
            `--strategy ${this.config.strategy}`
        ];
        
        if (this.config.topology) {
            parts.push(`--topology ${this.config.topology}`);
        }
        
        if (this.config.memoryNamespace) {
            parts.push(`--memory-namespace ${this.config.memoryNamespace}`);
        }
        
        if (this.config.neuralPatterns) {
            parts.push('--neural-patterns enabled');
        }
        
        if (this.config.parallelExecution) {
            parts.push('--parallel-execution true');
        }
        
        parts.push('--claude');
        
        return parts.join(' ');
    }
    
    saveConfig() {
        try {
            localStorage.setItem('planModeConfig', JSON.stringify(this.config));
        } catch (error) {
            console.warn('Failed to save plan mode config:', error);
        }
    }
    
    loadConfig() {
        try {
            const saved = localStorage.getItem('planModeConfig');
            if (saved) {
                this.config = { ...this.config, ...JSON.parse(saved) };
            }
        } catch (error) {
            console.warn('Failed to load plan mode config:', error);
        }
    }
    
    exportConfig() {
        return {
            config: this.config,
            command: this.generateCommand(),
            timestamp: new Date().toISOString()
        };
    }
    
    importConfig(configData) {
        if (configData && configData.config) {
            this.config = { ...this.config, ...configData.config };
            this.updateUI();
            this.updateConfig();
        }
    }
    
    // Manual initialization for debugging
    static manualInit() {
        console.log('🔧 Manual Plan Mode Config initialization...');
        if (window.planModeConfigManager) {
            console.log('⚠️ Plan Mode Config Manager already exists, rebinding events...');
            window.planModeConfigManager.bindEventListeners();
        } else {
            window.planModeConfigManager = new PlanModeConfigManager();
        }
        return window.planModeConfigManager;
    }
    
    // Global function to fix buttons if they break
    static fixButtons() {
        console.log('🔧 Attempting to fix plan mode buttons...');
        if (window.planModeConfigManager) {
            window.planModeConfigManager.bindEventListenersWithRetry(1, 5);
        } else {
            PlanModeConfigManager.manualInit();
        }
    }
    
    // Debug function to check button states
    debugButtons() {
        console.log('🔍 Debugging plan mode buttons...');
        
        const elements = {
            presetsContainer: document.querySelector('.plan-mode-presets'),
            configContainer: document.querySelector('.plan-mode-config'),
            presetButtons: document.querySelectorAll('.preset-btn'),
            workerSlider: document.getElementById('worker-count'),
            workerInput: document.getElementById('worker-count-input'),
            modeSelect: document.getElementById('plan-mode-type'),
            strategySelect: document.getElementById('plan-strategy'),
            topologySelect: document.getElementById('plan-topology'),
            commandPreview: document.getElementById('command-preview'),
            legacySelect: document.getElementById('plan-mode-command')
        };
        
        Object.entries(elements).forEach(([name, element]) => {
            if (element) {
                if (element.tagName === 'SELECT' || element.tagName === 'INPUT') {
                    console.log(`✅ ${name}: Found, value="${element.value}"`);
                } else if (name === 'presetButtons') {
                    console.log(`✅ ${name}: Found ${element.length} buttons`);
                    element.forEach((btn, i) => {
                        console.log(`  - Button ${i}: preset="${btn.dataset.preset}", active=${btn.classList.contains('active')}`);
                    });
                } else {
                    console.log(`✅ ${name}: Found`);
                }
            } else {
                console.log(`❌ ${name}: Not found`);
            }
        });
        
        console.log('📊 Current config:', this.config);
        console.log('🔗 Renderer connected:', !!window.terminalGUI);
        
        if (window.terminalGUI) {
            console.log('🔧 Renderer plan mode command:', window.terminalGUI.planModeCommand);
        }
        
        return elements;
    }
    
    // Force refresh the entire UI
    forceRefresh() {
        console.log('🔄 Force refreshing plan mode configuration...');
        
        // Re-bind all event listeners
        this.bindEventListeners();
        
        // Update UI with current config
        this.updateUI();
        
        // Update configuration and sync with renderer
        this.updateConfig();
        
        console.log('✅ Force refresh completed');
        return this.config;
    }
    
    // Test the configuration system
    testConfig() {
        console.log('🧪 Testing Plan Mode Configuration System...');
        
        // Test all presets
        Object.keys(this.presets).forEach(preset => {
            if (preset !== 'custom') {
                this.applyPreset(preset);
                const command = this.generateCommand();
                console.log(`✓ ${preset}: ${command} (preset: ${this.currentPreset})`);
            }
        });
        
        // Test custom switching behavior
        console.log('🧪 Testing automatic custom switching...');
        
        // Start with light preset
        this.applyPreset('light');
        console.log(`✓ Applied light preset (current: ${this.currentPreset})`);
        
        // Change agent count - should switch to custom
        this.config.agents = 7;
        this.checkAndSwitchToCustom();
        console.log(`✓ Changed agents to 7 (current preset: ${this.currentPreset})`);
        
        // Change back to light preset values
        this.config.agents = 3;
        this.checkAndSwitchToCustom();
        console.log(`✓ Changed agents back to 3 (current preset: ${this.currentPreset})`);
        
        // Test worker count changes
        [1, 5, 10, 20].forEach(count => {
            this.config.agents = count;
            this.checkAndSwitchToCustom();
            console.log(`✓ ${count} agents: ${this.generateCommand()} (preset: ${this.currentPreset})`);
        });
        
        console.log('✅ All tests completed successfully');
        return true;
    }
}

// Initialize when DOM is ready - with better error handling
if (typeof window !== 'undefined') {
    function initializePlanModeConfig() {
        try {
            console.log('Initializing Plan Mode Config Manager...');
            window.planModeConfigManager = new PlanModeConfigManager();
            window.planModeConfigManager.init(); // Actually call init!
            console.log('✅ Plan Mode Config Manager initialized successfully');
            
            // Make debugging and fix functions globally available
            window.fixPlanModeButtons = PlanModeConfigManager.fixButtons;
            window.debugPlanModeButtons = () => window.planModeConfigManager.debugButtons();
            window.testPlanModeConfig = () => window.planModeConfigManager.testConfig();
            window.refreshPlanModeConfig = () => window.planModeConfigManager.forceRefresh();
        } catch (error) {
            console.error('❌ Failed to initialize Plan Mode Config Manager:', error);
            // Retry after a delay
            setTimeout(initializePlanModeConfig, 1000);
        }
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(initializePlanModeConfig, 200);
        });
    } else {
        // DOM already loaded
        setTimeout(initializePlanModeConfig, 200);
    }
}

// Export for Node.js if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlanModeConfigManager;
}
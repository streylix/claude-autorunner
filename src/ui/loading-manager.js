class LoadingManager {
    constructor() {
        this.loadingModal = null;
        this.progressBar = null;
        this.progressText = null;
        this.progressSteps = null;
        this.currentStep = 0;
        this.totalSteps = 8;
        
        this.steps = [
            { id: 'preferences', text: 'Loading preferences' },
            { id: 'sessions', text: 'Loading sessions' },
            { id: 'terminal-state', text: 'Loading terminal state' },
            { id: 'backend', text: 'Connecting to backend' },
            { id: 'terminals', text: 'Initializing terminals' },
            { id: 'data-restore', text: 'Restoring data' },
            { id: 'ui-setup', text: 'Setting up interface' },
            { id: 'finalization', text: 'Finalizing' }
        ];
        
        this.initialize();
    }
    
    initialize() {
        this.loadingModal = document.getElementById('loading-modal');
        this.progressBar = document.getElementById('loading-progress-bar');
        this.progressText = document.getElementById('loading-progress-text');
        this.progressSteps = document.getElementById('loading-progress-steps');
        
        if (!this.loadingModal) {
            console.warn('Loading modal not found');
            return;
        }
        
        // Show the loading modal immediately
        this.show();
    }
    
    show() {
        if (this.loadingModal) {
            this.loadingModal.style.display = 'flex';
            this.loadingModal.classList.remove('hidden');
            
            // Initialize Lucide icons for the steps
            if (typeof lucide !== 'undefined') {
                lucide.createIcons();
            }
        }
    }
    
    hide() {
        if (this.loadingModal) {
            this.loadingModal.classList.add('hidden');
            
            // Remove the modal from DOM after animation completes
            setTimeout(() => {
                if (this.loadingModal) {
                    this.loadingModal.style.display = 'none';
                }
            }, 400);
        }
    }
    
    updateProgress(stepId, message = null) {
        const stepIndex = this.steps.findIndex(step => step.id === stepId);
        if (stepIndex === -1) {
            console.warn(`Unknown step: ${stepId}`);
            return;
        }
        
        this.currentStep = stepIndex;
        const progress = ((this.currentStep + 1) / this.totalSteps) * 100;
        
        // Update progress bar
        if (this.progressBar) {
            this.progressBar.style.width = `${progress}%`;
        }
        
        // Update progress text
        if (this.progressText) {
            this.progressText.textContent = message || this.steps[stepIndex].text;
        }
        
        // Update step states
        this.updateStepStates(stepIndex);
    }
    
    updateStepStates(currentIndex) {
        // No longer needed since we removed the step items
    }
    
    completeStep(stepId, message = null) {
        const stepIndex = this.steps.findIndex(step => step.id === stepId);
        if (stepIndex === -1) return;
        
        // Mark current step as completed
        this.updateProgress(stepId, message);
        
        // Add small delay before moving to next step for visual feedback
        setTimeout(() => {
            if (stepIndex < this.totalSteps - 1) {
                // Move to next step
                this.updateProgress(this.steps[stepIndex + 1].id);
            } else {
                // All steps completed
                this.finish();
            }
        }, 300);
    }
    
    finish() {
        // Update to 100% and show completion message
        if (this.progressBar) {
            this.progressBar.style.width = '100%';
        }
        
        if (this.progressText) {
            this.progressText.textContent = 'Loading complete!';
        }
        
        // All steps completed
        
        // Hide the modal after a brief delay
        setTimeout(() => {
            this.hide();
        }, 800);
    }
    
    // Error handling
    setError(stepId, errorMessage) {
        const stepIndex = this.steps.findIndex(step => step.id === stepId);
        if (stepIndex === -1) return;
        
        if (this.progressText) {
            this.progressText.textContent = `Error: ${errorMessage}`;
            this.progressText.style.color = 'var(--accent-error)';
        }
        
        // Show error state in progress bar
        if (this.progressBar) {
            this.progressBar.style.background = 'var(--accent-error)';
        }
    }
    
    // Utility methods for integration
    isVisible() {
        return this.loadingModal && !this.loadingModal.classList.contains('hidden');
    }
    
    getCurrentStep() {
        return this.currentStep < this.steps.length ? this.steps[this.currentStep] : null;
    }
    
    getProgress() {
        return ((this.currentStep + 1) / this.totalSteps) * 100;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LoadingManager;
} else {
    window.LoadingManager = LoadingManager;
}
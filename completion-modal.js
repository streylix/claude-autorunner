/**
 * Completion Modal Manager
 * Handles the completion details modal and status updates
 */

class CompletionModalManager {
    constructor() {
        this.modal = null;
        this.statusContainer = null;
        this.statusIcon = null;
        this.titleElement = null;
        this.init();
    }

    init() {
        this.modal = document.getElementById('completion-details-modal');
        this.statusContainer = document.querySelector('.completion-modal-status');
        this.statusIcon = document.getElementById('completion-modal-status-icon');
        this.titleElement = document.getElementById('completion-modal-title');
        
        // Set up click handlers for completion items
        this.setupCompletionItemClickHandlers();
    }

    setupCompletionItemClickHandlers() {
        // Add click handlers to existing completion items
        document.addEventListener('click', (e) => {
            const completionItem = e.target.closest('.completion-item');
            if (completionItem) {
                this.openModalForItem(completionItem);
            }
        });
    }

    openModalForItem(completionItem) {
        // Get item details
        const terminal = completionItem.querySelector('.completion-terminal').textContent;
        const prompt = completionItem.querySelector('.completion-prompt').textContent;
        const state = this.getItemState(completionItem);
        
        // Update modal content
        this.updateModalTitle(terminal);
        this.updateModalPrompt(prompt);
        this.updateModalStatus(state);
        
        // Show modal
        this.showModal();
    }

    getItemState(completionItem) {
        // Check the actual class names used in the HTML
        if (completionItem.classList.contains('failed')) {
            return 'failed';
        }
        if (completionItem.classList.contains('in-progress')) {
            return 'in-progress';
        }
        // Default to completed (first item has no explicit state class)
        return 'completed';
    }

    updateModalTitle(terminal) {
        if (this.titleElement) {
            this.titleElement.textContent = `# ${terminal}`;
        }
    }

    updateModalPrompt(prompt) {
        const promptElement = document.getElementById('completion-modal-prompt');
        if (promptElement) {
            promptElement.textContent = `> ${prompt}`;
        }
    }

    updateModalStatus(state) {
        if (!this.statusContainer || !this.statusIcon) return;

        // Clear existing classes
        this.statusContainer.classList.remove('completed', 'failed', 'in-progress');
        this.statusIcon.classList.remove('completed-icon', 'failed-icon', 'progress-icon');

        // Update based on state
        switch (state) {
            case 'completed':
                this.statusContainer.classList.add('completed');
                this.statusIcon.classList.add('completed-icon');
                this.setCompletedIcon();
                break;
            case 'failed':
                this.statusContainer.classList.add('failed');
                this.statusIcon.classList.add('failed-icon');
                this.setFailedIcon();
                break;
            case 'in-progress':
                this.statusContainer.classList.add('in-progress');
                this.statusIcon.classList.add('progress-icon');
                this.setProgressIcon();
                break;
        }
    }

    setCompletedIcon() {
        this.statusIcon.setAttribute('viewBox', '0 0 18 18');
        this.statusIcon.innerHTML = `
            <path d="M15.464 4.101a.562.562 0 0 1 0 .796l-7.875 7.875a.562.562 0 0 1-.796 0l-3.937-3.937a.562.562 0 1 1 .796-.796L7.313 11.579l7.355-7.478a.562.562 0 0 1 .796 0z"/>
        `;
    }

    setFailedIcon() {
        this.statusIcon.setAttribute('viewBox', '0 0 18 18');
        this.statusIcon.innerHTML = `
            <path d="M5.227 5.227a.562.562 0 0 1 .796 0L9 8.204l2.977-2.977a.562.562 0 0 1 .796.796L9.796 9l2.977 2.977a.562.562 0 0 1-.796.796L9 9.796l-2.977 2.977a.562.562 0 0 1-.796-.796L8.204 9 5.227 6.023a.562.562 0 0 1 0-.796z"/>
        `;
    }

    setProgressIcon() {
        this.statusIcon.setAttribute('viewBox', '0 0 18 18');
        this.statusIcon.innerHTML = `
            <circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-dasharray="18.85 6.28"></circle>
        `;
    }

    showModal() {
        if (this.modal) {
            this.modal.style.display = 'flex';
        }
    }

    hideModal() {
        if (this.modal) {
            this.modal.style.display = 'none';
        }
    }
}

// Global instance
let completionModalManager = null;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        completionModalManager = new CompletionModalManager();
    });
} else {
    completionModalManager = new CompletionModalManager();
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CompletionModalManager;
}
/**
 * Completion Timer Manager
 * Handles counting timers for in-progress completion items
 */

class CompletionTimerManager {
    constructor() {
        this.timers = new Map(); // Map of element IDs to timer data
        this.intervalId = null;
        this.init();
    }

    init() {
        // Start the main timer interval
        this.startMainInterval();
        
        // Initialize existing in-progress timers
        this.initializeExistingTimers();
    }

    startMainInterval() {
        // Update all timers every second
        this.intervalId = setInterval(() => {
            this.updateAllTimers();
        }, 1000);
    }

    initializeExistingTimers() {
        // Find all in-progress completion items and start their timers
        const inProgressItems = document.querySelectorAll('.completion-item.in-progress');
        
        inProgressItems.forEach((item, index) => {
            const timerElement = item.querySelector('.completion-timer');
            if (timerElement) {
                // Generate unique ID for this timer
                const timerId = `timer-${Date.now()}-${index}`;
                timerElement.setAttribute('data-timer-id', timerId);
                
                // Parse existing time or start from 0
                const currentTime = this.parseTimeString(timerElement.textContent) || 0;
                
                // Store timer data
                this.timers.set(timerId, {
                    element: timerElement,
                    startTime: Date.now() - (currentTime * 1000),
                    isRunning: true
                });
            }
        });
    }

    parseTimeString(timeStr) {
        // Parse "M:SS" format to seconds
        const parts = timeStr.split(':');
        if (parts.length === 2) {
            const minutes = parseInt(parts[0]) || 0;
            const seconds = parseInt(parts[1]) || 0;
            return (minutes * 60) + seconds;
        }
        return 0;
    }

    formatTime(seconds) {
        // Format seconds to "M:SS" format
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    updateAllTimers() {
        this.timers.forEach((timerData, timerId) => {
            if (timerData.isRunning && timerData.element) {
                const elapsedSeconds = Math.floor((Date.now() - timerData.startTime) / 1000);
                timerData.element.textContent = this.formatTime(elapsedSeconds);
            }
        });
    }

    startTimer(completionItem) {
        const timerElement = completionItem.querySelector('.completion-timer');
        if (!timerElement) return;

        const timerId = `timer-${Date.now()}-${Math.random()}`;
        timerElement.setAttribute('data-timer-id', timerId);

        this.timers.set(timerId, {
            element: timerElement,
            startTime: Date.now(),
            isRunning: true
        });

        // Update display immediately
        timerElement.textContent = '0:00';
    }

    stopTimer(completionItem, finalState = 'completed') {
        const timerElement = completionItem.querySelector('.completion-timer');
        if (!timerElement) return;

        const timerId = timerElement.getAttribute('data-timer-id');
        if (timerId && this.timers.has(timerId)) {
            const timerData = this.timers.get(timerId);
            timerData.isRunning = false;

            // Apply appropriate styling based on final state
            timerElement.classList.remove('completed', 'failed');
            timerElement.classList.add(finalState);
        }
    }

    // Method to add new completion item with timer
    addCompletionItem(itemElement) {
        if (itemElement.classList.contains('in-progress')) {
            this.startTimer(itemElement);
        }
    }

    // Method to update completion item state
    updateCompletionState(itemElement, newState) {
        // Remove old state classes
        itemElement.classList.remove('in-progress', 'completed', 'failed');
        
        // Add new state class
        itemElement.classList.add(newState);

        // Handle timer based on new state
        if (newState === 'in-progress') {
            this.startTimer(itemElement);
        } else {
            this.stopTimer(itemElement, newState);
        }
    }

    destroy() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.timers.clear();
    }
}

// Global instance
let completionTimerManager = null;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        completionTimerManager = new CompletionTimerManager();
    });
} else {
    completionTimerManager = new CompletionTimerManager();
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CompletionTimerManager;
}
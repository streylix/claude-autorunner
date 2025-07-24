/**
 * Microwave Mode - 5-minute repeat notification system
 * Like a microwave that beeps when food is ready and user hasn't opened the door
 */
class MicrowaveMode {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        this.repeatTimer = null;
        this.repeatCount = 0;
        this.maxRepeats = 5; // 5 minutes of beeping
        this.intervalMinutes = 1; // Beep every minute
        this.isActive = false;
        this.completionTime = null;
        
        // Track user activity to stop beeping
        this.setupActivityTrackers();
    }
    
    setupActivityTrackers() {
        // Track terminal clicks and user activity
        document.addEventListener('click', (e) => {
            // If user clicks on terminal area, stop microwave beeping
            if (e.target.closest('.terminal-container') || 
                e.target.closest('.terminal-wrapper')) {
                this.stopMicrowaveBeeping('terminal_clicked');
            }
        });
        
        // Track terminal focus
        document.addEventListener('focusin', (e) => {
            if (e.target.closest('.terminal-container')) {
                this.gui.terminalFocused = true;
                this.gui.lastUserActivity = Date.now();
                this.stopMicrowaveBeeping('terminal_focused');
            }
        });
        
        // Track new command execution
        if (this.gui.terminals) {
            this.gui.terminals.forEach((terminalData, terminalId) => {
                if (terminalData.terminal) {
                    terminalData.terminal.onData(() => {
                        this.stopMicrowaveBeeping('new_command_typed');
                    });
                }
            });
        }
    }
    
    startMicrowaveMode() {
        if (!this.gui.preferences.microwaveModeEnabled) {
            return;
        }
        
        console.log('🍽️ Microwave mode: Task completed, starting 5-minute notification cycle');
        this.gui.logAction('Microwave mode: Starting 5-minute notification cycle', 'info');
        
        this.isActive = true;
        this.repeatCount = 0;
        this.completionTime = Date.now();
        
        // Start the repeating timer (every minute for 5 minutes)
        this.repeatTimer = setInterval(() => {
            this.microwaveBeep();
        }, this.intervalMinutes * 60 * 1000); // 60 seconds = 1 minute
        
        // Initial beep after 2 seconds (like the user described)
        setTimeout(() => {
            if (this.isActive) {
                this.microwaveBeep();
            }
        }, 2000);
    }
    
    microwaveBeep() {
        if (!this.isActive || !this.gui.preferences.microwaveModeEnabled) {
            this.stopMicrowaveBeeping('disabled');
            return;
        }
        
        this.repeatCount++;
        console.log(`🍽️ Microwave beep #${this.repeatCount}/${this.maxRepeats}`);
        
        // Play the completion sound as the "microwave beep"
        this.gui.playCompletionSound();
        
        // Show system notification
        if (this.gui.preferences.showSystemNotifications) {
            this.gui.showSystemNotification(
                'Task Completed', 
                `Microwave mode: Beep ${this.repeatCount}/${this.maxRepeats} - Click terminal or run new command to stop`
            );
        }
        
        this.gui.logAction(`Microwave beep ${this.repeatCount}/${this.maxRepeats} - task completed ${Math.round((Date.now() - this.completionTime) / 1000)}s ago`, 'info');
        
        // Stop after 5 beeps (5 minutes)
        if (this.repeatCount >= this.maxRepeats) {
            this.stopMicrowaveBeeping('max_repeats_reached');
        }
    }
    
    stopMicrowaveBeeping(reason = 'manual') {
        if (!this.isActive) {
            return;
        }
        
        console.log(`🍽️ Microwave mode stopped: ${reason}`);
        this.gui.logAction(`Microwave mode stopped: ${reason} (after ${this.repeatCount} beeps)`, 'info');
        
        this.isActive = false;
        
        if (this.repeatTimer) {
            clearInterval(this.repeatTimer);
            this.repeatTimer = null;
        }
        
        this.repeatCount = 0;
        this.completionTime = null;
    }
    
    // Called when timer expires or task completes
    onTaskCompleted() {
        if (this.gui.preferences.microwaveModeEnabled) {
            // Check if user is still active or terminal is focused
            const timeSinceActivity = Date.now() - this.gui.lastUserActivity;
            const recentActivity = timeSinceActivity < 5000; // 5 seconds
            
            if (!recentActivity && !this.gui.terminalFocused) {
                this.startMicrowaveMode();
            } else {
                console.log('🍽️ Microwave mode: User is active, skipping notification cycle');
                this.gui.logAction('Microwave mode: User is active, skipping notification cycle', 'info');
            }
        }
    }
    
    // Check if another task started (to stop beeping)
    onNewTaskStarted() {
        this.stopMicrowaveBeeping('new_task_started');
    }
}

// Export for use in renderer.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MicrowaveMode;
} else {
    window.MicrowaveMode = MicrowaveMode;
}
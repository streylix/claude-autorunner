/**
 * Visual Feedback System - Provides visual indicators for recorded actions
 * Creates circles, paths, and animated indicators for user interactions
 */

class VisualFeedback {
    constructor(options = {}) {
        this.options = {
            // Animation settings
            animationDuration: options.animationDuration || 1500,
            fadeOutDuration: options.fadeOutDuration || 300,
            
            // Visual styles
            clickColor: options.clickColor || '#4CAF50',
            dragColor: options.dragColor || '#2196F3',
            longPressColor: options.longPressColor || '#FF9800',
            swipeColor: options.swipeColor || '#9C27B0',
            
            // Size settings
            clickRadius: options.clickRadius || 20,
            dragWidth: options.dragWidth || 3,
            pulseScale: options.pulseScale || 1.5,
            
            // Z-index settings
            baseZIndex: options.baseZIndex || 10000,
            
            // Container settings
            containerId: options.containerId || 'action-feedback-container',
            autoCreateContainer: options.autoCreateContainer !== false
        };
        
        this.state = {
            isInitialized: false,
            activeAnimations: new Map(),
            animationCounter: 0
        };
        
        this.container = null;
        this.style = null;
        
        // Animation cleanup timers
        this.cleanupTimers = new Map();
    }
    
    /**
     * Initialize the visual feedback system
     */
    initialize(parentElement = document.body) {
        try {
            // Create or find container
            this.container = document.getElementById(this.options.containerId);
            if (!this.container && this.options.autoCreateContainer) {
                this.container = this.createContainer(parentElement);
            }
            
            if (!this.container) {
                throw new Error('Feedback container not found and autoCreateContainer is disabled');
            }
            
            // Inject CSS styles
            this.injectStyles();
            
            this.state.isInitialized = true;
            return true;
            
        } catch (error) {
            console.error('VisualFeedback initialization failed:', error);
            return false;
        }
    }
    
    /**
     * Create feedback container
     */
    createContainer(parent) {
        const container = document.createElement('div');
        container.id = this.options.containerId;
        container.className = 'action-feedback-container';
        container.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: ${this.options.baseZIndex};
            overflow: hidden;
        `;
        
        parent.appendChild(container);
        return container;
    }
    
    /**
     * Inject CSS styles for animations
     */
    injectStyles() {
        if (this.style) return;
        
        this.style = document.createElement('style');
        this.style.textContent = `
            .action-feedback-container {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: ${this.options.baseZIndex};
                overflow: hidden;
            }
            
            .action-feedback-element {
                position: absolute;
                pointer-events: none;
                transform-origin: center;
            }
            
            .feedback-click {
                border-radius: 50%;
                border: 2px solid;
                animation: clickPulse ${this.options.animationDuration}ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
            }
            
            .feedback-drag-path {
                position: absolute;
                border-radius: 2px;
                animation: dragFade ${this.options.animationDuration}ms ease-out;
            }
            
            .feedback-drag-arrow {
                position: absolute;
                width: 0;
                height: 0;
                animation: arrowFade ${this.options.animationDuration}ms ease-out;
            }
            
            .feedback-longpress {
                border-radius: 50%;
                border: 3px solid;
                animation: longPressPulse ${this.options.animationDuration}ms ease-in-out;
            }
            
            .feedback-swipe-path {
                position: absolute;
                border-radius: 2px;
                animation: swipeFade ${this.options.animationDuration}ms ease-out;
            }
            
            @keyframes clickPulse {
                0% {
                    transform: scale(0.8);
                    opacity: 1;
                }
                50% {
                    transform: scale(${this.options.pulseScale});
                    opacity: 0.7;
                }
                100% {
                    transform: scale(1.2);
                    opacity: 0;
                }
            }
            
            @keyframes dragFade {
                0% {
                    opacity: 0.9;
                    transform: scaleY(0);
                }
                20% {
                    opacity: 0.8;
                    transform: scaleY(1);
                }
                100% {
                    opacity: 0;
                    transform: scaleY(1);
                }
            }
            
            @keyframes arrowFade {
                0% {
                    opacity: 0;
                    transform: scale(0.5);
                }
                30% {
                    opacity: 1;
                    transform: scale(1);
                }
                100% {
                    opacity: 0;
                    transform: scale(1);
                }
            }
            
            @keyframes longPressPulse {
                0%, 100% {
                    transform: scale(1);
                    opacity: 0.8;
                }
                50% {
                    transform: scale(${this.options.pulseScale});
                    opacity: 0.4;
                }
            }
            
            @keyframes swipeFade {
                0% {
                    opacity: 0.9;
                    transform: scaleX(0);
                }
                30% {
                    opacity: 0.8;
                    transform: scaleX(1);
                }
                100% {
                    opacity: 0;
                    transform: scaleX(1);
                }
            }
            
            .feedback-fade-out {
                animation: fadeOut ${this.options.fadeOutDuration}ms ease-out forwards;
            }
            
            @keyframes fadeOut {
                0% { opacity: 1; }
                100% { opacity: 0; }
            }
        `;
        
        document.head.appendChild(this.style);
    }
    
    /**
     * Show click feedback
     */
    showClickFeedback(x, y, options = {}) {
        if (!this.state.isInitialized) return null;
        
        const feedbackId = `click_${this.state.animationCounter++}`;
        const color = options.color || this.options.clickColor;
        const radius = options.radius || this.options.clickRadius;
        
        const element = document.createElement('div');
        element.className = 'action-feedback-element feedback-click';
        element.style.cssText = `
            left: ${x - radius}px;
            top: ${y - radius}px;
            width: ${radius * 2}px;
            height: ${radius * 2}px;
            border-color: ${color};
            z-index: ${this.options.baseZIndex + 1};
        `;
        
        this.container.appendChild(element);
        this.state.activeAnimations.set(feedbackId, element);
        
        // Schedule cleanup
        this.scheduleCleanup(feedbackId, element);
        
        return feedbackId;
    }
    
    /**
     * Show drag feedback
     */
    showDragFeedback(startX, startY, endX, endY, options = {}) {
        if (!this.state.isInitialized) return null;
        
        const feedbackId = `drag_${this.state.animationCounter++}`;
        const color = options.color || this.options.dragColor;
        const width = options.width || this.options.dragWidth;
        
        // Calculate drag path
        const deltaX = endX - startX;
        const deltaY = endY - startY;
        const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        const angle = Math.atan2(deltaY, deltaX) * 180 / Math.PI;
        
        // Create drag path
        const pathElement = document.createElement('div');
        pathElement.className = 'action-feedback-element feedback-drag-path';
        pathElement.style.cssText = `
            left: ${startX}px;
            top: ${startY - width / 2}px;
            width: ${length}px;
            height: ${width}px;
            background-color: ${color};
            transform: rotate(${angle}deg);
            transform-origin: left center;
            z-index: ${this.options.baseZIndex + 1};
        `;
        
        // Create arrow at the end
        const arrowElement = document.createElement('div');
        arrowElement.className = 'action-feedback-element feedback-drag-arrow';
        const arrowSize = width * 3;
        arrowElement.style.cssText = `
            left: ${endX}px;
            top: ${endY}px;
            border-left: ${arrowSize}px solid ${color};
            border-top: ${arrowSize / 2}px solid transparent;
            border-bottom: ${arrowSize / 2}px solid transparent;
            transform: translate(-${arrowSize}px, -${arrowSize / 2}px) rotate(${angle}deg);
            z-index: ${this.options.baseZIndex + 2};
        `;
        
        this.container.appendChild(pathElement);
        this.container.appendChild(arrowElement);
        
        const elements = [pathElement, arrowElement];
        this.state.activeAnimations.set(feedbackId, elements);
        
        // Schedule cleanup
        this.scheduleCleanup(feedbackId, elements);
        
        return feedbackId;
    }
    
    /**
     * Show long press feedback
     */
    showLongPressFeedback(x, y, duration, options = {}) {
        if (!this.state.isInitialized) return null;
        
        const feedbackId = `longpress_${this.state.animationCounter++}`;
        const color = options.color || this.options.longPressColor;
        const radius = options.radius || this.options.clickRadius * 1.2;
        
        const element = document.createElement('div');
        element.className = 'action-feedback-element feedback-longpress';
        element.style.cssText = `
            left: ${x - radius}px;
            top: ${y - radius}px;
            width: ${radius * 2}px;
            height: ${radius * 2}px;
            border-color: ${color};
            z-index: ${this.options.baseZIndex + 1};
        `;
        
        // Add duration indicator
        const durationText = document.createElement('div');
        durationText.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: ${color};
            font-size: 10px;
            font-weight: bold;
            font-family: monospace;
        `;
        durationText.textContent = `${duration}ms`;
        element.appendChild(durationText);
        
        this.container.appendChild(element);
        this.state.activeAnimations.set(feedbackId, element);
        
        // Schedule cleanup with longer duration for long press
        this.scheduleCleanup(feedbackId, element, this.options.animationDuration * 1.5);
        
        return feedbackId;
    }
    
    /**
     * Show swipe feedback
     */
    showSwipeFeedback(startX, startY, endX, endY, options = {}) {
        if (!this.state.isInitialized) return null;
        
        const feedbackId = `swipe_${this.state.animationCounter++}`;
        const color = options.color || this.options.swipeColor;
        const width = options.width || this.options.dragWidth * 2;
        
        // Calculate swipe path with curved effect
        const deltaX = endX - startX;
        const deltaY = endY - startY;
        const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        const angle = Math.atan2(deltaY, deltaX) * 180 / Math.PI;
        
        // Create multiple segments for curved swipe effect
        const segments = 5;
        const elements = [];
        
        for (let i = 0; i < segments; i++) {
            const progress = i / (segments - 1);
            const segmentX = startX + deltaX * progress;
            const segmentY = startY + deltaY * progress;
            const segmentLength = length / segments;
            const opacity = 0.8 - (progress * 0.4);
            
            const segmentElement = document.createElement('div');
            segmentElement.className = 'action-feedback-element feedback-swipe-path';
            segmentElement.style.cssText = `
                left: ${segmentX}px;
                top: ${segmentY - width / 2}px;
                width: ${segmentLength}px;
                height: ${width}px;
                background-color: ${color};
                opacity: ${opacity};
                transform: rotate(${angle}deg);
                transform-origin: left center;
                z-index: ${this.options.baseZIndex + 1};
                animation-delay: ${i * 50}ms;
            `;
            
            this.container.appendChild(segmentElement);
            elements.push(segmentElement);
        }
        
        // Add velocity indicator
        const velocity = options.velocity || 0;
        if (velocity > 0) {
            const velocityIndicator = document.createElement('div');
            velocityIndicator.style.cssText = `
                position: absolute;
                left: ${endX + 10}px;
                top: ${endY - 10}px;
                color: ${color};
                font-size: 12px;
                font-weight: bold;
                font-family: monospace;
                z-index: ${this.options.baseZIndex + 2};
                animation: fadeOut ${this.options.animationDuration}ms ease-out;
            `;
            velocityIndicator.textContent = `${Math.round(velocity)}px/s`;
            
            this.container.appendChild(velocityIndicator);
            elements.push(velocityIndicator);
        }
        
        this.state.activeAnimations.set(feedbackId, elements);
        
        // Schedule cleanup
        this.scheduleCleanup(feedbackId, elements);
        
        return feedbackId;
    }
    
    /**
     * Show generic action feedback based on action type
     */
    showActionFeedback(action) {
        if (!action || !this.state.isInitialized) return null;
        
        const { type, uiCoordinates } = action;
        
        switch (type) {
            case 'click':
                return this.showClickFeedback(
                    uiCoordinates.clientX,
                    uiCoordinates.clientY
                );
                
            case 'doubleclick':
                // Show double click as two quick pulses
                const firstClick = this.showClickFeedback(
                    uiCoordinates.clientX,
                    uiCoordinates.clientY,
                    { color: this.options.clickColor }
                );
                
                setTimeout(() => {
                    this.showClickFeedback(
                        uiCoordinates.clientX,
                        uiCoordinates.clientY,
                        { color: this.options.clickColor, radius: this.options.clickRadius * 0.8 }
                    );
                }, 100);
                
                return firstClick;
                
            case 'drag':
                return this.showDragFeedback(
                    uiCoordinates.clientX,
                    uiCoordinates.clientY,
                    uiCoordinates.endX,
                    uiCoordinates.endY
                );
                
            case 'swipe':
                return this.showSwipeFeedback(
                    uiCoordinates.clientX,
                    uiCoordinates.clientY,
                    uiCoordinates.endX,
                    uiCoordinates.endY,
                    { velocity: action.metadata.velocity }
                );
                
            case 'longpress':
                return this.showLongPressFeedback(
                    uiCoordinates.clientX,
                    uiCoordinates.clientY,
                    action.metadata.duration
                );
                
            default:
                // Generic click feedback for unknown types
                return this.showClickFeedback(
                    uiCoordinates.clientX,
                    uiCoordinates.clientY
                );
        }
    }
    
    /**
     * Hide specific feedback
     */
    hideFeedback(feedbackId) {
        const elements = this.state.activeAnimations.get(feedbackId);
        if (!elements) return false;
        
        const elementsArray = Array.isArray(elements) ? elements : [elements];
        
        elementsArray.forEach(element => {
            if (element && element.parentNode) {
                element.classList.add('feedback-fade-out');
            }
        });
        
        // Remove after fade out
        setTimeout(() => {
            elementsArray.forEach(element => {
                if (element && element.parentNode) {
                    element.parentNode.removeChild(element);
                }
            });
        }, this.options.fadeOutDuration);
        
        this.state.activeAnimations.delete(feedbackId);
        
        // Clear cleanup timer
        const timer = this.cleanupTimers.get(feedbackId);
        if (timer) {
            clearTimeout(timer);
            this.cleanupTimers.delete(feedbackId);
        }
        
        return true;
    }
    
    /**
     * Schedule cleanup for feedback elements
     */
    scheduleCleanup(feedbackId, elements, customDuration = null) {
        const duration = customDuration || this.options.animationDuration;
        
        const timer = setTimeout(() => {
            this.hideFeedback(feedbackId);
        }, duration);
        
        this.cleanupTimers.set(feedbackId, timer);
    }
    
    /**
     * Clear all active feedback
     */
    clearAllFeedback() {
        // Clear all timers
        this.cleanupTimers.forEach(timer => clearTimeout(timer));
        this.cleanupTimers.clear();
        
        // Remove all elements
        this.state.activeAnimations.forEach((elements, feedbackId) => {
            const elementsArray = Array.isArray(elements) ? elements : [elements];
            elementsArray.forEach(element => {
                if (element && element.parentNode) {
                    element.parentNode.removeChild(element);
                }
            });
        });
        
        this.state.activeAnimations.clear();
    }
    
    /**
     * Get active feedback count
     */
    getActiveFeedbackCount() {
        return this.state.activeAnimations.size;
    }
    
    /**
     * Update visual styles
     */
    updateStyles(newOptions) {
        this.options = { ...this.options, ...newOptions };
        
        // Recreate styles
        if (this.style) {
            this.style.remove();
            this.style = null;
        }
        
        this.injectStyles();
    }
    
    /**
     * Cleanup visual feedback system
     */
    cleanup() {
        this.clearAllFeedback();
        
        if (this.container && this.options.autoCreateContainer) {
            this.container.remove();
        }
        
        if (this.style) {
            this.style.remove();
        }
        
        this.state.isInitialized = false;
        this.container = null;
        this.style = null;
    }
}

// Export for both browser and Node.js environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VisualFeedback;
} else if (typeof window !== 'undefined') {
    window.VisualFeedback = VisualFeedback;
}
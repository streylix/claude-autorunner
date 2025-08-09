/**
 * Vanilla JS Glowing Effect for Timer Wrapper
 * Adapts the React glowing effect component for use in Electron app
 */

class GlowingEffect {
    constructor(container, options = {}) {
        this.container = container;
        this.options = {
            blur: options.blur || 0,
            spread: options.spread || 20,
            variant: options.variant || 'default',
            glow: options.glow !== undefined ? options.glow : true,
            disabled: options.disabled !== undefined ? options.disabled : false,
            movementDuration: options.movementDuration || 2,
            borderWidth: options.borderWidth || 1,
            autoRotate: options.autoRotate !== undefined ? options.autoRotate : false,
            autoRotateSpeed: options.autoRotateSpeed || 3000, // milliseconds for full rotation
            ...options
        };

        this.animationFrameRef = null;
        this.lastPosition = { x: 0, y: 0 };
        this.currentAngle = 0;
        this.autoRotateInterval = null;
        this.isActive = false;

        this.init();
    }

    init() {
        if (this.options.disabled) return;

        this.createElements();
        this.setupStyles();
        
        if (this.options.autoRotate) {
            this.startAutoRotate();
        }
    }

    createElements() {
        // Create the static border element (shown when disabled)
        this.staticBorder = document.createElement('div');
        this.staticBorder.className = 'glowing-effect-static-border';
        this.staticBorder.style.cssText = `
            pointer-events: none;
            position: absolute;
            inset: -1px;
            border-radius: inherit;
            border: 1px solid transparent;
            opacity: 0;
            transition: opacity 0.3s;
            display: ${this.options.disabled ? 'block' : 'none'};
        `;

        // Create the main glowing container
        this.glowContainer = document.createElement('div');
        this.glowContainer.className = 'glowing-effect-container';
        this.glowContainer.style.cssText = `
            pointer-events: none;
            position: absolute;
            inset: 0;
            border-radius: inherit;
            opacity: ${this.options.glow ? '1' : '0'};
            transition: opacity 0.3s;
            display: ${this.options.disabled ? 'none' : 'block'};
        `;

        // Create the glow element
        this.glowElement = document.createElement('div');
        this.glowElement.className = 'glowing-effect-glow';
        this.setupGlowStyles();

        this.glowContainer.appendChild(this.glowElement);

        // Ensure container is positioned relatively
        if (getComputedStyle(this.container).position === 'static') {
            this.container.style.position = 'relative';
        }

        this.container.appendChild(this.staticBorder);
        this.container.appendChild(this.glowContainer);
    }

    setupGlowStyles() {
        // Remove the complex spinning gradient, just use simple pulsing
        this.glowElement.style.display = 'none';
    }

    setupStyles() {
        // Set CSS custom properties
        this.container.style.setProperty('--glow-blur', `${this.options.blur}px`);
        this.container.style.setProperty('--glow-spread', this.options.spread);
        this.container.style.setProperty('--glow-start', '0');
        this.container.style.setProperty('--glow-active', '0');

        if (this.options.blur > 0) {
            this.glowContainer.style.filter = `blur(var(--glow-blur))`;
        }
    }

    startAutoRotate() {
        if (this.autoRotateInterval) {
            clearInterval(this.autoRotateInterval);
        }

        const updateRotation = () => {
            if (!this.isActive) return;
            
            const now = Date.now();
            const progress = (now % this.options.autoRotateSpeed) / this.options.autoRotateSpeed;
            const angle = progress * 360;
            
            this.setGlowAngle(angle);
            requestAnimationFrame(updateRotation);
        };

        // Start the animation loop when active
        if (this.isActive) {
            updateRotation();
        }
    }

    setGlowAngle(angle) {
        this.currentAngle = angle;
        this.container.style.setProperty('--glow-start', String(angle));
    }

    setActive(active) {
        this.isActive = active;
        // Just control the CSS pulsing animation via class
        const timingWrapper = document.querySelector('.timing-wrapper');
        if (timingWrapper) {
            if (active) {
                timingWrapper.classList.add('timer-active-glow');
            } else {
                timingWrapper.classList.remove('timer-active-glow');
            }
        }
    }

    updateOptions(newOptions) {
        this.options = { ...this.options, ...newOptions };
        
        if (newOptions.hasOwnProperty('disabled')) {
            this.staticBorder.style.display = this.options.disabled ? 'block' : 'none';
            this.glowContainer.style.display = this.options.disabled ? 'none' : 'block';
        }

        if (newOptions.hasOwnProperty('glow')) {
            this.glowContainer.style.opacity = this.options.glow ? '1' : '0';
        }

        if (newOptions.hasOwnProperty('blur')) {
            this.container.style.setProperty('--glow-blur', `${this.options.blur}px`);
            this.glowContainer.style.filter = this.options.blur > 0 ? `blur(var(--glow-blur))` : 'none';
        }

        if (newOptions.hasOwnProperty('spread')) {
            this.container.style.setProperty('--glow-spread', this.options.spread);
            this.setupGlowStyles(); // Recreate the mask with new spread
        }
    }

    destroy() {
        if (this.autoRotateInterval) {
            clearInterval(this.autoRotateInterval);
        }
        
        if (this.animationFrameRef) {
            cancelAnimationFrame(this.animationFrameRef);
        }

        if (this.staticBorder && this.staticBorder.parentNode) {
            this.staticBorder.parentNode.removeChild(this.staticBorder);
        }
        
        if (this.glowContainer && this.glowContainer.parentNode) {
            this.glowContainer.parentNode.removeChild(this.glowContainer);
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GlowingEffect;
}

// Make available globally for browser use
if (typeof window !== 'undefined') {
    window.GlowingEffect = GlowingEffect;
}
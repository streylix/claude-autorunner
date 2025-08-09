/**
 * Coordinate Mapper - UI to device coordinate conversion with precise scaling
 * Handles coordinate transformation between UI display and actual device coordinates
 */

class CoordinateMapper {
    constructor(options = {}) {
        this.options = {
            // Precision settings
            coordinatePrecision: options.coordinatePrecision || 2,
            scaleFactorPrecision: options.scaleFactorPrecision || 4,
            
            // Bounds validation
            validateBounds: options.validateBounds !== false,
            allowOutOfBounds: options.allowOutOfBounds || false,
            
            // Scaling settings
            maintainAspectRatio: options.maintainAspectRatio !== false,
            scaleMethod: options.scaleMethod || 'fit', // 'fit', 'fill', 'stretch'
            
            // Offset settings
            autoCalculateOffset: options.autoCalculateOffset !== false,
            manualOffset: options.manualOffset || { x: 0, y: 0 },
            
            // Debug settings
            debugMode: options.debugMode || false,
            logTransformations: options.logTransformations || false
        };
        
        this.state = {
            isInitialized: false,
            hasValidMapping: false,
            lastUpdateTime: null,
            transformationCount: 0,
            errors: []
        };
        
        // Coordinate system data
        this.uiDisplay = {
            width: null,
            height: null,
            offsetX: 0,
            offsetY: 0,
            element: null,
            bounds: null
        };
        
        this.deviceDisplay = {
            width: null,
            height: null,
            density: null,
            aspectRatio: null
        };
        
        this.scalingInfo = {
            scaleX: 1,
            scaleY: 1,
            uniformScale: 1,
            offsetX: 0,
            offsetY: 0,
            method: null
        };
        
        // Transformation cache
        this.transformationCache = new Map();
        this.cacheSize = 100;
    }
    
    /**
     * Initialize coordinate mapper with UI and device display information
     */
    initialize(uiElement, deviceInfo) {
        try {
            // Set up UI display information
            this.setupUIDisplay(uiElement);
            
            // Set up device display information
            this.setupDeviceDisplay(deviceInfo);
            
            // Calculate scaling factors
            this.calculateScaling();
            
            this.state.isInitialized = true;
            this.state.hasValidMapping = true;
            this.state.lastUpdateTime = Date.now();
            
            if (this.options.debugMode) {
                console.log('CoordinateMapper initialized:', {
                    ui: this.uiDisplay,
                    device: this.deviceDisplay,
                    scaling: this.scalingInfo
                });
            }
            
            return true;
        } catch (error) {
            this.state.errors.push({
                timestamp: Date.now(),
                error: error.message,
                type: 'initialization'
            });
            
            if (this.options.debugMode) {
                console.error('CoordinateMapper initialization failed:', error);
            }
            
            return false;
        }
    }
    
    /**
     * Set up UI display information from element
     */
    setupUIDisplay(element) {
        if (!element) {
            throw new Error('UI element is required for coordinate mapping');
        }
        
        const bounds = element.getBoundingClientRect();
        
        this.uiDisplay = {
            width: bounds.width,
            height: bounds.height,
            offsetX: bounds.left,
            offsetY: bounds.top,
            element: element,
            bounds: bounds
        };
        
        if (this.uiDisplay.width <= 0 || this.uiDisplay.height <= 0) {
            throw new Error('UI element has invalid dimensions');
        }
    }
    
    /**
     * Set up device display information
     */
    setupDeviceDisplay(deviceInfo) {
        if (!deviceInfo) {
            throw new Error('Device information is required for coordinate mapping');
        }
        
        this.deviceDisplay = {
            width: deviceInfo.displayWidth || deviceInfo.width || 1080,
            height: deviceInfo.displayHeight || deviceInfo.height || 1920,
            density: deviceInfo.density || deviceInfo.dpi || 420,
            aspectRatio: null
        };
        
        // Calculate aspect ratio
        this.deviceDisplay.aspectRatio = this.deviceDisplay.width / this.deviceDisplay.height;
        
        if (this.deviceDisplay.width <= 0 || this.deviceDisplay.height <= 0) {
            throw new Error('Device has invalid display dimensions');
        }
    }
    
    /**
     * Calculate scaling factors based on UI and device dimensions
     */
    calculateScaling() {
        const uiAspectRatio = this.uiDisplay.width / this.uiDisplay.height;
        const deviceAspectRatio = this.deviceDisplay.aspectRatio;
        
        let scaleX = this.deviceDisplay.width / this.uiDisplay.width;
        let scaleY = this.deviceDisplay.height / this.uiDisplay.height;
        let offsetX = 0;
        let offsetY = 0;
        let method = this.options.scaleMethod;
        
        if (this.options.maintainAspectRatio && method !== 'stretch') {
            if (method === 'fit') {
                // Scale to fit within bounds (letterbox/pillarbox)
                const uniformScale = Math.min(scaleX, scaleY);
                scaleX = uniformScale;
                scaleY = uniformScale;
                
                // Calculate centering offsets
                const scaledWidth = this.uiDisplay.width * uniformScale;
                const scaledHeight = this.uiDisplay.height * uniformScale;
                
                offsetX = (this.deviceDisplay.width - scaledWidth) / 2;
                offsetY = (this.deviceDisplay.height - scaledHeight) / 2;
                
            } else if (method === 'fill') {
                // Scale to fill bounds (crop if necessary)
                const uniformScale = Math.max(scaleX, scaleY);
                scaleX = uniformScale;
                scaleY = uniformScale;
                
                // Calculate crop offsets
                const scaledWidth = this.uiDisplay.width * uniformScale;
                const scaledHeight = this.uiDisplay.height * uniformScale;
                
                offsetX = (this.deviceDisplay.width - scaledWidth) / 2;
                offsetY = (this.deviceDisplay.height - scaledHeight) / 2;
            }
        }
        
        // Apply manual offset if provided
        if (!this.options.autoCalculateOffset) {
            offsetX = this.options.manualOffset.x;
            offsetY = this.options.manualOffset.y;
        }
        
        this.scalingInfo = {
            scaleX: parseFloat(scaleX.toFixed(this.options.scaleFactorPrecision)),
            scaleY: parseFloat(scaleY.toFixed(this.options.scaleFactorPrecision)),
            uniformScale: parseFloat(Math.min(scaleX, scaleY).toFixed(this.options.scaleFactorPrecision)),
            offsetX: parseFloat(offsetX.toFixed(this.options.coordinatePrecision)),
            offsetY: parseFloat(offsetY.toFixed(this.options.coordinatePrecision)),
            method: method
        };
        
        // Clear cache when scaling changes
        this.transformationCache.clear();
    }
    
    /**
     * Convert UI coordinates to device coordinates
     */
    uiToDevice(uiX, uiY) {
        if (!this.state.hasValidMapping) {
            throw new Error('Coordinate mapper not properly initialized');
        }
        
        // Create cache key
        const cacheKey = `ui:${uiX},${uiY}`;
        if (this.transformationCache.has(cacheKey)) {
            return this.transformationCache.get(cacheKey);
        }
        
        // Normalize UI coordinates relative to element bounds
        const relativeX = uiX - this.uiDisplay.offsetX;
        const relativeY = uiY - this.uiDisplay.offsetY;
        
        // Validate bounds if enabled
        if (this.options.validateBounds && !this.options.allowOutOfBounds) {
            if (relativeX < 0 || relativeX > this.uiDisplay.width ||
                relativeY < 0 || relativeY > this.uiDisplay.height) {
                throw new Error(`UI coordinates (${uiX}, ${uiY}) are out of bounds`);
            }
        }
        
        // Apply scaling transformation
        let deviceX = (relativeX * this.scalingInfo.scaleX) + this.scalingInfo.offsetX;
        let deviceY = (relativeY * this.scalingInfo.scaleY) + this.scalingInfo.offsetY;
        
        // Apply coordinate precision
        deviceX = parseFloat(deviceX.toFixed(this.options.coordinatePrecision));
        deviceY = parseFloat(deviceY.toFixed(this.options.coordinatePrecision));
        
        // Validate device bounds if enabled
        if (this.options.validateBounds && !this.options.allowOutOfBounds) {
            if (deviceX < 0 || deviceX > this.deviceDisplay.width ||
                deviceY < 0 || deviceY > this.deviceDisplay.height) {
                throw new Error(`Mapped device coordinates (${deviceX}, ${deviceY}) are out of bounds`);
            }
        }
        
        const result = { x: deviceX, y: deviceY };
        
        // Cache result
        this.cacheTransformation(cacheKey, result);
        
        // Log transformation if enabled
        if (this.options.logTransformations) {
            console.log(`UI→Device: (${uiX}, ${uiY}) → (${deviceX}, ${deviceY})`);
        }
        
        this.state.transformationCount++;
        
        return result;
    }
    
    /**
     * Convert device coordinates to UI coordinates
     */
    deviceToUI(deviceX, deviceY) {
        if (!this.state.hasValidMapping) {
            throw new Error('Coordinate mapper not properly initialized');
        }
        
        // Create cache key
        const cacheKey = `device:${deviceX},${deviceY}`;
        if (this.transformationCache.has(cacheKey)) {
            return this.transformationCache.get(cacheKey);
        }
        
        // Validate device bounds if enabled
        if (this.options.validateBounds && !this.options.allowOutOfBounds) {
            if (deviceX < 0 || deviceX > this.deviceDisplay.width ||
                deviceY < 0 || deviceY > this.deviceDisplay.height) {
                throw new Error(`Device coordinates (${deviceX}, ${deviceY}) are out of bounds`);
            }
        }
        
        // Apply inverse scaling transformation
        const relativeX = (deviceX - this.scalingInfo.offsetX) / this.scalingInfo.scaleX;
        const relativeY = (deviceY - this.scalingInfo.offsetY) / this.scalingInfo.scaleY;
        
        // Convert to absolute UI coordinates
        let uiX = relativeX + this.uiDisplay.offsetX;
        let uiY = relativeY + this.uiDisplay.offsetY;
        
        // Apply coordinate precision
        uiX = parseFloat(uiX.toFixed(this.options.coordinatePrecision));
        uiY = parseFloat(uiY.toFixed(this.options.coordinatePrecision));
        
        const result = { x: uiX, y: uiY };
        
        // Cache result
        this.cacheTransformation(cacheKey, result);
        
        // Log transformation if enabled
        if (this.options.logTransformations) {
            console.log(`Device→UI: (${deviceX}, ${deviceY}) → (${uiX}, ${uiY})`);
        }
        
        this.state.transformationCount++;
        
        return result;
    }
    
    /**
     * Convert UI rectangle to device rectangle
     */
    uiRectToDevice(uiRect) {
        const topLeft = this.uiToDevice(uiRect.x, uiRect.y);
        const bottomRight = this.uiToDevice(uiRect.x + uiRect.width, uiRect.y + uiRect.height);
        
        return {
            x: topLeft.x,
            y: topLeft.y,
            width: bottomRight.x - topLeft.x,
            height: bottomRight.y - topLeft.y
        };
    }
    
    /**
     * Convert device rectangle to UI rectangle
     */
    deviceRectToUI(deviceRect) {
        const topLeft = this.deviceToUI(deviceRect.x, deviceRect.y);
        const bottomRight = this.deviceToUI(deviceRect.x + deviceRect.width, deviceRect.y + deviceRect.height);
        
        return {
            x: topLeft.x,
            y: topLeft.y,
            width: bottomRight.x - topLeft.x,
            height: bottomRight.y - topLeft.y
        };
    }
    
    /**
     * Cache transformation result
     */
    cacheTransformation(key, result) {
        // Limit cache size
        if (this.transformationCache.size >= this.cacheSize) {
            const firstKey = this.transformationCache.keys().next().value;
            this.transformationCache.delete(firstKey);
        }
        
        this.transformationCache.set(key, result);
    }
    
    /**
     * Update UI element bounds (call when element is resized or moved)
     */
    updateUIBounds() {
        if (!this.uiDisplay.element) {
            throw new Error('No UI element to update bounds for');
        }
        
        const oldBounds = this.uiDisplay.bounds;
        this.setupUIDisplay(this.uiDisplay.element);
        
        // Recalculate scaling if dimensions changed
        if (oldBounds.width !== this.uiDisplay.bounds.width || 
            oldBounds.height !== this.uiDisplay.bounds.height) {
            this.calculateScaling();
        }
        
        this.state.lastUpdateTime = Date.now();
    }
    
    /**
     * Update device information
     */
    updateDeviceInfo(deviceInfo) {
        this.setupDeviceDisplay(deviceInfo);
        this.calculateScaling();
        this.state.lastUpdateTime = Date.now();
    }
    
    /**
     * Get scaling information
     */
    getScalingInfo() {
        return {
            ...this.scalingInfo,
            uiDisplay: { ...this.uiDisplay },
            deviceDisplay: { ...this.deviceDisplay },
            isValid: this.state.hasValidMapping
        };
    }
    
    /**
     * Get mapping statistics
     */
    getStatistics() {
        return {
            isInitialized: this.state.isInitialized,
            hasValidMapping: this.state.hasValidMapping,
            transformationCount: this.state.transformationCount,
            cacheSize: this.transformationCache.size,
            lastUpdateTime: this.state.lastUpdateTime,
            errorCount: this.state.errors.length
        };
    }
    
    /**
     * Validate coordinate mapping accuracy
     */
    validateMapping() {
        if (!this.state.hasValidMapping) {
            return { valid: false, error: 'Mapping not initialized' };
        }
        
        try {
            // Test round-trip transformation
            const testPoints = [
                { x: 0, y: 0 },
                { x: this.uiDisplay.width / 2, y: this.uiDisplay.height / 2 },
                { x: this.uiDisplay.width, y: this.uiDisplay.height }
            ];
            
            let maxError = 0;
            const errors = [];
            
            for (const point of testPoints) {
                const deviceCoord = this.uiToDevice(point.x + this.uiDisplay.offsetX, point.y + this.uiDisplay.offsetY);
                const backToUI = this.deviceToUI(deviceCoord.x, deviceCoord.y);
                
                const errorX = Math.abs(backToUI.x - (point.x + this.uiDisplay.offsetX));
                const errorY = Math.abs(backToUI.y - (point.y + this.uiDisplay.offsetY));
                const totalError = Math.sqrt(errorX * errorX + errorY * errorY);
                
                maxError = Math.max(maxError, totalError);
                errors.push({ point, error: totalError });
            }
            
            return {
                valid: maxError < 1.0, // Less than 1 pixel error acceptable
                maxError,
                errors,
                testPoints
            };
            
        } catch (error) {
            return {
                valid: false,
                error: error.message
            };
        }
    }
    
    /**
     * Clear transformation cache
     */
    clearCache() {
        this.transformationCache.clear();
    }
    
    /**
     * Reset coordinate mapper
     */
    reset() {
        this.state.isInitialized = false;
        this.state.hasValidMapping = false;
        this.state.transformationCount = 0;
        this.state.errors = [];
        
        this.uiDisplay = {
            width: null,
            height: null,
            offsetX: 0,
            offsetY: 0,
            element: null,
            bounds: null
        };
        
        this.deviceDisplay = {
            width: null,
            height: null,
            density: null,
            aspectRatio: null
        };
        
        this.scalingInfo = {
            scaleX: 1,
            scaleY: 1,
            uniformScale: 1,
            offsetX: 0,
            offsetY: 0,
            method: null
        };
        
        this.clearCache();
    }
}

module.exports = CoordinateMapper;
/**
 * Image Manager - Screenshot processing and display management
 * Handles image processing, thumbnails, and UI integration
 */

const path = require('path');
const fs = require('fs').promises;

class ImageManager {
    constructor(options = {}) {
        this.options = {
            // Thumbnail settings
            thumbnailSize: options.thumbnailSize || 150,
            thumbnailQuality: options.thumbnailQuality || 70,
            
            // Cache settings
            enableCache: options.enableCache !== false,
            cacheDir: options.cacheDir || path.join(__dirname, '../../cache/thumbnails'),
            maxCacheSize: options.maxCacheSize || 100, // MB
            
            // Processing settings
            supportedFormats: options.supportedFormats || ['png', 'jpg', 'jpeg', 'gif', 'webp'],
            maxImageSize: options.maxImageSize || 10 * 1024 * 1024, // 10MB
            
            // Display settings
            maxDisplayImages: options.maxDisplayImages || 10,
            imagePreviewModal: options.imagePreviewModal !== false
        };
        
        this.cache = new Map(); // filename -> cached data
        this.imageElements = new Map(); // id -> DOM element
        this.currentPreviewModal = null;
        
        this.init();
    }
    
    /**
     * Initialize image manager
     */
    async init() {
        if (this.options.enableCache) {
            await this.ensureCacheDirectory();
            await this.loadCache();
        }
        
        this.setupEventListeners();
    }
    
    /**
     * Ensure cache directory exists
     */
    async ensureCacheDirectory() {
        try {
            await fs.mkdir(this.options.cacheDir, { recursive: true });
        } catch (error) {
            console.warn('Failed to create cache directory:', error);
            this.options.enableCache = false;
        }
    }
    
    /**
     * Load existing cache data
     */
    async loadCache() {
        try {
            const cacheFile = path.join(this.options.cacheDir, 'cache.json');
            const data = await fs.readFile(cacheFile, 'utf8');
            const cacheData = JSON.parse(data);
            
            // Validate cache entries
            for (const [filename, entry] of Object.entries(cacheData)) {
                if (await this.isValidCacheEntry(entry)) {
                    this.cache.set(filename, entry);
                }
            }
        } catch (error) {
            // Cache file doesn't exist or is invalid, start fresh
            this.cache.clear();
        }
    }
    
    /**
     * Save cache data
     */
    async saveCache() {
        if (!this.options.enableCache) return;
        
        try {
            const cacheFile = path.join(this.options.cacheDir, 'cache.json');
            const cacheData = Object.fromEntries(this.cache);
            await fs.writeFile(cacheFile, JSON.stringify(cacheData, null, 2));
        } catch (error) {
            console.warn('Failed to save cache:', error);
        }
    }
    
    /**
     * Check if cache entry is still valid
     */
    async isValidCacheEntry(entry) {
        try {
            if (!entry.originalPath || !entry.thumbnailPath) return false;
            
            const [originalStat, thumbnailStat] = await Promise.all([
                fs.stat(entry.originalPath),
                fs.stat(entry.thumbnailPath)
            ]);
            
            return originalStat.mtime <= entry.timestamp && thumbnailStat.size > 0;
        } catch (error) {
            return false;
        }
    }
    
    /**
     * Process screenshot for display
     */
    async processScreenshot(screenshot) {
        try {
            // Validate image
            if (!await this.isValidImage(screenshot.filepath)) {
                throw new Error('Invalid image file');
            }
            
            // Generate thumbnail if needed
            const thumbnailPath = await this.generateThumbnail(screenshot);
            
            // Create display data
            const displayData = {
                id: screenshot.id,
                original: {
                    path: screenshot.filepath,
                    relativePath: screenshot.relativePath,
                    size: screenshot.size,
                    filename: screenshot.filename
                },
                thumbnail: {
                    path: thumbnailPath,
                    relativePath: this.getRelativePath(thumbnailPath)
                },
                metadata: {
                    timestamp: screenshot.timestamp,
                    type: screenshot.type,
                    order: screenshot.order
                }
            };
            
            return displayData;
            
        } catch (error) {
            console.error('Error processing screenshot:', error);
            return null;
        }
    }
    
    /**
     * Validate image file
     */
    async isValidImage(filepath) {
        try {
            const stats = await fs.stat(filepath);
            
            // Check file size
            if (stats.size > this.options.maxImageSize) {
                return false;
            }
            
            // Check file extension
            const ext = path.extname(filepath).toLowerCase().substring(1);
            if (!this.options.supportedFormats.includes(ext)) {
                return false;
            }
            
            // Basic file header check for PNG (screenshots are typically PNG)
            const buffer = Buffer.alloc(8);
            const fd = await fs.open(filepath, 'r');
            await fd.read(buffer, 0, 8, 0);
            await fd.close();
            
            // PNG signature: 89 50 4E 47 0D 0A 1A 0A
            const isPNG = buffer.equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
            
            return isPNG; // For now, only validate PNG since ADB screencap outputs PNG
            
        } catch (error) {
            return false;
        }
    }
    
    /**
     * Generate thumbnail for image
     */
    async generateThumbnail(screenshot) {
        const cacheKey = screenshot.filename;
        
        // Check cache first
        if (this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            if (await this.isValidCacheEntry(cached)) {
                return cached.thumbnailPath;
            }
        }
        
        try {
            // For now, we'll use the original image as thumbnail
            // In production, you'd want to use a library like Sharp or Canvas to resize
            const thumbnailPath = await this.createThumbnailCopy(screenshot);
            
            // Cache the result
            if (this.options.enableCache) {
                this.cache.set(cacheKey, {
                    originalPath: screenshot.filepath,
                    thumbnailPath: thumbnailPath,
                    timestamp: Date.now()
                });
                await this.saveCache();
            }
            
            return thumbnailPath;
            
        } catch (error) {
            console.error('Error generating thumbnail:', error);
            return screenshot.filepath; // Fallback to original
        }
    }
    
    /**
     * Create thumbnail copy (simplified - in production use proper image resizing)
     */
    async createThumbnailCopy(screenshot) {
        const thumbnailDir = path.join(this.options.cacheDir, 'thumbnails');
        await fs.mkdir(thumbnailDir, { recursive: true });
        
        const thumbnailFilename = `thumb_${screenshot.filename}`;
        const thumbnailPath = path.join(thumbnailDir, thumbnailFilename);
        
        // For now, just copy the file (in production, resize it)
        await fs.copyFile(screenshot.filepath, thumbnailPath);
        
        return thumbnailPath;
    }
    
    /**
     * Get relative path for web display
     */
    getRelativePath(absolutePath) {
        const projectRoot = path.resolve(__dirname, '../..');
        return path.relative(projectRoot, absolutePath).replace(/\\/g, '/');
    }
    
    /**
     * Create image display element
     */
    createImageElement(displayData, options = {}) {
        const container = document.createElement('div');
        container.className = 'screenshot-item';
        container.dataset.screenshotId = displayData.id;
        
        // Image number/order
        const numberElement = document.createElement('div');
        numberElement.className = 'screenshot-number';
        numberElement.textContent = (displayData.metadata.order + 1).toString();
        numberElement.contentEditable = true;
        numberElement.title = 'Click to edit order';
        
        // Thumbnail image
        const img = document.createElement('img');
        img.src = `file://${displayData.thumbnail.path}`;
        img.alt = displayData.original.filename;
        img.className = 'screenshot-thumbnail';
        img.loading = 'lazy';
        
        // Remove button
        const removeBtn = document.createElement('button');
        removeBtn.className = 'screenshot-remove';
        removeBtn.innerHTML = '×';
        removeBtn.title = 'Remove screenshot';
        removeBtn.type = 'button';
        
        // Metadata overlay
        const metadataElement = document.createElement('div');
        metadataElement.className = 'screenshot-metadata';
        metadataElement.innerHTML = `
            <span class="screenshot-type">${displayData.metadata.type}</span>
            <span class="screenshot-time">${this.formatTime(displayData.metadata.timestamp)}</span>
        `;
        
        // Event listeners
        img.addEventListener('click', () => {
            this.showImagePreview(displayData);
        });
        
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.removeImage(displayData.id);
        });
        
        numberElement.addEventListener('blur', () => {
            this.handleOrderChange(displayData.id, numberElement.textContent);
        });
        
        numberElement.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                numberElement.blur();
            } else if (e.key === 'Escape') {
                numberElement.textContent = (displayData.metadata.order + 1).toString();
                numberElement.blur();
            }
        });
        
        // Assemble element
        container.appendChild(numberElement);
        container.appendChild(img);
        container.appendChild(removeBtn);
        container.appendChild(metadataElement);
        
        // Store reference
        this.imageElements.set(displayData.id, container);
        
        return container;
    }
    
    /**
     * Show image preview modal
     */
    showImagePreview(displayData) {
        if (this.currentPreviewModal) {
            this.closeImagePreview();
        }
        
        const modal = document.createElement('div');
        modal.className = 'screenshot-preview-modal';
        
        const modalContent = document.createElement('div');
        modalContent.className = 'screenshot-preview-content';
        
        const img = document.createElement('img');
        img.src = `file://${displayData.original.path}`;
        img.alt = displayData.original.filename;
        img.className = 'screenshot-preview-image';
        
        const closeBtn = document.createElement('button');
        closeBtn.className = 'screenshot-preview-close';
        closeBtn.innerHTML = '×';
        closeBtn.title = 'Close preview';
        closeBtn.type = 'button';
        
        const metadata = document.createElement('div');
        metadata.className = 'screenshot-preview-metadata';
        metadata.innerHTML = `
            <h3>${displayData.original.filename}</h3>
            <p>Type: ${displayData.metadata.type}</p>
            <p>Size: ${this.formatFileSize(displayData.original.size)}</p>
            <p>Captured: ${new Date(displayData.metadata.timestamp).toLocaleString()}</p>
        `;
        
        // Event listeners
        const closeModal = () => this.closeImagePreview();
        
        closeBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
        
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeModal();
        });
        
        // Assemble modal
        modalContent.appendChild(closeBtn);
        modalContent.appendChild(img);
        modalContent.appendChild(metadata);
        modal.appendChild(modalContent);
        
        document.body.appendChild(modal);
        this.currentPreviewModal = modal;
        
        // Focus for keyboard events
        modal.focus();
    }
    
    /**
     * Close image preview modal
     */
    closeImagePreview() {
        if (this.currentPreviewModal) {
            this.currentPreviewModal.remove();
            this.currentPreviewModal = null;
        }
    }
    
    /**
     * Remove image from display
     */
    removeImage(imageId) {
        const element = this.imageElements.get(imageId);
        if (element) {
            element.remove();
            this.imageElements.delete(imageId);
        }
        
        // Emit remove event for parent to handle
        this.emit?.('imageRemoved', imageId);
    }
    
    /**
     * Handle order change
     */
    handleOrderChange(imageId, newOrderText) {
        const newOrder = parseInt(newOrderText) || 1;
        this.emit?.('imageOrderChanged', { imageId, newOrder });
    }
    
    /**
     * Update image display order
     */
    updateImageOrder(images) {
        images.forEach((imageData, index) => {
            const element = this.imageElements.get(imageData.id);
            if (element) {
                const numberElement = element.querySelector('.screenshot-number');
                if (numberElement) {
                    numberElement.textContent = (index + 1).toString();
                }
            }
        });
    }
    
    /**
     * Clear all images from display
     */
    clearAllImages() {
        this.imageElements.forEach(element => element.remove());
        this.imageElements.clear();
        
        if (this.currentPreviewModal) {
            this.closeImagePreview();
        }
    }
    
    /**
     * Setup global event listeners
     */
    setupEventListeners() {
        // Close modal on escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.currentPreviewModal) {
                this.closeImagePreview();
            }
        });
    }
    
    /**
     * Format timestamp for display
     */
    formatTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { 
            hour: '2-digit', 
            minute: '2-digit',
            second: '2-digit'
        });
    }
    
    /**
     * Format file size for display
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    /**
     * Clean up resources
     */
    async cleanup() {
        this.clearAllImages();
        
        if (this.options.enableCache) {
            await this.saveCache();
        }
    }
}

module.exports = ImageManager;
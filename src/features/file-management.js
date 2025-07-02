/**
 * File Management Module
 * Handles file operations, drag-and-drop, and file system interactions
 */

const { ipcMain, dialog } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

class FileManagement {
    constructor() {
        this.mainWindow = null;
        this.setupIpcHandlers();
    }

    setMainWindow(window) {
        this.mainWindow = window;
    }

    setupIpcHandlers() {
        // File selection and dialogs
        ipcMain.handle('show-directory-dialog', async (event) => {
            return await this.showDirectoryDialog();
        });

        ipcMain.handle('show-file-dialog', async (event, options = {}) => {
            return await this.showFileDialog(options);
        });

        // File operations
        ipcMain.handle('handle-file-drop', async (event, filePaths) => {
            return await this.handleFileDrop(filePaths);
        });

        ipcMain.handle('save-screenshot', async (event, imageData, filename) => {
            return await this.saveScreenshot(imageData, filename);
        });

        ipcMain.handle('get-file-info', async (event, filePath) => {
            return await this.getFileInfo(filePath);
        });

        ipcMain.handle('get-sound-effects', async (event) => {
            return await this.getSoundEffects();
        });

        // Directory operations
        ipcMain.handle('get-current-directory', async (event) => {
            return process.cwd();
        });

        ipcMain.handle('change-directory', async (event, newPath) => {
            return await this.changeDirectory(newPath);
        });

        ipcMain.handle('list-directory', async (event, dirPath) => {
            return await this.listDirectory(dirPath);
        });
    }

    async showDirectoryDialog() {
        try {
            if (!this.mainWindow) {
                throw new Error('Main window not available');
            }

            const result = await dialog.showOpenDialog(this.mainWindow, {
                properties: ['openDirectory'],
                title: 'Select Directory'
            });

            if (result.canceled || result.filePaths.length === 0) {
                return { success: false, canceled: true };
            }

            const selectedPath = result.filePaths[0];
            console.log('Directory selected:', selectedPath);

            return {
                success: true,
                path: selectedPath,
                name: path.basename(selectedPath)
            };
        } catch (error) {
            console.error('Error showing directory dialog:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async showFileDialog(options = {}) {
        try {
            if (!this.mainWindow) {
                throw new Error('Main window not available');
            }

            const dialogOptions = {
                properties: ['openFile'],
                title: options.title || 'Select File',
                filters: options.filters || [
                    { name: 'All Files', extensions: ['*'] }
                ],
                ...options
            };

            if (options.multiple) {
                dialogOptions.properties.push('multiSelections');
            }

            const result = await dialog.showOpenDialog(this.mainWindow, dialogOptions);

            if (result.canceled || result.filePaths.length === 0) {
                return { success: false, canceled: true };
            }

            return {
                success: true,
                filePaths: result.filePaths,
                files: result.filePaths.map(filePath => ({
                    path: filePath,
                    name: path.basename(filePath),
                    ext: path.extname(filePath),
                    dir: path.dirname(filePath)
                }))
            };
        } catch (error) {
            console.error('Error showing file dialog:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async handleFileDrop(filePaths) {
        try {
            if (!Array.isArray(filePaths) || filePaths.length === 0) {
                return { success: false, error: 'No files provided' };
            }

            const processedFiles = [];
            
            for (const filePath of filePaths) {
                try {
                    const stats = await fs.stat(filePath);
                    const fileInfo = {
                        path: filePath,
                        name: path.basename(filePath),
                        ext: path.extname(filePath).toLowerCase(),
                        size: stats.size,
                        isDirectory: stats.isDirectory(),
                        isFile: stats.isFile(),
                        modified: stats.mtime,
                        created: stats.birthtime
                    };

                    // Process different file types
                    if (fileInfo.isFile) {
                        // Read file content for text files
                        if (this.isTextFile(fileInfo.ext)) {
                            try {
                                fileInfo.content = await fs.readFile(filePath, 'utf8');
                                fileInfo.contentType = 'text';
                            } catch (error) {
                                console.warn('Failed to read text file:', filePath, error.message);
                                fileInfo.contentType = 'binary';
                            }
                        } else if (this.isImageFile(fileInfo.ext)) {
                            fileInfo.contentType = 'image';
                        } else if (this.isAudioFile(fileInfo.ext)) {
                            fileInfo.contentType = 'audio';
                        } else {
                            fileInfo.contentType = 'binary';
                        }
                    } else {
                        fileInfo.contentType = 'directory';
                    }

                    processedFiles.push(fileInfo);
                } catch (error) {
                    console.error('Error processing file:', filePath, error);
                    processedFiles.push({
                        path: filePath,
                        name: path.basename(filePath),
                        error: error.message
                    });
                }
            }

            console.log('Processed file drop:', processedFiles.length, 'files');
            return {
                success: true,
                files: processedFiles
            };
        } catch (error) {
            console.error('Error handling file drop:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async saveScreenshot(imageData, filename = null) {
        try {
            // Generate filename if not provided
            if (!filename) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                filename = `screenshot_${timestamp}.png`;
            }

            // Default to Desktop directory
            const desktopPath = path.join(os.homedir(), 'Desktop');
            const fullPath = path.join(desktopPath, filename);

            // Convert base64 to buffer if needed
            let imageBuffer;
            if (typeof imageData === 'string') {
                // Remove data URL prefix if present
                const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
                imageBuffer = Buffer.from(base64Data, 'base64');
            } else {
                imageBuffer = imageData;
            }

            await fs.writeFile(fullPath, imageBuffer);
            
            console.log('Screenshot saved:', fullPath);
            return {
                success: true,
                path: fullPath,
                filename: filename
            };
        } catch (error) {
            console.error('Error saving screenshot:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async getFileInfo(filePath) {
        try {
            const stats = await fs.stat(filePath);
            const fileInfo = {
                path: filePath,
                name: path.basename(filePath),
                ext: path.extname(filePath),
                size: stats.size,
                isDirectory: stats.isDirectory(),
                isFile: stats.isFile(),
                modified: stats.mtime,
                created: stats.birthtime,
                accessible: true
            };

            return {
                success: true,
                fileInfo: fileInfo
            };
        } catch (error) {
            console.error('Error getting file info:', filePath, error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async getSoundEffects() {
        try {
            const soundEffectsDir = path.join(__dirname, '..', '..', 'soundeffects');
            
            try {
                await fs.access(soundEffectsDir);
            } catch {
                return {
                    success: false,
                    error: 'Sound effects directory not found'
                };
            }

            const files = await fs.readdir(soundEffectsDir);
            const soundFiles = files.filter(file => {
                const ext = path.extname(file).toLowerCase();
                return ['.wav', '.mp3', '.ogg', '.aac'].includes(ext);
            });

            const soundEffects = soundFiles.map(file => ({
                name: file,
                path: path.join(soundEffectsDir, file),
                displayName: path.basename(file, path.extname(file))
            }));

            return {
                success: true,
                soundEffects: soundEffects
            };
        } catch (error) {
            console.error('Error getting sound effects:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async changeDirectory(newPath) {
        try {
            // Validate the path
            const stats = await fs.stat(newPath);
            if (!stats.isDirectory()) {
                throw new Error('Path is not a directory');
            }

            process.chdir(newPath);
            const currentDir = process.cwd();
            
            console.log('Changed directory to:', currentDir);
            return {
                success: true,
                path: currentDir
            };
        } catch (error) {
            console.error('Error changing directory:', error);
            return {
                success: false,
                error: error.message,
                currentPath: process.cwd()
            };
        }
    }

    async listDirectory(dirPath = null) {
        try {
            const targetPath = dirPath || process.cwd();
            const files = await fs.readdir(targetPath, { withFileTypes: true });
            
            const items = await Promise.all(files.map(async (dirent) => {
                const fullPath = path.join(targetPath, dirent.name);
                
                try {
                    const stats = await fs.stat(fullPath);
                    return {
                        name: dirent.name,
                        path: fullPath,
                        isDirectory: dirent.isDirectory(),
                        isFile: dirent.isFile(),
                        size: stats.size,
                        modified: stats.mtime,
                        ext: path.extname(dirent.name)
                    };
                } catch (error) {
                    return {
                        name: dirent.name,
                        path: fullPath,
                        isDirectory: dirent.isDirectory(),
                        isFile: dirent.isFile(),
                        error: error.message
                    };
                }
            }));

            return {
                success: true,
                path: targetPath,
                items: items
            };
        } catch (error) {
            console.error('Error listing directory:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Helper methods for file type detection
    isTextFile(ext) {
        const textExtensions = ['.txt', '.md', '.js', '.json', '.css', '.html', '.xml', '.csv', '.log', '.py', '.java', '.c', '.cpp', '.h', '.hpp'];
        return textExtensions.includes(ext);
    }

    isImageFile(ext) {
        const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico'];
        return imageExtensions.includes(ext);
    }

    isAudioFile(ext) {
        const audioExtensions = ['.wav', '.mp3', '.ogg', '.aac', '.flac', '.m4a'];
        return audioExtensions.includes(ext);
    }

    isVideoFile(ext) {
        const videoExtensions = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv'];
        return videoExtensions.includes(ext);
    }

    // Copy file to clipboard (if needed)
    async copyFileToClipboard(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            return {
                success: true,
                content: content,
                filename: path.basename(filePath)
            };
        } catch (error) {
            console.error('Error copying file to clipboard:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Cleanup method
    destroy() {
        // Clean up any file watchers or temporary files if needed
        console.log('File management module destroyed');
    }
}

module.exports = { FileManagement };
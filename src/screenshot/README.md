# Screenshot Engine System

A comprehensive real-time screenshot capture and management system for Android device recording via ADB.

## Features

### 🔴 Live Screenshot Capture
- **Real-time device screen capture** via ADB screencap
- **Optimized capture intervals** (configurable, default 2 seconds)
- **Async processing** to avoid UI blocking
- **Device resolution detection** and handling

### 📸 On-Demand Screenshots  
- **Single-click capture** with instant feedback
- **Manual screenshot button** in Device Recording section
- **Sound effects** integration with existing audio system
- **Immediate thumbnail generation** and display

### 🤖 Auto-Screenshot After Actions
- **Setting checkbox**: "Auto-screenshot after action"
- **Terminal action detection** - hooks into terminal input events
- **Debounced capture** - waits 500ms after action to capture stable state
- **Smart timing** - avoids capturing during rapid input sequences

### 🎯 Screenshot Management
- **Thumbnail list view** with numbered ordering
- **Drag and drop reordering** - change screenshot sequence
- **Individual delete** with confirmation
- **Clear all** with bulk confirmation
- **Export screenshots** with preset metadata

### 🚀 Performance Optimization
- **Memory management** - automatic cleanup of old screenshots
- **Image caching** - efficient thumbnail generation
- **Background processing** - non-blocking capture operations
- **Resource cleanup** - proper disposal on app exit

## Architecture

### Core Components

1. **ScreenshotEngine** (`screenshot-engine.js`)
   - ADB interface and device communication
   - Screenshot capture scheduling and management
   - Event-driven architecture with EventEmitter
   - Performance optimization and error handling

2. **ImageManager** (`image-manager.js`)
   - Image processing and thumbnail generation
   - Caching and storage management
   - UI element creation and preview modals
   - Drag-and-drop reordering logic

3. **ScreenshotUIController** (`screenshot-ui-controller.js`)
   - User interface management and integration
   - Event handling and user interaction
   - Integration with existing terminal system
   - Auto-screenshot hooks and terminal action detection

### Integration Points

- **Main Process**: IPC handlers in `main.js` for screenshot operations
- **Renderer Process**: UI initialization in `renderer.js`
- **HTML Structure**: Device Recording section in right sidebar
- **CSS Styles**: Complete styling for all screenshot UI components
- **Terminal Hooks**: Automatic screenshot triggers on terminal actions

## Usage

### Prerequisites

1. **Android Debug Bridge (ADB)** must be installed and available in PATH
2. **Android device** connected via USB with USB debugging enabled
3. **Device authorization** - accept debugging authorization on device

### Basic Operation

1. **Connect Device**: Plugin Android device, enable USB debugging
2. **Initialize System**: App automatically detects connected devices
3. **Manual Capture**: Click camera icon in Device Recording section
4. **Live Capture**: Click "Start Live Capture" for continuous screenshots
5. **Auto Capture**: Enable "Auto-screenshot after action" checkbox

### Advanced Features

#### Screenshot Management
- **Reorder**: Drag screenshot items to change sequence
- **Preview**: Click thumbnail to view full-size image
- **Delete**: Click × button on hover to remove individual screenshots
- **Export**: Click download icon to export all screenshots with metadata

#### Auto-Screenshot Configuration
- **Enable**: Check "Auto-screenshot after action" in Device Recording
- **Action Detection**: Automatically captures after terminal input
- **Debouncing**: 500ms delay after action to ensure stable capture
- **Terminal Integration**: Works with all terminal instances

#### Performance Settings
- **Capture Interval**: Configurable (default 2000ms for live mode)
- **Max Screenshots**: Auto-cleanup after 20 screenshots (configurable)
- **Memory Management**: Automatic thumbnail caching and cleanup
- **Error Recovery**: Retry logic for failed captures

## API Reference

### IPC Handlers (Main Process)

```javascript
// Initialize screenshot engine
await ipcRenderer.invoke('screenshot-init', options);

// Capture single screenshot
await ipcRenderer.invoke('screenshot-capture', 'manual');

// Start/stop continuous capture
await ipcRenderer.invoke('screenshot-start-capture');
await ipcRenderer.invoke('screenshot-stop-capture');

// Enable/disable auto-screenshot
await ipcRenderer.invoke('screenshot-enable-auto', terminalId);
await ipcRenderer.invoke('screenshot-disable-auto');

// Screenshot management
await ipcRenderer.invoke('screenshot-get-all');
await ipcRenderer.invoke('screenshot-delete', screenshotId);
await ipcRenderer.invoke('screenshot-reorder', newOrder);
await ipcRenderer.invoke('screenshot-export', options);
```

### Events (Renderer Process)

```javascript
// Screenshot captured
ipcRenderer.on('screenshot-captured', (screenshot) => {
    // Handle new screenshot
});

// Device status changes
ipcRenderer.on('screenshot-device-connected', (device) => {
    // Handle device connection
});

// Capture state changes
ipcRenderer.on('screenshot-capture-started', () => {
    // Live capture started
});

ipcRenderer.on('screenshot-capture-stopped', () => {
    // Live capture stopped
});

// Error handling
ipcRenderer.on('screenshot-error', (errorMessage) => {
    // Handle screenshot errors
});
```

### Configuration Options

```javascript
const options = {
    // Capture settings
    captureInterval: 2000,           // ms between live captures
    maxConcurrentCaptures: 3,        // max simultaneous captures
    compressionQuality: 80,          // image quality 1-100
    
    // Storage settings
    outputDir: './imported-files',   // screenshot storage directory
    maxStoredScreenshots: 20,        // max screenshots before cleanup
    autoCleanup: true,              // enable automatic cleanup
    
    // Performance settings
    debounceTime: 500,              // ms to wait after terminal action
    maxRetries: 3,                  // capture retry attempts
    
    // Auto-screenshot settings
    autoScreenshotEnabled: false,    // enable auto-capture
    actionDetectionTimeout: 2000     // ms timeout for action detection
};
```

## UI Components

### Device Recording Section
- **Location**: Right sidebar, above Message Queue
- **Device Status**: Online/offline indicator with device ID
- **Manual Capture**: Camera icon button for single screenshots
- **Live Capture**: Toggle button for continuous capture mode
- **Auto Capture**: Checkbox for action-triggered screenshots

### Screenshot List
- **Thumbnail Display**: 40x40px thumbnails with numbering
- **Drag-and-Drop**: Reorder screenshots by dragging items
- **Context Actions**: Delete button (×) appears on hover
- **Preview Modal**: Click thumbnail for full-size view
- **Export Action**: Download button for bulk export

### Status Indicators
- **Device Connection**: Green dot = connected, Red dot = disconnected
- **Capture State**: Active button highlighting during live capture
- **Screenshot Count**: Dynamic count display "(5)" next to "Screenshots"
- **Empty State**: Helpful text when no screenshots exist

## File Structure

```
src/screenshot/
├── screenshot-engine.js      # Core ADB capture engine
├── image-manager.js         # Image processing and UI management  
├── screenshot-ui-controller.js # UI integration and event handling
└── README.md               # This documentation

Integration files:
├── main.js                 # IPC handlers (lines 1273-1519)
├── renderer.js            # UI initialization (lines 11970-11978)
├── index.html             # Script inclusion (line 861)
└── style.css              # UI styles (lines 4416-4753)
```

## Troubleshooting

### Common Issues

1. **"ADB not found"**
   - Install Android SDK or platform-tools
   - Add ADB to system PATH
   - Restart application

2. **"No device connected"**
   - Enable USB debugging on Android device
   - Accept debugging authorization popup
   - Check USB cable and connection

3. **"Screenshot capture failed"**
   - Device may be locked or screen off
   - Check device permissions
   - Restart ADB with `adb kill-server && adb start-server`

4. **Performance issues**
   - Reduce capture interval in live mode
   - Enable auto-cleanup to manage memory
   - Close other resource-intensive applications

### Debug Information

- **Console Logs**: Check browser dev tools for detailed error messages
- **Action Log**: Screenshot events appear in application Action Log
- **Engine State**: Use `screenshot-get-state` IPC call for internal state
- **Memory Usage**: Monitor screenshot count and cleanup frequency

## Development

### Extending the System

1. **Custom Image Processing**: Extend `ImageManager` class
2. **Additional Capture Sources**: Implement new capture methods in `ScreenshotEngine`
3. **UI Customization**: Modify `ScreenshotUIController` and CSS styles
4. **Export Formats**: Add new export options in engine export methods

### Testing

1. **Manual Testing**: Connect Android device and test all features
2. **Error Scenarios**: Test with device disconnection, ADB failures
3. **Performance**: Test with extended capture sessions
4. **Memory**: Monitor memory usage during long sessions

The screenshot system provides a complete solution for Android device recording with real-time capture, intelligent automation, and comprehensive management features.
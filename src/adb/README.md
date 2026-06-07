# ADB Integration System

A comprehensive Android Debug Bridge (ADB) integration system for Electron applications, providing device discovery, connection management, and screenshot capture functionality.

## Overview

The ADB integration system consists of several components that work together to provide seamless Android device interaction:

- **ADBManager**: Core ADB functionality and command execution
- **DeviceManager**: High-level device state management and coordination
- **IPC Integration**: Electron main process handlers for renderer communication
- **Demo UI**: Complete demonstration interface
- **Integration Examples**: Simple integration patterns for existing applications

## Features

### ✅ Core Functionality
- **Cross-platform ADB detection** (Windows, macOS, Linux)
- **Automatic device discovery** and connection monitoring
- **Real-time device status tracking** (connected/disconnected/unauthorized)
- **Screenshot capture** with optimization and caching
- **Error handling and recovery** mechanisms
- **Performance metrics** and monitoring

### ✅ Device Management
- **Multiple device support** with device selection UI
- **Auto-reconnection** on device loss
- **Device authorization status** monitoring
- **Display information** retrieval (resolution, density)
- **Connection testing** and validation

### ✅ Screenshot Features
- **High-performance screenshot capture** via `adb shell screencap -p`
- **Intelligent caching** to prevent redundant captures
- **Real-time screenshot streaming** for live monitoring
- **Base64 encoding** for web display
- **Size and performance optimization**

### ✅ Integration Ready
- **IPC handlers** for Electron renderer communication
- **Event-driven architecture** with real-time updates
- **Memory management** and resource cleanup
- **Coordination hooks** for ScreenshotEngine integration
- **Modular design** for easy integration

## Installation & Setup

### Prerequisites

1. **Android SDK Platform Tools** must be installed with ADB in PATH, or in standard locations:
   - **Windows**: `C:\Program Files\Android\platform-tools\`, `C:\Android\platform-tools\`
   - **macOS**: `~/Library/Android/sdk/platform-tools/`, `/usr/local/bin/`, `/opt/homebrew/bin/`
   - **Linux**: `~/Android/Sdk/platform-tools/`, `/usr/bin/`, `/usr/local/bin/`

2. **USB Debugging** enabled on Android devices

3. **Device authorization** (accept USB debugging prompt on device)

### Basic Integration

```javascript
// Initialize ADB system
const { ipcRenderer } = require('electron');

// Initialize ADB
const result = await ipcRenderer.invoke('adb-initialize');
if (result.success) {
    console.log('ADB initialized with', result.devices.length, 'devices');
}

// Get devices
const devices = await ipcRenderer.invoke('adb-get-devices');

// Select device
await ipcRenderer.invoke('adb-select-device', 'device_id_here');

// Take screenshot
const screenshot = await ipcRenderer.invoke('adb-take-screenshot');
if (screenshot.success) {
    // Display screenshot using dataUrl
    document.getElementById('screenshot').src = screenshot.screenshot.dataUrl;
}
```

### Using the Integration Example

```javascript
const ADBIntegrationExample = require('./src/adb/adb-integration-example');

// Create integration instance
const adbIntegration = new ADBIntegrationExample();

// Initialize
await adbIntegration.initializeADB();

// Create device selector UI
const container = document.getElementById('device-container');
adbIntegration.createDeviceSelector(container);

// Take screenshot
const result = await adbIntegration.takeScreenshot();
if (result.success) {
    console.log('Screenshot captured:', result.screenshot);
}

// Coordinate with ScreenshotEngine
adbIntegration.setScreenshotCallback((screenshot) => {
    // Handle screenshot data
    screenshotEngine.processADBScreenshot(screenshot);
});
```

## API Reference

### IPC Handlers (Main Process)

#### `adb-initialize`
Initialize the ADB system and device manager.

**Returns:**
```javascript
{
    success: boolean,
    status: object,    // ADB system status
    devices: array     // Available devices with state
}
```

#### `adb-get-status`
Get current ADB system status.

**Returns:**
```javascript
{
    success: boolean,
    status: {
        initialized: boolean,
        adbPath: string,
        selectedDevice: string,
        deviceCount: number,
        connectedDeviceCount: number,
        metrics: object,
        monitoring: boolean
    },
    devices: array
}
```

#### `adb-get-devices`
Refresh and get all available devices.

**Returns:**
```javascript
{
    success: boolean,
    devices: [
        {
            device: {
                id: string,
                status: string,    // 'device', 'unauthorized', 'offline'
                model: string,
                product: string,
                transport_id: string
            },
            state: {
                firstSeen: timestamp,
                lastScreenshot: timestamp,
                screenshotCount: number,
                isSelected: boolean
            },
            isSelected: boolean,
            isConnected: boolean
        }
    ]
}
```

#### `adb-select-device`
Select a device for operations.

**Parameters:**
- `deviceId` (string): Device ID to select

**Returns:**
```javascript
{
    success: boolean,
    selectedDevice: string,
    deviceInfo: object
}
```

#### `adb-take-screenshot`
Capture screenshot from selected device.

**Parameters:**
```javascript
{
    deviceId?: string,    // Optional device ID (uses selected if not provided)
    timeout?: number,     // Timeout in milliseconds (default: 10000)
    useCache?: boolean    // Use cached screenshot if available (default: true)
}
```

**Returns:**
```javascript
{
    success: boolean,
    screenshot: {
        data: string,        // Base64 encoded PNG data
        dataUrl: string,     // Data URL for direct use in img tags
        size: number,        // Size in bytes
        format: string,      // 'png'
        deviceId: string,
        duration: number,    // Capture time in milliseconds
        deviceInfo: object
    }
}
```

#### `adb-get-display-info`
Get device display information.

**Parameters:**
- `deviceId` (string, optional): Device ID (uses selected if not provided)

**Returns:**
```javascript
{
    success: boolean,
    displayInfo: {
        width: number,
        height: number,
        density: number,
        aspectRatio: string,
        deviceId: string
    }
}
```

#### `adb-test-connection`
Test connection to device.

**Parameters:**
- `deviceId` (string, optional): Device ID (uses selected if not provided)

**Returns:**
```javascript
{
    success: boolean,
    connectionTest: {
        success: boolean,
        deviceId: string,
        responseTime: number,
        output?: string,
        error?: string
    }
}
```

#### `adb-get-metrics`
Get performance metrics.

**Returns:**
```javascript
{
    success: boolean,
    metrics: {
        screenshotsCount: number,
        screenshotErrors: number,
        averageScreenshotTime: number,
        deviceCount: number,
        connectedDevices: number,
        selectedDevice: string,
        cacheSize: number,
        uptime: number
    }
}
```

### IPC Events (Renderer Process)

#### `adb-device-connected`
Fired when a device connects.

**Data:**
```javascript
{
    device: object,      // Device information
    state: object,       // Device state
    isSelected: boolean  // Whether this device was auto-selected
}
```

#### `adb-device-disconnected`
Fired when a device disconnects.

**Data:**
```javascript
{
    device: object,      // Device information
    state: object,       // Device state
    wasSelected: boolean // Whether this device was previously selected
}
```

#### `adb-device-selected`
Fired when a device is selected.

**Data:**
```javascript
{
    device: object,  // Device information
    state: object    // Device state
}
```

#### `adb-screenshot-ready`
Fired when a screenshot is captured.

**Data:**
```javascript
{
    deviceId: string,
    data: Buffer,        // Screenshot binary data
    size: number,
    timestamp: number,
    deviceInfo: object
}
```

#### `adb-not-found`
Fired when ADB binary is not found.

**Data:**
```javascript
{
    searchedPaths: array,  // Paths that were searched
    platform: string       // Operating system platform
}
```

## Architecture

### Component Overview

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Renderer      │    │   Main Process   │    │   ADB System    │
│   Process       │    │                  │    │                 │
├─────────────────┤    ├──────────────────┤    ├─────────────────┤
│ ADBDemo         │◄──►│ IPC Handlers     │◄──►│ DeviceManager   │
│ Integration     │    │                  │    │                 │
│ Example         │    │ Event Forwarding │    │ ADBManager      │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │ Android Device  │
                                                │ (via ADB)       │
                                                └─────────────────┘
```

### Data Flow

1. **Initialization**: DeviceManager initializes ADBManager and detects ADB binary
2. **Device Discovery**: ADB devices command executed, devices parsed and tracked
3. **Monitoring**: Periodic device list refresh for connection changes
4. **Screenshot Capture**: `adb shell screencap -p` executed, data cached and returned
5. **Event Propagation**: Device events forwarded to renderer via IPC
6. **Cleanup**: All processes and resources cleaned up on app quit

### Memory Management

- **Bounded collections** prevent memory leaks from device tracking
- **Screenshot caching** with automatic cleanup and TTL
- **Command process tracking** and cleanup on shutdown
- **Event listener cleanup** in all components

## Integration with ScreenshotEngine

The ADB integration is designed to coordinate with the ScreenshotEngine agent:

```javascript
// Coordinate ADB screenshots with ScreenshotEngine
const adbIntegration = new ADBIntegrationExample();
await adbIntegration.initializeADB();

// Set up coordination
adbIntegration.setScreenshotCallback((screenshot) => {
    // Forward to ScreenshotEngine
    screenshotEngine.processExternalScreenshot({
        source: 'adb',
        data: screenshot.data,
        deviceInfo: screenshot.deviceInfo,
        timestamp: screenshot.timestamp
    });
});

// Use ADB for mobile screenshot capture
const adbScreenshot = await adbIntegration.captureForScreenshotEngine();
screenshotEngine.addScreenshot(adbScreenshot);
```

## Error Handling

The system includes comprehensive error handling:

- **ADB binary not found**: Graceful fallback with helpful error messages
- **Device connection failures**: Automatic retry and reconnection
- **Screenshot timeouts**: Configurable timeouts with fallback options
- **Command execution errors**: Proper cleanup and error propagation
- **Permission issues**: Clear error messages for USB debugging setup

## Performance Optimization

- **Screenshot caching**: Prevents redundant captures
- **Command pooling**: Efficient ADB command execution
- **Event batching**: Reduces IPC overhead
- **Memory monitoring**: Bounded collections and cleanup
- **Async operations**: Non-blocking UI interactions

## Testing

### Manual Testing
1. Connect Android device with USB debugging enabled
2. Run the demo: Load `adb-demo.js` in renderer
3. Click "Initialize ADB" to start system
4. Select device from list
5. Test screenshot capture and live monitoring

### Integration Testing
```javascript
// Test basic functionality
const adb = new ADBIntegrationExample();
const result = await adb.initializeADB();
console.assert(result.success, 'ADB should initialize');

const status = await adb.getStatus();
console.assert(status.success, 'Should get status');

// Test with device connected
if (status.devices.length > 0) {
    const deviceId = status.devices[0].device.id;
    await adb.selectDevice(deviceId);
    
    const screenshot = await adb.takeScreenshot();
    console.assert(screenshot.success, 'Should capture screenshot');
}
```

## Troubleshooting

### Common Issues

1. **"ADB not found"**
   - Install Android SDK Platform Tools
   - Add ADB to system PATH
   - Check file permissions

2. **"Device unauthorized"**
   - Enable USB debugging on device
   - Accept USB debugging authorization dialog
   - Check USB cable connection

3. **"Screenshot timeout"**
   - Check device is unlocked
   - Verify device is responsive
   - Increase timeout value

4. **"No devices found"**
   - Check USB connection
   - Try different USB cable/port
   - Restart ADB: `adb kill-server && adb start-server`

### Debug Mode

Enable debug logging by setting environment variable:
```bash
DEBUG=adb:* npm start
```

This provides detailed logging of all ADB operations and device interactions.

## Future Enhancements

- **Multi-device screenshot comparison**
- **Device screen recording** via `adb shell screenrecord`
- **Touch input simulation** for automated testing
- **File transfer** capabilities
- **Logcat integration** for debugging
- **Wireless ADB** support
- **Custom ADB commands** interface

## License

This ADB integration system is part of the Auto-Injector project and follows the same MIT license terms.
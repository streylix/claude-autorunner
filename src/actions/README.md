# Action Recording System

A comprehensive system for recording, managing, and exporting device interaction sequences with precise coordinate tracking and visual feedback.

## 🎯 Features

- **Precise Coordinate Tracking**: Accurate mapping between UI and device coordinates with configurable scaling
- **Visual Feedback**: Real-time visual indicators for recorded actions (clicks, drags, swipes)
- **Sequence Management**: Record, edit, and organize action sequences with timing data
- **Export Integration**: Export sequences as JSON, Python scripts, or YAML for automation
- **Auto-Screenshot Integration**: Automatic screenshot capture after actions for documentation
- **Recording View Integration**: Seamless integration with device recording interfaces

## 📦 Components

### Core Components

#### `ActionRecorder`
Records user interactions with precise coordinate mapping and timing data.

```javascript
const recorder = new ActionRecorder({
    enableCoordinateTracking: true,
    enableVisualFeedback: true,
    autoScreenshotAfterAction: true
});

await recorder.initialize(coordinateMapper, deviceInfo);
const sequenceId = recorder.startRecording('My Sequence');
// User interactions are automatically recorded
const sequence = recorder.stopRecording();
```

#### `CoordinateMapper`
Handles precise coordinate transformation between UI display and device coordinates.

```javascript
const mapper = new CoordinateMapper({
    coordinatePrecision: 2,
    scaleMethod: 'fit',
    maintainAspectRatio: true
});

mapper.initialize(uiElement, deviceInfo);
const deviceCoords = mapper.uiToDevice(clientX, clientY);
const uiCoords = mapper.deviceToUI(deviceX, deviceY);
```

#### `VisualFeedback`
Provides animated visual feedback for recorded actions.

```javascript
const feedback = new VisualFeedback({
    animationDuration: 1500,
    clickColor: '#4CAF50',
    dragColor: '#2196F3'
});

feedback.initialize(document.body);
const feedbackId = feedback.showClickFeedback(x, y);
```

### Integration Components

#### `RecordingViewIntegration`
Integrates action recording with device recording interfaces.

```javascript
const integration = new RecordingViewIntegration({
    enableActionRecording: true,
    enableVisualFeedback: true,
    enableAutoScreenshots: true
});

await integration.initialize(screenshotEngine, deviceInfo);
// Automatically handles UI integration and event management
```

#### `ActionSequenceEditor`
Provides a graphical interface for editing recorded sequences.

```javascript
const editor = new ActionSequenceEditor({
    enableReordering: true,
    enableEditing: true,
    enablePreview: true
});

editor.initialize(containerElement);
editor.loadSequences(sequenceMap);
```

#### `ActionExportIntegration`
Exports action sequences in various formats for automation.

```javascript
const exporter = new ActionExportIntegration({
    exportFormat: 'python',
    includeCoordinateMapping: true,
    includeDeviceInfo: true
});

const result = exporter.exportForPreset(sequences, presetData);
```

### Main System

#### `ActionRecordingSystem`
Orchestrates all components and provides a unified API.

```javascript
const system = new ActionRecordingSystem({
    enableVisualFeedback: true,
    enableSequenceEditor: true,
    enableAutoScreenshots: true
});

await system.initialize(screenshotEngine, deviceInfo, uiContainer);

// Start recording
system.startRecording('My Automation Sequence');
// User interactions are recorded with visual feedback
const sequence = system.stopRecording();

// Export sequence
const exportResult = system.exportSequence(sequence.id, 'python');
```

## 🚀 Quick Start

### Basic Usage

```javascript
const { ActionRecordingSystem } = require('./src/actions');

// Initialize the system
const system = new ActionRecordingSystem();
await system.initialize(screenshotEngine, deviceInfo);

// Start recording actions
system.startRecording('Login Sequence');

// Actions are automatically recorded as user interacts with the device display
// - Clicks show animated circles
// - Drags show animated paths with arrows
// - Long presses show pulsing indicators

// Stop recording and get the sequence
const sequence = system.stopRecording();

// Export as Python automation script
system.exportSequence(sequence.id, 'python');
```

### Advanced Configuration

```javascript
const system = new ActionRecordingSystem({
    // Action recorder options
    actionRecorderOptions: {
        coordinatePrecision: 2,
        enableVisualFeedback: true,
        autoScreenshotAfterAction: true,
        screenshotDelay: 500
    },
    
    // Coordinate mapper options
    coordinateMapperOptions: {
        scaleMethod: 'fit',
        maintainAspectRatio: true,
        validateBounds: true
    },
    
    // Visual feedback options
    visualFeedbackOptions: {
        animationDuration: 1500,
        clickColor: '#4CAF50',
        dragColor: '#2196F3',
        feedbackDuration: 2000
    },
    
    // Export options
    exportOptions: {
        includeCoordinateMapping: true,
        includeDeviceInfo: true,
        includeTimingData: true,
        exportFormat: 'python'
    }
});
```

## 📊 Coordinate Mapping

The system provides precise coordinate mapping between UI display and actual device coordinates:

### Scaling Methods

- **`fit`**: Scale to fit within bounds (letterbox/pillarbox)
- **`fill`**: Scale to fill bounds (crop if necessary)
- **`stretch`**: Stretch to fill bounds (may distort aspect ratio)

### Precision Control

```javascript
const mapper = new CoordinateMapper({
    coordinatePrecision: 2,      // Decimal places for coordinates
    scaleFactorPrecision: 4,     // Decimal places for scaling factors
    validateBounds: true,        // Validate coordinate bounds
    allowOutOfBounds: false      // Allow out-of-bounds coordinates
});
```

### Validation

```javascript
// Validate mapping accuracy
const validation = mapper.validateMapping();
if (validation.valid) {
    console.log('Mapping is accurate');
} else {
    console.log('Mapping error:', validation.error);
    console.log('Max error:', validation.maxError, 'pixels');
}
```

## 🎨 Visual Feedback

The system provides real-time visual feedback for all recorded actions:

### Action Types

- **Click**: Animated expanding circle
- **Double Click**: Two quick pulses
- **Drag**: Animated path with directional arrow
- **Swipe**: Multi-segment curved path with velocity indicator
- **Long Press**: Pulsing circle with duration display

### Customization

```javascript
const feedback = new VisualFeedback({
    // Colors for different action types
    clickColor: '#4CAF50',
    dragColor: '#2196F3',
    longPressColor: '#FF9800',
    swipeColor: '#9C27B0',
    
    // Animation settings
    animationDuration: 1500,
    fadeOutDuration: 300,
    pulseScale: 1.5,
    
    // Size settings
    clickRadius: 20,
    dragWidth: 3
});
```

## 📤 Export Formats

### JSON Export

Exports sequences in structured JSON format for programmatic use:

```json
{
  "preset": {
    "id": "preset_123",
    "name": "Login Automation",
    "description": "Automated login sequence"
  },
  "actionSequences": [
    {
      "id": "sequence_1",
      "name": "Login Sequence",
      "duration": 5000,
      "actions": [
        {
          "id": "action_1",
          "type": "click",
          "relativeTime": 0,
          "deviceCoordinates": { "x": 540, "y": 960 }
        }
      ]
    }
  ]
}
```

### Python Export

Generates executable Python scripts with ADB integration:

```python
#!/usr/bin/env python3
"""
Login Automation - Device Action Automation
Generated by Action Export Integration
"""

class ActionSequence:
    def __init__(self):
        self.sequences = self._load_sequences()
    
    def execute_sequence(self, sequence_name, dry_run=False):
        # Execute recorded actions using ADB commands
        pass
    
    def _adb_tap(self, x, y):
        # Execute ADB tap command
        subprocess.run(['adb', 'shell', 'input', 'tap', str(x), str(y)])
```

### YAML Export

Human-readable YAML format for configuration:

```yaml
preset:
  name: Login Automation
  description: Automated login sequence
actionSequences:
  - id: sequence_1
    name: Login Sequence
    actions:
      - type: click
        deviceCoordinates:
          x: 540
          y: 960
```

## 🧪 Testing

Run the comprehensive test suite:

```javascript
const ActionSystemTester = require('./test-action-system.js');

const tester = new ActionSystemTester();
const report = await tester.runAllTests();

if (report.success) {
    console.log('All tests passed!');
} else {
    console.log('Some tests failed:', report.summary);
}
```

### Test Coverage

- ✅ Coordinate mapping precision (< 1px error)
- ✅ Visual feedback rendering
- ✅ Action recording accuracy
- ✅ Sequence management
- ✅ Export functionality
- ✅ Integration components
- ✅ Edge case handling
- ✅ Performance validation

## 🔧 Integration Examples

### With Screenshot Engine

```javascript
const { ScreenshotEngine } = require('../screenshot/screenshot-engine.js');
const { ActionRecordingSystem } = require('./index.js');

const screenshotEngine = new ScreenshotEngine();
await screenshotEngine.initialize();

const actionSystem = new ActionRecordingSystem({
    enableAutoScreenshots: true
});
await actionSystem.initialize(screenshotEngine, deviceInfo);

// Actions will automatically trigger screenshots
```

### With ADB Manager

```javascript
const { ADBManager } = require('../adb/adb-manager.js');
const { ActionRecordingSystem } = require('./index.js');

const adbManager = new ADBManager();
await adbManager.detectADBPath();

const devices = await adbManager.getDevices();
const deviceInfo = await adbManager.getDisplayInfo(devices[0].id);

const actionSystem = new ActionRecordingSystem();
await actionSystem.initialize(null, deviceInfo);
```

### With Export System

```javascript
const { PythonExportSystem } = require('../python-export-system.js');
const { ActionRecordingSystem } = require('./index.js');

const actionSystem = new ActionRecordingSystem();
const sequences = actionSystem.getAllSequences();

// Export to Python using existing export system
const pythonExporter = new PythonExportSystem();
const result = pythonExporter.exportPresetToPython({
    mode: 'device-automation',
    sequences: sequences
});
```

## 📱 Device Integration

The system supports various device types and configurations:

### Android Devices

```javascript
const deviceInfo = {
    displayWidth: 1080,
    displayHeight: 1920,
    density: 420,
    model: 'Pixel 6',
    androidVersion: '12'
};
```

### Custom Scaling

```javascript
const mapper = new CoordinateMapper({
    scaleMethod: 'custom',
    customScaleX: 2.5,
    customScaleY: 2.5,
    customOffsetX: 50,
    customOffsetY: 100
});
```

## 🔄 Event System

The system provides comprehensive event handling:

```javascript
system.on('actionRecorded', (data) => {
    console.log('Action recorded:', data.action.type);
});

system.on('recordingStarted', (data) => {
    console.log('Recording started:', data.sequenceId);
});

system.on('recordingStopped', (data) => {
    console.log('Recording stopped:', data.sequence.name);
});

system.on('sequenceExported', (data) => {
    console.log('Sequence exported:', data.exportData.format);
});
```

## 🛠️ Configuration Options

### Action Recorder Options

```javascript
{
    enableCoordinateTracking: true,
    enableVisualFeedback: true,
    enableSequenceManagement: true,
    coordinatePrecision: 2,
    actionDebounceTime: 100,
    maxActionSequenceLength: 100,
    autoScreenshotAfterAction: false,
    screenshotDelay: 500
}
```

### Coordinate Mapper Options

```javascript
{
    coordinatePrecision: 2,
    scaleFactorPrecision: 4,
    validateBounds: true,
    allowOutOfBounds: false,
    maintainAspectRatio: true,
    scaleMethod: 'fit',
    autoCalculateOffset: true
}
```

### Visual Feedback Options

```javascript
{
    animationDuration: 1500,
    fadeOutDuration: 300,
    clickColor: '#4CAF50',
    dragColor: '#2196F3',
    longPressColor: '#FF9800',
    swipeColor: '#9C27B0',
    clickRadius: 20,
    dragWidth: 3,
    pulseScale: 1.5
}
```

## 🚨 Error Handling

The system provides comprehensive error handling:

```javascript
try {
    await system.initialize(screenshotEngine, deviceInfo);
    system.startRecording('Test Sequence');
} catch (error) {
    if (error.message.includes('not initialized')) {
        console.log('System needs initialization');
    } else if (error.message.includes('already recording')) {
        console.log('Stop current recording first');
    } else {
        console.log('Unexpected error:', error.message);
    }
}
```

## 📈 Performance

The system is optimized for smooth real-time recording:

- **Coordinate transformations**: Cached for repeated operations
- **Visual feedback**: GPU-accelerated CSS animations
- **Memory usage**: Automatic cleanup of old sequences
- **Event handling**: Debounced to prevent excessive triggering

### Performance Monitoring

```javascript
const stats = system.getSystemStatistics();
console.log('Performance stats:', {
    sequenceCount: stats.sequenceCount,
    totalActions: stats.totalActions,
    transformationCount: stats.componentStats.coordinateMapper.transformationCount,
    cacheHitRate: stats.componentStats.coordinateMapper.cacheSize
});
```

## 🔧 Troubleshooting

### Common Issues

**Coordinate mapping inaccurate:**
```javascript
// Validate mapping
const validation = mapper.validateMapping();
if (!validation.valid) {
    console.log('Mapping error:', validation.error);
    // Reinitialize with correct device info
    mapper.initialize(uiElement, correctedDeviceInfo);
}
```

**Visual feedback not showing:**
```javascript
// Check initialization
if (!feedback.state.isInitialized) {
    feedback.initialize(document.body);
}

// Check container exists
const container = document.getElementById('action-feedback-container');
if (!container) {
    console.log('Feedback container missing');
}
```

**Actions not recording:**
```javascript
// Check recording state
const state = system.getRecordingState();
if (!state.isRecording) {
    system.startRecording('New Sequence');
}

// Check coordinate mapper
if (!mapper.state.hasValidMapping) {
    mapper.initialize(uiElement, deviceInfo);
}
```

## 📝 License

This Action Recording System is part of the Claude Code Bot project and follows the same licensing terms.

## 🤝 Contributing

Contributions are welcome! Please ensure all tests pass before submitting:

```bash
node src/actions/test-action-system.js
```

Key areas for contribution:
- Additional export formats
- Enhanced visual feedback animations
- Performance optimizations
- Device-specific integrations
- Advanced sequence editing features
# 🔧 Plan Mode Debug Guide

## ⚡ Quick Fix for Non-Functional Buttons

If the plan mode configuration buttons aren't working, here's the **ONE-LINE FIX**:

### 🎯 **Instant Fix (Open Console & Run)**
```javascript
// One command fixes all button issues
fixPlanModeButtons();
```

### Alternative Methods:

#### **Method 1: Simple Reload**
- Press `F12` → Console tab
- Run: `fixPlanModeButtons()`

#### **Method 2: Manual Init**
```javascript
PlanModeConfigManager.manualInit();
```

#### **Method 3: Force Rebind**
```javascript
window.planModeConfigManager?.bindEventListeners();
```

### 4. **Test the Configuration System**
```javascript
// Run diagnostic tests
window.planModeConfigManager.testConfig();
```

### 5. **Check for DOM Elements**
```javascript
// Check if the new UI elements exist
console.log('Preset buttons:', document.querySelectorAll('.preset-btn').length);
console.log('Worker slider:', document.getElementById('worker-count'));
console.log('Settings modal:', document.getElementById('settings-modal'));
```

### 6. **Force Rebind Event Listeners**
```javascript
// If elements exist but buttons don't work
window.planModeConfigManager.bindEventListeners();
```

## Expected Console Output

When working correctly, you should see:
```
🚀 Initializing Plan Mode Configuration...
🔄 Binding event listeners (attempt 1/10)
✅ Bound 5 preset buttons
✅ Worker count controls bound
📊 Event binding summary: 2/2 element groups bound (SUCCESS)
✅ Plan Mode Config Manager initialized successfully
```

## Troubleshooting Common Issues

### Issue 1: "No preset buttons found"
**Cause**: Settings modal hasn't been opened yet
**Solution**: 
1. Click the Settings button (gear icon)
2. Navigate to Plan Mode Configuration section
3. Run: `PlanModeConfigManager.manualInit()`

### Issue 2: "planModeConfigManager is undefined"
**Cause**: JavaScript didn't load properly
**Solution**:
```javascript
// Force reload the script
const script = document.createElement('script');
script.src = 'plan-mode-config.js';
document.head.appendChild(script);
```

### Issue 3: Buttons exist but don't respond
**Cause**: Event listeners not bound
**Solution**:
```javascript
window.planModeConfigManager.bindEventListenersWithRetry();
```

## Testing Individual Components

### Test Preset Buttons
```javascript
// Manually trigger preset change
window.planModeConfigManager.applyPreset('heavy');
```

### Test Worker Count
```javascript
// Change worker count programmatically
window.planModeConfigManager.config.agents = 10;
window.planModeConfigManager.updateConfig();
```

### Test Command Generation
```javascript
// Generate command for current config
console.log(window.planModeConfigManager.generateCommand());
```

## Expected Commands by Preset

- **Light**: `npx claude-flow@alpha hive-mind spawn "{message}" --agents 3 --strategy development --claude`
- **Standard**: `npx claude-flow@alpha hive-mind spawn "{message}" --agents 5 --strategy balanced --topology hierarchical --memory-namespace default --claude`
- **Heavy**: `npx claude-flow@alpha hive-mind spawn "{message}" --agents 8 --strategy parallel --topology mesh --memory-namespace heavy --neural-patterns enabled --parallel-execution true --claude`

## Final Test

Run this comprehensive test:
```javascript
// Complete functionality test
const manager = window.planModeConfigManager;
if (manager) {
    console.log('✅ Manager exists');
    console.log('Current config:', manager.config);
    console.log('Generated command:', manager.generateCommand());
    manager.testConfig();
    console.log('🎉 Plan Mode is working!');
} else {
    console.log('❌ Manager not found, running manual init...');
    PlanModeConfigManager.manualInit().testConfig();
}
```

If all tests pass, the plan mode configuration system is working correctly! 🎉
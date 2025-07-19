# Claude Development Instructions

## Auto-Inject Timer Testing

### Virtual Environment Setup
This project includes a Python virtual environment specifically for testing the auto-inject timer functionality.

**Location**: `test_env/`

**First-time Setup**:
```bash
# Create virtual environment (if not exists)
python3 -m venv test_env

# Activate and install dependencies
source test_env/bin/activate
pip install selenium webdriver-manager pillow numpy
```

**Daily Usage**:
```bash
# Activate the virtual environment
source test_env/bin/activate

# Run tests
python scripts/test_auto_injector.py <commands>

# Deactivate when done
deactivate
```

**Troubleshooting Chrome/ChromeDriver Issues**:
```bash
# If you get ChromeDriver version errors:
source test_env/bin/activate
pip install --upgrade webdriver-manager
# This will auto-download the correct ChromeDriver version
```

**Dependencies Installed**:
- selenium (web automation)
- webdriver-manager (Chrome driver management)
- pillow (image processing for screenshot comparison)
- numpy (numerical operations for image analysis)

### Testing Auto-Inject Timer

**Test Script**: `scripts/test_auto_injector.py`

**Key Commands**:
```bash
# Start app and connect
source test_env/bin/activate
python scripts/test_auto_injector.py start connect

# Test timer functionality
python scripts/test_auto_injector.py start connect screenshot "before_timer" wait 30 screenshot "after_timer"

# Test injection with our fixes
python scripts/test_auto_injector.py start connect type "test message" screenshot "queued" hotkey "cmd+shift+t" wait 5 screenshot "timer_set"

# Capture debug logs
python scripts/test_auto_injector.py start connect all_logs
```

**Available Commands**:
- `start` - Start Electron app with debugging
- `connect` - Connect to running app
- `screenshot <name>` - Take timestamped screenshot
- `click <data-test-id>` - Click element by test ID
- `type <text>` - Type message into input
- `wait <seconds>` - Wait specified time
- `hotkey <combination>` - Send hotkey (e.g., "cmd+t")
- `all_logs` - Show both main and renderer logs
- `verify <before> <after>` - Compare screenshots

### Auto-Inject Timer Issues Fixed

1. **Timer Stuck at 0**: Added debug logging in injection-manager.js
2. **Missing 5-Hour Threshold**: Implemented in timer-controller.js:719-723
3. **Plan Mode Delays**: Verified 30s/5s delays working correctly
4. **Usage Limit Repopulation**: Already fixed in commit e04eda6f
5. **Duplicate Detection**: Verified functional with processedUsageLimitMessages

### Testing Checklist

When testing auto-inject timer fixes:
- [ ] Timer counts down correctly
- [ ] Timer triggers injection at 00:00:00
- [ ] Usage limit timers > 5 hours are ignored
- [ ] Plan mode has 30-second delay
- [ ] Normal messages have 5-second delay
- [ ] Debug logs show terminal availability
- [ ] No duplicate usage limit processing

**Always use the virtual environment for testing** to ensure consistent dependencies and avoid conflicts with system Python packages.
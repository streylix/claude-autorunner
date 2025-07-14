# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🚨 MANDATORY FOR CLAUDE CODE: ALWAYS TEST & VERIFY 🚨

**EVERY SINGLE CHANGE REQUIRES:**
```bash
python test_auto_injector.py start connect wait 15 screenshot "before" [test the change] screenshot "after"
```

**THEN YOU MUST:**
1. **Use unbiased Claude review process** - DO NOT analyze screenshots yourself
2. **Send screenshots to separate Claude process** for objective assessment
3. **Use review command** for automated unbiased analysis
4. **Verify** no UI elements are broken or missing based on Claude review

**🤖 UNBIASED SCREENSHOT REVIEW PROCESS:**
```bash
# For detailed comparison with difference highlighting
python test_auto_injector.py compare "before" "after" "description of expected change"

# For unbiased Claude review (MANDATORY for all visual verification)
python test_auto_injector.py review "before" "after" "description of expected change"
```

**❌ NEVER say "task complete" without:**
- Running the test script with before/after screenshots
- Getting unbiased Claude review of the screenshots
- Confirming the change works based on external review
- Using review command to validate visual changes

**⚠️ DO NOT ANALYZE SCREENSHOTS YOURSELF:**
- Always use the `review` command to send screenshots to separate Claude
- Never rely on your own visual analysis - use external Claude for objectivity
- The review process prevents confirmation bias and ensures accurate assessment

**💡 QUICK IMPROVEMENT TIPS:**
- Add `data-test-id` to any new interactive elements
- Use specific test actions that target your changes
- Wait 2-3 seconds after UI interactions for proper rendering
- Test edge cases (clicking buttons, entering text, modal interactions)

## Commands

### Development Commands
- `npm start` - Start the Electron application in production mode
- `npm run dev` - Start the Electron application in development mode with debugging
- `npm run build` - Build the application for distribution using electron-builder
- `npm run rebuild` - Rebuild native modules for current Electron version
- `npm install` or `npm postinstall` - Install dependencies and rebuild native modules
- `./run.sh` - Interactive script for testing (per Cursor rules)

### Backend Integration (Optional)
- `./start_with_backend.sh` - Start both Django backend and Electron frontend
- `./start_simple.sh` - Start without waiting for backend to be ready
- `cd backend && python manage.py runserver` - Start Django backend separately
- `cd backend && python manage.py migrate` - Run database migrations

### Testing and Validation

**Primary Test Script: `test_auto_injector.py`**
Always use this script for testing changes. It provides automated UI interaction and verification capabilities.

**Critical Testing Requirements:**
1. **Always use `start` command** - Never assume the app is running
2. **Wait for proper loading** - Use `wait 15` after `start` and `wait 2` between commands
3. **Take before/after screenshots** - Visual verification is mandatory
4. **Read and compare screenshots** - Verify changes actually worked
5. **Complete testing cycle** - Only mark tasks complete when functionality is confirmed

**Required Test Script Pattern:**
```bash
python test_auto_injector.py start connect wait 15 screenshot "before_test" [actions] screenshot "after_test" review "before_test" "after_test" "description of change"
```

**Enhanced Testing Commands:**
```bash
# Close specific terminals by ID
close_terminal <terminal-id>

# Detailed screenshot comparison with difference highlighting
compare "before" "after" "terminal close functionality test"

# Unbiased Claude review (MANDATORY for verification)
review "before" "after" "tested terminal close button functionality"

# Console log debugging (AUTOMATIC after connect)
main_logs      # Show main process logs (Node.js/Electron errors)
logs           # Show renderer console logs (browser JavaScript)
all_logs       # Show both main process and renderer logs
```

**Essential Elements for Testing:**

**Data-Test-ID Requirements:**
- Every interactive button MUST have unique `data-test-id` attributes
- Timer inputs: `timer-hours-input`, `timer-minutes-input`, `timer-seconds-input`
- Timer controls: `timer-save-btn`, `timer-cancel-btn`, `timer-play-pause-btn`
- Navigation: `settings-btn`, `add-terminal-btn`, `send-btn`
- Queue controls: `inject-now-btn`, `clear-queue-header-btn`
- Modal controls: All modal close buttons, action buttons

**Key Functional Areas to Test:**
1. **Message Queue System**
   - Add messages to queue
   - Verify queue count updates
   - Test auto-injection timing
   - Verify message execution in terminal

2. **Timer Functionality**
   - Open timer edit (Cmd+B or click timer-edit-btn)
   - Set timer values using proper input data-test-ids
   - Save timer settings
   - Start/pause timer operations
   - Verify countdown and auto-injection

3. **Terminal Operations**
   - Create new terminals
   - Switch between terminals
   - Verify terminal output
   - Test command execution

4. **Settings and Configuration**
   - Open settings modal
   - Modify configuration options
   - Verify settings persistence
   - Test keyboard shortcuts

**Auto-Inject Testing Protocol:**
1. Queue a test command (e.g., `echo 'test' > output.txt`)
2. Set timer to short duration (5-10 seconds)
3. Start timer and wait for injection
4. Verify file creation or terminal output
5. Check action logs for injection events

**Screenshot Verification Requirements:**
- Capture before state showing initial UI
- Document each interaction step
- Capture final state showing changes
- Verify visual indicators (queue counts, timer display, status changes)
- Check for error states or unexpected behavior

**Common Test Scenarios:**
- Basic message queuing and injection
- Timer setting and countdown
- Multi-terminal coordination
- Settings modal interactions
- Voice transcription (if applicable)
- Auto-continue functionality
- Plan mode operations

**Console Log Debugging:**
The test script automatically captures and displays console logs after every `connect` command. This provides visibility into:

**Main Process Logs** (Node.js/Electron):
- Module loading errors (e.g., "Cannot find module './src/messaging/injection-manager'")
- File system operations and errors
- IPC communication between main and renderer processes
- Service worker and database errors
- Application startup and initialization

**Renderer Process Logs** (Browser JavaScript):
- JavaScript console.log, console.error, console.warn output
- Uncaught JavaScript errors and exceptions
- Unhandled promise rejections
- Security warnings (CSP violations)
- Runtime errors in UI components

**Key Debugging Commands:**
```bash
# Logs are automatically shown after connect, but can also be called manually:
python test_auto_injector.py start connect main_logs    # Main process only
python test_auto_injector.py start connect logs         # Renderer only  
python test_auto_injector.py start connect all_logs     # Both processes
```

**Common Error Patterns to Look For:**
- `[SEVERE] node:internal/modules/cjs/loader` - Module loading failures
- `Failed to delete the database: Database IO error` - Storage issues
- `Uncaught Error:` - JavaScript runtime errors
- `Cannot find module` - Missing dependencies
- `Security Warning` - CSP and security configuration issues

**Failure Indicators:**
- Timer shows "Cannot start timer - time not set"
- Messages remain in queue without processing
- UI elements not responding to clicks
- Missing or incorrect visual feedback
- Error messages in action log
- Console errors appearing in main_logs or renderer logs

## 🔴 TESTING ENFORCEMENT RULES 🔴

**FOR CLAUDE CODE SPECIFICALLY:**

1. **BEFORE making ANY code changes** - Take a "before" screenshot to establish baseline
2. **AFTER making ANY code changes** - IMMEDIATELY run the test script
3. **ALWAYS use this exact pattern:**
   ```bash
   python test_auto_injector.py start connect wait 15 screenshot "before_[description]" [relevant test actions] screenshot "after_[description]"
   ```
4. **REQUIRED verification steps:**
   - Read both before/after screenshots visually
   - Confirm expected changes are visible
   - Verify no regressions or broken functionality
   - Check that all UI elements are properly identified with data-test-ids

5. **NEVER COMPLETE A TASK without:**
   - Running the test script successfully
   - Visually confirming the changes work
   - Seeing evidence in screenshots that functionality is working

**Common test patterns to use:**
- **Button changes:** Test clicking the modified button
- **UI changes:** Test the affected interface area  
- **Timer changes:** Test timer setting and auto-injection
- **Queue changes:** Test message queuing and processing
- **Settings changes:** Test opening/modifying settings

**Remember:** This application has complex interactions between UI, timers, queues, and terminal processes. The ONLY reliable way to verify changes is through the visual testing framework.

## Architecture

Auto-Injector is an advanced terminal automation suite built as an Electron desktop application. It enhances the Claude Code terminal experience with message queuing, voice-to-text transcription, smart auto-continue features, and multi-terminal orchestration.

### Core Components
YOU ARE LIKELY BEING RAN WITHIN THIS SCRIPT!!!!! ONLY RUN `npm run` OR `pkill` RARELY
**Main Process (`main.js`)**
- Electron main process handling window management, system tray, and IPC
- Spawns terminal processes using `node-pty` 
- Manages terminal I/O communication between renderer and shell
- Handles file operations, power management, and notifications
- Manages application data persistence and settings

**Renderer Process (`renderer.js`)**
- Contains the `TerminalGUI` class managing the entire application logic
- Uses `@xterm/xterm` for terminal emulation with FitAddon, SearchAddon, and WebLinksAddon
- Implements message queuing system with FIFO processing
- Handles time-based message injection with realistic typing simulation
- Voice recording and transcription integration
- Multi-terminal orchestration and session management
- AI usage limit detection and handling

**UI Structure (`index.html`)**
- Split layout: terminal section (left) and control sidebar (right)
- Multiple terminal containers for concurrent sessions
- Sidebar with queue display, input controls, and timing settings
- Settings modal with extensive configuration options
- Todo list and action log sidebars

### Codebase Function Analysis

**ALWAYS run function analysis before making changes to avoid duplicates:**

```bash
python analyze_functions.py
```

This script analyzes `main.js` and `renderer.js` to extract:
- All function declarations, methods, and arrow functions
- Line counts and locations for each function
- Function purposes based on naming patterns
- Class structure and method organization

**Key Benefits:**
- Prevents creation of duplicate functionality
- Helps identify existing functions before writing new ones
- Provides overview of code organization and complexity
- Assists in debugging by locating specific functions

**Function Categories in the Codebase:**
- **Terminal operations**: Functions managing pty processes, terminal UI, and shell communication
- **Message queue system**: Functions handling FIFO queuing, injection scheduling, and typing simulation
- **User interface management**: Functions controlling modals, buttons, dropdowns, and visual feedback
- **Timer and scheduling**: Functions managing countdown timers and auto-injection timing
- **Event handling**: Functions processing user interactions, keyboard shortcuts, and callbacks
- **Data persistence**: Functions saving/loading settings, message history, and application state
- **Voice transcription**: Functions handling audio recording and speech-to-text processing
- **Initialization and setup**: Functions configuring components and establishing connections

**Example Usage:**
```bash
# Analyze specific files
python analyze_functions.py main.js renderer.js

# Get full report saved to function_analysis_report.md
python analyze_functions.py
```

**Before coding, check if functionality already exists:**
1. Run `python analyze_functions.py` 
2. Search the output for functions related to your task
3. Examine existing functions before writing new ones
4. Avoid creating duplicate or conflicting functionality

### Key Features

**Terminal Integration**
- Full terminal emulation using xterm.js with custom theming
- Multi-terminal support with color-coded identification
- Real-time bidirectional communication with shell process via IPC
- Terminal resizing and fit-to-container support
- Directory change detection from terminal output
- Terminal status indicators (idle, busy, prompting)

**Message Queuing System**
- FIFO queue for command processing with persistence
- Time-based injection scheduling with configurable delays
- Auto-agree mode for continuous processing
- Character-by-character typing simulation (configurable speed)
- Real-time status tracking (directory, injection count, queue size)
- Terminal-specific queue targeting

**Voice Transcription**
- OpenAI Whisper integration for voice-to-text
- Local transcription with @xenova/transformers
- Audio recording with visual feedback
- Smart punctuation and formatting

**Smart Auto-Continue**
- Intelligent prompt detection and automatic response
- Keyword blocking system with custom rules
- AI usage limit detection and handling
- Automatic pause/resume on rate limits
- Visual progress indicators

**IPC Communication**
- `terminal-start` - Initialize shell process
- `terminal-input` - Send input to shell
- `terminal-data` - Receive shell output
- `terminal-resize` - Handle terminal resizing
- `terminal-exit` - Handle shell process termination
- `voice-transcribe` - Process voice recordings
- `settings-*` - Settings persistence

### Dependencies

**Production Dependencies**
- `@xterm/xterm` - Terminal emulator with addons (fit, search, web-links)
- `node-pty` - Pseudo terminal for shell process spawning
- `@xenova/transformers` - Local AI model support
- `fluent-ffmpeg` - Audio processing for voice features
- `wavefile` - Audio file handling
- `lucide` - Icon library

**Development Dependencies**
- `electron` - Desktop application framework
- `electron-builder` - Application packaging and distribution
- `electron-rebuild` - Native module rebuilding for Electron

**Optional Backend (Django)**
- `Django` 4.2.7 - Python web framework
- `Django REST Framework` - REST API
- `Channels` - WebSocket support
- `Redis` - Message queue backend
- `OpenAI API` - Voice transcription services

### File Structure
```
├── main.js               # Electron main process
├── renderer.js           # Renderer process with TerminalGUI class
├── index.html            # Application UI structure  
├── style.css             # Application styling
├── api-client.js         # API client for backend integration
├── package.json          # Dependencies and scripts
├── run.sh                # Interactive testing script
├── start_with_backend.sh # Launch script with Django backend
├── start_simple.sh       # Launch script without backend
├── README.md             # Project documentation
├── .cursor/rules/        # Cursor IDE rules (always run ./run.sh)
└── backend/              # Optional Django backend
    ├── manage.py         # Django management script
    ├── terminal_backend/ # Main Django project
    ├── message_queue/    # Message persistence app
    ├── terminal/         # Terminal session management
    ├── todos/            # AI-powered todo generation
    ├── voice/            # Voice transcription services
    └── settings/         # Settings persistence
```

### Security Considerations
- Uses deprecated `nodeIntegration: true` and `contextIsolation: false` settings
- Direct shell access through node-pty requires careful input validation
- Remote module access enabled for window controls

### Ethical Guidelines
- Never kill the system
- Do not kill the process ever
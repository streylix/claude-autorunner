# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🚨 MANDATORY FOR CLAUDE CODE: ALWAYS TEST & VERIFY 🚨

**EVERY SINGLE CHANGE REQUIRES:**
```bash
python test_auto_injector.py start connect wait 15 screenshot "before" [test the change] screenshot "after"
```

**THEN YOU MUST:**
1. **Read BOTH screenshots** with your vision capabilities
2. **Visually confirm** the change is working as expected
3. **Verify** no UI elements are broken or missing
4. **Check** that buttons/functionality actually respond correctly

**❌ NEVER say "task complete" without:**
- Running the test script
- Taking before/after screenshots  
- Actually looking at the screenshots with your eyes
- Confirming the change works visually

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
python test_auto_injector.py start connect wait 15 screenshot "before_test" [actions] screenshot "after_test"
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

**Failure Indicators:**
- Timer shows "Cannot start timer - time not set"
- Messages remain in queue without processing
- UI elements not responding to clicks
- Missing or incorrect visual feedback
- Error messages in action log

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
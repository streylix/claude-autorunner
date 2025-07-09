# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- Always run `./run.sh` before completing tasks (required by Cursor rules in `.cursor/rules/always-run.mdc`)
- The `run.sh` script provides detailed feedback about the current project state
- **Note**: `run.sh` does not actually test it, it is an input system that is for glitching cursor to save request costs

## Architecture

Auto-Injector is an advanced terminal automation suite built as an Electron desktop application. It enhances the Claude Code terminal experience with message queuing, voice-to-text transcription, smart auto-continue features, and multi-terminal orchestration.

### Core Components

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
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

### Testing and Validation
- Always run `./run.sh` before completing tasks (required by Cursor rules in `.cursor/rules/always-run.mdc`)
- The `run.sh` script provides detailed feedback about the current project state
- **Note**: `run.sh` does not actually test it, it is an input system that is for glitching cursor to save request costs

## Architecture

This is an Electron-based desktop application that provides a terminal GUI with message queuing and automated command injection capabilities.

### Core Components

**Main Process (`main.js`)**
- Electron main process handling window management and IPC
- Spawns terminal processes using `node-pty` 
- Manages terminal I/O communication between renderer and shell

**Renderer Process (`renderer.js`)**
- Contains the `TerminalGUI` class managing the entire application logic
- Uses `@xterm/xterm` for terminal emulation with FitAddon and WebLinksAddon
- Implements message queuing system with FIFO processing
- Handles time-based message injection with realistic typing simulation

**UI Structure (`index.html`)**
- Split layout: terminal section (left) and sidebar (right)
- Terminal container for xterm.js instance
- Sidebar with status display, queued messages, input controls, and timing settings

### Key Features

**Terminal Integration**
- Full terminal emulation using xterm.js with custom theming
- Real-time bidirectional communication with shell process via IPC
- Terminal resizing and fit-to-container support
- Directory change detection from terminal output

**Message Queuing System**
- FIFO queue for command processing
- Time-based injection scheduling
- Auto-agree mode for continuous processing
- Character-by-character typing simulation (50ms intervals)
- Real-time status tracking (directory, injection count, queue size)

**IPC Communication**
- `terminal-start` - Initialize shell process
- `terminal-input` - Send input to shell
- `terminal-data` - Receive shell output
- `terminal-resize` - Handle terminal resizing
- `terminal-exit` - Handle shell process termination

### Dependencies

**Production Dependencies**
- `@xterm/xterm` - Terminal emulator
- `@xterm/addon-fit` - Terminal fitting addon  
- `@xterm/addon-web-links` - Web links addon
- `node-pty` - Pseudo terminal for shell process spawning

**Development Dependencies**
- `electron` - Desktop application framework
- `electron-builder` - Application packaging and distribution
- `electron-rebuild` - Native module rebuilding for Electron

### File Structure
```
├── main.js          # Electron main process
├── renderer.js      # Renderer process with TerminalGUI class
├── index.html       # Application UI structure  
├── style.css        # Application styling
├── package.json     # Dependencies and scripts
├── run.sh           # Interactive testing script
├── README.md        # Project documentation
└── .cursor/rules/   # Cursor IDE rules (always run ./run.sh)
```

### Security Considerations
- Uses deprecated `nodeIntegration: true` and `contextIsolation: false` settings
- Direct shell access through node-pty requires careful input validation
- Remote module access enabled for window controls

### Ethical Guidelines
- Never kill the system
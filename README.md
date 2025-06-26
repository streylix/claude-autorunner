# Terminal GUI with Advanced Automation

A sophisticated desktop application that provides an interactive terminal with intelligent message queuing, automation features, and macOS system integration for scheduled command execution and workflow automation.

## ✨ Key Features

### 🖥️ **Advanced Terminal Interface**
- Full-featured terminal emulation using xterm.js with modern theming
- Smart terminal status detection (running, prompting, idle)
- Directory change tracking and current working directory display
- Auto-scrolling with user interaction pause/resume
- Terminal command hotkey shortcuts (Ctrl+C, Ctrl+Z, Ctrl+D, etc.)

### ⏰ **Intelligent Message Queuing System**
- Time-based message injection with precise scheduling
- FIFO (First-In-First-Out) processing with drag-and-drop reordering
- Auto-continue mode with smart keyword blocking
- Claude prompt detection and intelligent response handling
- Usage limit detection with automatic queue resumption
- Safety checks to prevent infinite loops

### 🔊 **Audio Feedback System**
- Completion sound notifications when auto-injection processes finish
- Half-Life 2 themed sound effects collection
- Customizable sound selection with preview functionality
- Terminal idle state detection for accurate completion timing
- Sound settings with enable/disable toggle

### 📁 **File Management & Import**
- Drag-and-drop file import with visual overlay animations
- Screenshot capture from clipboard with automatic saving
- Automatic file organization in `imported-files` directory
- File metadata tracking (names, sizes, types, timestamps)
- Visual file attachment indicators in message queue

### 🎨 **Modern UI/UX**
- Multiple theme support: Dark, Light (Catppuccin Latte), System
- Responsive layout with adaptive sidebar sizing
- Comprehensive settings modal with organized sections
- Real-time action logging with timestamped sidebar
- Visual status indicators with color-coded states
- Drag-to-adjust timer interface

## 🚀 Installation & Setup

### Prerequisites
- **Node.js** (v16 or higher) - [Download from nodejs.org](https://nodejs.org/)
- Cross-platform compatibility (Windows, macOS, Linux)

### Quick Start
```bash
# Clone or download the repository
# Navigate to the project directory

# Install dependencies and rebuild native modules
npm install

# Start the application
npm start
```

### Development Mode
```bash
# Run with debugging enabled
npm run dev

# Build for distribution
npm run build
```

## 📖 Usage Guide

### 🔧 **Basic Operations**

1. **Terminal Interaction**:
   - Full interactive terminal in the left panel (supports zsh/bash/cmd)
   - All standard terminal features work (tab completion, history, etc.)
   - Real-time status updates show current directory and terminal state

2. **Message Queue Management**:
   - Type commands in the input textarea and click "Add to Queue"
   - Drag messages to reorder them in the queue
   - Set precise execution times using the date/time picker
   - Use "Clear Queue" to remove all pending messages

3. **Automated Execution**:
   - Messages are typed into terminal with realistic character-by-character simulation
   - Smart detection of command completion triggers next message
   - Auto-continue mode processes entire queue without user intervention

### ⚡ **Advanced Features**

#### **Hotkey Shortcuts**
- Click the hotkey dropdown for quick access to common terminal commands
- Includes Ctrl+C (interrupt), Ctrl+Z (suspend), Ctrl+D (EOF), and more
- Hotkeys are inserted at cursor position in the message input

#### **File Import System**
- **Drag & Drop**: Drop files directly onto the interface to import them
- **Screenshot Capture**: Use Cmd+Shift+4 → Cmd+V to paste screenshots
- Files are automatically organized in the `imported-files` directory
- Visual indicators show which messages have attached files

#### **Audio Notifications**
- Enable completion sounds in Settings for audio feedback
- Choose from Half-Life 2 themed sound effects
- Test sounds before applying with the preview button
- Sounds play when auto-injection processes complete

### 🎛️ **Settings & Customization**

Access comprehensive settings through the gear icon:
- **Theme Selection**: Dark, Light (Catppuccin Latte), or System
- **Audio Settings**: Enable/disable sounds and select sound effects
- **Automation Settings**: Set keyword blocking rules and safety limits

## 🏗️ Technical Architecture

### **Core Technologies**
- **Electron** - Desktop application framework with Node.js integration
- **node-pty** - Pseudo terminal for cross-platform shell process spawning
- **xterm.js** - Full-featured terminal emulator with addon support
- **Lucide Icons** - Modern icon library for UI elements

### **Key Components**

#### **Main Process (`main.js`)**
- Electron main process handling window lifecycle and system integration
- IPC (Inter-Process Communication) bridge between renderer and shell
- Terminal process management using node-pty
- File handling for drag-and-drop imports and screenshot saving

#### **Renderer Process (`renderer.js`)**
- `TerminalGUI` class managing entire application state and logic
- xterm.js terminal emulation with FitAddon and WebLinksAddon
- Message queuing system with intelligent processing
- File import system with drag-and-drop support
- Audio system integration for completion notifications

#### **UI Structure (`index.html` + `style.css`)**
- Split-pane layout: terminal (left) and control sidebar (right)
- Responsive design with theme system support
- Settings modal with organized configuration sections
- Action log sidebar for real-time activity tracking

### **Data Flow Architecture**
```
User Input → Message Queue → Timer System → Auto-injection → Terminal
     ↓              ↓             ↓              ↓           ↓
File Import → Queue Display → Status Updates → Audio → Command Execution
```

## 📁 Project Structure

```
├── main.js              # Electron main process & system integration
├── renderer.js          # TerminalGUI class & application logic  
├── index.html           # Application UI structure & layout
├── style.css            # Styling, themes & responsive design
├── package.json         # Dependencies, scripts & metadata
├── run.sh              # Interactive testing script
├── soundeffects/       # Audio files for completion notifications
├── imported-files/     # Auto-organized imported file storage
├── .cursor/rules/      # Development environment rules
└── README.md           # This documentation
```

## 🔧 Development

### **Available Scripts**
```bash
npm start           # Production mode
npm run dev         # Development mode with debugging
npm run build       # Build for distribution  
npm run rebuild     # Rebuild native modules
./run.sh           # Interactive testing (required before task completion)
```

### **Development Notes**
- Uses `nodeIntegration: true` for full Node.js access in renderer
- IPC communication for terminal data exchange
- Real-time status monitoring with terminal state detection
- Modular component architecture for easy feature extension

## 🚨 Troubleshooting

### **Installation Issues**
```bash
# If native modules fail to build
npm run rebuild

# On macOS if build tools missing
xcode-select --install

# On Linux if build essentials missing  
sudo apt-get install build-essential python3
```

### **Runtime Issues**

**Terminal not starting**
- Verify shell permissions and default shell accessibility
- Check terminal access in System Preferences (macOS)
- Run with elevated privileges if needed

**Audio not working**
- Ensure sound files exist in `soundeffects/` directory
- Check system audio permissions and output device
- Verify audio settings in application Settings modal

**File import not working**
- Check `imported-files/` directory permissions
- Verify drag-and-drop browser security settings
- Ensure sufficient disk space for file copies

## 🛡️ Security & Permissions

This application requires several system permissions for full functionality:
- **Terminal Access** - For shell process spawning and command execution
- **File System Access** - For file import and organization
- **Audio System** - For completion sound notifications

## 📄 License

MIT License - Open source and free to modify for personal and commercial use. 
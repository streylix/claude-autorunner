# Terminal GUI with Message Queuing

A modern desktop application that provides an interactive terminal with a message queuing system for automated command injection at specified times.

## Features

- **Interactive Terminal**: Full-featured terminal that matches macOS/VS Code/Cursor terminal functionality
- **Message Queuing**: Add commands to a queue for automatic execution
- **Time-based Injection**: Schedule messages to be sent at specific times
- **FIFO Processing**: Messages are processed in first-in-first-out order
- **Auto-agree Mode**: Automatically continue processing queued messages
- **Real-time Status**: Track current directory, injection count, and queue status
- **Modern UI**: Dark theme matching popular terminal applications

## Installation

1. **Install Node.js** (if not already installed):
   - Download from [nodejs.org](https://nodejs.org/)
   - Or use Homebrew: `brew install node`

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run the application**:
   ```bash
   npm start
   ```

## Usage

### Basic Operations

1. **Terminal Usage**:
   - The left panel contains a fully interactive terminal
   - Use it like any standard terminal (zsh/bash)
   - All standard terminal features are supported

2. **Adding Messages to Queue**:
   - Enter commands in the "input container" textarea
   - Click "Add to Queue" to add them to the message queue
   - Messages appear in the "[queued messages]" section

3. **Setting Execution Time**:
   - Set the date and time when messages should be injected
   - The system will wait until that exact time to start processing

4. **Message Injection**:
   - Messages are automatically typed into the terminal at the scheduled time
   - Each message is sent with realistic typing speed
   - Messages are processed in FIFO (first-in-first-out) order

### Advanced Features

- **Auto Agree**: When enabled, the system automatically continues processing all queued messages
- **Queue Management**: Clear the entire queue with the "Clear Queue" button
- **Status Monitoring**: The top section shows current directory, injection count, and queue size

## Architecture

- **Electron**: Desktop application framework
- **node-pty**: Terminal process spawning and management
- **xterm.js**: Terminal emulator in the browser
- **IPC**: Inter-process communication between main and renderer processes

## File Structure

```
├── main.js          # Main Electron process
├── renderer.js      # Renderer process (UI logic)
├── index.html       # Application HTML structure
├── style.css        # Application styling
├── package.json     # Dependencies and scripts
└── README.md        # This file
```

## Development

To run in development mode with debugging enabled:

```bash
npm run dev
```

To build for distribution:

```bash
npm run build
```

## Troubleshooting

### Terminal not starting
- Ensure you have proper shell permissions
- Check that your default shell is accessible
- Try running with administrator privileges if needed

### Dependencies not installing
- Make sure you have Python and build tools installed for native modules
- On macOS: `xcode-select --install`
- On Ubuntu: `sudo apt-get install build-essential`

### Permission issues
- Grant necessary permissions to the application
- Check terminal access permissions in System Preferences (macOS)

## License

MIT License - feel free to use and modify as needed. 
# Auto-Injector: Advanced Terminal Automation Suite

This is a tool that enhances the Claude Code terminal experience. Queue messages, convert speech to prompts, smart auto-continue with keyword detection, completion sounds and more!

Now introducing *Advanced Plan Mode* which intuitively utilizes Claude Flow for better propmt execution.

![Auto-Injector Demo](./docs/injectortest.gif)

## 🌟 Revolutionary Features

![Settings view](./docs/images/sound-settings.png)

## 🚀 Quick Start Guide

### Prerequisites
- **Node.js** v16+ and npm
- **macOS** 10.15+, **Windows** 10+, or **Linux** with X11
- **Microphone access** for voice features (optional)

### Installation

#### Quick Start (Recommended)
```bash
# Clone the repository
git clone https://github.com/streylix/claude-autorunner.git
cd claude-autorunner

# Start with automatic setup (first time only)
./start.sh --setup

# Start the application
./start.sh
```

The `--setup` flag automatically:
- ✅ Installs npm dependencies
- ✅ Creates Python virtual environment
- ✅ Installs backend requirements
- ✅ Runs database migrations
- ✅ Creates .env file from template

##### Frontend Only (Optional):
```bash
# Install dependencies
npm install

# Start the application
npm start
```

## 📄 License

MIT License - Free for personal and commercial use.

## 🙏 Acknowledgments

- Terminal emulation powered by [xterm.js](https://xtermjs.org/)
- Voice transcription via [OpenAI Whisper](https://openai.com/whisper)
- Icons by [Lucide](https://lucide.dev/)
- Sound effects from Half-Life 2

---
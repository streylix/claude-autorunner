#!/usr/bin/env python3
"""
Simple Discord-style bot for terminal commands
Only handles !addmsg command for simplicity
Runs as a background service monitoring for commands
"""

import sys
import json
import requests
import re
import time
import os
import signal
from typing import Optional, Tuple
from pathlib import Path

# Configuration
API_BASE_URL = "http://127.0.0.1:8001/api"
COMMAND_FILE = "/tmp/claude-bot-commands"
STATUS_FILE = "/tmp/claude-bot-status"
PID_FILE = "/tmp/claude-bot.pid"

class SimpleBot:
    def __init__(self):
        self.api_base = API_BASE_URL
        self.running = True
        
    def parse_addmsg_command(self, message: str) -> Optional[Tuple[str, int]]:
        """
        Parse !addmsg command
        Format: !addmsg "message" [terminal_number]
        Returns: (message, terminal_number) or None if invalid
        """
        # Pattern to match !addmsg "message" [number]
        pattern = r'^!addmsg\s+"([^"]+)"(?:\s+(\d+))?'
        match = re.match(pattern, message)
        
        if match:
            msg_content = match.group(1)
            terminal_num = int(match.group(2)) if match.group(2) else 1
            return (msg_content, terminal_num)
        
        # Also try without quotes for simple messages
        pattern2 = r'^!addmsg\s+(\S+)(?:\s+(\d+))?'
        match2 = re.match(pattern2, message)
        
        if match2:
            msg_content = match2.group(1)
            terminal_num = int(match2.group(2)) if match2.group(2) else 1
            return (msg_content, terminal_num)
        
        return None
    
    def get_terminal_id(self, terminal_num: int) -> str:
        """Generate terminal ID for simplified backend"""
        return f"terminal_{terminal_num}"
    
    def send_message_to_terminal(self, message: str, terminal_num: int) -> bool:
        """
        Send message to terminal via backend API
        Uses the same method as scripts/addmsg
        """
        terminal_id = self.get_terminal_id(terminal_num)
        
        # Create JSON payload matching the current addmsg script
        payload = {
            'content': message,
            'terminal_id': terminal_id
        }
        
        try:
            # Send to the pass-through endpoint like addmsg does
            response = requests.post(
                f"{self.api_base}/queue/add/",
                json=payload,
                headers={'Content-Type': 'application/json'},
                timeout=5
            )
            
            if response.status_code == 200:
                result = response.json()
                # Check for error in response
                if 'error' not in result and 'detail' not in result:
                    print(f"✓ Message sent to Terminal {terminal_num}: \"{message}\"")
                    
                    # Create file-based trigger for immediate frontend notification
                    trigger_file = "/tmp/claude-code-addmsg-trigger"
                    timestamp = int(time.time())
                    with open(trigger_file, 'w') as f:
                        f.write(f"{timestamp}:addmsg:{message}:{terminal_id}")
                    
                    return True
                else:
                    print(f"✗ API error: {result.get('error', result.get('detail', 'Unknown error'))}")
                    return False
            else:
                print(f"✗ Failed to send message. Status: {response.status_code}")
                return False
                
        except requests.exceptions.ConnectionError:
            print("✗ Cannot connect to backend. Is it running on port 8001?")
            return False
        except requests.exceptions.Timeout:
            print("✗ Request timed out")
            return False
        except Exception as e:
            print(f"✗ Error: {e}")
            return False
    
    def process_command(self, command: str) -> bool:
        """
        Process a command string
        Returns True if command was handled, False otherwise
        """
        command = command.strip()
        
        # Check if it's an addmsg command
        if command.startswith('!addmsg'):
            parsed = self.parse_addmsg_command(command)
            if parsed:
                message, terminal_num = parsed
                return self.send_message_to_terminal(message, terminal_num)
            else:
                print("✗ Invalid command format. Use: !addmsg \"message\" [terminal_number]")
                print("  Example: !addmsg \"ls -la\" 1")
                return False
        
        # Unknown command
        if command.startswith('!'):
            print(f"✗ Unknown command. Only !addmsg is supported.")
            return False
        
        return False
    
    def write_status(self, status: str):
        """Write bot status to status file"""
        try:
            with open(STATUS_FILE, 'w') as f:
                f.write(f"{int(time.time())}:{status}\n")
        except:
            pass
    
    def write_pid(self):
        """Write PID to file"""
        try:
            with open(PID_FILE, 'w') as f:
                f.write(str(os.getpid()))
        except:
            pass
    
    def cleanup(self):
        """Clean up files on exit"""
        for file_path in [STATUS_FILE, PID_FILE, COMMAND_FILE]:
            try:
                if os.path.exists(file_path):
                    os.remove(file_path)
            except:
                pass
    
    def signal_handler(self, signum, frame):
        """Handle shutdown signals"""
        print("\n👋 Bot shutting down...")
        self.running = False
        self.cleanup()
        sys.exit(0)
    
    def run_daemon(self):
        """Run bot as a daemon monitoring command file"""
        print("🤖 Claude Bot - Background Service")
        print("📝 Monitoring for !addmsg commands")
        print(f"📁 Command file: {COMMAND_FILE}")
        print(f"📊 Status file: {STATUS_FILE}")
        print("✅ Bot is online and ready!")
        print("-" * 50)
        
        # Set up signal handlers
        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)
        
        # Write PID and initial status
        self.write_pid()
        self.write_status("online")
        
        # Clear command file if it exists
        if os.path.exists(COMMAND_FILE):
            os.remove(COMMAND_FILE)
        
        # Monitor for commands
        last_mtime = 0
        while self.running:
            try:
                # Check if command file exists and has been modified
                if os.path.exists(COMMAND_FILE):
                    current_mtime = os.path.getmtime(COMMAND_FILE)
                    if current_mtime > last_mtime:
                        last_mtime = current_mtime
                        
                        # Read and process command
                        with open(COMMAND_FILE, 'r') as f:
                            command = f.read().strip()
                        
                        if command:
                            print(f"\n📨 Received: {command}")
                            self.process_command(command)
                            
                        # Clear command file after processing
                        os.remove(COMMAND_FILE)
                
                # Update status periodically
                if int(time.time()) % 10 == 0:
                    self.write_status("online")
                
                # Small sleep to avoid CPU spinning
                time.sleep(0.1)
                
            except KeyboardInterrupt:
                break
            except Exception as e:
                print(f"Error in daemon loop: {e}")
                time.sleep(1)
        
        self.cleanup()
    
    def run_interactive(self):
        """Run bot in interactive mode"""
        print("🤖 Claude Bot - Simple Terminal Command Bot")
        print("📝 Available command: !addmsg \"message\" [terminal_number]")
        print("   Example: !addmsg \"ls -la\" 1")
        print("   Type 'quit' or 'exit' to stop")
        print("-" * 50)
        
        while True:
            try:
                user_input = input("bot> ").strip()
                
                if user_input.lower() in ['quit', 'exit', 'q']:
                    print("👋 Goodbye!")
                    break
                
                if user_input:
                    self.process_command(user_input)
                    
            except KeyboardInterrupt:
                print("\n👋 Goodbye!")
                break
            except EOFError:
                break
    
    def send_command(self, command: str):
        """Send a command to the running daemon"""
        try:
            with open(COMMAND_FILE, 'w') as f:
                f.write(command)
            print(f"📤 Command sent to bot: {command}")
            return True
        except Exception as e:
            print(f"❌ Failed to send command: {e}")
            return False
    
    def check_status(self):
        """Check if bot daemon is running"""
        try:
            if os.path.exists(STATUS_FILE):
                with open(STATUS_FILE, 'r') as f:
                    line = f.read().strip()
                    if line:
                        timestamp, status = line.split(':', 1)
                        age = int(time.time()) - int(timestamp)
                        if age < 30:  # Consider online if updated in last 30 seconds
                            print(f"✅ Bot is {status} (last update: {age}s ago)")
                            return True
                        else:
                            print(f"⚠️ Bot status is stale (last update: {age}s ago)")
                            return False
            print("❌ Bot is offline (no status file)")
            return False
        except Exception as e:
            print(f"❌ Failed to check status: {e}")
            return False
    
    def run_single_command(self, command: str):
        """Run a single command and exit"""
        # Check if daemon is running
        if os.path.exists(PID_FILE):
            # Send to daemon
            success = self.send_command(command)
        else:
            # Process directly
            success = self.process_command(command)
        sys.exit(0 if success else 1)

def main():
    """Main entry point"""
    bot = SimpleBot()
    
    # Parse arguments
    if len(sys.argv) > 1:
        if sys.argv[1] == '--daemon':
            # Run as daemon
            bot.run_daemon()
        elif sys.argv[1] == '--status':
            # Check status
            bot.check_status()
        elif sys.argv[1] == '--stop':
            # Stop daemon
            if os.path.exists(PID_FILE):
                with open(PID_FILE, 'r') as f:
                    pid = int(f.read())
                try:
                    os.kill(pid, signal.SIGTERM)
                    print("✅ Bot daemon stopped")
                except:
                    print("❌ Failed to stop bot daemon")
            else:
                print("❌ Bot daemon not running")
        else:
            # Treat as command
            command = ' '.join(sys.argv[1:])
            bot.run_single_command(command)
    else:
        # Run in interactive mode
        bot.run_interactive()

if __name__ == "__main__":
    main()
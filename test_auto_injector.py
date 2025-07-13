#!/usr/bin/env python3
"""
Selenium-based test automation script for the Electron Auto-Injector Terminal App.
This script enables Claude Code to:
- Take screenshots
- Click buttons based on data-test-id
- Type messages sequentially  
- Wait a set integer of seconds
- Enter hotkeys

Usage:
    python test_auto_injector.py <commands...>

Commands:
    screenshot <name>                    - Take a screenshot with given name
    click <data-test-id>                 - Click element by data-test-id
    type <text> [input-id]              - Type text into input (default: message-input)
    wait <seconds>                      - Wait for specified seconds
    hotkey <key-combination>            - Send hotkey (e.g., cmd+t, ctrl+c)
    connect                             - Connect to running Electron app
    start                               - Start Electron app with debugging
    verify <before-name> <after-name>   - Compare two screenshots for differences
    
Examples:
    python test_auto_injector.py start connect screenshot "before_test" click "plan-mode-btn" screenshot "after_click"
    python test_auto_injector.py connect screenshot "initial" type "echo hello" click "send-btn" wait 2 screenshot "after_send"
    python test_auto_injector.py connect hotkey "cmd+t" wait 1 screenshot "new_terminal"
"""

import os
import sys
import time
import json
import subprocess
import platform
import argparse
from datetime import datetime
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.common.exceptions import TimeoutException, NoSuchElementException, WebDriverException
from webdriver_manager.chrome import ChromeDriverManager
import chromedriver_binary


class AutoInjectorTester:
    def __init__(self, electron_path=None, app_path=None):
        """Initialize the tester with Electron app configuration."""
        self.electron_path = electron_path or self._find_electron_path()
        self.app_path = app_path or os.getcwd()
        self.driver = None
        self.wait = None
        self.screenshots_dir = os.path.join(self.app_path, "test_screenshots")
        self.is_mac = platform.system() == "Darwin"
        self.electron_process = None
        
        # Create screenshots directory
        os.makedirs(self.screenshots_dir, exist_ok=True)
        
        # Clean up old screenshots
        self._cleanup_old_screenshots()
        
    def _find_electron_path(self):
        """Find the Electron executable path."""
        possible_paths = [
            "./node_modules/.bin/electron",
            "./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
            "./node_modules/electron/dist/electron",
            "npx electron"
        ]
        
        for path in possible_paths:
            if os.path.exists(path):
                return path
                
        # Fallback to npx
        return "npx electron"
    
    def _cleanup_old_screenshots(self):
        """Remove screenshots older than 1 hour."""
        if not os.path.exists(self.screenshots_dir):
            return
            
        current_time = time.time()
        for filename in os.listdir(self.screenshots_dir):
            file_path = os.path.join(self.screenshots_dir, filename)
            if os.path.isfile(file_path):
                file_age = current_time - os.path.getmtime(file_path)
                if file_age > 3600:  # 1 hour
                    os.remove(file_path)
    
    def start_electron_app(self):
        """Start the Electron app with remote debugging enabled."""
        cmd = [self.electron_path, "--remote-debugging-port=9223", "."]
        
        try:
            # Start Electron with remote debugging
            self.electron_process = subprocess.Popen(cmd, cwd=self.app_path)
            print("Starting Electron app...")
            time.sleep(3)  # Wait for app to start
            return True
        except Exception as e:
            print(f"Failed to start Electron app: {e}")
            return False
    
    def connect_to_app(self):
        """Connect to the running Electron app via Chrome debugging protocol."""
        chrome_options = Options()
        chrome_options.add_experimental_option("debuggerAddress", "127.0.0.1:9223")
        chrome_options.add_argument("--no-sandbox")
        chrome_options.add_argument("--disable-dev-shm-usage")
        chrome_options.add_argument("--disable-web-security")
        chrome_options.add_argument("--allow-running-insecure-content")
        
        try:
            # Try system ChromeDriver first
            self.driver = webdriver.Chrome(options=chrome_options)
            self.wait = WebDriverWait(self.driver, 10)
            print("Connected to Electron app")
            return True
        except Exception as e:
            try:
                # Fallback to webdriver manager
                service = Service(ChromeDriverManager().install())
                self.driver = webdriver.Chrome(service=service, options=chrome_options)
                self.wait = WebDriverWait(self.driver, 10)
                print("Connected to Electron app")
                return True
            except Exception as e2:
                print(f"Failed to connect to Electron app: {e2}")
                return False
    
    def take_screenshot(self, name):
        """Take a screenshot and save it with timestamp."""
        if not self.driver:
            print("Error: Not connected to app. Use 'connect' command first.")
            return False
            
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{timestamp}_{name}.png"
        filepath = os.path.join(self.screenshots_dir, filename)
        
        try:
            self.driver.save_screenshot(filepath)
            print(f"Screenshot saved: {filename}")
            return True
        except Exception as e:
            print(f"Failed to take screenshot: {e}")
            return False
    
    def click_by_test_id(self, test_id):
        """Click a button by its data-test-id attribute."""
        if not self.driver:
            print("Error: Not connected to app. Use 'connect' command first.")
            return False
            
        try:
            element = self.wait.until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, f'[data-test-id="{test_id}"]'))
            )
            element.click()
            print(f"Clicked element with test-id: {test_id}")
            return True
        except TimeoutException:
            print(f"Element with test-id '{test_id}' not found or not clickable")
            return False
        except Exception as e:
            print(f"Error clicking element with test-id '{test_id}': {e}")
            return False
    
    def type_message(self, text, test_id="message-input"):
        """Type a message into the specified input field."""
        if not self.driver:
            print("Error: Not connected to app. Use 'connect' command first.")
            return False
            
        try:
            element = self.wait.until(
                EC.presence_of_element_located((By.CSS_SELECTOR, f'[data-test-id="{test_id}"]'))
            )
            element.clear()
            element.send_keys(text)
            print(f"Typed message: '{text}'")
            return True
        except Exception as e:
            print(f"Error typing message: {e}")
            return False
    
    def wait_seconds(self, seconds):
        """Wait for a specified number of seconds."""
        try:
            seconds = float(seconds)
            print(f"Waiting {seconds} seconds...")
            time.sleep(seconds)
            return True
        except ValueError:
            print(f"Invalid wait time: {seconds}")
            return False
    
    def send_hotkey(self, hotkey):
        """Send a hotkey combination."""
        if not self.driver:
            print("Error: Not connected to app. Use 'connect' command first.")
            return False
            
        try:
            actions = ActionChains(self.driver)
            
            # Parse hotkey string (e.g., "cmd+t", "ctrl+c")
            keys = hotkey.lower().split('+')
            
            # Build key combination
            if self.is_mac:
                key_map = {
                    'cmd': Keys.COMMAND,
                    'ctrl': Keys.CONTROL,
                    'shift': Keys.SHIFT,
                    'alt': Keys.ALT,
                    'option': Keys.ALT
                }
            else:
                key_map = {
                    'cmd': Keys.CONTROL,  # Map cmd to ctrl on non-Mac
                    'ctrl': Keys.CONTROL,
                    'shift': Keys.SHIFT,
                    'alt': Keys.ALT
                }
            
            # Press modifier keys
            for key in keys[:-1]:
                if key in key_map:
                    actions.key_down(key_map[key])
            
            # Press the main key
            main_key = keys[-1].upper()
            if hasattr(Keys, main_key):
                actions.send_keys(getattr(Keys, main_key))
            else:
                actions.send_keys(main_key)
            
            # Release modifier keys
            for key in reversed(keys[:-1]):
                if key in key_map:
                    actions.key_up(key_map[key])
            
            actions.perform()
            print(f"Sent hotkey: {hotkey}")
            return True
        except Exception as e:
            print(f"Error sending hotkey '{hotkey}': {e}")
            return False
    
    def execute_commands(self, commands):
        """Execute a list of commands sequentially."""
        results = []
        has_start = any(cmd[0].lower() == "start" for cmd in commands if cmd)
        has_connect = any(cmd[0].lower() == "connect" for cmd in commands if cmd)
        
        # Validation: if connect is present but start is not, give error
        if has_connect and not has_start:
            print("Error: 'connect' command found but 'start' command is missing. Always use 'start' before 'connect'.")
            return [False]
        
        for i, command in enumerate(commands):
            print(f"\n[{i+1}/{len(commands)}] Executing: {' '.join(command)}")
            
            if not command:
                continue
                
            cmd = command[0].lower()
            args = command[1:]
            
            if cmd == "start":
                result = self.start_electron_app()
                if result:
                    # Always wait 15 seconds after start
                    print("Waiting 15 seconds after start...")
                    time.sleep(15)
            elif cmd == "connect":
                result = self.connect_to_app()
            elif cmd == "screenshot":
                if not args:
                    print("Error: screenshot requires a name")
                    result = False
                else:
                    result = self.take_screenshot(args[0])
            elif cmd == "click":
                if not args:
                    print("Error: click requires a data-test-id")
                    result = False
                else:
                    result = self.click_by_test_id(args[0])
            elif cmd == "type":
                if not args:
                    print("Error: type requires text")
                    result = False
                else:
                    input_id = args[1] if len(args) > 1 else "message-input"
                    result = self.type_message(args[0], input_id)
            elif cmd == "wait":
                if not args:
                    print("Error: wait requires seconds")
                    result = False
                else:
                    result = self.wait_seconds(args[0])
            elif cmd == "hotkey":
                if not args:
                    print("Error: hotkey requires key combination")
                    result = False
                else:
                    result = self.send_hotkey(args[0])
            elif cmd == "verify":
                if len(args) < 2:
                    print("Error: verify requires two screenshot names")
                    result = False
                else:
                    before_file = None
                    after_file = None
                    # Find the most recent screenshots with the given names
                    for filename in os.listdir(self.screenshots_dir):
                        if args[0] in filename:
                            before_file = os.path.join(self.screenshots_dir, filename)
                        if args[1] in filename:
                            after_file = os.path.join(self.screenshots_dir, filename)
                    
                    if before_file and after_file:
                        result = self.verify_screenshots(before_file, after_file)
                        if result is None:
                            result = False  # Treat comparison errors as failures
                    else:
                        print(f"Error: Could not find screenshots for '{args[0]}' and/or '{args[1]}'")
                        result = False
            else:
                print(f"Unknown command: {cmd}")
                result = False
            
            results.append(result)
            
            if not result:
                print(f"Command failed: {' '.join(command)}")
            
            # Add 2-second delay between commands (except for the last one)
            if i < len(commands) - 1:
                time.sleep(2)
        
        return results
    
    def verify_screenshots(self, before_path, after_path):
        """Compare two screenshots to verify if changes occurred."""
        try:
            from PIL import Image
            import numpy as np
            
            # Load images
            before_img = Image.open(before_path)
            after_img = Image.open(after_path)
            
            # Convert to same size if needed
            if before_img.size != after_img.size:
                print(f"Warning: Screenshot sizes differ - Before: {before_img.size}, After: {after_img.size}")
                # Resize to smallest common size
                min_width = min(before_img.width, after_img.width)
                min_height = min(before_img.height, after_img.height)
                before_img = before_img.resize((min_width, min_height))
                after_img = after_img.resize((min_width, min_height))
            
            # Convert to numpy arrays
            before_array = np.array(before_img)
            after_array = np.array(after_img)
            
            # Calculate difference
            diff = np.abs(before_array.astype(float) - after_array.astype(float))
            total_diff = np.sum(diff)
            max_possible_diff = before_array.size * 255
            
            # Calculate percentage difference
            diff_percentage = (total_diff / max_possible_diff) * 100
            
            print(f"Screenshot comparison:")
            print(f"  Before: {before_path}")
            print(f"  After: {after_path}")
            print(f"  Difference: {diff_percentage:.2f}%")
            
            # Consider significant if > 0.1% difference
            if diff_percentage > 0.1:
                print("  ✓ VERIFICATION PASSED: Screenshots show visible changes")
                return True
            else:
                print("  ✗ VERIFICATION FAILED: Screenshots appear identical (no changes detected)")
                return False
                
        except ImportError:
            print("PIL (Pillow) not available for screenshot comparison. Install with: pip install Pillow")
            return None
        except Exception as e:
            print(f"Error comparing screenshots: {e}")
            return None
    
    def cleanup(self):
        """Clean up resources."""
        if self.driver:
            self.driver.quit()
        if self.electron_process:
            self.electron_process.terminate()
            time.sleep(1)  # Give process time to terminate


def parse_commands(args):
    """Parse command line arguments into command groups."""
    commands = []
    current_command = []
    
    for arg in args:
        if arg.lower() in ['start', 'connect', 'screenshot', 'click', 'type', 'wait', 'hotkey', 'verify']:
            if current_command:
                commands.append(current_command)
            current_command = [arg]
        else:
            current_command.append(arg)
    
    if current_command:
        commands.append(current_command)
    
    return commands


def main():
    """Main function to run the test automation."""
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    
    # Parse commands from arguments
    commands = parse_commands(sys.argv[1:])
    
    if not commands:
        print("No valid commands provided")
        print(__doc__)
        return 1
    
    # Initialize tester
    tester = AutoInjectorTester()
    
    try:
        # Execute commands
        results = tester.execute_commands(commands)
        
        # Print summary
        passed = sum(results)
        total = len(results)
        print(f"\n=== Summary ===")
        print(f"Commands executed: {total}")
        print(f"Successful: {passed}")
        print(f"Failed: {total - passed}")
        
        # Return appropriate exit code
        return 0 if all(results) else 1
        
    except Exception as e:
        print(f"Test execution failed: {e}")
        return 1
    finally:
        # Cleanup
        tester.cleanup()


if __name__ == "__main__":
    exit_code = main()
    sys.exit(exit_code)
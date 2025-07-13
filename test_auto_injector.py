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
    close_terminal <terminal-id>         - Close specific terminal by ID
    type <text> [input-id]              - Type text into input (default: message-input)
    wait <seconds>                      - Wait for specified seconds
    hotkey <key-combination>            - Send hotkey (e.g., cmd+t, ctrl+c)
    connect                             - Connect to running Electron app
    start                               - Start Electron app with debugging
    console_logs / logs                 - Print renderer console output from the app
    main_logs                           - Print main process logs from Electron
    all_logs                            - Print both main process and renderer logs
    verify <before-name> <after-name>   - Compare two screenshots for differences
    compare <name1> <name2> [description] - Detailed comparison of two screenshots
    review <name1> <name2> <description> - Send screenshots to Claude for unbiased review
    
Examples:
    python test_auto_injector.py start connect screenshot "before_test" click "plan-mode-btn" screenshot "after_click"
    python test_auto_injector.py connect screenshot "initial" type "echo hello" click "send-btn" wait 2 screenshot "after_send"
    python test_auto_injector.py connect hotkey "cmd+t" wait 1 screenshot "new_terminal"
    python test_auto_injector.py start connect main_logs  # See Electron main process errors
    python test_auto_injector.py start connect all_logs   # See both main and renderer console logs

Note: Console logs are automatically displayed after 'connect' command to aid in debugging.
"""

import os
import sys
import time
import json
import subprocess
import platform
import argparse
import threading
import queue
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
        
        # Log capture for main process
        self.main_process_logs = []
        self.log_capture_threads = []
        self.log_queue = queue.Queue()
        self.max_log_entries = 1000  # Limit memory usage
        
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
    
    def _start_log_capture(self):
        """Start thread to capture main process logs."""
        if self.electron_process and self.electron_process.stdout:
            log_thread = threading.Thread(
                target=self._capture_logs, 
                args=(self.electron_process.stdout,),
                daemon=True
            )
            log_thread.start()
            self.log_capture_threads.append(log_thread)
    
    def _capture_logs(self, stream):
        """Capture logs from subprocess stream."""
        try:
            while self.electron_process and self.electron_process.poll() is None:
                line = stream.readline()
                if line:
                    timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                    log_entry = {
                        'timestamp': timestamp,
                        'level': 'MAIN',
                        'message': line.strip()
                    }
                    
                    # Add to main process logs with size limit
                    self.main_process_logs.append(log_entry)
                    if len(self.main_process_logs) > self.max_log_entries:
                        self.main_process_logs.pop(0)  # Remove oldest entry
        except Exception as e:
            # Log capture failed, but don't interrupt main execution
            pass
    
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
            # Start Electron with remote debugging and capture output
            self.electron_process = subprocess.Popen(
                cmd, 
                cwd=self.app_path,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,  # Merge stderr into stdout
                universal_newlines=True,
                bufsize=1  # Line buffered
            )
            
            # Start log capture thread
            self._start_log_capture()
            
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
        
        # Enable browser logging to capture console output (simplified approach)
        
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
    
    def click_close_terminal_by_id(self, terminal_id):
        """Click the close button for a specific terminal ID."""
        if not self.driver:
            print("Error: Not connected to app. Use 'connect' command first.")
            return False
            
        try:
            # Find the close button for the specific terminal
            element = self.wait.until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, f'.close-terminal-btn[data-terminal-id="{terminal_id}"]'))
            )
            element.click()
            print(f"Clicked close button for terminal {terminal_id}")
            return True
        except TimeoutException:
            print(f"Close button for terminal {terminal_id} not found or not clickable")
            return False
        except Exception as e:
            print(f"Error clicking close button for terminal {terminal_id}: {e}")
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
    
    def print_main_process_logs(self):
        """Print main process logs captured from Electron subprocess."""
        if not self.main_process_logs:
            print("No main process logs captured yet. (App may not be started or no output generated)")
            return True
            
        print("\n=== MAIN PROCESS LOGS ===")
        for log in self.main_process_logs:
            timestamp = log.get('timestamp', '')
            level = log.get('level', 'MAIN')
            message = log.get('message', '')
            print(f"[{timestamp}] [{level}] {message}")
        
        print("=== END MAIN PROCESS LOGS ===\n")
        return True
    
    def print_all_logs(self):
        """Print both main process and renderer console logs."""
        success = True
        
        # Print main process logs first
        if not self.print_main_process_logs():
            success = False
            
        # Print renderer logs second  
        if not self.print_console_logs():
            success = False
            
        return success
    
    def print_console_logs(self):
        """Print all console logs from the browser using multiple methods."""
        if not self.driver:
            print("Error: Not connected to app. Use 'connect' command first.")
            return False
            
        has_logs = False
        
        try:
            # Method 1: Try to get browser logs via Selenium (works for some types)
            try:
                browser_logs = self.driver.get_log('browser')
                if browser_logs:
                    print("\n=== BROWSER LOGS (VIA SELENIUM) ===")
                    for entry in browser_logs:
                        timestamp = entry.get('timestamp', 0)
                        if timestamp:
                            import datetime
                            dt = datetime.datetime.fromtimestamp(timestamp/1000)
                            time_str = dt.strftime('%H:%M:%S.%f')[:-3]
                        else:
                            time_str = "unknown"
                        level = entry.get('level', 'INFO')
                        message = entry.get('message', '')
                        print(f"[{time_str}] [{level}] {message}")
                    print("=== END BROWSER LOGS ===\n")
                    has_logs = True
            except Exception as selenium_log_error:
                # Browser logs not available via Selenium, continue to next method
                pass
            
            # Method 2: Enhanced JavaScript execution to capture console activity
            js_code = """
            // Enhanced console capture with immediate retrieval
            (function() {
                if (!window.consoleCapture) {
                    window.consoleCapture = {
                        logs: [],
                        initialized: false
                    };
                    
                    // Store original console methods
                    const original = {
                        log: console.log,
                        error: console.error,
                        warn: console.warn,
                        info: console.info,
                        debug: console.debug
                    };
                    
                    // Override console methods
                    ['log', 'error', 'warn', 'info', 'debug'].forEach(method => {
                        console[method] = function(...args) {
                            const timestamp = Date.now();
                            const message = args.map(arg => 
                                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
                            ).join(' ');
                            
                            window.consoleCapture.logs.push({
                                level: method.toUpperCase(),
                                message: message,
                                timestamp: timestamp,
                                args: args
                            });
                            
                            // Call original method
                            original[method].apply(console, args);
                        };
                    });
                    
                    // Capture unhandled errors
                    window.addEventListener('error', function(event) {
                        window.consoleCapture.logs.push({
                            level: 'ERROR',
                            message: `Uncaught ${event.error?.name || 'Error'}: ${event.error?.message || event.message}`,
                            timestamp: Date.now(),
                            stack: event.error?.stack,
                            filename: event.filename,
                            lineno: event.lineno,
                            colno: event.colno
                        });
                    });
                    
                    // Capture unhandled promise rejections
                    window.addEventListener('unhandledrejection', function(event) {
                        window.consoleCapture.logs.push({
                            level: 'ERROR',
                            message: `Unhandled Promise Rejection: ${event.reason}`,
                            timestamp: Date.now(),
                            reason: event.reason
                        });
                    });
                    
                    window.consoleCapture.initialized = true;
                }
                
                return window.consoleCapture.logs;
            })();
            """
            
            logs = self.driver.execute_script(js_code)
            
            if logs and len(logs) > 0:
                print("\n=== RENDERER CONSOLE OUTPUT ===")
                for log in logs:
                    level = log.get('level', 'LOG')
                    message = log.get('message', '')
                    timestamp = log.get('timestamp', '')
                    stack = log.get('stack', '')
                    filename = log.get('filename', '')
                    lineno = log.get('lineno', '')
                    
                    if timestamp:
                        import datetime
                        dt = datetime.datetime.fromtimestamp(timestamp/1000)
                        time_str = dt.strftime('%H:%M:%S.%f')[:-3]
                    else:
                        time_str = "unknown"
                    
                    print(f"[{time_str}] [{level}] {message}")
                    
                    # Print additional error details if available
                    if filename and lineno:
                        print(f"    at {filename}:{lineno}")
                    if stack and level == 'ERROR':
                        # Print first few lines of stack trace
                        stack_lines = stack.split('\n')[:3]
                        for line in stack_lines:
                            if line.strip():
                                print(f"    {line.strip()}")
                
                # Clear the log array after printing
                self.driver.execute_script("if (window.consoleCapture) window.consoleCapture.logs = [];")
                print("=== END RENDERER CONSOLE OUTPUT ===\n")
                has_logs = True
            
            if not has_logs:
                print("No renderer console logs found. (Console logging may not be active yet)")
            return True
        except Exception as e:
            print(f"Error getting renderer console logs: {e}")
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
                if result:
                    # Automatically print logs after successful connection
                    print("\n--- AUTOMATIC LOG CAPTURE AFTER CONNECT ---")
                    self.print_all_logs()
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
            elif cmd == "close_terminal":
                if not args:
                    print("Error: close_terminal requires a terminal ID")
                    result = False
                else:
                    result = self.click_close_terminal_by_id(args[0])
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
            elif cmd == "console_logs" or cmd == "logs":
                result = self.print_console_logs()
            elif cmd == "main_logs":
                result = self.print_main_process_logs()
            elif cmd == "all_logs":
                result = self.print_all_logs()
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
            elif cmd == "compare":
                if len(args) < 2:
                    print("Error: compare requires two screenshot names")
                    result = False
                else:
                    description = " ".join(args[2:]) if len(args) > 2 else ""
                    result = self.detailed_compare_screenshots(args[0], args[1], description)
            elif cmd == "review":
                if len(args) < 2:
                    print("Error: review requires two screenshot names")
                    result = False
                else:
                    description = " ".join(args[2:]) if len(args) > 2 else ""
                    result = self.claude_review_screenshots(args[0], args[1], description)
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
    
    def detailed_compare_screenshots(self, name1, name2, description=""):
        """Perform detailed comparison of two screenshots with difference highlighting."""
        # Find the most recent screenshots with the given names
        file1 = None
        file2 = None
        
        for filename in sorted(os.listdir(self.screenshots_dir), reverse=True):
            if name1 in filename and not file1:
                file1 = os.path.join(self.screenshots_dir, filename)
            if name2 in filename and not file2:
                file2 = os.path.join(self.screenshots_dir, filename)
            if file1 and file2:
                break
        
        if not file1 or not file2:
            print(f"Error: Could not find screenshots for '{name1}' and/or '{name2}'")
            return False
        
        try:
            from PIL import Image, ImageDraw, ImageFont
            import numpy as np
            
            print(f"\n=== DETAILED SCREENSHOT COMPARISON ===")
            print(f"Description: {description}")
            print(f"Comparing: {os.path.basename(file1)} vs {os.path.basename(file2)}")
            
            # Load images
            img1 = Image.open(file1)
            img2 = Image.open(file2)
            
            # Ensure same size
            if img1.size != img2.size:
                print(f"Resizing images: {img1.size} -> {img2.size}")
                img1 = img1.resize(img2.size)
            
            # Convert to arrays for analysis
            arr1 = np.array(img1)
            arr2 = np.array(img2)
            
            # Calculate differences
            diff = np.abs(arr1.astype(float) - arr2.astype(float))
            total_diff = np.sum(diff)
            max_possible_diff = arr1.size * 255
            diff_percentage = (total_diff / max_possible_diff) * 100
            
            # Find regions with significant differences
            threshold = 30  # Pixel difference threshold
            diff_mask = np.any(diff > threshold, axis=2)
            
            # Create difference visualization
            diff_img = Image.fromarray((diff_mask * 255).astype(np.uint8))
            
            print(f"Overall difference: {diff_percentage:.3f}%")
            print(f"Changed pixels: {np.sum(diff_mask)}/{diff_mask.size} ({100*np.sum(diff_mask)/diff_mask.size:.2f}%)")
            
            # Save difference image
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            diff_filename = f"{timestamp}_diff_{name1}_vs_{name2}.png"
            diff_path = os.path.join(self.screenshots_dir, diff_filename)
            diff_img.save(diff_path)
            print(f"Difference mask saved: {diff_filename}")
            
            # Analyze regions of change
            if np.sum(diff_mask) > 0:
                # Find bounding boxes of changed regions
                changed_rows = np.any(diff_mask, axis=1)
                changed_cols = np.any(diff_mask, axis=0)
                
                if np.any(changed_rows) and np.any(changed_cols):
                    top = np.argmax(changed_rows)
                    bottom = len(changed_rows) - np.argmax(changed_rows[::-1]) - 1
                    left = np.argmax(changed_cols)
                    right = len(changed_cols) - np.argmax(changed_cols[::-1]) - 1
                    
                    print(f"Primary change region: ({left},{top}) to ({right},{bottom})")
                    print(f"Change area: {(right-left)*(bottom-top)} pixels")
            
            return diff_percentage > 0.1
            
        except ImportError:
            print("PIL (Pillow) and numpy required for detailed comparison. Install with: pip install Pillow numpy")
            return None
        except Exception as e:
            print(f"Error in detailed comparison: {e}")
            return None
    
    def claude_review_screenshots(self, name1, name2, description=""):
        """Send screenshots to a separate Claude process for unbiased review."""
        # Find the screenshot files
        file1 = None
        file2 = None
        
        for filename in sorted(os.listdir(self.screenshots_dir), reverse=True):
            if name1 in filename and not file1:
                file1 = os.path.join(self.screenshots_dir, filename)
            if name2 in filename and not file2:
                file2 = os.path.join(self.screenshots_dir, filename)
            if file1 and file2:
                break
        
        if not file1 or not file2:
            print(f"Error: Could not find screenshots for '{name1}' and/or '{name2}'")
            return False
        
        print(f"\n=== CLAUDE REVIEW REQUEST ===")
        print(f"Description: {description}")
        print(f"Screenshots: {os.path.basename(file1)} vs {os.path.basename(file2)}")
        print(f"")
        print(f"REVIEW INSTRUCTIONS:")
        print(f"Please analyze these two screenshots and provide an unbiased assessment:")
        print(f"1. What are the visible differences between the screenshots?")
        print(f"2. Based on the description '{description}', did the expected changes occur?")
        print(f"3. Are there any unexpected changes or visual artifacts?")
        print(f"4. Rate the success of the change implementation (1-10)")
        print(f"")
        print(f"Screenshot paths for manual review:")
        print(f"Before: {file1}")
        print(f"After:  {file2}")
        
        # Create a review report file
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        review_filename = f"{timestamp}_review_{name1}_vs_{name2}.txt"
        review_path = os.path.join(self.screenshots_dir, review_filename)
        
        with open(review_path, 'w') as f:
            f.write(f"Screenshot Review Request\n")
            f.write(f"========================\n")
            f.write(f"Timestamp: {datetime.now().isoformat()}\n")
            f.write(f"Description: {description}\n")
            f.write(f"Before: {file1}\n")
            f.write(f"After:  {file2}\n")
            f.write(f"\nReview Instructions:\n")
            f.write(f"1. Analyze visible differences between screenshots\n")
            f.write(f"2. Assess if expected changes occurred\n")
            f.write(f"3. Identify unexpected changes or artifacts\n")
            f.write(f"4. Rate implementation success (1-10)\n")
            f.write(f"\n[Review results to be added by external Claude process]\n")
        
        print(f"Review request saved: {review_filename}")
        print(f"*** ACTION REQUIRED: Send both screenshots to a separate Claude instance for review ***")
        
        return True
    
    def cleanup(self):
        """Clean up resources."""
        if self.driver:
            self.driver.quit()
        if self.electron_process:
            self.electron_process.terminate()
            time.sleep(1)  # Give process time to terminate
            
        # Clear log buffers
        self.main_process_logs.clear()
        
        # Log capture threads are daemon threads and will cleanup automatically


def parse_commands(args):
    """Parse command line arguments into command groups."""
    commands = []
    current_command = []
    
    for arg in args:
        if arg.lower() in ['start', 'connect', 'screenshot', 'click', 'close_terminal', 'type', 'wait', 'hotkey', 'verify', 'compare', 'review', 'console_logs', 'logs', 'main_logs', 'all_logs']:
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
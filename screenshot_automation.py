#!/usr/bin/env python3
"""
Electron App Screenshot Automation
Automatically takes screenshots of the Electron app interface for testing
"""

import time
import os
import subprocess
import sys
from datetime import datetime
import json
import psutil
import signal

try:
    import pyautogui
    import PIL
    from PIL import Image
except ImportError:
    print("Required packages not found. Installing...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pyautogui", "pillow"])
    import pyautogui
    import PIL
    from PIL import Image

# Disable pyautogui failsafe for automation
pyautogui.FAILSAFE = False

class ElectronAppTester:
    def __init__(self, app_path="/Users/ethan/claude code bot"):
        self.app_path = app_path
        self.app_process = None
        self.screenshots_dir = None
        self.test_sequence = []
        self.window_bounds = None
        
    def setup_screenshot_directory(self, directory_name="initialized"):
        """Create directory for screenshots"""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.screenshots_dir = os.path.join(self.app_path, f"screenshots_{directory_name}_{timestamp}")
        os.makedirs(self.screenshots_dir, exist_ok=True)
        print(f"📁 Screenshots will be saved to: {self.screenshots_dir}")
        return self.screenshots_dir
        
    def start_electron_app(self):
        """Start the Electron application"""
        print("🚀 Starting Electron app...")
        
        # Change to app directory
        os.chdir(self.app_path)
        
        # Start the app
        try:
            self.app_process = subprocess.Popen(
                ["npm", "start"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                preexec_fn=os.setsid if os.name != 'nt' else None
            )
            
            # Wait for app to start
            print("⏳ Waiting for app to start...")
            time.sleep(8)
            
            # Find the app window
            self.find_app_window()
            
            return True
            
        except Exception as e:
            print(f"❌ Failed to start app: {e}")
            return False
    
    def find_app_window(self):
        """Find and focus the Electron app window"""
        print("🔍 Looking for app window...")
        
        # Try to find window by process name or title
        try:
            # Use AppleScript on macOS to find and focus window
            if sys.platform == "darwin":
                subprocess.run([
                    "osascript", "-e",
                    'tell application "System Events" to set frontmost of first process whose name contains "Electron" to true'
                ], check=False)
                
            time.sleep(2)
            
            # Get screen size for reference
            screen_width, screen_height = pyautogui.size()
            print(f"📺 Screen size: {screen_width}x{screen_height}")
            
            # Assume app takes center portion of screen
            self.window_bounds = {
                'left': screen_width // 6,
                'top': screen_height // 6, 
                'width': (screen_width * 2) // 3,
                'height': (screen_height * 2) // 3
            }
            
            print(f"🎯 App window bounds: {self.window_bounds}")
            
        except Exception as e:
            print(f"⚠️ Could not determine window bounds: {e}")
            
    def take_screenshot(self, name, description=""):
        """Take a screenshot of the current state"""
        if not self.screenshots_dir:
            print("❌ Screenshot directory not set up")
            return None
            
        timestamp = datetime.now().strftime("%H%M%S")
        filename = f"{timestamp}_{name}.png"
        filepath = os.path.join(self.screenshots_dir, filename)
        
        try:
            # Take screenshot
            if self.window_bounds:
                # Screenshot just the app window area
                screenshot = pyautogui.screenshot(
                    region=(
                        self.window_bounds['left'],
                        self.window_bounds['top'],
                        self.window_bounds['width'],
                        self.window_bounds['height']
                    )
                )
            else:
                # Full screen screenshot
                screenshot = pyautogui.screenshot()
                
            screenshot.save(filepath)
            
            # Save metadata
            metadata = {
                'name': name,
                'description': description,
                'timestamp': datetime.now().isoformat(),
                'filename': filename,
                'window_bounds': self.window_bounds
            }
            
            metadata_file = filepath.replace('.png', '_metadata.json')
            with open(metadata_file, 'w') as f:
                json.dump(metadata, f, indent=2)
                
            print(f"📸 Screenshot saved: {filename} - {description}")
            return filepath
            
        except Exception as e:
            print(f"❌ Failed to take screenshot {name}: {e}")
            return None
    
    def click_element(self, x, y, description="", wait_after=2):
        """Click at specific coordinates and take screenshot"""
        try:
            # Adjust coordinates relative to window bounds
            if self.window_bounds:
                abs_x = self.window_bounds['left'] + x
                abs_y = self.window_bounds['top'] + y
            else:
                abs_x, abs_y = x, y
                
            print(f"🖱️ Clicking at ({abs_x}, {abs_y}) - {description}")
            pyautogui.click(abs_x, abs_y)
            time.sleep(wait_after)
            
            # Take screenshot after click
            screenshot_name = description.lower().replace(' ', '_').replace('/', '_')
            return self.take_screenshot(f"click_{screenshot_name}", f"After clicking: {description}")
            
        except Exception as e:
            print(f"❌ Failed to click {description}: {e}")
            return None
    
    def run_comprehensive_test_suite(self):
        """Run a comprehensive test of all UI elements"""
        print("🧪 Starting comprehensive UI test suite...")
        
        # Initial state
        self.take_screenshot("00_initial_state", "Initial app state")
        time.sleep(2)
        
        # Define test sequence with relative coordinates (these will need adjustment)
        test_sequence = [
            # Main UI elements
            (50, 50, "Menu/Settings area", 2),
            (200, 100, "Terminal area", 2),
            (600, 100, "Message input area", 2),
            
            # Sidebar buttons (right side)
            (950, 150, "Timer controls", 2),
            (950, 200, "Auto-continue button", 2),
            (950, 250, "Voice button", 2),
            (950, 300, "Settings button", 2),
            
            # Message queue area
            (800, 400, "Message queue area", 2),
            (900, 450, "Add message button", 2),
            
            # Terminal controls
            (100, 50, "Terminal selector", 2),
            (150, 50, "New terminal button", 2),
            
            # Timer area
            (850, 100, "Timer display", 2),
            (900, 130, "Timer play/pause", 2),
            (920, 130, "Timer stop", 2),
            
            # Action log area
            (800, 600, "Action log area", 2),
            (850, 630, "Clear log button", 2),
            
            # Status indicators
            (800, 50, "Status area", 1),
            (850, 70, "Directory status", 1),
            (850, 90, "Injection status", 1),
        ]
        
        # Execute test sequence
        for i, (x, y, description, wait_time) in enumerate(test_sequence):
            print(f"\n🔄 Test {i+1}/{len(test_sequence)}: {description}")
            self.click_element(x, y, description, wait_time)
            
        # Test some keyboard interactions
        print("\n⌨️ Testing keyboard interactions...")
        
        # Focus message input and type
        self.click_element(600, 200, "Message input focus", 1)
        pyautogui.typewrite("Test message for screenshot")
        time.sleep(1)
        self.take_screenshot("keyboard_input", "After typing in message input")
        
        # Clear the input
        pyautogui.selectAll()
        pyautogui.press('delete')
        time.sleep(1)
        
        # Test some hotkeys
        hotkey_tests = [
            (['cmd', 'shift', 'i'], "Developer tools toggle"),
            (['cmd', 'r'], "Refresh app"),
        ]
        
        for keys, description in hotkey_tests:
            print(f"⌨️ Testing hotkey: {' + '.join(keys)} - {description}")
            try:
                pyautogui.hotkey(*keys)
                time.sleep(2)
                self.take_screenshot(f"hotkey_{'_'.join(keys)}", f"After {description}")
            except Exception as e:
                print(f"⚠️ Hotkey test failed: {e}")
        
        # Final state
        time.sleep(2)
        self.take_screenshot("99_final_state", "Final app state after all tests")
        
        print(f"✅ Test suite complete! Screenshots saved to: {self.screenshots_dir}")
        
    def stop_electron_app(self):
        """Stop the Electron application"""
        if self.app_process:
            print("🛑 Stopping Electron app...")
            try:
                # Try graceful shutdown first
                if os.name != 'nt':
                    os.killpg(os.getpgid(self.app_process.pid), signal.SIGTERM)
                else:
                    self.app_process.terminate()
                    
                # Wait a bit for graceful shutdown
                time.sleep(3)
                
                # Force kill if still running
                if self.app_process.poll() is None:
                    if os.name != 'nt':
                        os.killpg(os.getpgid(self.app_process.pid), signal.SIGKILL)
                    else:
                        self.app_process.kill()
                        
                print("✅ App stopped successfully")
                
            except Exception as e:
                print(f"⚠️ Error stopping app: {e}")
                
            self.app_process = None
    
    def run_quick_test(self, test_name="quick"):
        """Run a quick test with just essential screenshots"""
        print(f"⚡ Running quick test: {test_name}")
        
        # Essential screenshots
        essential_tests = [
            ("initial", "Initial state"),
            ("terminal_area", "Terminal interaction area"), 
            ("sidebar", "Sidebar controls"),
            ("message_queue", "Message queue area"),
            ("timer_controls", "Timer controls"),
            ("final", "Final state")
        ]
        
        for name, description in essential_tests:
            self.take_screenshot(name, description)
            time.sleep(1)
            
        print(f"✅ Quick test complete!")

def main():
    """Main execution function"""
    print("🎯 Electron App Screenshot Automation")
    print("=" * 50)
    
    # Parse command line arguments
    import argparse
    parser = argparse.ArgumentParser(description='Automate Electron app screenshots')
    parser.add_argument('--directory', '-d', default='initialized', 
                       help='Screenshot directory name (default: initialized)')
    parser.add_argument('--quick', '-q', action='store_true', 
                       help='Run quick test instead of comprehensive')
    parser.add_argument('--no-start', '-n', action='store_true',
                       help='Skip starting the app (assume already running)')
    
    args = parser.parse_args()
    
    # Create tester instance
    tester = ElectronAppTester()
    
    try:
        # Setup screenshot directory
        tester.setup_screenshot_directory(args.directory)
        
        # Start app if requested
        if not args.no_start:
            if not tester.start_electron_app():
                print("❌ Failed to start app. Exiting.")
                return 1
        else:
            print("📱 Assuming app is already running...")
            tester.find_app_window()
        
        # Run appropriate test suite
        if args.quick:
            tester.run_quick_test()
        else:
            tester.run_comprehensive_test_suite()
            
        print(f"\n🎉 Screenshot automation complete!")
        print(f"📁 Results saved to: {tester.screenshots_dir}")
        
        return 0
        
    except KeyboardInterrupt:
        print("\n⚠️ Test interrupted by user")
        return 1
        
    except Exception as e:
        print(f"\n❌ Test failed with error: {e}")
        return 1
        
    finally:
        # Always try to stop the app
        if not args.no_start:
            tester.stop_electron_app()

if __name__ == "__main__":
    exit(main())
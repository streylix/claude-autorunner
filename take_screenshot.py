#!/usr/bin/env python3
"""
Screenshot Tool for Terminal GUI Application
Takes screenshots of the running Electron app for debugging
"""

import subprocess
import time
import os
from datetime import datetime

def take_screenshot():
    """Take a screenshot of the current desktop"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    screenshot_path = f"/tmp/terminal_gui_screenshot_{timestamp}.png"
    
    try:
        # Use macOS screencapture to take a screenshot
        subprocess.run([
            'screencapture', 
            '-x',  # No sound
            screenshot_path
        ], check=True)
        
        print(f"Screenshot saved to: {screenshot_path}")
        return screenshot_path
        
    except subprocess.CalledProcessError as e:
        print(f"Failed to take screenshot: {e}")
        return None

def check_electron_processes():
    """Check if Electron processes are running"""
    try:
        result = subprocess.run([
            'ps', 'aux'
        ], capture_output=True, text=True, check=True)
        
        electron_processes = []
        for line in result.stdout.split('\n'):
            if 'electron' in line.lower() and 'claude code bot' in line:
                electron_processes.append(line.strip())
        
        print(f"Found {len(electron_processes)} Electron processes:")
        for process in electron_processes:
            print(f"  {process}")
        
        return len(electron_processes) > 0
        
    except subprocess.CalledProcessError as e:
        print(f"Failed to check processes: {e}")
        return False

def main():
    print("=== Terminal GUI Screenshot Tool ===")
    print()
    
    # Check if Electron is running
    if not check_electron_processes():
        print("❌ No Electron processes found. Is the application running?")
        return
    
    print("✅ Electron application detected")
    print()
    
    # Take screenshot
    print("Taking screenshot...")
    screenshot_path = take_screenshot()
    
    if screenshot_path:
        print(f"✅ Screenshot captured: {screenshot_path}")
        
        # Try to open the screenshot
        try:
            subprocess.run(['open', screenshot_path], check=True)
            print("📷 Screenshot opened in default viewer")
        except subprocess.CalledProcessError:
            print("📷 Screenshot saved but couldn't open automatically")
    else:
        print("❌ Failed to capture screenshot")

if __name__ == "__main__":
    main()
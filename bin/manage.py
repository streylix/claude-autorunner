#!/usr/bin/env python3
"""
Convenience script for adding messages to the message queue.

Usage:
    python manage.py addMessage "Test Message" 3
    
This adds "Test Message" to the message queue for Terminal 3.
"""

import sys
import subprocess
import os

def main():
    # Change to backend directory
    backend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend')
    os.chdir(backend_dir)
    
    if len(sys.argv) < 2:
        print("Usage: python manage.py addMessage <message> [terminal_number]")
        sys.exit(1)
    
    # Handle the addMessage command
    if sys.argv[1] == "addMessage" and len(sys.argv) >= 3:
        message = sys.argv[2]
        terminal = sys.argv[3] if len(sys.argv) > 3 else None
        
        # Build the Django management command
        cmd = ["python", "manage.py", "add_message", message]
        if terminal:
            cmd.extend(["--terminal", terminal])
        
        # Execute the command
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.stdout:
            print(result.stdout.strip())
        if result.stderr:
            print(result.stderr.strip(), file=sys.stderr)
        sys.exit(result.returncode)
    else:
        # Pass through to Django's manage.py for other commands
        cmd = ["python", "manage.py"] + sys.argv[1:]
        result = subprocess.run(cmd)
        sys.exit(result.returncode)

if __name__ == "__main__":
    main()
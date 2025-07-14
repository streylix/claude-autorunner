#!/usr/bin/env python3
"""
JavaScript Function Analyzer for Auto-Injector Frontend

This script analyzes JavaScript files (main.js and renderer.js) to extract:
- Function declarations and their line counts
- Class methods and constructors
- Arrow functions and variable assignments
- Function purposes based on names and comments

Usage:
    python analyze_functions.py [file1.js] [file2.js] ...
    
If no files specified, defaults to main.js and renderer.js
"""

import re
import sys
import os
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass
from pathlib import Path

@dataclass
class FunctionInfo:
    name: str
    type: str  # 'function', 'method', 'arrow', 'constructor', 'async'
    start_line: int
    end_line: int
    line_count: int
    purpose: str
    file_path: str
    class_name: Optional[str] = None

class JavaScriptFunctionAnalyzer:
    def __init__(self):
        self.functions = []
        self.current_file = ""
        
    def analyze_file(self, file_path: str) -> List[FunctionInfo]:
        """Analyze a JavaScript file and extract function information"""
        if not os.path.exists(file_path):
            print(f"Warning: File {file_path} not found")
            return []
            
        self.current_file = file_path
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
        except Exception as e:
            print(f"Error reading {file_path}: {e}")
            return []
            
        functions = []
        current_class = None
        brace_stack = []
        
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            
            # Track class declarations
            class_match = re.match(r'class\s+(\w+)', stripped)
            if class_match:
                current_class = class_match.group(1)
            
            # Find function declarations
            func_info = self._extract_function_info(line, i, current_class)
            if func_info:
                # Find the end of the function
                end_line = self._find_function_end(lines, i-1)
                func_info.end_line = end_line
                func_info.line_count = end_line - func_info.start_line + 1
                func_info.file_path = file_path
                functions.append(func_info)
                
        return functions
    
    def _extract_function_info(self, line: str, line_num: int, current_class: str = None) -> Optional[FunctionInfo]:
        """Extract function information from a line"""
        stripped = line.strip()
        
        # Skip comments and empty lines
        if not stripped or stripped.startswith('//') or stripped.startswith('/*'):
            return None
            
        # Regular function declaration
        func_match = re.match(r'(?:async\s+)?function\s+(\w+)\s*\(', stripped)
        if func_match:
            name = func_match.group(1)
            func_type = 'async' if 'async' in stripped else 'function'
            purpose = self._infer_purpose(name, line)
            return FunctionInfo(name, func_type, line_num, 0, 0, purpose, "", current_class)
        
        # Constructor
        if re.match(r'constructor\s*\(', stripped):
            purpose = f"Constructor for {current_class}" if current_class else "Constructor"
            return FunctionInfo('constructor', 'constructor', line_num, 0, 0, purpose, "", current_class)
        
        # Class method
        method_match = re.match(r'(?:async\s+)?(\w+)\s*\([^)]*\)\s*{', stripped)
        if method_match and current_class:
            name = method_match.group(1)
            func_type = 'async_method' if 'async' in stripped else 'method'
            purpose = self._infer_purpose(name, line)
            return FunctionInfo(name, func_type, line_num, 0, 0, purpose, "", current_class)
        
        # Arrow function assignment
        arrow_match = re.match(r'(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>', stripped)
        if arrow_match:
            name = arrow_match.group(1)
            func_type = 'async_arrow' if 'async' in stripped else 'arrow'
            purpose = self._infer_purpose(name, line)
            return FunctionInfo(name, func_type, line_num, 0, 0, purpose, "", current_class)
        
        # Method assignment (this.methodName = function)
        method_assign_match = re.match(r'this\.(\w+)\s*=\s*(?:async\s+)?(?:function\s*)?\(', stripped)
        if method_assign_match:
            name = method_assign_match.group(1)
            func_type = 'async_assignment' if 'async' in stripped else 'assignment'
            purpose = self._infer_purpose(name, line)
            return FunctionInfo(name, func_type, line_num, 0, 0, purpose, "", current_class)
        
        return None
    
    def _find_function_end(self, lines: List[str], start_idx: int) -> int:
        """Find the end line of a function by tracking braces"""
        brace_count = 0
        found_opening = False
        
        for i in range(start_idx, len(lines)):
            line = lines[i]
            
            # Count braces, ignoring those in strings and comments
            clean_line = self._remove_strings_and_comments(line)
            
            for char in clean_line:
                if char == '{':
                    brace_count += 1
                    found_opening = True
                elif char == '}':
                    brace_count -= 1
                    
            # If we've found the opening brace and closed all braces
            if found_opening and brace_count == 0:
                return i + 1
                
        # If we couldn't find the end, return a reasonable estimate
        return start_idx + 10
    
    def _remove_strings_and_comments(self, line: str) -> str:
        """Remove strings and comments from a line to avoid counting braces inside them"""
        # Simple regex to remove common string patterns and comments
        # This is not perfect but good enough for basic analysis
        line = re.sub(r'//.*$', '', line)  # Remove single-line comments
        line = re.sub(r'/\*.*?\*/', '', line)  # Remove inline block comments
        line = re.sub(r'"[^"]*"', '""', line)  # Remove double-quoted strings
        line = re.sub(r"'[^']*'", "''", line)  # Remove single-quoted strings
        line = re.sub(r'`[^`]*`', '``', line)  # Remove template literals
        return line
    
    def _infer_purpose(self, func_name: str, line: str) -> str:
        """Infer the purpose of a function based on its name and context"""
        name_lower = func_name.lower()
        
        # Terminal related functions
        if any(term in name_lower for term in ['terminal', 'pty', 'shell', 'command']):
            return "Terminal operations and process management"
        
        # UI related functions
        if any(ui in name_lower for ui in ['ui', 'dom', 'element', 'button', 'modal', 'display', 'show', 'hide']):
            return "User interface management"
        
        # Message queue functions
        if any(msg in name_lower for msg in ['message', 'queue', 'inject', 'schedule']):
            return "Message queue and injection system"
        
        # Timer functions
        if any(timer in name_lower for timer in ['timer', 'timeout', 'interval', 'delay']):
            return "Timer and scheduling functionality"
        
        # Audio/Voice functions
        if any(audio in name_lower for audio in ['audio', 'voice', 'record', 'transcribe', 'whisper']):
            return "Voice transcription and audio processing"
        
        # Settings and configuration
        if any(config in name_lower for config in ['setting', 'config', 'option', 'preference']):
            return "Settings and configuration management"
        
        # Event handlers
        if any(event in name_lower for event in ['on', 'handle', 'listener', 'callback']):
            return "Event handling and callbacks"
        
        # Data persistence
        if any(data in name_lower for data in ['save', 'load', 'store', 'persist', 'data']):
            return "Data persistence and storage"
        
        # Initialization
        if any(init in name_lower for init in ['init', 'setup', 'create', 'start']):
            return "Initialization and setup"
        
        # Utility functions
        if any(util in name_lower for util in ['get', 'set', 'update', 'format', 'parse', 'validate']):
            return "Utility and helper functions"
        
        return "General application logic"
    
    def generate_report(self, functions: List[FunctionInfo]) -> str:
        """Generate a comprehensive report of all functions"""
        if not functions:
            return "No functions found."
        
        # Group by file
        files = {}
        for func in functions:
            file_name = os.path.basename(func.file_path)
            if file_name not in files:
                files[file_name] = []
            files[file_name].append(func)
        
        report = []
        report.append("=" * 80)
        report.append("AUTO-INJECTOR FRONTEND FUNCTION ANALYSIS")
        report.append("=" * 80)
        report.append("")
        
        total_functions = len(functions)
        total_lines = sum(func.line_count for func in functions)
        
        report.append(f"📊 SUMMARY:")
        report.append(f"   • Total Functions: {total_functions}")
        report.append(f"   • Total Lines: {total_lines}")
        report.append(f"   • Average Lines per Function: {total_lines / total_functions:.1f}")
        report.append("")
        
        # File-by-file breakdown
        for file_name, file_functions in files.items():
            report.append(f"📁 {file_name.upper()}")
            report.append("-" * 60)
            
            # Group by type
            by_type = {}
            for func in file_functions:
                if func.type not in by_type:
                    by_type[func.type] = []
                by_type[func.type].append(func)
            
            for func_type, type_functions in by_type.items():
                report.append(f"\n🔧 {func_type.upper()} FUNCTIONS ({len(type_functions)}):")
                
                # Sort by line count (largest first)
                type_functions.sort(key=lambda f: f.line_count, reverse=True)
                
                for func in type_functions:
                    class_info = f" [{func.class_name}]" if func.class_name else ""
                    report.append(f"   • {func.name}{class_info}")
                    report.append(f"     Lines {func.start_line}-{func.end_line} ({func.line_count} lines)")
                    report.append(f"     Purpose: {func.purpose}")
                    report.append("")
            
            report.append("")
        
        # Function categories summary
        categories = {}
        for func in functions:
            if func.purpose not in categories:
                categories[func.purpose] = []
            categories[func.purpose].append(func)
        
        report.append("🎯 FUNCTIONS BY PURPOSE:")
        report.append("-" * 60)
        for purpose, purpose_functions in sorted(categories.items()):
            total_lines = sum(f.line_count for f in purpose_functions)
            report.append(f"{purpose}: {len(purpose_functions)} functions, {total_lines} lines")
        
        report.append("")
        report.append("=" * 80)
        report.append("Generated by analyze_functions.py")
        report.append("=" * 80)
        
        return "\n".join(report)

def main():
    """Main function to run the analyzer"""
    analyzer = JavaScriptFunctionAnalyzer()
    
    # Determine which files to analyze
    if len(sys.argv) > 1:
        files_to_analyze = sys.argv[1:]
    else:
        # Default to main frontend files
        files_to_analyze = ['main.js', 'renderer.js']
    
    all_functions = []
    
    print("🔍 Analyzing JavaScript functions...")
    print()
    
    for file_path in files_to_analyze:
        print(f"📄 Analyzing {file_path}...")
        functions = analyzer.analyze_file(file_path)
        all_functions.extend(functions)
        print(f"   Found {len(functions)} functions")
    
    print()
    
    if not all_functions:
        print("❌ No functions found in the specified files.")
        return
    
    # Generate and display report
    report = analyzer.generate_report(all_functions)
    print(report)
    
    # Save report to file
    report_file = "function_analysis_report.md"
    try:
        with open(report_file, 'w', encoding='utf-8') as f:
            f.write(report)
        print(f"\n💾 Report saved to {report_file}")
    except Exception as e:
        print(f"\n❌ Error saving report: {e}")

if __name__ == "__main__":
    main()
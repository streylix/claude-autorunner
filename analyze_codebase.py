#!/usr/bin/env python3
"""
Codebase Analyzer for Claude Code Bot
Analyzes main.js and renderer.js to extract functions and plan directory structure
"""

import re
import json
import os
from collections import defaultdict

class CodebaseAnalyzer:
    def __init__(self):
        self.functions = []
        self.class_methods = []
        self.total_lines = 0
        
    def analyze_file(self, file_path):
        """Analyze a JavaScript file to extract functions and methods"""
        print(f"\n{'='*60}")
        print(f"ANALYZING: {file_path}")
        print(f"{'='*60}")
        
        if not os.path.exists(file_path):
            print(f"Error: File {file_path} not found")
            return
            
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
            lines = content.split('\n')
            
        self.total_lines += len(lines)
        
        # Patterns for different function types
        patterns = {
            'function_declaration': r'^\s*function\s+(\w+)\s*\(',
            'arrow_function': r'^\s*(?:const|let|var)\s+(\w+)\s*=\s*\([^)]*\)\s*=>\s*{',
            'async_function': r'^\s*async\s+function\s+(\w+)\s*\(',
            'class_method': r'^\s*(\w+)\s*\([^)]*\)\s*{',
            'ipc_handler': r'^\s*ipcMain\.(?:on|handle)\s*\(\s*[\'"]([^\'\"]+)[\'"]',
            'event_listener': r'addEventListener\s*\(\s*[\'"]([^\'\"]+)[\'"]'
        }
        
        current_class = None
        functions_found = []
        
        for i, line in enumerate(lines, 1):
            # Detect class definitions
            class_match = re.match(r'^\s*class\s+(\w+)', line)
            if class_match:
                current_class = class_match.group(1)
                continue
                
            # Check for function patterns
            for pattern_type, pattern in patterns.items():
                match = re.search(pattern, line)
                if match:
                    func_name = match.group(1)
                    
                    # Calculate function length (rough estimate)
                    func_length = self._estimate_function_length(lines, i-1)
                    
                    func_info = {
                        'name': func_name,
                        'type': pattern_type,
                        'line': i,
                        'length': func_length,
                        'class': current_class,
                        'file': os.path.basename(file_path)
                    }
                    
                    functions_found.append(func_info)
                    break
        
        # Print functions found in this file
        print(f"\nFunctions found in {os.path.basename(file_path)}:")
        print("-" * 60)
        
        for func in sorted(functions_found, key=lambda x: x['line']):
            class_info = f" (in {func['class']})" if func['class'] else ""
            print(f"  {func['name']:<30} | {func['type']:<20} | Line {func['line']:>4} | {func['length']:>3} lines{class_info}")
            
        self.functions.extend(functions_found)
        
        print(f"\nTotal functions in {os.path.basename(file_path)}: {len(functions_found)}")
        print(f"Total lines in {os.path.basename(file_path)}: {len(lines)}")
        
        return functions_found
    
    def _estimate_function_length(self, lines, start_line):
        """Estimate function length by counting braces"""
        if start_line >= len(lines):
            return 1
            
        brace_count = 0
        length = 0
        
        for i in range(start_line, len(lines)):
            line = lines[i]
            length += 1
            
            # Count opening and closing braces
            brace_count += line.count('{') - line.count('}')
            
            # If we've closed all braces and this isn't the first line, we're done
            if brace_count <= 0 and i > start_line:
                break
                
            # Safety limit to avoid runaway
            if length > 200:
                break
                
        return length
    
    def categorize_functions(self):
        """Categorize functions by their purpose based on naming patterns"""
        categories = defaultdict(list)
        
        category_patterns = {
            'terminal': [
                'terminal', 'pty', 'shell', 'spawn', 'resize', 'cwd'
            ],
            'message_queue': [
                'message', 'queue', 'inject', 'sequence', 'execute'
            ],
            'auto_injection': [
                'auto', 'injection', 'timer', 'continue', 'pause', 'resume'
            ],
            'ui_controls': [
                'button', 'btn', 'toggle', 'show', 'hide', 'display', 'update'
            ],
            'sidebar': [
                'sidebar', 'status', 'log', 'action', 'history'
            ],
            'file_management': [
                'file', 'save', 'load', 'backup', 'restore', 'drag', 'drop'
            ],
            'ipc_communication': [
                'ipc', 'handle', 'send', 'receive'
            ],
            'settings_preferences': [
                'setting', 'preference', 'config', 'theme'
            ],
            'voice_transcription': [
                'voice', 'audio', 'transcrib', 'whisper', 'record'
            ],
            'power_management': [
                'power', 'save', 'blocker', 'prevent'
            ],
            'notifications': [
                'notification', 'tray', 'badge', 'alert'
            ],
            'data_storage': [
                'db', 'storage', 'migrate', 'localstorage'
            ],
            'utilities': [
                'util', 'helper', 'format', 'validate', 'parse'
            ]
        }
        
        for func in self.functions:
            func_name_lower = func['name'].lower()
            categorized = False
            
            for category, keywords in category_patterns.items():
                if any(keyword in func_name_lower for keyword in keywords):
                    categories[category].append(func)
                    categorized = True
                    break
                    
            if not categorized:
                categories['uncategorized'].append(func)
                
        return categories
    
    def print_categorized_summary(self, categories):
        """Print a summary of functions by category"""
        print(f"\n{'='*80}")
        print("FUNCTION CATEGORIZATION SUMMARY")
        print(f"{'='*80}")
        
        total_funcs = sum(len(funcs) for funcs in categories.values())
        
        for category, functions in sorted(categories.items()):
            if not functions:
                continue
                
            print(f"\n📁 {category.upper().replace('_', ' ')} ({len(functions)} functions)")
            print("-" * 60)
            
            total_lines = sum(f['length'] for f in functions)
            files = set(f['file'] for f in functions)
            
            print(f"   Total lines: {total_lines}")
            print(f"   Files: {', '.join(sorted(files))}")
            print(f"   Functions:")
            
            for func in sorted(functions, key=lambda x: x['length'], reverse=True):
                class_info = f" ({func['class']})" if func['class'] else ""
                print(f"     • {func['name']:<25} | {func['length']:>3} lines | {func['file']}{class_info}")
                
        print(f"\n📊 TOTALS:")
        print(f"   Total functions analyzed: {total_funcs}")
        print(f"   Total lines of code: {self.total_lines}")
        
    def suggest_directory_structure(self, categories):
        """Suggest a directory structure for reorganizing the code"""
        print(f"\n{'='*80}")
        print("SUGGESTED DIRECTORY STRUCTURE")
        print(f"{'='*80}")
        
        structure = {
            'src/': {
                'main/': {
                    'main.js': 'Entry point and window management',
                    'app-lifecycle.js': 'App event handlers and lifecycle management',
                    'tray-management.js': 'System tray functionality'
                },
                'terminal/': {
                    'terminal-manager.js': 'Terminal creation and management',
                    'pty-handler.js': 'PTY process handling',
                    'terminal-ipc.js': 'Terminal IPC communication'
                },
                'message-system/': {
                    'message-queue.js': 'Message queue management',
                    'message-injection.js': 'Message injection logic',
                    'message-processing.js': 'Message processing and validation'
                },
                'auto-injection/': {
                    'timer-controls.js': 'Timer functionality',
                    'injection-engine.js': 'Core injection logic',
                    'auto-continue.js': 'Auto-continue functionality',
                    'keyword-detection.js': 'Keyword blocking system'
                },
                'ui/': {
                    'sidebar/': {
                        'status-display.js': 'Status information display',
                        'action-logs.js': 'Action logging functionality',
                        'message-history.js': 'Message history management'
                    },
                    'controls/': {
                        'button-handlers.js': 'Button event handlers',
                        'ui-updates.js': 'UI state updates',
                        'modal-dialogs.js': 'Modal and dialog management'
                    },
                    'terminal-gui/': {
                        'terminal-display.js': 'Terminal GUI class core',
                        'terminal-events.js': 'Terminal event handling',
                        'terminal-theming.js': 'Terminal themes and styling'
                    }
                },
                'storage/': {
                    'data-manager.js': 'Data persistence',
                    'settings-manager.js': 'Settings and preferences',
                    'migration.js': 'Data migration utilities'
                },
                'features/': {
                    'voice-transcription.js': 'Voice recording and transcription',
                    'file-management.js': 'File drag/drop and management',
                    'power-management.js': 'Power save blocking',
                    'notifications.js': 'System notifications and tray updates'
                },
                'utils/': {
                    'helpers.js': 'Utility functions',
                    'validators.js': 'Input validation',
                    'formatters.js': 'Data formatting utilities'
                }
            }
        }
        
        def print_structure(struct, indent=0):
            for name, content in struct.items():
                spaces = "  " * indent
                if isinstance(content, dict):
                    print(f"{spaces}📁 {name}")
                    print_structure(content, indent + 1)
                else:
                    print(f"{spaces}📄 {name} - {content}")
                    
        print_structure(structure)
        
        # Calculate estimated lines per file
        print(f"\n{'='*80}")
        print("ESTIMATED LINES PER NEW FILE")
        print(f"{'='*80}")
        
        estimated_lines = {}
        
        for category, functions in categories.items():
            if not functions:
                continue
                
            total_lines = sum(f['length'] for f in functions)
            
            # Map categories to suggested files
            category_mapping = {
                'terminal': ['src/terminal/terminal-manager.js', 'src/terminal/pty-handler.js'],
                'message_queue': ['src/message-system/message-queue.js', 'src/message-system/message-injection.js'],
                'auto_injection': ['src/auto-injection/injection-engine.js', 'src/auto-injection/timer-controls.js'],
                'ui_controls': ['src/ui/controls/button-handlers.js', 'src/ui/controls/ui-updates.js'],
                'sidebar': ['src/ui/sidebar/status-display.js', 'src/ui/sidebar/action-logs.js'],
                'file_management': ['src/features/file-management.js'],
                'ipc_communication': ['src/terminal/terminal-ipc.js', 'src/storage/data-manager.js'],
                'settings_preferences': ['src/storage/settings-manager.js'],
                'voice_transcription': ['src/features/voice-transcription.js'],
                'power_management': ['src/features/power-management.js'],
                'notifications': ['src/features/notifications.js'],
                'data_storage': ['src/storage/data-manager.js', 'src/storage/migration.js'],
                'utilities': ['src/utils/helpers.js', 'src/utils/validators.js']
            }
            
            if category in category_mapping:
                files = category_mapping[category]
                lines_per_file = total_lines // len(files)
                
                for file_path in files:
                    if file_path not in estimated_lines:
                        estimated_lines[file_path] = 0
                    estimated_lines[file_path] += lines_per_file
                    
        # Print estimated lines
        over_limit = []
        for file_path, lines in sorted(estimated_lines.items()):
            status = "✅" if lines <= 1000 else "⚠️"
            print(f"{status} {file_path:<40} | {lines:>4} lines")
            if lines > 1000:
                over_limit.append((file_path, lines))
                
        if over_limit:
            print(f"\n⚠️  FILES OVER 1000 LINE LIMIT:")
            for file_path, lines in over_limit:
                print(f"   • {file_path} ({lines} lines) - needs further splitting")
                
        return structure
    
    def generate_migration_plan(self, categories):
        """Generate a detailed migration plan"""
        print(f"\n{'='*80}")
        print("MIGRATION PLAN")
        print(f"{'='*80}")
        
        print("""
🎯 MIGRATION STRATEGY:

1. CREATE DIRECTORY STRUCTURE
   • Create the suggested src/ directory structure
   • Set up proper module exports/imports

2. PHASE 1: Extract Core Systems
   • Move terminal management functions first (most isolated)
   • Extract data storage and IPC handlers
   • Test each extraction

3. PHASE 2: Extract UI Components  
   • Move sidebar functionality
   • Extract button handlers and UI updates
   • Maintain renderer.js as main coordinator

4. PHASE 3: Extract Feature Modules
   • Move auto-injection logic
   • Extract voice transcription
   • Move power management and notifications

5. PHASE 4: Final Cleanup
   • Extract utilities and helpers
   • Optimize imports and dependencies
   • Final testing and validation

⚠️  CRITICAL CONSIDERATIONS:
   • Maintain existing IPC communication patterns
   • Preserve class structure for TerminalGUI
   • Keep initialization order intact
   • Test each migration step thoroughly
   • Backup current working code before starting
        """)
        
        return True

def main():
    analyzer = CodebaseAnalyzer()
    
    # Analyze both files
    files_to_analyze = [
        '/Users/ethan/claude code bot/main.js',
        '/Users/ethan/claude code bot/renderer.js'
    ]
    
    for file_path in files_to_analyze:
        analyzer.analyze_file(file_path)
    
    # Categorize all functions
    categories = analyzer.categorize_functions()
    
    # Print detailed analysis
    analyzer.print_categorized_summary(categories)
    
    # Suggest directory structure
    analyzer.suggest_directory_structure(categories)
    
    # Generate migration plan
    analyzer.generate_migration_plan(categories)
    
    # Save results to JSON
    results = {
        'total_lines': analyzer.total_lines,
        'total_functions': len(analyzer.functions),
        'functions_by_category': {cat: [f['name'] for f in funcs] for cat, funcs in categories.items()},
        'detailed_functions': analyzer.functions
    }
    
    with open('/Users/ethan/claude code bot/codebase_analysis.json', 'w') as f:
        json.dump(results, f, indent=2)
        
    print(f"\n💾 Analysis results saved to: codebase_analysis.json")
    print(f"\n🎉 Analysis complete! Review the suggestions above to plan your refactoring.")

if __name__ == "__main__":
    main()
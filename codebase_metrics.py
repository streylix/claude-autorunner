#!/usr/bin/env python3
"""
Codebase Metrics Analyzer
Analyzes JavaScript codebase for lines of code, functions, and token count
"""

import os
import re
import json
import glob
import argparse
from datetime import datetime
from pathlib import Path
from collections import defaultdict

try:
    import tiktoken
except ImportError:
    print("Installing tiktoken for token counting...")
    import subprocess
    import sys
    subprocess.check_call([sys.executable, "-m", "pip", "install", "tiktoken"])
    import tiktoken

class CodebaseMetrics:
    def __init__(self, project_path):
        self.project_path = project_path
        self.ignored_dirs = {
            'node_modules', '.git', 'dist', 'build', 'coverage', 
            '__pycache__', '.pytest_cache', '.vscode', '.idea',
            'screenshots_initialized', 'screenshots_current', 'comparison_',
            'imported-files', 'soundeffects'
        }
        self.ignored_files = {
            '.DS_Store', 'package-lock.json', 'yarn.lock',
            '.gitignore', 'LICENSE', 'README.md'
        }
        self.js_extensions = {'.js', '.ts', '.jsx', '.tsx', '.mjs'}
        self.css_extensions = {'.css', '.scss', '.sass', '.less'}
        self.html_extensions = {'.html', '.htm', '.xhtml'}
        
        # Initialize tokenizer for GPT-4 token counting
        try:
            self.tokenizer = tiktoken.encoding_for_model("gpt-4")
        except:
            self.tokenizer = tiktoken.get_encoding("cl100k_base")
            
        self.metrics = {
            'timestamp': datetime.now().isoformat(),
            'project_path': project_path,
            'summary': {},
            'files': [],
            'by_extension': defaultdict(lambda: {'count': 0, 'lines': 0, 'tokens': 0}),
            'by_directory': defaultdict(lambda: {'count': 0, 'lines': 0, 'tokens': 0}),
            'functions': [],
            'classes': [],
            'issues': []
        }
        
    def should_ignore_path(self, path):
        """Check if a path should be ignored"""
        path_parts = Path(path).parts
        
        # Check if any part of the path is in ignored directories
        for part in path_parts:
            if part in self.ignored_dirs or part.startswith('.'):
                return True
                
        # Check if filename is ignored
        filename = os.path.basename(path)
        if filename in self.ignored_files:
            return True
            
        # Check for screenshot directories
        if 'screenshots_' in filename or filename.startswith('comparison_'):
            return True
            
        return False
    
    def count_lines_of_code(self, content):
        """Count actual lines of code, excluding comments and empty lines"""
        lines = content.split('\n')
        
        code_lines = 0
        comment_lines = 0
        empty_lines = 0
        in_block_comment = False
        
        for line in lines:
            stripped = line.strip()
            
            if not stripped:
                empty_lines += 1
                continue
                
            # Handle block comments
            if '/*' in stripped and '*/' in stripped:
                # Single line block comment
                comment_lines += 1
                continue
            elif '/*' in stripped:
                in_block_comment = True
                comment_lines += 1
                continue
            elif '*/' in stripped:
                in_block_comment = False
                comment_lines += 1
                continue
            elif in_block_comment:
                comment_lines += 1
                continue
                
            # Handle line comments
            if stripped.startswith('//') or stripped.startswith('#'):
                comment_lines += 1
                continue
                
            # This is a code line
            code_lines += 1
            
        return {
            'total': len(lines),
            'code': code_lines,
            'comments': comment_lines,
            'empty': empty_lines
        }
    
    def extract_functions(self, content, file_path):
        """Extract function definitions from JavaScript/TypeScript content"""
        functions = []
        
        # Patterns for different function types
        patterns = [
            # Regular function declarations
            (r'^\s*function\s+(\w+)\s*\(([^)]*)\)\s*{', 'function_declaration'),
            
            # Arrow functions assigned to variables
            (r'^\s*(?:const|let|var)\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>\s*{', 'arrow_function'),
            (r'^\s*(?:const|let|var)\s+(\w+)\s*=\s*([^=]+)\s*=>\s*{', 'arrow_function_single'),
            
            # Async functions
            (r'^\s*async\s+function\s+(\w+)\s*\(([^)]*)\)\s*{', 'async_function'),
            
            # Class methods
            (r'^\s*(\w+)\s*\(([^)]*)\)\s*{', 'method'),
            
            # Object method shorthand
            (r'^\s*(\w+):\s*function\s*\(([^)]*)\)\s*{', 'object_method'),
            
            # Generator functions
            (r'^\s*function\*\s+(\w+)\s*\(([^)]*)\)\s*{', 'generator'),
        ]
        
        lines = content.split('\n')
        current_class = None
        
        for i, line in enumerate(lines, 1):
            # Check for class definitions
            class_match = re.search(r'^\s*class\s+(\w+)', line)
            if class_match:
                current_class = class_match.group(1)
                continue
                
            # Check for function patterns
            for pattern, func_type in patterns:
                match = re.search(pattern, line)
                if match:
                    func_name = match.group(1)
                    params = match.group(2) if len(match.groups()) > 1 else ''
                    
                    # Estimate function length
                    func_length = self.estimate_function_length(lines, i-1)
                    
                    functions.append({
                        'name': func_name,
                        'type': func_type,
                        'line': i,
                        'length': func_length,
                        'parameters': params.strip(),
                        'class': current_class,
                        'file': os.path.relpath(file_path, self.project_path)
                    })
                    break
                    
        return functions
    
    def estimate_function_length(self, lines, start_line):
        """Estimate function length by counting braces"""
        if start_line >= len(lines):
            return 1
            
        brace_count = 0
        length = 0
        
        for i in range(start_line, len(lines)):
            line = lines[i]
            length += 1
            
            # Count braces
            brace_count += line.count('{') - line.count('}')
            
            # Function ends when braces are balanced and we're past the first line
            if brace_count <= 0 and i > start_line:
                break
                
            # Safety limit
            if length > 500:
                break
                
        return length
    
    def extract_classes(self, content, file_path):
        """Extract class definitions"""
        classes = []
        
        class_pattern = r'^\s*class\s+(\w+)(?:\s+extends\s+(\w+))?\s*{'
        
        for i, line in enumerate(content.split('\n'), 1):
            match = re.search(class_pattern, line)
            if match:
                class_name = match.group(1)
                extends = match.group(2) if match.group(2) else None
                
                classes.append({
                    'name': class_name,
                    'extends': extends,
                    'line': i,
                    'file': os.path.relpath(file_path, self.project_path)
                })
                
        return classes
    
    def detect_code_issues(self, content, file_path):
        """Detect potential code issues"""
        issues = []
        lines = content.split('\n')
        
        for i, line in enumerate(lines, 1):
            # Long lines
            if len(line) > 120:
                issues.append({
                    'type': 'long_line',
                    'line': i,
                    'message': f'Line exceeds 120 characters ({len(line)} chars)',
                    'file': os.path.relpath(file_path, self.project_path)
                })
                
            # Console.log statements (potential debug code)
            if re.search(r'console\.(log|debug|info)', line):
                issues.append({
                    'type': 'console_log',
                    'line': i,
                    'message': 'Console.log statement found',
                    'file': os.path.relpath(file_path, self.project_path)
                })
                
            # TODO/FIXME comments
            if re.search(r'(TODO|FIXME|HACK|XXX)', line, re.IGNORECASE):
                issues.append({
                    'type': 'todo_comment',
                    'line': i,
                    'message': 'TODO/FIXME comment found',
                    'file': os.path.relpath(file_path, self.project_path)
                })
                
        return issues
    
    def analyze_file(self, file_path):
        """Analyze a single file"""
        try:
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
        except Exception as e:
            print(f"⚠️ Error reading {file_path}: {e}")
            return None
            
        # Get file info
        file_size = os.path.getsize(file_path)
        file_ext = Path(file_path).suffix.lower()
        rel_path = os.path.relpath(file_path, self.project_path)
        directory = os.path.dirname(rel_path) if os.path.dirname(rel_path) else '.'
        
        # Count lines
        line_counts = self.count_lines_of_code(content)
        
        # Count tokens
        try:
            token_count = len(self.tokenizer.encode(content))
        except:
            token_count = 0
            
        # Extract functions and classes for JS/TS files
        functions = []
        classes = []
        issues = []
        
        if file_ext in self.js_extensions:
            functions = self.extract_functions(content, file_path)
            classes = self.extract_classes(content, file_path)
            issues = self.detect_code_issues(content, file_path)
        
        # Build file metrics
        file_metrics = {
            'path': rel_path,
            'name': os.path.basename(file_path),
            'extension': file_ext,
            'directory': directory,
            'size_bytes': file_size,
            'lines': line_counts,
            'tokens': token_count,
            'functions': len(functions),
            'classes': len(classes),
            'issues': len(issues)
        }
        
        # Update aggregated metrics
        self.metrics['by_extension'][file_ext]['count'] += 1
        self.metrics['by_extension'][file_ext]['lines'] += line_counts['code']
        self.metrics['by_extension'][file_ext]['tokens'] += token_count
        
        self.metrics['by_directory'][directory]['count'] += 1
        self.metrics['by_directory'][directory]['lines'] += line_counts['code']
        self.metrics['by_directory'][directory]['tokens'] += token_count
        
        # Store detailed data
        self.metrics['functions'].extend(functions)
        self.metrics['classes'].extend(classes)
        self.metrics['issues'].extend(issues)
        
        return file_metrics
    
    def analyze_project(self):
        """Analyze the entire project"""
        print(f"📊 Analyzing codebase: {self.project_path}")
        
        # Find all relevant files
        all_files = []
        
        for root, dirs, files in os.walk(self.project_path):
            # Filter out ignored directories
            dirs[:] = [d for d in dirs if not self.should_ignore_path(os.path.join(root, d))]
            
            for file in files:
                file_path = os.path.join(root, file)
                
                if self.should_ignore_path(file_path):
                    continue
                    
                # Include code files
                ext = Path(file).suffix.lower()
                if ext in (self.js_extensions | self.css_extensions | self.html_extensions):
                    all_files.append(file_path)
        
        print(f"📁 Found {len(all_files)} code files to analyze")
        
        # Analyze each file
        analyzed_files = []
        for i, file_path in enumerate(all_files, 1):
            print(f"   Analyzing ({i}/{len(all_files)}): {os.path.relpath(file_path, self.project_path)}")
            
            file_metrics = self.analyze_file(file_path)
            if file_metrics:
                analyzed_files.append(file_metrics)
                
        self.metrics['files'] = analyzed_files
        
        # Calculate summary
        self.calculate_summary()
        
        return self.metrics
    
    def calculate_summary(self):
        """Calculate summary statistics"""
        files = self.metrics['files']
        
        if not files:
            return
            
        # Overall totals
        total_files = len(files)
        total_lines = sum(f['lines']['total'] for f in files)
        total_code_lines = sum(f['lines']['code'] for f in files)
        total_tokens = sum(f['tokens'] for f in files)
        total_functions = len(self.metrics['functions'])
        total_classes = len(self.metrics['classes'])
        total_issues = len(self.metrics['issues'])
        
        # File size distribution
        file_sizes = [f['lines']['code'] for f in files]
        avg_file_size = sum(file_sizes) / len(file_sizes) if file_sizes else 0
        
        # Largest files
        largest_files = sorted(files, key=lambda x: x['lines']['code'], reverse=True)[:10]
        
        # Most complex functions
        complex_functions = sorted(
            self.metrics['functions'], 
            key=lambda x: x['length'], 
            reverse=True
        )[:10]
        
        self.metrics['summary'] = {
            'total_files': total_files,
            'total_lines': total_lines,
            'total_code_lines': total_code_lines,
            'total_tokens': total_tokens,
            'total_functions': total_functions,
            'total_classes': total_classes,
            'total_issues': total_issues,
            'avg_file_size': round(avg_file_size, 1),
            'largest_files': largest_files,
            'most_complex_functions': complex_functions
        }
    
    def print_report(self):
        """Print a comprehensive report"""
        summary = self.metrics['summary']
        
        print(f"\n{'='*80}")
        print("CODEBASE METRICS REPORT")
        print(f"{'='*80}")
        
        print(f"📊 OVERVIEW:")
        print(f"   Total files: {summary['total_files']:,}")
        print(f"   Total lines: {summary['total_lines']:,}")
        print(f"   Code lines: {summary['total_code_lines']:,}")
        print(f"   Total tokens: {summary['total_tokens']:,}")
        print(f"   Functions: {summary['total_functions']:,}")
        print(f"   Classes: {summary['total_classes']:,}")
        print(f"   Issues found: {summary['total_issues']:,}")
        print(f"   Avg file size: {summary['avg_file_size']} lines")
        
        # By extension
        print(f"\n📁 BY FILE TYPE:")
        for ext, stats in sorted(self.metrics['by_extension'].items()):
            if stats['count'] > 0:
                print(f"   {ext:<8} | {stats['count']:>3} files | {stats['lines']:>6} lines | {stats['tokens']:>8} tokens")
        
        # By directory
        print(f"\n📂 BY DIRECTORY:")
        for directory, stats in sorted(self.metrics['by_directory'].items()):
            if stats['count'] > 0:
                dir_name = directory if directory != '.' else '(root)'
                print(f"   {dir_name:<20} | {stats['count']:>3} files | {stats['lines']:>6} lines | {stats['tokens']:>8} tokens")
        
        # Largest files
        print(f"\n📄 LARGEST FILES:")
        for file_info in summary['largest_files']:
            print(f"   {file_info['path']:<40} | {file_info['lines']['code']:>5} lines")
        
        # Most complex functions
        print(f"\n🔧 MOST COMPLEX FUNCTIONS:")
        for func in summary['most_complex_functions']:
            class_info = f" ({func['class']})" if func['class'] else ""
            print(f"   {func['name']:<25} | {func['length']:>3} lines | {func['file']}{class_info}")
        
        # Issues summary
        if summary['total_issues'] > 0:
            print(f"\n⚠️  ISSUES SUMMARY:")
            issue_types = defaultdict(int)
            for issue in self.metrics['issues']:
                issue_types[issue['type']] += 1
                
            for issue_type, count in sorted(issue_types.items()):
                print(f"   {issue_type.replace('_', ' ').title()}: {count}")
    
    def save_report(self, output_path=None):
        """Save metrics to JSON file"""
        if not output_path:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_path = os.path.join(self.project_path, f"codebase_metrics_{timestamp}.json")
            
        with open(output_path, 'w') as f:
            json.dump(self.metrics, f, indent=2)
            
        print(f"💾 Metrics saved to: {output_path}")
        return output_path

def main():
    """Main execution function"""
    parser = argparse.ArgumentParser(description='Analyze codebase metrics')
    parser.add_argument('--path', '-p', default='/Users/ethan/claude code bot',
                       help='Project path to analyze')
    parser.add_argument('--output', '-o', help='Output JSON file path')
    parser.add_argument('--quiet', '-q', action='store_true',
                       help='Minimal output (just summary)')
    
    args = parser.parse_args()
    
    try:
        # Create analyzer
        analyzer = CodebaseMetrics(args.path)
        
        # Analyze project
        metrics = analyzer.analyze_project()
        
        # Print report
        if not args.quiet:
            analyzer.print_report()
        else:
            summary = metrics['summary']
            print(f"Files: {summary['total_files']}, "
                  f"Lines: {summary['total_code_lines']:,}, "
                  f"Functions: {summary['total_functions']}, "
                  f"Tokens: {summary['total_tokens']:,}")
        
        # Save report
        analyzer.save_report(args.output)
        
        return 0
        
    except KeyboardInterrupt:
        print("\n⚠️ Analysis interrupted by user")
        return 1
        
    except Exception as e:
        print(f"\n❌ Analysis failed: {e}")
        return 1

if __name__ == "__main__":
    exit(main())
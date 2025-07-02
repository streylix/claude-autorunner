#!/usr/bin/env python3
"""
Test Orchestrator for Codebase Refactoring
Coordinates screenshot testing, metrics collection, and validation
"""

import os
import sys
import subprocess
import json
from datetime import datetime
import argparse

class TestOrchestrator:
    def __init__(self, project_path="/Users/ethan/claude code bot"):
        self.project_path = project_path
        self.baseline_screenshots = None
        self.current_screenshots = None
        self.baseline_metrics = None
        self.current_metrics = None
        
    def run_baseline_capture(self):
        """Capture baseline screenshots and metrics"""
        print("🎯 PHASE 1: Capturing Baseline State")
        print("=" * 50)
        
        # Get baseline metrics
        print("📊 Collecting baseline metrics...")
        result = subprocess.run([
            sys.executable, "codebase_metrics.py", 
            "--path", self.project_path,
            "--quiet"
        ], capture_output=True, text=True, cwd=self.project_path)
        
        if result.returncode == 0:
            print("✅ Baseline metrics collected")
            # Find the most recent metrics file
            metrics_files = [f for f in os.listdir(self.project_path) if f.startswith("codebase_metrics_")]
            if metrics_files:
                self.baseline_metrics = max(metrics_files)
                print(f"💾 Baseline metrics: {self.baseline_metrics}")
        else:
            print(f"❌ Failed to collect baseline metrics: {result.stderr}")
        
        # Take baseline screenshots
        print("\n📸 Taking baseline screenshots...")
        result = subprocess.run([
            sys.executable, "screenshot_automation.py",
            "--directory", "baseline",
            "--quick"
        ], cwd=self.project_path)
        
        if result.returncode == 0:
            print("✅ Baseline screenshots captured")
            # Find the most recent screenshot directory
            screenshot_dirs = [d for d in os.listdir(self.project_path) if d.startswith("screenshots_baseline_")]
            if screenshot_dirs:
                self.baseline_screenshots = max(screenshot_dirs)
                print(f"📁 Baseline screenshots: {self.baseline_screenshots}")
        else:
            print("❌ Failed to capture baseline screenshots")
            
        return bool(self.baseline_metrics and self.baseline_screenshots)
    
    def run_current_capture(self):
        """Capture current screenshots and metrics after changes"""
        print("\n🎯 PHASE 2: Capturing Current State")
        print("=" * 50)
        
        # Get current metrics
        print("📊 Collecting current metrics...")
        result = subprocess.run([
            sys.executable, "codebase_metrics.py", 
            "--path", self.project_path,
            "--quiet"
        ], capture_output=True, text=True, cwd=self.project_path)
        
        if result.returncode == 0:
            print("✅ Current metrics collected")
            # Find the most recent metrics file (excluding baseline)
            metrics_files = [f for f in os.listdir(self.project_path) 
                           if f.startswith("codebase_metrics_") and f != self.baseline_metrics]
            if metrics_files:
                self.current_metrics = max(metrics_files)
                print(f"💾 Current metrics: {self.current_metrics}")
        else:
            print(f"❌ Failed to collect current metrics: {result.stderr}")
        
        # Take current screenshots
        print("\n📸 Taking current screenshots...")
        result = subprocess.run([
            sys.executable, "screenshot_automation.py",
            "--directory", "current", 
            "--quick"
        ], cwd=self.project_path)
        
        if result.returncode == 0:
            print("✅ Current screenshots captured")
            # Find the most recent current screenshot directory
            screenshot_dirs = [d for d in os.listdir(self.project_path) if d.startswith("screenshots_current_")]
            if screenshot_dirs:
                self.current_screenshots = max(screenshot_dirs)
                print(f"📁 Current screenshots: {self.current_screenshots}")
        else:
            print("❌ Failed to capture current screenshots")
            
        return bool(self.current_metrics and self.current_screenshots)
    
    def run_comparison(self):
        """Compare current state to baseline"""
        print("\n🎯 PHASE 3: Running Comparisons")
        print("=" * 50)
        
        success = True
        
        # Compare screenshots
        if self.baseline_screenshots and self.current_screenshots:
            print("🖼️ Comparing screenshots...")
            baseline_path = os.path.join(self.project_path, self.baseline_screenshots)
            current_path = os.path.join(self.project_path, self.current_screenshots)
            
            result = subprocess.run([
                sys.executable, "image_comparison.py",
                "--baseline", baseline_path,
                "--current", current_path
            ], cwd=self.project_path)
            
            if result.returncode == 0:
                print("✅ Screenshots match - no visual regressions!")
            else:
                print("⚠️ Visual differences detected")
                success = False
        
        # Compare metrics
        if self.baseline_metrics and self.current_metrics:
            print("\n📊 Comparing metrics...")
            self.compare_metrics()
        
        return success
    
    def compare_metrics(self):
        """Compare baseline and current metrics"""
        try:
            with open(os.path.join(self.project_path, self.baseline_metrics)) as f:
                baseline = json.load(f)
                
            with open(os.path.join(self.project_path, self.current_metrics)) as f:
                current = json.load(f)
                
            baseline_summary = baseline['summary']
            current_summary = current['summary']
            
            print("📈 METRICS COMPARISON:")
            
            metrics_to_compare = [
                ('Files', 'total_files'),
                ('Code Lines', 'total_code_lines'), 
                ('Functions', 'total_functions'),
                ('Classes', 'total_classes'),
                ('Tokens', 'total_tokens'),
                ('Issues', 'total_issues')
            ]
            
            for name, key in metrics_to_compare:
                baseline_val = baseline_summary.get(key, 0)
                current_val = current_summary.get(key, 0)
                diff = current_val - baseline_val
                
                if diff == 0:
                    status = "="
                elif diff > 0:
                    status = f"+{diff}"
                else:
                    status = str(diff)
                    
                print(f"   {name:<12} | {baseline_val:>6} → {current_val:>6} ({status})")
            
            # Calculate reduction percentages for key metrics
            if baseline_summary.get('total_code_lines', 0) > 0:
                line_reduction = ((baseline_summary['total_code_lines'] - current_summary['total_code_lines']) / 
                                baseline_summary['total_code_lines']) * 100
                print(f"\n💡 Code reduction: {line_reduction:.1f}%")
                
        except Exception as e:
            print(f"❌ Error comparing metrics: {e}")
    
    def run_full_workflow(self):
        """Run the complete testing workflow"""
        print("🚀 STARTING COMPLETE REFACTORING WORKFLOW")
        print("=" * 60)
        
        # Phase 1: Baseline
        if not self.run_baseline_capture():
            print("❌ Failed to capture baseline state")
            return False
            
        print(f"\n✅ BASELINE CAPTURED SUCCESSFULLY")
        print(f"   Screenshots: {self.baseline_screenshots}")
        print(f"   Metrics: {self.baseline_metrics}")
        
        input("\n⏸️  Press Enter after making your code changes...")
        
        # Phase 2: Current state
        if not self.run_current_capture():
            print("❌ Failed to capture current state")
            return False
            
        # Phase 3: Comparison
        comparison_success = self.run_comparison()
        
        print(f"\n{'='*60}")
        if comparison_success:
            print("🎉 REFACTORING SUCCESSFUL!")
            print("   ✅ Visual appearance preserved")
            print("   ✅ All tests passed")
        else:
            print("⚠️  REFACTORING NEEDS ATTENTION")
            print("   ❌ Visual differences detected")
            print("   📋 Review comparison results")
        print(f"{'='*60}")
        
        return comparison_success

def main():
    """Main execution function"""
    parser = argparse.ArgumentParser(description='Orchestrate codebase refactoring tests')
    parser.add_argument('--baseline-only', action='store_true',
                       help='Only capture baseline state')
    parser.add_argument('--current-only', action='store_true',
                       help='Only capture current state')
    parser.add_argument('--compare-only', action='store_true',
                       help='Only run comparisons')
    parser.add_argument('--full', action='store_true',
                       help='Run full interactive workflow')
    
    args = parser.parse_args()
    
    orchestrator = TestOrchestrator()
    
    try:
        if args.baseline_only:
            return 0 if orchestrator.run_baseline_capture() else 1
        elif args.current_only:
            return 0 if orchestrator.run_current_capture() else 1
        elif args.compare_only:
            return 0 if orchestrator.run_comparison() else 1
        elif args.full:
            return 0 if orchestrator.run_full_workflow() else 1
        else:
            # Default: run baseline
            print("📋 Running baseline capture (use --full for complete workflow)")
            return 0 if orchestrator.run_baseline_capture() else 1
            
    except KeyboardInterrupt:
        print("\n⚠️ Workflow interrupted by user")
        return 1
    except Exception as e:
        print(f"\n❌ Workflow failed: {e}")
        return 1

if __name__ == "__main__":
    exit(main())
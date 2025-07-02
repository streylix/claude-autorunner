#!/usr/bin/env python3
"""
Image Comparison Script for UI Testing
Compares screenshots to detect visual changes in the Electron app
"""

import os
import sys
import json
import glob
from datetime import datetime
import argparse
from pathlib import Path

try:
    import cv2
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
    import matplotlib.pyplot as plt
except ImportError:
    print("Required packages not found. Installing...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "opencv-python", "pillow", "numpy", "matplotlib"])
    import cv2
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
    import matplotlib.pyplot as plt

class ImageComparator:
    def __init__(self, tolerance=0.95, diff_threshold=10):
        """
        Initialize image comparator
        
        Args:
            tolerance: Similarity threshold (0.95 = 95% similar)
            diff_threshold: Pixel difference threshold for highlighting
        """
        self.tolerance = tolerance
        self.diff_threshold = diff_threshold
        self.comparison_results = []
        
    def load_image(self, image_path):
        """Load and preprocess image"""
        try:
            # Load with PIL first to handle various formats
            pil_image = Image.open(image_path)
            
            # Convert to RGB if needed
            if pil_image.mode != 'RGB':
                pil_image = pil_image.convert('RGB')
                
            # Convert to numpy array for OpenCV
            image_array = np.array(pil_image)
            
            # Convert RGB to BGR for OpenCV
            image_bgr = cv2.cvtColor(image_array, cv2.COLOR_RGB2BGR)
            
            return image_bgr
            
        except Exception as e:
            print(f"❌ Error loading image {image_path}: {e}")
            return None
    
    def resize_images_to_match(self, img1, img2):
        """Resize images to match dimensions"""
        h1, w1 = img1.shape[:2]
        h2, w2 = img2.shape[:2]
        
        if (h1, w1) != (h2, w2):
            print(f"⚠️ Image size mismatch: {w1}x{h1} vs {w2}x{h2}")
            
            # Resize to the smaller dimensions to avoid upscaling
            target_h = min(h1, h2)
            target_w = min(w1, w2)
            
            img1_resized = cv2.resize(img1, (target_w, target_h))
            img2_resized = cv2.resize(img2, (target_w, target_h))
            
            return img1_resized, img2_resized
            
        return img1, img2
    
    def calculate_similarity_metrics(self, img1, img2):
        """Calculate various similarity metrics"""
        # Structural Similarity Index (SSIM)
        gray1 = cv2.cvtColor(img1, cv2.COLOR_BGR2GRAY)
        gray2 = cv2.cvtColor(img2, cv2.COLOR_BGR2GRAY)
        
        ssim_score = cv2.matchTemplate(gray1, gray2, cv2.TM_CCOEFF_NORMED)[0][0]
        
        # Mean Squared Error
        mse = np.mean((img1.astype(float) - img2.astype(float)) ** 2)
        
        # Peak Signal-to-Noise Ratio
        if mse == 0:
            psnr = float('inf')
        else:
            max_pixel = 255.0
            psnr = 20 * np.log10(max_pixel / np.sqrt(mse))
        
        # Histogram comparison
        hist1 = cv2.calcHist([img1], [0, 1, 2], None, [50, 50, 50], [0, 256, 0, 256, 0, 256])
        hist2 = cv2.calcHist([img2], [0, 1, 2], None, [50, 50, 50], [0, 256, 0, 256, 0, 256])
        hist_corr = cv2.compareHist(hist1, hist2, cv2.HISTCMP_CORREL)
        
        return {
            'ssim': ssim_score,
            'mse': mse,
            'psnr': psnr,
            'histogram_correlation': hist_corr
        }
    
    def generate_difference_map(self, img1, img2, output_path=None):
        """Generate visual difference map"""
        # Calculate absolute difference
        diff = cv2.absdiff(img1, img2)
        
        # Convert to grayscale for thresholding
        diff_gray = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
        
        # Create binary mask of significant differences
        _, thresh = cv2.threshold(diff_gray, self.diff_threshold, 255, cv2.THRESH_BINARY)
        
        # Create colored difference map
        diff_colored = img1.copy()
        diff_colored[thresh > 0] = [0, 0, 255]  # Highlight differences in red
        
        # Create side-by-side comparison
        comparison = np.hstack([img1, img2, diff_colored])
        
        if output_path:
            cv2.imwrite(output_path, comparison)
            
        return comparison, thresh
    
    def compare_images(self, img1_path, img2_path, output_dir=None):
        """Compare two images and return detailed results"""
        print(f"🔍 Comparing: {os.path.basename(img1_path)} vs {os.path.basename(img2_path)}")
        
        # Load images
        img1 = self.load_image(img1_path)
        img2 = self.load_image(img2_path)
        
        if img1 is None or img2 is None:
            return None
            
        # Resize to match if needed
        img1, img2 = self.resize_images_to_match(img1, img2)
        
        # Calculate metrics
        metrics = self.calculate_similarity_metrics(img1, img2)
        
        # Determine if images are similar enough
        is_similar = (
            metrics['ssim'] >= self.tolerance and
            metrics['histogram_correlation'] >= self.tolerance and
            metrics['psnr'] >= 20  # Good quality threshold
        )
        
        # Generate difference map if requested
        diff_map_path = None
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
            base_name = f"diff_{os.path.basename(img1_path)}"
            diff_map_path = os.path.join(output_dir, base_name)
            self.generate_difference_map(img1, img2, diff_map_path)
        
        result = {
            'image1': img1_path,
            'image2': img2_path,
            'is_similar': is_similar,
            'metrics': metrics,
            'difference_map': diff_map_path,
            'timestamp': datetime.now().isoformat()
        }
        
        # Print results
        status = "✅ SIMILAR" if is_similar else "❌ DIFFERENT"
        print(f"   {status} - SSIM: {metrics['ssim']:.3f}, PSNR: {metrics['psnr']:.1f}")
        
        return result
    
    def compare_directories(self, dir1, dir2, output_dir=None):
        """Compare all matching images between two directories"""
        print(f"📁 Comparing directories:")
        print(f"   Baseline: {dir1}")
        print(f"   Current:  {dir2}")
        
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
            
        # Find all PNG files in both directories
        files1 = set(os.path.basename(f) for f in glob.glob(os.path.join(dir1, "*.png")))
        files2 = set(os.path.basename(f) for f in glob.glob(os.path.join(dir2, "*.png")))
        
        # Find common files
        common_files = files1.intersection(files2)
        missing_in_dir2 = files1 - files2
        extra_in_dir2 = files2 - files1
        
        print(f"📊 Found {len(common_files)} matching files")
        
        if missing_in_dir2:
            print(f"⚠️ Missing in current: {', '.join(missing_in_dir2)}")
            
        if extra_in_dir2:
            print(f"ℹ️ Extra in current: {', '.join(extra_in_dir2)}")
        
        # Compare common files
        results = []
        similar_count = 0
        
        for filename in sorted(common_files):
            img1_path = os.path.join(dir1, filename)
            img2_path = os.path.join(dir2, filename)
            
            result = self.compare_images(img1_path, img2_path, output_dir)
            if result:
                results.append(result)
                if result['is_similar']:
                    similar_count += 1
        
        # Summary
        total_compared = len(results)
        different_count = total_compared - similar_count
        
        print(f"\n📈 COMPARISON SUMMARY:")
        print(f"   Total compared: {total_compared}")
        print(f"   Similar: {similar_count}")
        print(f"   Different: {different_count}")
        print(f"   Success rate: {(similar_count/total_compared)*100:.1f}%" if total_compared > 0 else "   No files compared")
        
        # Save detailed results
        if output_dir:
            results_file = os.path.join(output_dir, "comparison_results.json")
            summary = {
                'timestamp': datetime.now().isoformat(),
                'directories': {'baseline': dir1, 'current': dir2},
                'summary': {
                    'total_compared': total_compared,
                    'similar': similar_count,
                    'different': different_count,
                    'success_rate': (similar_count/total_compared)*100 if total_compared > 0 else 0
                },
                'detailed_results': results,
                'missing_files': list(missing_in_dir2),
                'extra_files': list(extra_in_dir2)
            }
            
            with open(results_file, 'w') as f:
                json.dump(summary, f, indent=2)
                
            print(f"💾 Detailed results saved to: {results_file}")
        
        return results, similar_count == total_compared
    
    def find_screenshot_directories(self, base_path):
        """Find all screenshot directories"""
        screenshot_dirs = []
        
        for item in os.listdir(base_path):
            if item.startswith("screenshots_") and os.path.isdir(os.path.join(base_path, item)):
                screenshot_dirs.append(os.path.join(base_path, item))
                
        return sorted(screenshot_dirs)
    
    def auto_compare_latest(self, base_path, output_dir=None):
        """Automatically compare the two most recent screenshot directories"""
        screenshot_dirs = self.find_screenshot_directories(base_path)
        
        if len(screenshot_dirs) < 2:
            print(f"❌ Need at least 2 screenshot directories. Found: {len(screenshot_dirs)}")
            return False
            
        # Use the two most recent directories
        baseline_dir = screenshot_dirs[-2]  # Second most recent
        current_dir = screenshot_dirs[-1]   # Most recent
        
        print(f"🎯 Auto-comparing latest directories:")
        print(f"   Baseline: {os.path.basename(baseline_dir)}")
        print(f"   Current:  {os.path.basename(current_dir)}")
        
        if not output_dir:
            output_dir = os.path.join(base_path, f"comparison_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
            
        results, all_similar = self.compare_directories(baseline_dir, current_dir, output_dir)
        
        if all_similar:
            print("🎉 ALL IMAGES ARE SIMILAR! No visual regressions detected.")
        else:
            print("⚠️ VISUAL DIFFERENCES DETECTED! Check the comparison results.")
            
        return all_similar

def main():
    """Main execution function"""
    parser = argparse.ArgumentParser(description='Compare screenshot images for UI testing')
    parser.add_argument('--baseline', '-b', help='Baseline screenshot directory')
    parser.add_argument('--current', '-c', help='Current screenshot directory') 
    parser.add_argument('--output', '-o', help='Output directory for comparison results')
    parser.add_argument('--auto', '-a', action='store_true', 
                       help='Auto-compare the two most recent screenshot directories')
    parser.add_argument('--tolerance', '-t', type=float, default=0.95,
                       help='Similarity tolerance (default: 0.95)')
    parser.add_argument('--threshold', type=int, default=10,
                       help='Pixel difference threshold (default: 10)')
    
    args = parser.parse_args()
    
    # Create comparator
    comparator = ImageComparator(tolerance=args.tolerance, diff_threshold=args.threshold)
    
    base_path = "/Users/ethan/claude code bot"
    
    try:
        if args.auto:
            # Auto-compare mode
            success = comparator.auto_compare_latest(base_path, args.output)
            return 0 if success else 1
            
        elif args.baseline and args.current:
            # Manual comparison mode
            results, all_similar = comparator.compare_directories(
                args.baseline, args.current, args.output
            )
            return 0 if all_similar else 1
            
        else:
            print("❌ Please specify either --auto or both --baseline and --current directories")
            return 1
            
    except KeyboardInterrupt:
        print("\n⚠️ Comparison interrupted by user")
        return 1
        
    except Exception as e:
        print(f"\n❌ Comparison failed: {e}")
        return 1

if __name__ == "__main__":
    exit(main())
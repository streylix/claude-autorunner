import json
import subprocess
import re
import datetime
from decimal import Decimal
from django.utils import timezone
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from .models import PricingData, PricingCache
from .serializers import PricingDataSerializer


class PricingViewSet(viewsets.ModelViewSet):
    queryset = PricingData.objects.all()
    serializer_class = PricingDataSerializer

    @action(detail=False, methods=['post'])
    def execute_ccusage(self, request):
        """Execute npx ccusage command and return parsed pricing data"""
        try:
            # Check cache first (valid for 5 minutes)
            cache_key = "ccusage_data"
            cached_data = PricingCache.objects.filter(
                cache_key=cache_key,
                expires_at__gt=timezone.now()
            ).first()
            
            if cached_data:
                return Response({
                    'success': True,
                    'data': cached_data.data,
                    'cached': True,
                    'timestamp': cached_data.created_at.isoformat()
                })

            # Execute ccusage command
            result = subprocess.run(
                ['npx', 'ccusage'],
                capture_output=True,
                text=True,
                timeout=30,
                cwd=None  # Use current working directory
            )
            
            if result.returncode != 0:
                return Response({
                    'success': False,
                    'error': 'Failed to execute ccusage command',
                    'stderr': result.stderr
                }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

            raw_output = result.stdout
            
            # Clean ANSI codes but preserve line structure
            import re
            clean_output = raw_output
            # Remove ANSI escape sequences but keep newlines
            clean_output = re.sub(r'\x1b\[[0-9;]*m', '', clean_output)
            clean_output = re.sub(r'\x1b\[[0-9;]*[mGKHJ]', '', clean_output)
            clean_output = re.sub(r'\x1b\[[0-9]+[ABCD]', '', clean_output)
            clean_output = re.sub(r'\x1b\[2J', '', clean_output)
            clean_output = re.sub(r'\x1b\[3J', '', clean_output)
            clean_output = re.sub(r'\x1b\[H', '', clean_output)
            clean_output = re.sub(r'\x1b\[2K', '', clean_output)
            clean_output = re.sub(r'\x1b\[1A', '', clean_output)
            clean_output = re.sub(r'\x1b\[G', '', clean_output)
            # Remove control characters but preserve newlines and tabs
            clean_output = re.sub(r'[\x00-\x08\x0B\x0C\x0E-\x1f\x7f-\x9f]', '', clean_output)
            
            # Parse the cleaned output
            parsed_data = self._parse_ccusage_output(clean_output)
            
            # Store in database
            session_id = request.data.get('session_id', 'default')
            pricing_record = PricingData.objects.create(
                session_id=session_id,
                raw_output=raw_output,
                parsed_data=parsed_data,
                total_cost=parsed_data.get('total_cost')
            )
            
            # Cache the result
            PricingCache.objects.update_or_create(
                cache_key=cache_key,
                defaults={
                    'data': parsed_data,
                    'expires_at': timezone.now() + timezone.timedelta(minutes=5)
                }
            )
            
            return Response({
                'success': True,
                'data': parsed_data,
                'cached': False,
                'timestamp': pricing_record.execution_timestamp.isoformat()
            })
            
        except subprocess.TimeoutExpired:
            return Response({
                'success': False,
                'error': 'Command execution timed out'
            }, status=status.HTTP_408_REQUEST_TIMEOUT)
            
        except Exception as e:
            return Response({
                'success': False,
                'error': str(e)
            }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @action(detail=False, methods=['get'])
    def get_cached_data(self, request):
        """Get cached pricing data if available"""
        cache_key = "ccusage_data"
        cached_data = PricingCache.objects.filter(
            cache_key=cache_key,
            expires_at__gt=timezone.now()
        ).first()
        
        if cached_data:
            return Response({
                'success': True,
                'data': cached_data.data,
                'cached': True,
                'timestamp': cached_data.created_at.isoformat()
            })
        else:
            return Response({
                'success': False,
                'message': 'No cached data available'
            })

    @action(detail=False, methods=['post'])
    def clear_cache(self, request):
        """Clear pricing cache"""
        PricingCache.objects.all().delete()
        return Response({'success': True, 'message': 'Cache cleared'})

    def _parse_ccusage_output(self, output):
        """Parse ccusage command output - exact copy of working debug script logic"""
        try:
            lines = output.split('\n')
            data = {
                'daily_entries': [],
                'total_cost': None,
                'last_updated': timezone.now().isoformat(),
                'weekly_cost': None,
                'monthly_cost': None,
                'daily_cost': None
            }
            
            # Clean ANSI function - exact copy from debug script
            def clean_ansi(text):
                text = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', text)
                text = re.sub(r'\[[0-9;]*m', '', text)
                return text
            
            # Find total cost - exact copy from debug script
            for line in lines:
                clean_line = clean_ansi(line)
                if 'Total' in clean_line and '$' in clean_line:
                    cost_match = re.search(r'\$(\d+\.?\d*)', clean_line)
                    if cost_match:
                        data['total_cost'] = float(cost_match.group(1))
                        break
            
            # Parse table entries - exact copy from debug script
            current_year = None
            current_date_part = None
            
            for i, line in enumerate(lines):
                clean_line = clean_ansi(line)
                
                # Skip non-table lines
                if not '│' in clean_line:
                    continue
                    
                # Skip header lines
                if any(header in clean_line for header in ['Date', 'Models', 'Input', 'Output', 'Cache', 'Total']):
                    continue
                    
                # Skip border lines
                if all(c in '├┼┤─│┌┐└┘ ' for c in clean_line.replace('│', '')):
                    continue
                
                # Parse table row
                columns = [col.strip() for col in clean_line.split('│')]
                if len(columns) < 8:
                    continue
                
                date_col = columns[1].strip() if len(columns) > 1 else ''
                model_col = columns[2].strip() if len(columns) > 2 else ''
                cost_col = columns[8].strip() if len(columns) > 8 else (columns[-1].strip() if columns else '')
                
                # Check for year
                year_match = re.search(r'(20\d{2})', date_col)
                if year_match:
                    current_year = year_match.group(1)
                
                # Check for date
                date_match = re.search(r'(\d{2}-\d{2})', date_col)
                if date_match:
                    current_date_part = date_match.group(1)
                
                # Check for cost
                cost_match = re.search(r'\$(\d+\.?\d*)', cost_col)
                if cost_match and current_year and current_date_part:
                    cost = float(cost_match.group(1))
                    
                    # Add entry
                    data['daily_entries'].append({
                        'date': f"{current_year} {current_date_part}",
                        'model': model_col or 'claude',
                        'cost': round(cost, 2)
                    })
                    
                    # Reset date part
                    current_date_part = None
            
            # Sort by date (most recent first)
            def parse_date_for_sorting(date_str):
                try:
                    year_match = re.search(r'(20\d{2})', date_str)
                    date_match = re.search(r'(\d{2})-(\d{2})', date_str)
                    
                    if year_match and date_match:
                        year = int(year_match.group(1))
                        month = int(date_match.group(1))
                        day = int(date_match.group(2))
                        return datetime.datetime(year, month, day)
                    return datetime.datetime.min
                except (ValueError, AttributeError):
                    return datetime.datetime.min
            
            data['daily_entries'].sort(key=lambda x: parse_date_for_sorting(x['date']), reverse=True)
            
            # Calculate time-based costs
            if data['daily_entries']:
                now = datetime.datetime.now()
                today = now.date()
                week_ago = now - datetime.timedelta(days=7)
                month_ago = now - datetime.timedelta(days=30)
                
                # Daily cost = most recent day's usage (first entry since sorted by date desc)
                daily_cost = data['daily_entries'][0]['cost'] if data['daily_entries'] else 0
                
                weekly_cost = 0
                monthly_cost = 0
                
                for entry in data['daily_entries']:
                    try:
                        # Parse date - format: "2025 MM-DD"
                        date_str = entry['date']
                        year_match = re.search(r'(20\d{2})', date_str)
                        date_match = re.search(r'(\d{2})-(\d{2})', date_str)
                        
                        if year_match and date_match:
                            year = int(year_match.group(1))
                            month = int(date_match.group(1))
                            day = int(date_match.group(2))
                            entry_date = datetime.datetime(year, month, day)
                            
                            # Check if it's within the last week
                            if entry_date >= week_ago:
                                weekly_cost += entry['cost']
                            
                            # Check if it's within the last month
                            if entry_date >= month_ago:
                                monthly_cost += entry['cost']
                                
                    except (ValueError, IndexError):
                        continue
                
                data['daily_cost'] = round(daily_cost, 2)
                data['weekly_cost'] = round(weekly_cost, 2)
                data['monthly_cost'] = round(monthly_cost, 2)
            
            return data
            
        except Exception as e:
            return {
                'error': f'Failed to parse output: {str(e)}',
                'raw_output': output[:500]  # First 500 chars for debugging
            }


@csrf_exempt
@require_http_methods(["POST"])
def execute_ccusage_simple(request):
    """Simple endpoint for executing ccusage command"""
    try:
        # Execute ccusage command to get real usage data
        result = subprocess.run(
            ['npx', 'ccusage'],
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode == 0:
            # Parse the output using existing parser
            from .ccusage_simple_parser import create_mock_pricing_data
            
            # Try to parse real ccusage output, fall back to mock if parsing fails
            try:
                # Clean ANSI codes before parsing - comprehensive cleaning
                import re
                clean_output = result.stdout
                # Remove all ANSI escape sequences
                clean_output = re.sub(r'\x1b\[[0-9;]*m', '', clean_output)
                clean_output = re.sub(r'\x1b\[[0-9;]*[mGKHJ]', '', clean_output)
                clean_output = re.sub(r'\x1b\[[0-9]+[ABCD]', '', clean_output)
                clean_output = re.sub(r'\x1b\[2J', '', clean_output)
                clean_output = re.sub(r'\x1b\[3J', '', clean_output)
                clean_output = re.sub(r'\x1b\[H', '', clean_output)
                clean_output = re.sub(r'\x1b\[2K', '', clean_output)
                clean_output = re.sub(r'\x1b\[1A', '', clean_output)
                clean_output = re.sub(r'\x1b\[G', '', clean_output)
                # Remove any remaining control characters
                clean_output = re.sub(r'[\x00-\x1f\x7f-\x9f]', ' ', clean_output)
                # Normalize whitespace
                clean_output = re.sub(r'\s+', ' ', clean_output)
                
                # Use the main parser from views.py
                pricing_view = PricingViewSet()
                parsed_data = pricing_view._parse_ccusage_output(clean_output)
                
                return JsonResponse({
                    'success': True,
                    'data': parsed_data,
                    'cached': False,
                    'timestamp': timezone.now().isoformat()
                })
            except Exception as parse_error:
                # If parsing fails, return the raw output for debugging
                return JsonResponse({
                    'success': True,
                    'raw_output': result.stdout,
                    'parse_error': str(parse_error),
                    'timestamp': timezone.now().isoformat()
                })
        else:
            # If ccusage command fails, try to provide more details
            error_msg = result.stderr or 'Unknown error executing ccusage'
            
            # Check if it's an authentication error
            if 'Invalid API key' in error_msg or 'authentication' in error_msg.lower():
                return JsonResponse({
                    'success': False,
                    'error': 'Authentication error: Please ensure Claude Code is properly authenticated. Run `claude auth status` to check.',
                    'details': error_msg
                }, status=500)
            
            return JsonResponse({
                'success': False,
                'error': f'ccusage command failed: {error_msg}',
                'returncode': result.returncode
            }, status=500)
            
    except Exception as e:
        return JsonResponse({
            'success': False,
            'error': str(e)
        }, status=500)
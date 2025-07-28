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
            
            # Parse the output
            parsed_data = self._parse_ccusage_output(raw_output)
            
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
        """Parse ccusage command output into structured data"""
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
            
            # Dictionary to track separate date entries
            daily_entries = []
            current_year = None
            
            for i, line in enumerate(lines):
                # Skip pseudo-ANSI color codes
                clean_line = re.sub(r'\[[0-9;]*m', '', line)
                
                # Skip header and border lines
                if not '│' in clean_line or any(x in clean_line for x in ['Date', 'Models', 'Input', 'Output', 'Cache', 'Total']):
                    # Look for total cost in non-table lines
                    if 'Total' in clean_line and '$' in clean_line:
                        cost_match = re.search(r'\$(\d+\.?\d*)', clean_line)
                        if cost_match:
                            data['total_cost'] = float(cost_match.group(1))
                    continue
                
                # Parse table data rows
                columns = [col.strip() for col in clean_line.split('│')]
                if len(columns) < 9:
                    continue
                
                date_col = columns[1].strip()
                model_col = columns[2].strip()
                cost_col = columns[8].strip() if len(columns) > 8 else columns[-1].strip()
                
                # Check if this is a year row (contains 20XX)
                if re.search(r'20\d{2}', date_col):
                    current_year = re.search(r'(20\d{2})', date_col).group(1)
                    
                    # Extract cost from this row if present
                    cost_match = re.search(r'\$(\d+\.?\d*)', cost_col)
                    if cost_match:
                        cost = float(cost_match.group(1))
                        
                        # Clean model name - remove pseudo-ANSI codes and dashes
                        model_name = re.sub(r'\[[0-9;]*m', '', model_col).replace('-', '').strip() if model_col else 'unknown'
                        
                        # Store as pending entry (we'll get the date in the next row)
                        daily_entries.append({
                            'year': current_year,
                            'date_part': None,  # Will be filled by next row
                            'model': model_name,
                            'cost': cost,
                            'complete': False
                        })
                
                # Check if this is a date continuation row (MM-DD format)
                elif current_year and re.search(r'\d{2}-\d{2}', date_col):
                    # Clean up pseudo-ANSI codes from date
                    date_part = re.sub(r'\[[0-9;]*m', '', date_col).strip()
                    
                    # Find the most recent incomplete entry and complete it
                    for entry in reversed(daily_entries):
                        if not entry['complete']:
                            entry['date_part'] = date_part
                            entry['complete'] = True
                            break
                    
                    # Check if this row also has a model and cost (additional model for same date)
                    if model_col and model_col.strip() and '$' in cost_col:
                        cost_match = re.search(r'\$(\d+\.?\d*)', cost_col)
                        if cost_match:
                            cost = float(cost_match.group(1))
                            model_name = re.sub(r'\[[0-9;]*m', '', model_col).replace('-', '').strip()
                            
                            daily_entries.append({
                                'year': current_year,
                                'date_part': date_part,
                                'model': model_name,
                                'cost': cost,
                                'complete': True
                            })
            
            # Group completed entries by date and combine models
            date_groups = {}
            for entry in daily_entries:
                if entry['complete'] and entry['date_part']:
                    full_date = f"{entry['year']} {entry['date_part']}"
                    
                    if full_date in date_groups:
                        date_groups[full_date]['cost'] += entry['cost']
                        if entry['model'] and entry['model'] not in date_groups[full_date]['models']:
                            date_groups[full_date]['models'].append(entry['model'])
                    else:
                        date_groups[full_date] = {
                            'cost': entry['cost'],
                            'models': [entry['model']] if entry['model'] else []
                        }
            
            # Convert to final format
            for date_str, group_data in date_groups.items():
                models_text = ', '.join(set(group_data['models'])) if group_data['models'] else 'multiple models'
                
                data['daily_entries'].append({
                    'date': date_str,
                    'model': models_text,
                    'cost': round(group_data['cost'], 2)
                })
            
            # Sort by date (most recent first)
            def parse_date_for_sorting(date_str):
                """Parse date string for proper sorting"""
                try:
                    # Extract year and month-day from "2025 07-26" format
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
                
                daily_cost = 0
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
                            
                            # Check if it's today
                            if entry_date.date() == today:
                                daily_cost += entry['cost']
                            
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
        # For testing, return mock data instead of executing ccusage
        # Remove this mock when ccusage is working properly
        from datetime import datetime, timedelta
        
        # Generate realistic daily entries for the past 30 days (sorted most recent first)
        today = datetime.now()
        daily_entries = []
        total_cost = 0
        
        for i in range(30):
            date = today - timedelta(days=i)
            cost = 30 + (i * 3.5) + (i % 7) * 10  # Varying costs
            total_cost += cost
            
            entry = {
                'date': f"2025 {date.strftime('%m-%d')}",
                'model': 'opus-4, sonnet-4',
                'cost': round(cost, 2)
            }
            daily_entries.append(entry)
        
        # Entries are already in correct order (most recent first) since i=0 is today
        
        # Calculate time-based costs
        daily_cost = daily_entries[0]['cost'] if daily_entries else 0
        weekly_cost = sum(entry['cost'] for entry in daily_entries[:7])
        monthly_cost = sum(entry['cost'] for entry in daily_entries)
        
        data = {
            'daily_entries': daily_entries,
            'total_cost': round(total_cost, 2),
            'daily_cost': round(daily_cost, 2),
            'weekly_cost': round(weekly_cost, 2),
            'monthly_cost': round(monthly_cost, 2),
            'last_updated': timezone.now().isoformat()
        }
        
        return JsonResponse({
            'success': True,
            'data': data,
            'cached': False,
            'timestamp': timezone.now().isoformat()
        })
        
        # Original ccusage execution (commented out for testing)
        """
        result = subprocess.run(
            ['npx', 'ccusage'],
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode == 0:
            return JsonResponse({
                'success': True,
                'output': result.stdout,
                'timestamp': timezone.now().isoformat()
            })
        else:
            return JsonResponse({
                'success': False,
                'error': result.stderr
            }, status=500)
        """
            
    except Exception as e:
        return JsonResponse({
            'success': False,
            'error': str(e)
        }, status=500)
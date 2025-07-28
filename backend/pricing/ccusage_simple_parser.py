#!/usr/bin/env python3
"""Simple test to create mock pricing data for frontend testing"""

import json
import subprocess
import sys
from datetime import datetime, timedelta

def create_mock_pricing_data():
    """Create realistic mock pricing data for testing"""
    
    # Generate realistic daily entries for the past 30 days
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
        'last_updated': datetime.now().isoformat()
    }
    
    return data

def mock_ccusage_endpoint():
    """Create a simple mock endpoint response"""
    try:
        data = create_mock_pricing_data()
        response = {
            'success': True,
            'data': data,
            'cached': False,
            'timestamp': datetime.now().isoformat()
        }
        return json.dumps(response, indent=2)
    except Exception as e:
        return json.dumps({
            'success': False,
            'error': str(e)
        }, indent=2)

if __name__ == "__main__":
    print(mock_ccusage_endpoint())
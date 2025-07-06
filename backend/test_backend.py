#!/usr/bin/env python3
"""
Test script to verify the Django backend API endpoints
"""

import requests
import json
import sys

BASE_URL = "http://127.0.0.1:8001/api"

def test_endpoints():
    """Test all API endpoints"""
    
    endpoints = [
        "/terminal/sessions/",
        "/queue/queue/", 
        "/voice/transcriptions/",
        "/settings/app-settings/"
    ]
    
    print("Testing Django backend API endpoints...")
    
    for endpoint in endpoints:
        try:
            url = BASE_URL + endpoint
            response = requests.get(url, timeout=5)
            
            if response.status_code == 200:
                print(f"✅ {endpoint} - OK ({response.status_code})")
                data = response.json()
                print(f"   Response: {len(data.get('results', data))} items")
            else:
                print(f"❌ {endpoint} - Error ({response.status_code})")
                
        except requests.exceptions.RequestException as e:
            print(f"❌ {endpoint} - Connection Error: {e}")
            return False
    
    # Test creating a terminal session
    try:
        url = BASE_URL + "/terminal/sessions/"
        data = {"name": "Test Terminal", "current_directory": "/tmp"}
        response = requests.post(url, json=data, timeout=5)
        
        if response.status_code == 201:
            print("✅ Terminal session creation - OK")
            session_data = response.json()
            session_id = session_data['id']
            
            # Test adding a message to queue
            queue_url = BASE_URL + "/queue/queue/"
            queue_data = {
                "terminal_session": session_id,
                "content": "echo 'Hello from Django backend!'"
            }
            queue_response = requests.post(queue_url, json=queue_data, timeout=5)
            
            if queue_response.status_code == 201:
                print("✅ Message queue creation - OK")
            else:
                print(f"❌ Message queue creation - Error ({queue_response.status_code})")
                
        else:
            print(f"❌ Terminal session creation - Error ({response.status_code})")
            
    except requests.exceptions.RequestException as e:
        print(f"❌ API Test - Connection Error: {e}")
        return False
    
    print("\n🎉 Backend API tests completed successfully!")
    return True

if __name__ == "__main__":
    success = test_endpoints()
    sys.exit(0 if success else 1)
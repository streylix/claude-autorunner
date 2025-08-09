"""
Comprehensive tests for frontend control API endpoints
"""

from django.test import TestCase, Client
from django.urls import reverse
import json
import os
import tempfile
import shutil
from unittest.mock import patch, MagicMock
from django.utils import timezone


class TimerControlTestCase(TestCase):
    """Test timer control endpoints"""
    
    def setUp(self):
        self.client = Client()
        # Create a temporary directory for trigger files
        self.temp_dir = tempfile.mkdtemp()
        self.original_tmp = '/tmp'
        
    def tearDown(self):
        # Clean up temporary directory
        shutil.rmtree(self.temp_dir, ignore_errors=True)
    
    def test_timer_start(self):
        """Test timer start endpoint"""
        response = self.client.post('/api/timer/start/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertEqual(data['action'], 'start')
        self.assertEqual(data['status'], 'Timer started')
        
        # Check trigger file was created
        trigger_file = '/tmp/claude-code-timer-start-trigger'
        self.assertTrue(os.path.exists(trigger_file))
        
        # Clean up
        if os.path.exists(trigger_file):
            os.remove(trigger_file)
    
    def test_timer_stop(self):
        """Test timer stop endpoint"""
        response = self.client.post('/api/timer/stop/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertEqual(data['action'], 'stop')
        self.assertEqual(data['status'], 'Timer stopped')
        
        # Check trigger file
        trigger_file = '/tmp/claude-code-timer-stop-trigger'
        self.assertTrue(os.path.exists(trigger_file))
        
        # Clean up
        if os.path.exists(trigger_file):
            os.remove(trigger_file)
    
    def test_timer_pause(self):
        """Test timer pause endpoint"""
        response = self.client.post('/api/timer/pause/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertEqual(data['action'], 'pause')
        self.assertEqual(data['status'], 'Timer paused')
        
        # Check trigger file
        trigger_file = '/tmp/claude-code-timer-pause-trigger'
        self.assertTrue(os.path.exists(trigger_file))
        
        # Clean up
        if os.path.exists(trigger_file):
            os.remove(trigger_file)
    
    def test_timer_resume(self):
        """Test timer resume endpoint"""
        response = self.client.post('/api/timer/resume/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertEqual(data['action'], 'resume')
        self.assertEqual(data['status'], 'Timer resumed')
        
        # Check trigger file
        trigger_file = '/tmp/claude-code-timer-resume-trigger'
        self.assertTrue(os.path.exists(trigger_file))
        
        # Clean up
        if os.path.exists(trigger_file):
            os.remove(trigger_file)
    
    def test_timer_reset(self):
        """Test timer reset endpoint"""
        response = self.client.post('/api/timer/reset/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertEqual(data['action'], 'reset')
        self.assertEqual(data['status'], 'Timer reset')
        
        # Check trigger file
        trigger_file = '/tmp/claude-code-timer-reset-trigger'
        self.assertTrue(os.path.exists(trigger_file))
        
        # Clean up
        if os.path.exists(trigger_file):
            os.remove(trigger_file)
    
    def test_timer_set_valid(self):
        """Test timer set with valid values"""
        payload = {
            'hours': 0,
            'minutes': 25,
            'seconds': 30
        }
        response = self.client.post('/api/timer/set/',
                                   data=json.dumps(payload),
                                   content_type='application/json')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertEqual(data['action'], 'set')
        self.assertEqual(data['time'], '00:25:30')
        self.assertEqual(data['status'], 'Timer set to 00:25:30')
        
        # Check trigger file
        trigger_file = '/tmp/claude-code-timer-set-trigger'
        self.assertTrue(os.path.exists(trigger_file))
        
        # Verify trigger file content
        with open(trigger_file, 'r') as f:
            content = f.read()
            self.assertIn('"hours": 0', content)
            self.assertIn('"minutes": 25', content)
            self.assertIn('"seconds": 30', content)
        
        # Clean up
        if os.path.exists(trigger_file):
            os.remove(trigger_file)
    
    def test_timer_set_invalid_types(self):
        """Test timer set with invalid data types"""
        payload = {
            'hours': 'invalid',
            'minutes': 25,
            'seconds': 30
        }
        response = self.client.post('/api/timer/set/',
                                   data=json.dumps(payload),
                                   content_type='application/json')
        self.assertEqual(response.status_code, 400)
        
        data = json.loads(response.content)
        self.assertIn('error', data)
        self.assertIn('must be integers', data['error'])
    
    def test_timer_set_negative_values(self):
        """Test timer set with negative values"""
        payload = {
            'hours': -1,
            'minutes': 25,
            'seconds': 30
        }
        response = self.client.post('/api/timer/set/',
                                   data=json.dumps(payload),
                                   content_type='application/json')
        self.assertEqual(response.status_code, 400)
        
        data = json.loads(response.content)
        self.assertIn('error', data)
        self.assertIn('cannot be negative', data['error'])
    
    def test_timer_set_invalid_range(self):
        """Test timer set with out-of-range values"""
        payload = {
            'hours': 0,
            'minutes': 75,  # Invalid: >= 60
            'seconds': 30
        }
        response = self.client.post('/api/timer/set/',
                                   data=json.dumps(payload),
                                   content_type='application/json')
        self.assertEqual(response.status_code, 400)
        
        data = json.loads(response.content)
        self.assertIn('error', data)
        self.assertIn('must be less than 60', data['error'])
    
    def test_timer_status_no_file(self):
        """Test timer status when no status file exists"""
        # Ensure status file doesn't exist
        status_file = '/tmp/claude-code-timer-status'
        if os.path.exists(status_file):
            os.remove(status_file)
        
        response = self.client.get('/api/timer/status/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertFalse(data['running'])
        self.assertFalse(data['paused'])
        self.assertEqual(data['time'], '00:00:00')
        self.assertEqual(data['elapsed_seconds'], 0)
    
    def test_timer_status_with_file(self):
        """Test timer status when status file exists"""
        status_file = '/tmp/claude-code-timer-status'
        status_data = {
            'running': True,
            'paused': False,
            'time': '00:12:34',
            'elapsed_seconds': 754
        }
        
        with open(status_file, 'w') as f:
            json.dump(status_data, f)
        
        response = self.client.get('/api/timer/status/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertTrue(data['running'])
        self.assertFalse(data['paused'])
        self.assertEqual(data['time'], '00:12:34')
        self.assertEqual(data['elapsed_seconds'], 754)
        
        # Clean up
        if os.path.exists(status_file):
            os.remove(status_file)


class TerminalControlTestCase(TestCase):
    """Test terminal control endpoints"""
    
    def setUp(self):
        self.client = Client()
    
    def test_terminal_switch_valid(self):
        """Test switching to a valid terminal"""
        payload = {'terminal_id': 2}
        response = self.client.post('/api/terminal/switch/',
                                   data=json.dumps(payload),
                                   content_type='application/json')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertEqual(data['active_terminal'], 2)
        self.assertEqual(data['status'], 'Switched to Terminal 2')
        
        # Check trigger file
        trigger_file = '/tmp/claude-code-terminal-switch-trigger'
        self.assertTrue(os.path.exists(trigger_file))
        
        # Clean up
        if os.path.exists(trigger_file):
            os.remove(trigger_file)
    
    def test_terminal_switch_invalid(self):
        """Test switching to an invalid terminal"""
        # Test terminal ID too high
        payload = {'terminal_id': 5}
        response = self.client.post('/api/terminal/switch/',
                                   data=json.dumps(payload),
                                   content_type='application/json')
        self.assertEqual(response.status_code, 400)
        
        data = json.loads(response.content)
        self.assertIn('error', data)
        self.assertIn('between 1 and 4', data['error'])
        
        # Test terminal ID too low
        payload = {'terminal_id': 0}
        response = self.client.post('/api/terminal/switch/',
                                   data=json.dumps(payload),
                                   content_type='application/json')
        self.assertEqual(response.status_code, 400)
    
    def test_terminal_status(self):
        """Test getting terminal status"""
        # Create a mock status file
        status_file = '/tmp/claude-code-terminal-status'
        status_data = {
            'active_terminal': 1,
            'terminals': {
                '1': {'name': 'Terminal 1', 'running': True, 'current_command': 'npm run dev'},
                '2': {'name': 'Terminal 2', 'running': False, 'current_command': None}
            }
        }
        
        with open(status_file, 'w') as f:
            json.dump(status_data, f)
        
        response = self.client.get('/api/terminal/status/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertEqual(data['active_terminal'], 1)
        self.assertIn('terminals', data)
        self.assertEqual(data['terminals']['1']['name'], 'Terminal 1')
        self.assertTrue(data['terminals']['1']['running'])
        
        # Clean up
        if os.path.exists(status_file):
            os.remove(status_file)


class PlanModeTestCase(TestCase):
    """Test plan mode control endpoints"""
    
    def setUp(self):
        self.client = Client()
    
    def test_planmode_toggle(self):
        """Test toggling plan mode"""
        response = self.client.post('/api/planmode/toggle/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertIn('plan_mode_enabled', data)
        
        # Check trigger file
        trigger_file = '/tmp/claude-code-planmode-toggle-trigger'
        self.assertTrue(os.path.exists(trigger_file))
        
        # Clean up
        if os.path.exists(trigger_file):
            os.remove(trigger_file)
    
    def test_planmode_status(self):
        """Test getting plan mode status"""
        # Test without status file
        status_file = '/tmp/claude-code-planmode-status'
        if os.path.exists(status_file):
            os.remove(status_file)
        
        response = self.client.get('/api/planmode/status/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertFalse(data['plan_mode_enabled'])
        
        # Test with status file
        with open(status_file, 'w') as f:
            json.dump({'enabled': True}, f)
        
        response = self.client.get('/api/planmode/status/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertTrue(data['plan_mode_enabled'])
        
        # Clean up
        if os.path.exists(status_file):
            os.remove(status_file)


class InjectionControlTestCase(TestCase):
    """Test injection control endpoints"""
    
    def setUp(self):
        self.client = Client()
    
    def test_injection_pause(self):
        """Test pausing injection"""
        response = self.client.post('/api/injection/pause/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertTrue(data['injection_paused'])
        self.assertEqual(data['status'], 'Injection paused')
        
        # Check trigger file
        trigger_file = '/tmp/claude-code-injection-pause-trigger'
        self.assertTrue(os.path.exists(trigger_file))
        
        # Clean up
        if os.path.exists(trigger_file):
            os.remove(trigger_file)
    
    def test_injection_resume(self):
        """Test resuming injection"""
        response = self.client.post('/api/injection/resume/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertFalse(data['injection_paused'])
        self.assertEqual(data['status'], 'Injection resumed')
        
        # Check trigger file
        trigger_file = '/tmp/claude-code-injection-resume-trigger'
        self.assertTrue(os.path.exists(trigger_file))
        
        # Clean up
        if os.path.exists(trigger_file):
            os.remove(trigger_file)
    
    def test_injection_manual(self):
        """Test manual injection trigger"""
        response = self.client.post('/api/injection/manual/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertTrue(data['message_injected'])
        self.assertEqual(data['status'], 'Manual injection triggered')
        
        # Check trigger file
        trigger_file = '/tmp/claude-code-injection-manual-trigger'
        self.assertTrue(os.path.exists(trigger_file))
        
        # Clean up
        if os.path.exists(trigger_file):
            os.remove(trigger_file)


class QueueStatusTestCase(TestCase):
    """Test queue status endpoint"""
    
    def setUp(self):
        self.client = Client()
    
    def test_queue_status_no_file(self):
        """Test queue status when no status file exists"""
        status_file = '/tmp/claude-code-queue-status'
        if os.path.exists(status_file):
            os.remove(status_file)
        
        response = self.client.get('/api/queue/status/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertEqual(data['total_messages'], 0)
        self.assertEqual(data['terminals'], {})
    
    def test_queue_status_with_file(self):
        """Test queue status with existing status file"""
        status_file = '/tmp/claude-code-queue-status'
        status_data = {
            'total_messages': 3,
            'terminals': {
                'terminal_1': {
                    'count': 2,
                    'messages': [
                        {'content': 'ls -la', 'created_at': '2024-01-09T12:00:00Z'},
                        {'content': 'pwd', 'created_at': '2024-01-09T12:01:00Z'}
                    ]
                },
                'terminal_2': {
                    'count': 1,
                    'messages': [
                        {'content': 'echo test', 'created_at': '2024-01-09T12:02:00Z'}
                    ]
                }
            }
        }
        
        with open(status_file, 'w') as f:
            json.dump(status_data, f)
        
        response = self.client.get('/api/queue/status/')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertEqual(data['total_messages'], 3)
        self.assertIn('terminal_1', data['terminals'])
        self.assertEqual(data['terminals']['terminal_1']['count'], 2)
        
        # Clean up
        if os.path.exists(status_file):
            os.remove(status_file)
    
    def test_queue_status_filtered(self):
        """Test queue status filtered by terminal"""
        status_file = '/tmp/claude-code-queue-status'
        status_data = {
            'total_messages': 3,
            'terminals': {
                'terminal_1': {
                    'count': 2,
                    'messages': [
                        {'content': 'ls -la', 'created_at': '2024-01-09T12:00:00Z'}
                    ]
                },
                'terminal_2': {
                    'count': 1,
                    'messages': [
                        {'content': 'echo test', 'created_at': '2024-01-09T12:02:00Z'}
                    ]
                }
            }
        }
        
        with open(status_file, 'w') as f:
            json.dump(status_data, f)
        
        response = self.client.get('/api/queue/status/?terminal_id=1')
        self.assertEqual(response.status_code, 200)
        
        data = json.loads(response.content)
        self.assertTrue(data['success'])
        self.assertEqual(data['terminal_id'], '1')
        self.assertEqual(data['count'], 2)
        
        # Clean up
        if os.path.exists(status_file):
            os.remove(status_file)
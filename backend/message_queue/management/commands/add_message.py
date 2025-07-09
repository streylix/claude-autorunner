from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from datetime import datetime
from message_queue.models import QueuedMessage
from terminal.models import TerminalSession
import pytz


class Command(BaseCommand):
    help = 'Add a message to the message queue for a specific terminal session'

    def add_arguments(self, parser):
        parser.add_argument(
            'messages',
            nargs='+',
            type=str,
            help='The message(s) to add to the queue'
        )
        
        parser.add_argument(
            '--terminal',
            '-t',
            type=str,
            help='Terminal session name or ID (defaults to most recent active session)'
        )
        
        parser.add_argument(
            '--schedule',
            '-s',
            type=str,
            help='Schedule the message for a specific time (format: YYYY-MM-DD HH:MM:SS)'
        )
        
        parser.add_argument(
            '--status',
            type=str,
            default='pending',
            choices=['pending', 'injected', 'cancelled'],
            help='Initial status of the message (default: pending)'
        )

    def handle(self, *args, **options):
        messages = options['messages']
        terminal_identifier = options['terminal']
        schedule_time = options['schedule']
        status = options['status']
        
        # Find the terminal session
        terminal_session = self._get_terminal_session(terminal_identifier)
        
        if not terminal_session:
            raise CommandError('No terminal session found. Please specify a valid terminal or ensure at least one session exists.')
        
        # Parse scheduled time if provided
        scheduled_for = None
        if schedule_time:
            try:
                # Parse the datetime and make it timezone-aware
                scheduled_for = datetime.strptime(schedule_time, '%Y-%m-%d %H:%M:%S')
                scheduled_for = timezone.make_aware(scheduled_for)
            except ValueError:
                raise CommandError(f'Invalid datetime format: {schedule_time}. Use YYYY-MM-DD HH:MM:SS')
        
        # Add each message to the queue
        created_messages = []
        for message_content in messages:
            queued_message = QueuedMessage.objects.create(
                terminal_session=terminal_session,
                content=message_content,
                scheduled_for=scheduled_for,
                status=status
            )
            created_messages.append(queued_message)
            
            self.stdout.write(
                self.style.SUCCESS(
                    f'Successfully added message to terminal "{terminal_session.name}" (ID: {terminal_session.id}): {message_content[:50]}{"..." if len(message_content) > 50 else ""}'
                )
            )
        
        # Summary
        if len(created_messages) > 1:
            self.stdout.write(
                self.style.SUCCESS(
                    f'\nTotal: {len(created_messages)} messages added to the queue'
                )
            )
    
    def _get_terminal_session(self, identifier):
        """Get terminal session by name, ID, or return the most recent active one"""
        
        if identifier:
            # Try to find by name first (get the most recent one if multiple exist)
            terminal_sessions = TerminalSession.objects.filter(name=identifier).order_by('-created_at')
            if terminal_sessions.exists():
                return terminal_sessions.first()
            
            # If identifier is just a number, try to find by terminal number
            if identifier.isdigit():
                terminal_name = f'Terminal {identifier}'
                terminal_sessions = TerminalSession.objects.filter(name=terminal_name).order_by('-created_at')
                if terminal_sessions.exists():
                    return terminal_sessions.first()
            
            # Try to find by ID if it's a valid UUID
            try:
                import uuid
                uuid_identifier = uuid.UUID(identifier)
                return TerminalSession.objects.get(id=uuid_identifier)
            except (ValueError, TerminalSession.DoesNotExist):
                pass
            
            raise CommandError(f'Terminal session "{identifier}" not found')
        
        # No identifier provided - get the most recent active session
        terminal_session = TerminalSession.objects.filter(is_active=True).order_by('-created_at').first()
        
        # If no active sessions, get the most recent session
        if not terminal_session:
            terminal_session = TerminalSession.objects.order_by('-created_at').first()
        
        return terminal_session
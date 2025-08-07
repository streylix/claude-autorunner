# Management command simplified for new backend structure
# Terminal sessions have been removed, now uses simple terminal_id strings

from django.core.management.base import BaseCommand
from message_queue.models import QueuedMessage


class Command(BaseCommand):
    help = 'Add a message to the message queue for a specific terminal'

    def add_arguments(self, parser):
        parser.add_argument(
            'message', type=str,
            help='The message content to add to the queue'
        )
        parser.add_argument(
            '--terminal-id', type=str, default='terminal_1',
            help='The terminal ID (e.g., terminal_1, terminal_2)'
        )

    def handle(self, *args, **options):
        message_content = options['message']
        terminal_id = options['terminal_id']
        
        try:
            # Create the queued message with simple terminal_id
            queued_message = QueuedMessage.objects.create(
                terminal_id=terminal_id,
                content=message_content,
                status='pending'
            )
            
            self.stdout.write(
                self.style.SUCCESS(
                    f'Successfully added message to {terminal_id}: {message_content[:50]}{"..." if len(message_content) > 50 else ""}'
                )
            )
            
            return f'Message queued with ID: {queued_message.id}'
            
        except Exception as e:
            self.stderr.write(
                self.style.ERROR(f'Failed to add message: {str(e)}')
            )
            raise
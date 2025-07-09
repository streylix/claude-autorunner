from django.db.models.signals import post_save, post_delete
from django.dispatch import receiver
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
from .models import QueuedMessage


@receiver(post_save, sender=QueuedMessage)
def message_saved(sender, instance, created, **kwargs):
    """Send WebSocket notification when a message is created or updated"""
    channel_layer = get_channel_layer()
    
    if created:
        # Message was newly created
        action = 'added'
    else:
        # Message was updated (e.g., status changed)
        action = 'updated'
    
    message_data = {
        'id': str(instance.id),
        'content': instance.content,
        'status': instance.status,
        'created_at': instance.created_at.isoformat(),
        'scheduled_for': instance.scheduled_for.isoformat() if instance.scheduled_for else None,
        'injected_at': instance.injected_at.isoformat() if instance.injected_at else None,
    }
    
    # Send to general message queue group
    async_to_sync(channel_layer.group_send)(
        'message_queue_updates',
        {
            'type': 'message_queue_update',
            'action': action,
            'message': message_data,
            'terminal_session': str(instance.terminal_session.id),
        }
    )
    
    # Send to specific terminal group
    terminal_group = f'terminal_{instance.terminal_session.id}_queue'
    async_to_sync(channel_layer.group_send)(
        terminal_group,
        {
            'type': 'message_added' if created else 'message_queue_update',
            'message': message_data,
            'terminal_session': str(instance.terminal_session.id),
        }
    )


@receiver(post_delete, sender=QueuedMessage)
def message_deleted(sender, instance, **kwargs):
    """Send WebSocket notification when a message is deleted"""
    channel_layer = get_channel_layer()
    
    message_data = {
        'id': str(instance.id),
        'content': instance.content,
    }
    
    # Send to general message queue group
    async_to_sync(channel_layer.group_send)(
        'message_queue_updates',
        {
            'type': 'message_queue_update',
            'action': 'removed',
            'message': message_data,
            'terminal_session': str(instance.terminal_session.id),
        }
    )
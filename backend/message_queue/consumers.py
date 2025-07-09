import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from .models import QueuedMessage
from terminal.models import TerminalSession


class MessageQueueConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        # Join a general message queue group for all updates
        self.group_name = 'message_queue_updates'

        await self.channel_layer.group_add(
            self.group_name,
            self.channel_name
        )

        await self.accept()

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(
            self.group_name,
            self.channel_name
        )

    # Receive message from WebSocket
    async def receive(self, text_data):
        data = json.loads(text_data)
        message_type = data.get('type')

        if message_type == 'subscribe_terminal':
            # Subscribe to updates for a specific terminal session
            terminal_id = data.get('terminal_id')
            if terminal_id:
                terminal_group = f'terminal_{terminal_id}_queue'
                await self.channel_layer.group_add(
                    terminal_group,
                    self.channel_name
                )

    # Handle message queue update events
    async def message_queue_update(self, event):
        # Send message to WebSocket
        await self.send(text_data=json.dumps({
            'type': 'message_queue_update',
            'action': event['action'],  # 'added', 'removed', 'updated'
            'message': event['message'],
            'terminal_session': event.get('terminal_session'),
        }))

    async def message_added(self, event):
        # Send message added event
        await self.send(text_data=json.dumps({
            'type': 'message_added',
            'message': event['message'],
            'terminal_session': event.get('terminal_session'),
        }))

    async def message_injected(self, event):
        # Send message injected event
        await self.send(text_data=json.dumps({
            'type': 'message_injected',
            'message_id': event['message_id'],
            'terminal_session': event.get('terminal_session'),
        }))
import json
import asyncio
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from .models import TerminalSession, TerminalCommand


class TerminalConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.session_id = self.scope['url_route']['kwargs']['session_id']
        self.session_group_name = f'terminal_{self.session_id}'

        # Join session group
        await self.channel_layer.group_add(
            self.session_group_name,
            self.channel_name
        )

        await self.accept()

    async def disconnect(self, close_code):
        # Leave session group
        await self.channel_layer.group_discard(
            self.session_group_name,
            self.channel_name
        )

    async def receive(self, text_data):
        data = json.loads(text_data)
        message_type = data.get('type')

        if message_type == 'terminal_input':
            await self.handle_terminal_input(data)
        elif message_type == 'resize':
            await self.handle_resize(data)

    async def handle_terminal_input(self, data):
        input_data = data.get('data', '')
        
        # Send to group
        await self.channel_layer.group_send(
            self.session_group_name,
            {
                'type': 'terminal_output',
                'data': input_data
            }
        )

    async def handle_resize(self, data):
        cols = data.get('cols')
        rows = data.get('rows')
        
        # Handle terminal resize
        await self.channel_layer.group_send(
            self.session_group_name,
            {
                'type': 'terminal_resize',
                'cols': cols,
                'rows': rows
            }
        )

    async def terminal_output(self, event):
        # Send message to WebSocket
        await self.send(text_data=json.dumps({
            'type': 'terminal_output',
            'data': event['data']
        }))

    async def terminal_resize(self, event):
        # Send resize event to WebSocket
        await self.send(text_data=json.dumps({
            'type': 'terminal_resize',
            'cols': event['cols'],
            'rows': event['rows']
        }))
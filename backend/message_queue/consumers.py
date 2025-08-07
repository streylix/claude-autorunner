import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async


class MessageQueueConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        # Join a group for message queue updates
        self.group_name = 'message_queue'
        
        await self.channel_layer.group_add(
            self.group_name,
            self.channel_name
        )
        
        await self.accept()
        print(f"[WebSocket] Client connected to message queue")

    async def disconnect(self, close_code):
        # Leave group
        await self.channel_layer.group_discard(
            self.group_name,
            self.channel_name
        )
        print(f"[WebSocket] Client disconnected from message queue")

    async def receive(self, text_data):
        # Handle incoming WebSocket messages (if needed)
        pass

    async def addmsg_message(self, event):
        # Send message to WebSocket
        message = event['message']
        
        await self.send(text_data=json.dumps({
            'type': 'addmsg',
            'content': message['content'],
            'terminal_id': message['terminal_id'],
            'timestamp': message['timestamp']
        }))
        print(f"[WebSocket] Sent addmsg message: {message['content']}")
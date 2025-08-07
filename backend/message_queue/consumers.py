# WebSocket consumers removed for simplified backend
# This eliminates the need for channels and real-time updates

# The simplified backend only uses REST API endpoints for message queuing
# No WebSocket functionality is needed for the core use cases:
# - ccusage (pricing)
# - addmsg (message queue)  
# - audio transcribing
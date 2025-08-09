# Claude Code Bot API Documentation

## Overview
This document describes the API endpoints available for controlling the Claude Code Bot terminal application. These endpoints are designed for integration with Discord bots and other external tools.

## Base URL
```
http://127.0.0.1:8001/api
```

## Authentication
Currently, no authentication is required as the API is only accessible locally.

## Endpoints

### Message Queue Management

#### Add Message to Queue
Adds a message to the terminal's message queue for injection.

**Endpoint:** `POST /api/queue/add/`

**Request Body:**
```json
{
  "content": "ls -la",
  "terminal_id": "terminal_1"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Message added to queue",
  "terminal_id": "terminal_1"
}
```

**Script:** `scripts/addmsg`
```bash
./scripts/addmsg "command" [terminal_number]
```

---

### Timer Control

#### Start Timer
Starts the timer in the frontend application.

**Endpoint:** `POST /api/timer/start/`

**Response:**
```json
{
  "success": true,
  "action": "start",
  "status": "Timer started"
}
```

**Script:** `scripts/timer-start`
```bash
./scripts/timer-start
```

---

#### Stop Timer
Stops the currently running timer.

**Endpoint:** `POST /api/timer/stop/`

**Response:**
```json
{
  "success": true,
  "action": "stop",
  "status": "Timer stopped"
}
```

**Script:** `scripts/timer-stop`
```bash
./scripts/timer-stop
```

---

#### Pause Timer
Pauses the currently running timer.

**Endpoint:** `POST /api/timer/pause/`

**Response:**
```json
{
  "success": true,
  "action": "pause",
  "status": "Timer paused"
}
```

**Script:** `scripts/timer-pause`
```bash
./scripts/timer-pause
```

---

#### Resume Timer
Resumes a paused timer.

**Endpoint:** `POST /api/timer/resume/`

**Response:**
```json
{
  "success": true,
  "action": "resume",
  "status": "Timer resumed"
}
```

**Script:** `scripts/timer-resume`
```bash
./scripts/timer-resume
```

---

#### Reset Timer
Resets the timer to 00:00:00.

**Endpoint:** `POST /api/timer/reset/`

**Response:**
```json
{
  "success": true,
  "action": "reset",
  "status": "Timer reset"
}
```

**Script:** `scripts/timer-reset`
```bash
./scripts/timer-reset
```

---

#### Set Timer
Sets the timer to a specific duration.

**Endpoint:** `POST /api/timer/set/`

**Request Body:**
```json
{
  "hours": 0,
  "minutes": 25,
  "seconds": 0
}
```

**Response:**
```json
{
  "success": true,
  "action": "set",
  "time": "00:25:00",
  "status": "Timer set to 00:25:00"
}
```

**Script:** `scripts/timer-set`
```bash
./scripts/timer-set [hours] [minutes] [seconds]
# Example: ./scripts/timer-set 0 25 0
```

---

#### Get Timer Status
Gets the current timer status and time.

**Endpoint:** `GET /api/timer/status/`

**Response:**
```json
{
  "success": true,
  "running": true,
  "paused": false,
  "time": "00:12:34",
  "elapsed_seconds": 754
}
```

**Script:** `scripts/timer-status`
```bash
./scripts/timer-status
```

---

### Queue Management

#### Clear Message Queue
Clears all messages from the queue.

**Endpoint:** `POST /api/queue/clear/`

**Request Body (optional):**
```json
{
  "terminal_id": "terminal_1"
}
```
If no terminal_id is provided, clears all queues.

**Response:**
```json
{
  "success": true,
  "cleared_count": 5,
  "status": "Queue cleared"
}
```

**Script:** `scripts/clear-queue`
```bash
./scripts/clear-queue [terminal_number]
```

---

#### Get Queue Status
Gets the current queue status and pending messages.

**Endpoint:** `GET /api/queue/status/`

**Query Parameters:**
- `terminal_id` (optional): Get queue for specific terminal

**Response:**
```json
{
  "success": true,
  "total_messages": 3,
  "terminals": {
    "terminal_1": {
      "count": 2,
      "messages": [
        {
          "content": "ls -la",
          "created_at": "2024-01-09T12:00:00Z"
        }
      ]
    },
    "terminal_2": {
      "count": 1,
      "messages": []
    }
  }
}
```

**Script:** `scripts/queue-status`
```bash
./scripts/queue-status [terminal_number]
```

---

### Terminal Control

#### Switch Active Terminal
Switches the active terminal in the frontend.

**Endpoint:** `POST /api/terminal/switch/`

**Request Body:**
```json
{
  "terminal_id": 2
}
```

**Response:**
```json
{
  "success": true,
  "active_terminal": 2,
  "status": "Switched to Terminal 2"
}
```

**Script:** `scripts/switch-terminal`
```bash
./scripts/switch-terminal [terminal_number]
```

---

#### Get Terminal Status
Gets the status of all terminals.

**Endpoint:** `GET /api/terminal/status/`

**Response:**
```json
{
  "success": true,
  "active_terminal": 1,
  "terminals": {
    "1": {
      "name": "Terminal 1",
      "running": true,
      "current_command": "npm run dev"
    },
    "2": {
      "name": "Terminal 2",
      "running": false,
      "current_command": null
    }
  }
}
```

**Script:** `scripts/terminal-status`
```bash
./scripts/terminal-status
```

---

### Plan Mode Control

#### Toggle Plan Mode
Toggles plan mode on/off for message injection.

**Endpoint:** `POST /api/planmode/toggle/`

**Response:**
```json
{
  "success": true,
  "plan_mode_enabled": true,
  "status": "Plan mode enabled"
}
```

**Script:** `scripts/toggle-planmode`
```bash
./scripts/toggle-planmode
```

---

#### Get Plan Mode Status
Gets the current plan mode status.

**Endpoint:** `GET /api/planmode/status/`

**Response:**
```json
{
  "success": true,
  "plan_mode_enabled": false
}
```

**Script:** `scripts/planmode-status`
```bash
./scripts/planmode-status
```

---

### Auto-Continue Control

#### Toggle Auto-Continue
Toggles auto-continue mode for automatic message injection.

**Endpoint:** `POST /api/autocontinue/toggle/`

**Response:**
```json
{
  "success": true,
  "auto_continue_enabled": true,
  "status": "Auto-continue enabled"
}
```

**Script:** `scripts/toggle-autocontinue`
```bash
./scripts/toggle-autocontinue
```

---

### Injection Control

#### Pause Injection
Pauses message injection.

**Endpoint:** `POST /api/injection/pause/`

**Response:**
```json
{
  "success": true,
  "injection_paused": true,
  "status": "Injection paused"
}
```

**Script:** `scripts/pause-injection`
```bash
./scripts/pause-injection
```

---

#### Resume Injection
Resumes message injection.

**Endpoint:** `POST /api/injection/resume/`

**Response:**
```json
{
  "success": true,
  "injection_paused": false,
  "status": "Injection resumed"
}
```

**Script:** `scripts/resume-injection`
```bash
./scripts/resume-injection
```

---

#### Manual Inject
Manually triggers injection of the next message in queue.

**Endpoint:** `POST /api/injection/manual/`

**Response:**
```json
{
  "success": true,
  "message_injected": true,
  "content": "ls -la",
  "terminal": 1
}
```

**Script:** `scripts/inject-next`
```bash
./scripts/inject-next
```

---

## WebSocket Connection

For real-time updates, connect to the WebSocket endpoint:

**Endpoint:** `ws://127.0.0.1:8001/ws/queue/`

**Message Format:**
```json
{
  "type": "status_update",
  "data": {
    "queue_size": 3,
    "timer_status": "running",
    "active_terminal": 1
  }
}
```

---

## Error Responses

All endpoints return consistent error responses:

**400 Bad Request:**
```json
{
  "error": "Invalid request",
  "details": "Missing required field: terminal_id"
}
```

**500 Internal Server Error:**
```json
{
  "error": "Internal server error",
  "details": "Failed to communicate with frontend"
}
```

---

## Usage Examples

### Discord Bot Integration

```python
import requests

API_BASE = "http://127.0.0.1:8001/api"

# Add message to queue
def add_message(content, terminal=1):
    response = requests.post(
        f"{API_BASE}/queue/add/",
        json={"content": content, "terminal_id": f"terminal_{terminal}"}
    )
    return response.json()

# Control timer
def start_timer():
    response = requests.post(f"{API_BASE}/timer/start/")
    return response.json()

def set_timer(hours=0, minutes=25, seconds=0):
    response = requests.post(
        f"{API_BASE}/timer/set/",
        json={"hours": hours, "minutes": minutes, "seconds": seconds}
    )
    return response.json()
```

### Bash Script Usage

```bash
# Add multiple messages
./scripts/addmsg "cd /project" 1
./scripts/addmsg "npm install" 1
./scripts/addmsg "npm run dev" 1

# Set a 25-minute timer
./scripts/timer-set 0 25 0
./scripts/timer-start

# Check status
./scripts/queue-status
./scripts/timer-status
```

---

## Notes

- All endpoints that modify state use POST method
- All endpoints that only read state use GET method
- Terminal IDs are 1-indexed (1, 2, 3, 4)
- The backend API acts as a bridge to the frontend Electron app
- File triggers are created for immediate frontend notification
- All timestamps are in ISO 8601 format (UTC)
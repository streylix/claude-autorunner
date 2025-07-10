/**
 * Django Backend API Client
 * Handles communication with the Django backend running on port 8001
 */

class BackendAPIClient {
    constructor(baseUrl = 'http://127.0.0.1:8001/api') {
        this.baseUrl = baseUrl;
        this.currentSessionId = null;
    }

    async _fetch(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json',
            },
        };

        const mergedOptions = { ...defaultOptions, ...options };

        try {
            const response = await fetch(url, mergedOptions);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error(`API request failed: ${url}`, error);
            throw error;
        }
    }

    // Terminal Session Management
    async createTerminalSession(name, currentDirectory = '~') {
        const data = await this._fetch('/terminal/sessions/', {
            method: 'POST',
            body: JSON.stringify({
                name,
                current_directory: currentDirectory
            })
        });
        
        this.currentSessionId = data.id;
        return data;
    }

    async getTerminalSessions() {
        return await this._fetch('/terminal/sessions/');
    }

    async getTerminalSession(sessionId) {
        return await this._fetch(`/terminal/sessions/${sessionId}/`);
    }

    async updateTerminalSession(sessionId, updates) {
        return await this._fetch(`/terminal/sessions/${sessionId}/`, {
            method: 'PUT',
            body: JSON.stringify(updates)
        });
    }

    async updateTerminalSessionComplete(sessionId, name, color, frontendTerminalId, positionIndex, currentDirectory) {
        return await this._fetch(`/terminal/sessions/${sessionId}/`, {
            method: 'PUT',
            body: JSON.stringify({
                name,
                color,
                frontend_terminal_id: frontendTerminalId,
                position_index: positionIndex,
                current_directory: currentDirectory
            })
        });
    }

    async deleteTerminalSession(sessionId) {
        return await this._fetch(`/terminal/sessions/${sessionId}/`, {
            method: 'DELETE'
        });
    }

    async getTerminalHistory(sessionId) {
        return await this._fetch(`/terminal/sessions/${sessionId}/history/`);
    }

    // Message Queue Management
    async addMessageToQueue(terminalSessionId, content, scheduledFor = null) {
        return await this._fetch('/queue/queue/', {
            method: 'POST',
            body: JSON.stringify({
                terminal_session: terminalSessionId,
                content,
                scheduled_for: scheduledFor
            })
        });
    }

    async getQueuedMessages(terminalSessionId = null, status = null) {
        let url = '/queue/queue/';
        const params = new URLSearchParams();
        
        if (terminalSessionId) params.append('terminal_session', terminalSessionId);
        if (status) params.append('status', status);
        
        if (params.toString()) {
            url += '?' + params.toString();
        }
        
        return await this._fetch(url);
    }

    async injectMessage(messageId) {
        return await this._fetch(`/queue/queue/${messageId}/inject/`, {
            method: 'POST'
        });
    }

    async clearQueue(terminalSessionId) {
        return await this._fetch('/queue/queue/clear_queue/', {
            method: 'POST',
            body: JSON.stringify({
                terminal_session: terminalSessionId
            })
        });
    }

    async getMessageHistory(terminalSessionId = null) {
        let url = '/queue/history/';
        if (terminalSessionId) {
            url += `?terminal_session=${terminalSessionId}`;
        }
        return await this._fetch(url);
    }

    async addMessageToHistory(terminalSessionId, content, source = 'manual', terminalId = null, counter = null) {
        return await this._fetch('/queue/history/', {
            method: 'POST',
            body: JSON.stringify({
                terminal_session: terminalSessionId,
                message: content,
                source,
                terminal_id: terminalId,
                counter
            })
        });
    }

    // Voice Transcription
    async transcribeAudioFile(terminalSessionId, audioBlob) {
        const formData = new FormData();
        formData.append('terminal_session', terminalSessionId);
        formData.append('audio_file', audioBlob, 'recording.webm');

        return await this._fetch('/voice/transcriptions/', {
            method: 'POST',
            headers: {}, // Remove Content-Type header for FormData
            body: formData
        });
    }

    async transcribeBase64Audio(terminalSessionId, audioBase64, format = 'webm') {
        return await this._fetch('/voice/transcriptions/transcribe_base64/', {
            method: 'POST',
            body: JSON.stringify({
                terminal_session: terminalSessionId,
                audio_data: audioBase64,
                format
            })
        });
    }

    async getTranscriptionStatus(transcriptionId) {
        return await this._fetch(`/voice/transcriptions/${transcriptionId}/status/`);
    }

    async getTranscriptions(terminalSessionId = null) {
        let url = '/voice/transcriptions/';
        if (terminalSessionId) {
            url += `?terminal_session=${terminalSessionId}`;
        }
        return await this._fetch(url);
    }

    // Settings Management
    async getSetting(key) {
        return await this._fetch(`/settings/app-settings/${key}/`);
    }

    async setSetting(key, value) {
        try {
            // Try to update existing setting
            return await this._fetch(`/settings/app-settings/${key}/`, {
                method: 'PUT',
                body: JSON.stringify({ key, value })
            });
        } catch (error) {
            // If not found, create new setting
            return await this._fetch('/settings/app-settings/', {
                method: 'POST',
                body: JSON.stringify({ key, value })
            });
        }
    }

    async getAllSettings() {
        return await this._fetch('/settings/app-settings/');
    }

    async deleteSetting(key) {
        return await this._fetch(`/settings/app-settings/${key}/`, {
            method: 'DELETE'
        });
    }

    // Application Statistics Management
    async getApplicationStats(sessionId) {
        return await this._fetch(`/terminal/stats/${sessionId}/`);
    }

    async updateApplicationStats(sessionId, stats) {
        return await this._fetch(`/terminal/stats/${sessionId}/update_stats/`, {
            method: 'POST',
            body: JSON.stringify(stats)
        });
    }

    async createApplicationStats(sessionId, initialStats = {}) {
        return await this._fetch('/terminal/stats/', {
            method: 'POST',
            body: JSON.stringify({
                session_id: sessionId,
                ...initialStats
            })
        });
    }

    // WebSocket Connection
    createWebSocket(sessionId) {
        const wsUrl = `ws://127.0.0.1:8001/ws/terminal/${sessionId}/`;
        const ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            console.log('WebSocket connected for session:', sessionId);
        };
        
        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
        
        ws.onclose = () => {
            console.log('WebSocket disconnected for session:', sessionId);
        };
        
        return ws;
    }

    // Message Queue WebSocket Connection
    createMessageQueueWebSocket() {
        const wsUrl = `ws://127.0.0.1:8001/ws/message_queue/`;
        const ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            console.log('Message Queue WebSocket connected');
        };
        
        ws.onerror = (error) => {
            console.error('Message Queue WebSocket error:', error);
        };
        
        ws.onclose = () => {
            console.log('Message Queue WebSocket disconnected');
        };
        
        return ws;
    }

    // Todo Management
    async getTodos(terminalSessionId = null, completed = null, autoGenerated = null) {
        let url = '/todos/items/';
        const params = new URLSearchParams();
        
        if (terminalSessionId) params.append('terminal_session', terminalSessionId);
        if (completed !== null) params.append('completed', completed.toString());
        if (autoGenerated !== null) params.append('auto_generated', autoGenerated.toString());
        
        if (params.toString()) {
            url += '?' + params.toString();
        }
        
        return await this._fetch(url);
    }

    async createTodo(terminalSessionId, title, description = '', priority = 'medium') {
        return await this._fetch('/todos/items/', {
            method: 'POST',
            body: JSON.stringify({
                terminal_session: terminalSessionId,
                title,
                description,
                priority
            })
        });
    }

    async toggleTodo(todoId) {
        return await this._fetch(`/todos/items/${todoId}/toggle_completed/`, {
            method: 'POST'
        });
    }

    async updateTodo(todoId, updates) {
        return await this._fetch(`/todos/items/${todoId}/`, {
            method: 'PUT',
            body: JSON.stringify(updates)
        });
    }

    async deleteTodo(todoId) {
        return await this._fetch(`/todos/items/${todoId}/`, {
            method: 'DELETE'
        });
    }

    async clearCompletedTodos(terminalSessionId = null) {
        const body = terminalSessionId ? 
            { terminal_session: terminalSessionId } : 
            { clear_all_sessions: true };
            
        return await this._fetch('/todos/items/clear_completed/', {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    async clearAllTodos() {
        // Get all todos and delete them one by one
        const todos = await this.getTodos();
        let deletedCount = 0;
        
        for (const todo of todos) {
            try {
                await this.deleteTodo(todo.id);
                deletedCount++;
            } catch (error) {
                console.error(`Failed to delete todo ${todo.id}:`, error);
            }
        }
        
        return { deleted_count: deletedCount };
    }

    async generateTodosFromOutput(terminalSessionId, terminalOutput) {
        return await this._fetch('/todos/items/generate_from_output/', {
            method: 'POST',
            body: JSON.stringify({
                terminal_session: terminalSessionId,
                terminal_output: terminalOutput
            })
        });
    }

    async getTodoGenerations(terminalSessionId = null) {
        let url = '/todos/generations/';
        if (terminalSessionId) {
            url += `?terminal_session=${terminalSessionId}`;
        }
        return await this._fetch(url);
    }

    // Health Check
    async isBackendAvailable() {
        try {
            await this._fetch('/terminal/sessions/');
            return true;
        } catch (error) {
            return false;
        }
    }

    // Sync methods for integrating with existing code
    async syncQueueWithBackend(currentQueue, terminalSessionId) {
        try {
            // Get current queue from backend
            const backendQueue = await this.getQueuedMessages(terminalSessionId, 'pending');
            
            // Add any local queue items that aren't in backend
            for (const item of currentQueue) {
                await this.addMessageToQueue(terminalSessionId, item.content);
            }
            
            return backendQueue.results || backendQueue;
        } catch (error) {
            console.error('Failed to sync queue with backend:', error);
            return currentQueue; // Fallback to local queue
        }
    }

    async syncSettingsWithBackend(currentSettings) {
        try {
            // Upload current settings to backend
            for (const [key, value] of Object.entries(currentSettings)) {
                await this.setSetting(key, value);
            }
            
            // Get all settings from backend
            const backendSettings = await this.getAllSettings();
            
            // Convert to object format
            const settingsObj = {};
            for (const setting of backendSettings.results || backendSettings) {
                settingsObj[setting.key] = setting.value;
            }
            
            return settingsObj;
        } catch (error) {
            console.error('Failed to sync settings with backend:', error);
            return currentSettings; // Fallback to local settings
        }
    }
}

// Export for use in renderer.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BackendAPIClient;
} else {
    window.BackendAPIClient = BackendAPIClient;
}
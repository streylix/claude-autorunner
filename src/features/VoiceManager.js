/**
 * VoiceManager - Handles voice recording and transcription functionality
 * Consolidates voice/Whisper integration from renderer.js
 */
class VoiceManager {
    constructor(eventBus, appStateStore) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;
        
        // Voice recording state
        this.isRecording = false;
        this.voiceEnabled = false;
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.audioStream = null;
        
        // Transcription state
        this.speechRecognition = null;
        this.speechResult = '';
        
        // Backend API reference (set during initialization)
        this.backendAPIClient = null;
        
        this.setupEventListeners();
    }
    
    // Set external dependencies
    setBackendClient(backendAPIClient) {
        this.backendAPIClient = backendAPIClient;
    }
    
    setupEventListeners() {
        // Listen for voice button clicks
        this.eventBus.on('voice:toggle', async () => {
            await this.toggleRecording();
        });
        
        // Listen for transcription results
        this.eventBus.on('voice:transcription-complete', (text) => {
            this.handleTranscriptionComplete(text);
        });
    }
    
    // ======= RECORDING CONTROL =======
    async toggleRecording() {
        if (this.isRecording) {
            this.stopRecording();
        } else {
            this.voiceEnabled = true;
            await this.startRecording();
        }
    }
    
    async startRecording() {
        try {
            this.eventBus.emit('log:action', {
                message: '🎤 Starting LOCAL voice transcription with Whisper...',
                type: 'info'
            });
            
            // Check for MediaRecorder support
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('Voice recording not supported in this browser. Please use a modern browser.');
            }
            
            // Check if backend is available
            const backendAvailable = await this.checkBackendHealth();
            if (!backendAvailable) {
                this.eventBus.emit('log:action', {
                    message: '⚠️ Backend server not available. Please ensure the backend is running.',
                    type: 'error'
                });
                this.updateButtonState('error');
                return;
            }
            
            // Request microphone access
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.audioStream = stream;
            
            // Create MediaRecorder with appropriate MIME type
            this.mediaRecorder = new MediaRecorder(stream, {
                mimeType: this.getSupportedMimeType()
            });
            
            this.audioChunks = [];
            this.isRecording = true;
            
            // Set up event handlers
            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.audioChunks.push(event.data);
                }
            };
            
            this.mediaRecorder.onstop = async () => {
                await this.processAudioRecording();
            };
            
            // Start recording
            this.mediaRecorder.start();
            
            // Update UI
            this.updateButtonState('recording');
            
            // Auto-stop after 60 seconds
            setTimeout(() => {
                if (this.isRecording) {
                    this.eventBus.emit('log:action', {
                        message: '⏱️ Auto-stopping recording after 60 seconds',
                        type: 'info'
                    });
                    this.stopRecording();
                }
            }, 60000);
            
        } catch (error) {
            console.error('Error starting recording:', error);
            this.eventBus.emit('log:action', {
                message: `❌ Recording error: ${error.message}`,
                type: 'error'
            });
            this.updateButtonState('error');
            this.cleanup();
        }
    }
    
    stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.isRecording = false;
            this.mediaRecorder.stop();
            
            // Stop all audio tracks
            if (this.audioStream) {
                this.audioStream.getTracks().forEach(track => track.stop());
                this.audioStream = null;
            }
            
            this.updateButtonState('processing');
        }
    }
    
    // ======= AUDIO PROCESSING =======
    async processAudioRecording() {
        try {
            this.eventBus.emit('log:action', {
                message: '🔄 Processing audio for transcription...',
                type: 'info'
            });
            
            // Create audio blob from chunks
            const audioBlob = new Blob(this.audioChunks, { 
                type: this.mediaRecorder.mimeType || 'audio/webm' 
            });
            
            // Clear chunks for next recording
            this.audioChunks = [];
            
            // Convert to WAV if needed
            const wavBlob = await this.convertToWav(audioBlob);
            
            // Send to backend for transcription
            await this.transcribeAudio(wavBlob);
            
        } catch (error) {
            console.error('Error processing audio:', error);
            this.eventBus.emit('log:action', {
                message: `❌ Processing error: ${error.message}`,
                type: 'error'
            });
            this.updateButtonState('error');
        } finally {
            this.cleanup();
        }
    }
    
    async transcribeAudio(audioBlob) {
        try {
            if (!this.backendAPIClient) {
                throw new Error('Backend API client not initialized');
            }
            
            const formData = new FormData();
            formData.append('audio', audioBlob, 'recording.wav');
            
            // Call backend transcription endpoint
            const response = await fetch('http://localhost:8123/api/transcribe/', {
                method: 'POST',
                body: formData
            });
            
            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Transcription failed: ${error}`);
            }
            
            const data = await response.json();
            
            if (data.text && data.text.trim()) {
                this.handleTranscriptionSuccess(data.text.trim());
            } else {
                this.eventBus.emit('log:action', {
                    message: '⚠️ No speech detected in recording',
                    type: 'warning'
                });
                this.updateButtonState('ready');
            }
            
        } catch (error) {
            console.error('Transcription error:', error);
            this.eventBus.emit('log:action', {
                message: `❌ Transcription failed: ${error.message}`,
                type: 'error'
            });
            this.updateButtonState('error');
        }
    }
    
    // ======= TRANSCRIPTION HANDLING =======
    handleTranscriptionSuccess(text) {
        this.eventBus.emit('log:action', {
            message: `✅ Transcribed: "${text}"`,
            type: 'success'
        });
        
        // Insert transcribed text into active input
        this.eventBus.emit('voice:insert-text', text);
        
        // Update button state
        this.updateButtonState('ready');
        
        // Store last transcription
        this.speechResult = text;
    }
    
    handleTranscriptionComplete(text) {
        // Additional handling if needed
        this.speechResult = text;
    }
    
    // ======= UTILITY FUNCTIONS =======
    getSupportedMimeType() {
        const types = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/mp4',
            'audio/wav'
        ];
        
        for (const type of types) {
            if (MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        }
        
        return 'audio/webm'; // Fallback
    }
    
    async convertToWav(blob) {
        // If already WAV, return as is
        if (blob.type === 'audio/wav') {
            return blob;
        }
        
        // For now, return the original blob
        // Full WAV conversion would require additional libraries
        return blob;
    }
    
    async checkBackendHealth() {
        try {
            const response = await fetch('http://localhost:8123/api/health/', {
                method: 'GET',
                signal: AbortSignal.timeout(3000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }
    
    updateButtonState(state) {
        this.eventBus.emit('voice:button-state', state);
        
        // Update internal state
        switch (state) {
            case 'ready':
                this.voiceEnabled = true;
                this.isRecording = false;
                break;
            case 'recording':
                this.voiceEnabled = true;
                this.isRecording = true;
                break;
            case 'processing':
                this.voiceEnabled = false;
                this.isRecording = false;
                break;
            case 'error':
                this.voiceEnabled = false;
                this.isRecording = false;
                break;
        }
    }
    
    cleanup() {
        // Stop any active recording
        if (this.mediaRecorder) {
            if (this.mediaRecorder.state !== 'inactive') {
                this.mediaRecorder.stop();
            }
            this.mediaRecorder = null;
        }
        
        // Stop audio stream
        if (this.audioStream) {
            this.audioStream.getTracks().forEach(track => track.stop());
            this.audioStream = null;
        }
        
        // Clear audio chunks
        this.audioChunks = [];
        
        // Reset state
        this.isRecording = false;
    }
    
    // ======= PUBLIC API =======
    isCurrentlyRecording() {
        return this.isRecording;
    }
    
    isVoiceEnabled() {
        return this.voiceEnabled;
    }
    
    getLastTranscription() {
        return this.speechResult;
    }
    
    async initialize() {
        // Check backend availability on startup
        const backendAvailable = await this.checkBackendHealth();
        if (backendAvailable) {
            this.updateButtonState('ready');
        } else {
            this.updateButtonState('error');
        }
    }
}

module.exports = VoiceManager;
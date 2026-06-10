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

        // Microphone input device ('default' = system default). Persisted as
        // the 'microphoneDeviceId' preference; applied via the events below.
        this.microphoneDeviceId = 'default';
        
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

        // Pick up the persisted microphone choice on load and live changes
        // from the settings modal (PreferenceManager events).
        this.eventBus.on('preferences:applied', (prefs) => {
            if (prefs && prefs.microphoneDeviceId) {
                this.setMicrophoneDevice(prefs.microphoneDeviceId);
            }
        });
        this.eventBus.on('preference:changed', ({ key, value }) => {
            if (key === 'microphoneDeviceId') this.setMicrophoneDevice(value);
        });
    }

    setMicrophoneDevice(deviceId) {
        this.microphoneDeviceId = deviceId || 'default';
    }

    // getUserMedia audio constraints honoring the selected input device.
    buildAudioConstraints() {
        const id = this.microphoneDeviceId;
        return (id && id !== 'default') ? { deviceId: { exact: id } } : true;
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
            
            // Request microphone access on the selected device; if that device
            // is gone (unplugged USB mic, stale id), fall back to the system
            // default rather than failing the recording outright.
            let stream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: this.buildAudioConstraints() });
            } catch (err) {
                if (this.microphoneDeviceId !== 'default'
                    && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
                    this.eventBus.emit('log:action', {
                        message: '⚠️ Selected microphone unavailable — falling back to system default',
                        type: 'warning'
                    });
                    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                } else {
                    throw err;
                }
            }
            this.audioStream = stream;

            // Surface which device is actually capturing — the #1 cause of
            // "recorded but silent" is the wrong input being used.
            const track = stream.getAudioTracks()[0];
            this.activeMicLabel = (track && track.label) || 'unknown device';
            if (track) {
                this.eventBus.emit('log:action', {
                    message: `🎙️ Using microphone: ${this.activeMicLabel}`,
                    type: 'info'
                });
            }

            // Meter the input so a dead mic is reported as such (instead of a
            // misleading "No speech detected" after a pointless Whisper run).
            this._startLevelMeter(stream);

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
            const mimeType = this.mediaRecorder.mimeType || 'audio/webm';
            const audioBlob = new Blob(this.audioChunks, { type: mimeType });

            // Clear chunks for next recording
            this.audioChunks = [];

            // If the meter saw essentially nothing, the capture itself is dead —
            // tell the user which device was silent rather than sending silence
            // to Whisper and reporting "No speech detected".
            const peakPct = Math.round((this.peakLevel || 0) * 100);
            if ((this.peakLevel || 0) < 0.01) {
                this.eventBus.emit('log:action', {
                    message: `🔇 Recording captured no audio (peak ${peakPct}%) from "${this.activeMicLabel}". `
                        + 'Pick a different input in Settings → Microphone, or check the OS input volume/mute.',
                    type: 'error'
                });
                this.updateButtonState('ready');
                return;
            }
            this.eventBus.emit('log:action', {
                message: `🎚️ Recording peak input level: ${peakPct}%`,
                type: 'info'
            });

            // Convert to WAV if needed
            const wavBlob = await this.convertToWav(audioBlob);

            // Send to backend for transcription
            await this.transcribeAudio(wavBlob, mimeType);
            
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
    
    async transcribeAudio(audioBlob, mimeType = 'audio/webm') {
        try {
            if (!this.backendAPIClient) {
                throw new Error('Backend API client not initialized');
            }

            // Name the upload by its real container — the backend derives its
            // temp-file suffix from this name, and MediaRecorder produces
            // webm/ogg/mp4 here, never an actual WAV.
            const ext = (/audio\/(\w+)/.exec(audioBlob.type || mimeType) || [, 'webm'])[1];
            const formData = new FormData();
            // Field name must match the backend serializer (audio_file = FileField()).
            formData.append('audio_file', audioBlob, `recording.${ext}`);
            
            // Call backend transcription endpoint
            const response = await fetch('http://localhost:8123/api/voice/transcribe/', {
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
    
    // ======= INPUT LEVEL METER =======
    // Tracks the peak amplitude (0..1) seen during the recording via a
    // WebAudio analyser tapped off the same stream MediaRecorder consumes.
    _startLevelMeter(stream) {
        try {
            this.peakLevel = 0;
            this._meterContext = new AudioContext();
            const source = this._meterContext.createMediaStreamSource(stream);
            this._meterAnalyser = this._meterContext.createAnalyser();
            this._meterAnalyser.fftSize = 2048;
            source.connect(this._meterAnalyser);
            const buf = new Float32Array(this._meterAnalyser.fftSize);
            this._meterInterval = setInterval(() => {
                this._meterAnalyser.getFloatTimeDomainData(buf);
                for (let i = 0; i < buf.length; i++) {
                    const v = Math.abs(buf[i]);
                    if (v > this.peakLevel) this.peakLevel = v;
                }
            }, 150);
        } catch (e) {
            // Metering is best-effort; never let it break recording.
            console.warn('Level meter unavailable:', e);
            this.peakLevel = 1; // assume audible so the silence guard stays out of the way
        }
    }

    _stopLevelMeter() {
        if (this._meterInterval) {
            clearInterval(this._meterInterval);
            this._meterInterval = null;
        }
        this._meterAnalyser = null;
        if (this._meterContext) {
            this._meterContext.close().catch(() => {});
            this._meterContext = null;
        }
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
            const response = await fetch('http://localhost:8123/api/voice/health/', {
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
        // Stop the input level meter
        this._stopLevelMeter();

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
/**
 * Voice Interface Module
 * Handles voice recording, transcription, and audio processing
 */

class VoiceInterface {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        
        // Recording state
        this.isRecording = false;
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.recordingStream = null;
        
        // Recording settings
        this.recordingOptions = {
            mimeType: 'audio/webm;codecs=opus',
            audioBitsPerSecond: 128000
        };
        
        // Transcription settings
        this.transcriptionEnabled = false;
        this.transcriptionLanguage = 'auto';
        
        // Voice button state
        this.recordingStartTime = null;
        this.recordingTimer = null;
    }

    // Initialize voice interface
    async initialize() {
        // Check if media devices are available
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            console.warn('Media devices not supported');
            this.disableVoiceFeatures();
            return false;
        }

        // Check transcription availability
        await this.checkTranscriptionAvailability();
        
        return true;
    }

    // Check if transcription service is available
    async checkTranscriptionAvailability() {
        try {
            const { ipcRenderer } = require('electron');
            const response = await ipcRenderer.invoke('check-transcription-deps');
            
            if (response && response.available) {
                this.transcriptionEnabled = true;
                this.gui.logAction('Voice transcription available', 'success');
            } else {
                this.transcriptionEnabled = false;
                this.gui.logAction('Voice transcription not available: ' + (response?.message || 'Unknown error'), 'warning');
            }
        } catch (error) {
            console.warn('Could not check transcription availability:', error);
            this.transcriptionEnabled = false;
        }
    }

    // Toggle voice recording
    async toggleVoiceRecording() {
        if (this.isRecording) {
            await this.stopRecording();
        } else {
            await this.startRecording();
        }
    }

    // Start voice recording
    async startRecording() {
        if (this.isRecording) {
            console.warn('Already recording');
            return false;
        }

        try {
            // Request microphone access
            this.recordingStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 44100
                }
            });

            // Create MediaRecorder
            this.mediaRecorder = new MediaRecorder(this.recordingStream, this.recordingOptions);
            this.audioChunks = [];

            // Set up event listeners
            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.audioChunks.push(event.data);
                }
            };

            this.mediaRecorder.onstop = () => {
                this.processRecording();
            };

            this.mediaRecorder.onerror = (event) => {
                console.error('MediaRecorder error:', event.error);
                this.gui.logAction(`Recording error: ${event.error.message}`, 'error');
                this.stopRecording();
            };

            // Start recording
            this.mediaRecorder.start(1000); // Collect data every second
            this.isRecording = true;
            this.recordingStartTime = Date.now();

            // Update UI
            this.gui.uiManager.updateVoiceButtonState(true);
            this.startRecordingTimer();

            this.gui.logAction('Voice recording started', 'info');
            return true;

        } catch (error) {
            console.error('Failed to start recording:', error);
            this.gui.logAction(`Failed to start recording: ${error.message}`, 'error');
            
            if (error.name === 'NotAllowedError') {
                this.gui.uiManager.showNotification(
                    'Microphone Access Denied',
                    'Please allow microphone access to use voice recording.',
                    'error'
                );
            }
            
            return false;
        }
    }

    // Stop voice recording
    async stopRecording() {
        if (!this.isRecording) {
            console.warn('Not currently recording');
            return false;
        }

        try {
            // Stop MediaRecorder
            if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
                this.mediaRecorder.stop();
            }

            // Stop recording stream
            if (this.recordingStream) {
                this.recordingStream.getTracks().forEach(track => track.stop());
                this.recordingStream = null;
            }

            // Update state
            this.isRecording = false;
            this.stopRecordingTimer();

            // Update UI
            this.gui.uiManager.updateVoiceButtonState(false);

            const duration = this.recordingStartTime ? (Date.now() - this.recordingStartTime) / 1000 : 0;
            this.gui.logAction(`Voice recording stopped (${duration.toFixed(1)}s)`, 'info');

            return true;

        } catch (error) {
            console.error('Failed to stop recording:', error);
            this.gui.logAction(`Failed to stop recording: ${error.message}`, 'error');
            return false;
        }
    }

    // Process recorded audio
    async processRecording() {
        if (this.audioChunks.length === 0) {
            this.gui.logAction('No audio data recorded', 'warning');
            return;
        }

        try {
            // Create audio blob
            const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
            const duration = this.recordingStartTime ? (Date.now() - this.recordingStartTime) / 1000 : 0;

            this.gui.logAction(`Processing ${duration.toFixed(1)}s of audio...`, 'info');

            // Convert to base64 for transmission
            const base64Audio = await this.blobToBase64(audioBlob);

            if (this.transcriptionEnabled) {
                // Send for transcription
                await this.transcribeAudio(base64Audio);
            } else {
                // Save audio file locally if transcription not available
                this.saveAudioFile(audioBlob);
            }

        } catch (error) {
            console.error('Failed to process recording:', error);
            this.gui.logAction(`Failed to process recording: ${error.message}`, 'error');
        } finally {
            // Cleanup
            this.audioChunks = [];
            this.recordingStartTime = null;
        }
    }

    // Transcribe audio using backend service
    async transcribeAudio(base64Audio) {
        try {
            this.gui.uiManager.showNotification('Transcribing Audio', 'Please wait...', 'info');
            
            const { ipcRenderer } = require('electron');
            const response = await ipcRenderer.invoke('transcribe-audio', base64Audio);

            if (response.success) {
                const transcription = response.transcription.trim();
                
                if (transcription) {
                    // Add transcription to message input
                    this.addTranscriptionToInput(transcription);
                    
                    this.gui.logAction(`Voice transcribed: "${transcription}"`, 'success');
                    this.gui.uiManager.showNotification(
                        'Transcription Complete',
                        `"${transcription.substring(0, 50)}${transcription.length > 50 ? '...' : ''}"`,
                        'success'
                    );
                } else {
                    this.gui.logAction('No speech detected in recording', 'warning');
                    this.gui.uiManager.showNotification(
                        'No Speech Detected',
                        'Please try recording again with clearer speech.',
                        'warning'
                    );
                }
            } else {
                throw new Error(response.error || 'Transcription failed');
            }

        } catch (error) {
            console.error('Transcription failed:', error);
            this.gui.logAction(`Transcription failed: ${error.message}`, 'error');
            this.gui.uiManager.showNotification(
                'Transcription Failed',
                error.message,
                'error'
            );
        }
    }

    // Add transcription to message input
    addTranscriptionToInput(transcription) {
        const messageInput = document.getElementById('message-input');
        if (messageInput) {
            // Add to existing content or replace
            const currentValue = messageInput.value.trim();
            
            if (currentValue) {
                messageInput.value = currentValue + ' ' + transcription;
            } else {
                messageInput.value = transcription;
            }

            // Auto-resize input
            this.gui.uiManager.autoResizeMessageInput(messageInput);
            
            // Focus input
            messageInput.focus();
            
            // Move cursor to end
            messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
        }
    }

    // Save audio file locally
    saveAudioFile(audioBlob) {
        const url = URL.createObjectURL(audioBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `voice-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
        link.click();
        
        // Cleanup
        URL.revokeObjectURL(url);
        
        this.gui.logAction('Audio file saved locally', 'info');
    }

    // Convert blob to base64
    blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1]; // Remove data:audio/webm;base64, prefix
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // Recording timer management
    startRecordingTimer() {
        const updateTimer = () => {
            if (!this.isRecording || !this.recordingStartTime) return;
            
            const elapsed = (Date.now() - this.recordingStartTime) / 1000;
            this.updateRecordingDisplay(elapsed);
        };

        this.recordingTimer = setInterval(updateTimer, 100);
        updateTimer(); // Initial update
    }

    stopRecordingTimer() {
        if (this.recordingTimer) {
            clearInterval(this.recordingTimer);
            this.recordingTimer = null;
        }
        this.updateRecordingDisplay(0);
    }

    updateRecordingDisplay(elapsed) {
        const voiceBtn = document.getElementById('voice-record-btn');
        if (voiceBtn && this.isRecording) {
            const seconds = Math.floor(elapsed);
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            const timeDisplay = `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
            
            voiceBtn.title = `Recording... ${timeDisplay}`;
        } else if (voiceBtn) {
            voiceBtn.title = 'Start voice recording';
        }
    }

    // Disable voice features if not supported
    disableVoiceFeatures() {
        const voiceBtn = document.getElementById('voice-record-btn');
        if (voiceBtn) {
            voiceBtn.disabled = true;
            voiceBtn.title = 'Voice recording not supported';
            voiceBtn.style.opacity = '0.5';
        }
        
        this.gui.logAction('Voice recording disabled: Not supported on this device', 'warning');
    }

    // Get recording state
    getRecordingState() {
        return {
            isRecording: this.isRecording,
            transcriptionEnabled: this.transcriptionEnabled,
            duration: this.recordingStartTime ? (Date.now() - this.recordingStartTime) / 1000 : 0
        };
    }

    // Settings management
    updateSettings(settings) {
        if (settings.transcriptionLanguage) {
            this.transcriptionLanguage = settings.transcriptionLanguage;
        }
        
        if (settings.recordingOptions) {
            this.recordingOptions = { ...this.recordingOptions, ...settings.recordingOptions };
        }
    }

    // Test microphone access
    async testMicrophone() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
            
            this.gui.logAction('Microphone test successful', 'success');
            return true;
        } catch (error) {
            console.error('Microphone test failed:', error);
            this.gui.logAction(`Microphone test failed: ${error.message}`, 'error');
            return false;
        }
    }

    // Cleanup
    destroy() {
        if (this.isRecording) {
            this.stopRecording();
        }
        
        this.stopRecordingTimer();
        
        if (this.recordingStream) {
            this.recordingStream.getTracks().forEach(track => track.stop());
            this.recordingStream = null;
        }
        
        this.audioChunks = [];
        this.mediaRecorder = null;
    }
}

// Export for use in main TerminalGUI class
window.VoiceInterface = VoiceInterface;
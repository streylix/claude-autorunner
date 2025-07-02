/**
 * Voice Transcription Module
 * Handles audio transcription using Python Whisper
 */

const { ipcMain } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

class VoiceTranscription {
    constructor() {
        this.isTranscribing = false;
        this.tempAudioPath = null;
        this.setupIpcHandlers();
    }

    setupIpcHandlers() {
        ipcMain.handle('transcribe-audio', async (event, audioData) => {
            return await this.transcribeAudio(audioData);
        });
    }

    async transcribeAudio(audioData) {
        if (this.isTranscribing) {
            console.warn('Transcription already in progress');
            return { success: false, error: 'Transcription already in progress' };
        }

        this.isTranscribing = true;

        try {
            // Create temp directory if it doesn't exist
            const tempDir = path.join(__dirname, '..', '..', 'temp');
            try {
                await fs.access(tempDir);
            } catch {
                await fs.mkdir(tempDir, { recursive: true });
            }

            // Save audio data to temporary file
            const timestamp = Date.now();
            this.tempAudioPath = path.join(tempDir, `recording_${timestamp}.wav`);
            
            // Convert base64 to buffer and save
            const audioBuffer = Buffer.from(audioData, 'base64');
            await fs.writeFile(this.tempAudioPath, audioBuffer);

            console.log('Audio saved to:', this.tempAudioPath);

            // Transcribe using Python script
            const transcription = await this.runWhisperTranscription();
            
            // Clean up temp file
            await this.cleanupTempFile();

            return {
                success: true,
                transcription: transcription
            };

        } catch (error) {
            console.error('Transcription error:', error);
            await this.cleanupTempFile();
            
            return {
                success: false,
                error: error.message
            };
        } finally {
            this.isTranscribing = false;
        }
    }

    async runWhisperTranscription() {
        return new Promise((resolve, reject) => {
            // Python script for Whisper transcription
            const pythonScript = `
import whisper
import sys
import json
import warnings

# Suppress warnings
warnings.filterwarnings("ignore")

def transcribe_audio(audio_path):
    try:
        # Load the Whisper model (using base model for speed)
        model = whisper.load_model("base")
        
        # Transcribe the audio
        result = model.transcribe(audio_path)
        
        return {
            "success": True,
            "text": result["text"].strip(),
            "language": result.get("language", "unknown")
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"success": False, "error": "Audio path required"}))
        sys.exit(1)
    
    audio_path = sys.argv[1]
    result = transcribe_audio(audio_path)
    print(json.dumps(result))
`;

            // Write Python script to temp file
            const scriptPath = path.join(path.dirname(this.tempAudioPath), 'transcribe.py');
            
            fs.writeFile(scriptPath, pythonScript)
                .then(() => {
                    // Run Python script
                    const pythonProcess = spawn('python3', [scriptPath, this.tempAudioPath], {
                        stdio: ['pipe', 'pipe', 'pipe']
                    });

                    let output = '';
                    let errorOutput = '';

                    pythonProcess.stdout.on('data', (data) => {
                        output += data.toString();
                    });

                    pythonProcess.stderr.on('data', (data) => {
                        errorOutput += data.toString();
                    });

                    pythonProcess.on('close', async (code) => {
                        // Clean up script file
                        try {
                            await fs.unlink(scriptPath);
                        } catch (error) {
                            console.warn('Failed to clean up script file:', error.message);
                        }

                        if (code === 0 && output.trim()) {
                            try {
                                const result = JSON.parse(output.trim());
                                if (result.success) {
                                    console.log('Transcription successful:', result.text);
                                    resolve(result.text);
                                } else {
                                    reject(new Error(result.error || 'Unknown transcription error'));
                                }
                            } catch (parseError) {
                                console.error('Failed to parse transcription result:', output);
                                reject(new Error('Failed to parse transcription result'));
                            }
                        } else {
                            const errorMsg = errorOutput || `Python process exited with code ${code}`;
                            console.error('Transcription failed:', errorMsg);
                            
                            // Check for common issues
                            if (errorOutput.includes('ModuleNotFoundError')) {
                                reject(new Error('Whisper not installed. Please install with: pip install openai-whisper'));
                            } else if (errorOutput.includes('ffmpeg')) {
                                reject(new Error('FFmpeg not found. Please install FFmpeg for audio processing.'));
                            } else {
                                reject(new Error(errorMsg));
                            }
                        }
                    });

                    pythonProcess.on('error', (error) => {
                        console.error('Failed to start Python process:', error);
                        if (error.code === 'ENOENT') {
                            reject(new Error('Python3 not found. Please install Python 3.'));
                        } else {
                            reject(new Error(`Failed to start transcription: ${error.message}`));
                        }
                    });
                })
                .catch(reject);
        });
    }

    async cleanupTempFile() {
        if (this.tempAudioPath) {
            try {
                await fs.unlink(this.tempAudioPath);
                console.log('Cleaned up temp audio file:', this.tempAudioPath);
            } catch (error) {
                console.warn('Failed to clean up temp audio file:', error.message);
            }
            this.tempAudioPath = null;
        }
    }

    // Check if transcription dependencies are available
    async checkDependencies() {
        return new Promise((resolve) => {
            const pythonProcess = spawn('python3', ['-c', 'import whisper; print("OK")'], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let output = '';
            let errorOutput = '';

            pythonProcess.stdout.on('data', (data) => {
                output += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            pythonProcess.on('close', (code) => {
                if (code === 0 && output.includes('OK')) {
                    resolve({
                        available: true,
                        message: 'Whisper transcription available'
                    });
                } else {
                    let message = 'Whisper not available. ';
                    if (errorOutput.includes('ModuleNotFoundError')) {
                        message += 'Install with: pip install openai-whisper';
                    } else {
                        message += 'Please check Python installation.';
                    }
                    
                    resolve({
                        available: false,
                        message: message
                    });
                }
            });

            pythonProcess.on('error', (error) => {
                resolve({
                    available: false,
                    message: 'Python3 not found. Please install Python 3.'
                });
            });
        });
    }

    // Cleanup method
    async destroy() {
        await this.cleanupTempFile();
        this.isTranscribing = false;
    }
}

module.exports = { VoiceTranscription };
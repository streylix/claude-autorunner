import speech_recognition as sr
from pydub import AudioSegment
import os
import tempfile


class VoiceTranscriptionService:
    def __init__(self):
        self.recognizer = sr.Recognizer()
    
    def transcribe_audio_file(self, audio_file_path):
        """
        Transcribe an audio file using SpeechRecognition library
        Supports various audio formats
        """
        try:
            # Convert audio to WAV format if needed
            file_extension = os.path.splitext(audio_file_path)[1].lower()
            
            if file_extension != '.wav':
                # Convert to WAV using pydub
                audio = AudioSegment.from_file(audio_file_path)
                wav_path = tempfile.mktemp(suffix='.wav')
                audio.export(wav_path, format='wav')
                audio_file_path = wav_path
            
            # Transcribe using SpeechRecognition
            with sr.AudioFile(audio_file_path) as source:
                audio_data = self.recognizer.record(source)
                
                # Try Google Speech Recognition first
                try:
                    text = self.recognizer.recognize_google(audio_data)
                    return {'success': True, 'text': text}
                except sr.UnknownValueError:
                    return {'success': False, 'error': 'Could not understand audio'}
                except sr.RequestError as e:
                    # Fallback to offline recognition if available
                    try:
                        text = self.recognizer.recognize_sphinx(audio_data)
                        return {'success': True, 'text': text}
                    except:
                        return {'success': False, 'error': f'Recognition service error: {str(e)}'}
                    
        except Exception as e:
            return {'success': False, 'error': f'Error processing audio file: {str(e)}'}
        finally:
            # Clean up temporary WAV file if created
            if 'wav_path' in locals() and os.path.exists(wav_path):
                os.remove(wav_path)
import whisper
import time
import os
import tempfile
import logging
from typing import Dict, Any, Optional
from django.conf import settings
import torch

logger = logging.getLogger(__name__)


class WhisperTranscriptionService:
    """
    Service for handling offline voice transcription using OpenAI Whisper
    """
    
    def __init__(self):
        self.models = {}
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        logger.info(f"Whisper service initialized on device: {self.device}")
        
    def _get_model(self, model_name: str):
        """Load and cache Whisper models"""
        if model_name not in self.models:
            logger.info(f"Loading Whisper model: {model_name}")
            try:
                self.models[model_name] = whisper.load_model(model_name, device=self.device)
                logger.info(f"Successfully loaded {model_name} model")
            except Exception as e:
                logger.error(f"Failed to load {model_name} model: {e}")
                # Fallback to base model
                if model_name != 'base':
                    logger.info("Falling back to base model")
                    self.models[model_name] = whisper.load_model('base', device=self.device)
                else:
                    raise
        return self.models[model_name]
    
    def transcribe_audio(self, audio_file_path: str, model_name: str = 'base', 
                        language: Optional[str] = None) -> Dict[str, Any]:
        """
        Transcribe audio file using Whisper
        
        Args:
            audio_file_path: Path to audio file
            model_name: Whisper model to use ('tiny', 'base', 'small', 'medium')
            language: Language code (e.g., 'en', 'es', 'fr') or None for auto-detect
            
        Returns:
            Dict with transcription results
        """
        start_time = time.time()
        
        try:
            # Load the model
            model = self._get_model(model_name)
            
            # Transcribe
            logger.info(f"Starting transcription of {audio_file_path} with {model_name} model")
            
            transcribe_options = {}
            if language:
                transcribe_options['language'] = language
                
            result = model.transcribe(audio_file_path, **transcribe_options)
            
            processing_time = time.time() - start_time
            
            transcription_result = {
                'text': result['text'].strip(),
                'language': result.get('language', 'unknown'),
                'confidence': self._calculate_confidence(result),
                'model_used': model_name,
                'processing_time': processing_time,
                'segments': result.get('segments', []),
                'success': True
            }
            
            logger.info(f"Transcription completed in {processing_time:.2f}s: {transcription_result['text'][:100]}...")
            return transcription_result
            
        except Exception as e:
            processing_time = time.time() - start_time
            logger.error(f"Transcription failed after {processing_time:.2f}s: {e}")
            return {
                'text': '',
                'error': str(e),
                'model_used': model_name,
                'processing_time': processing_time,
                'success': False
            }
    
    def _calculate_confidence(self, whisper_result: Dict) -> float:
        """
        Calculate average confidence from Whisper segments
        """
        try:
            segments = whisper_result.get('segments', [])
            if not segments:
                return 0.0
                
            total_confidence = 0.0
            total_duration = 0.0
            
            for segment in segments:
                # Whisper doesn't provide confidence directly, 
                # but we can estimate from no_speech_prob
                no_speech_prob = segment.get('no_speech_prob', 0.5)
                confidence = 1.0 - no_speech_prob
                duration = segment.get('end', 0) - segment.get('start', 0)
                
                total_confidence += confidence * duration
                total_duration += duration
            
            return total_confidence / total_duration if total_duration > 0 else 0.0
            
        except Exception as e:
            logger.warning(f"Failed to calculate confidence: {e}")
            return 0.0
    
    def save_temp_audio_file(self, audio_data: bytes, suffix: str = '.wav') -> str:
        """
        Save audio data to temporary file
        
        Returns:
            Path to temporary file
        """
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        temp_file.write(audio_data)
        temp_file.close()
        return temp_file.name
    
    def cleanup_temp_file(self, file_path: str):
        """
        Clean up temporary file
        """
        try:
            if os.path.exists(file_path):
                os.unlink(file_path)
                logger.debug(f"Cleaned up temp file: {file_path}")
        except Exception as e:
            logger.warning(f"Failed to cleanup temp file {file_path}: {e}")


# Global service instance
transcription_service = WhisperTranscriptionService()
#!/usr/bin/env python3
"""
Generate simple sound files for injection completion notifications
"""
import os
import wave
import numpy as np

def create_tone(frequency, duration, sample_rate=44100, amplitude=0.3):
    """Create a simple sine wave tone"""
    frames = int(duration * sample_rate)
    arr = amplitude * np.sin(2 * np.pi * frequency * np.linspace(0, duration, frames))
    return (arr * 32767).astype(np.int16)

def create_beep(filename, frequency, duration):
    """Create a simple beep sound"""
    tone = create_tone(frequency, duration)
    
    with wave.open(filename, 'w') as wav_file:
        wav_file.setnchannels(1)  # Mono
        wav_file.setsampwidth(2)  # 16-bit
        wav_file.setframerate(44100)
        wav_file.writeframes(tone.tobytes())

def create_chord(filename, frequencies, duration):
    """Create a chord sound"""
    tones = [create_tone(freq, duration) for freq in frequencies]
    combined = np.sum(tones, axis=0) / len(tones)
    
    with wave.open(filename, 'w') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(44100)
        wav_file.writeframes(combined.astype(np.int16).tobytes())

if __name__ == "__main__":
    # Create different notification sounds
    sounds = [
        ("completion_beep.wav", 800, 0.3),
        ("success_chime.wav", 1000, 0.5),
        ("gentle_ping.wav", 600, 0.2),
        ("notification_bell.wav", 1200, 0.4),
    ]
    
    for filename, frequency, duration in sounds:
        create_beep(filename, frequency, duration)
        print(f"Created {filename}")
    
    # Create a chord sound
    create_chord("completion_chord.wav", [440, 554, 659], 0.6)
    print("Created completion_chord.wav")
    
    print("All sound files created successfully!") 
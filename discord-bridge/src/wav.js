'use strict';

// Wrap raw PCM (signed 16-bit little-endian) in a minimal WAV container so the
// Whisper endpoint accepts it. Discord/Opus decodes to 48kHz; we keep that.

function pcmToWav(pcmBuffer, { sampleRate = 48000, channels = 2, bitDepth = 16 } = {}) {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // PCM fmt chunk size
  header.writeUInt16LE(1, 20);         // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

module.exports = { pcmToWav };

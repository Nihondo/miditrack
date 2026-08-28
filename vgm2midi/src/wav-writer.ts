import * as fs from 'fs';

export const WAV_SAMPLE_RATE = 44100;
export const WAV_CHANNELS = 2;
export const WAV_BITS_PER_SAMPLE = 16;

/** [-32768, 32767]へクランプする。 */
export function clampInt16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

/** モノラルのInt16Arrayを16bit/44.1kHz/stereo WAVとして書き出す（両チャンネルへ複製）。 */
export function writeWaveFile(outPath: string, samples: Int16Array): void {
  const dataBytes = samples.byteLength;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(WAV_CHANNELS, 22);
  header.writeUInt32LE(WAV_SAMPLE_RATE, 24);
  const blockAlign = WAV_CHANNELS * (WAV_BITS_PER_SAMPLE / 8);
  header.writeUInt32LE(WAV_SAMPLE_RATE * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(WAV_BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);

  const file = fs.openSync(outPath, 'w');
  try {
    fs.writeSync(file, header);
    fs.writeSync(file, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  } finally {
    fs.closeSync(file);
  }
}

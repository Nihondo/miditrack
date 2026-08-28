export declare const WAV_SAMPLE_RATE = 44100;
export declare const WAV_CHANNELS = 2;
export declare const WAV_BITS_PER_SAMPLE = 16;
/** [-32768, 32767]へクランプする。 */
export declare function clampInt16(value: number): number;
/** モノラルのInt16Arrayを16bit/44.1kHz/stereo WAVとして書き出す（両チャンネルへ複製）。 */
export declare function writeWaveFile(outPath: string, samples: Int16Array): void;

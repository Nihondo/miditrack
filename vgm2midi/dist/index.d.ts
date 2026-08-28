export { VGMParser } from './vgm-parser';
export { MidiConverter } from './midi-converter';
export { prepareVGMPlayback } from './vgm-playback';
export { renderNoiseWav } from './noise-renderer';
export { renderDacWav } from './dac-renderer';
export { renderLibvgmStems } from './stems';
export * from './types';
export declare function convertVGMToMidi(inputPath: string, outputPath: string, options?: import('./types').ConversionOptions): void;

export { VGMParser } from './vgm-parser';
export { MidiConverter } from './midi-converter';
export { prepareVGMPlayback } from './vgm-playback';
export { renderNoiseWav } from './noise-renderer';
export { renderDacWav } from './dac-renderer';
export { renderLibvgmStems } from './stems';
export * from './types';

// Main conversion function for convenience
export function convertVGMToMidi(
  inputPath: string,
  outputPath: string,
  options?: import('./types').ConversionOptions
): void {
  const { VGMParser } = require('./vgm-parser');
  const { MidiConverter } = require('./midi-converter');
  const { prepareVGMPlayback } = require('./vgm-playback');
  const { renderNoiseWav } = require('./noise-renderer');
  const { renderDacWav } = require('./dac-renderer');

  const parser = VGMParser.fromFile(inputPath);
  const vgmData = parser.parse();
  const playback = prepareVGMPlayback(vgmData, {
    loopCount: options?.loopCount,
    durationSeconds: options?.durationSeconds,
  });
  const converter = new MidiConverter(playback.data, {
    ...options,
    suppressHardwareNoise:
      options?.suppressHardwareNoise ?? options?.noiseWavPath !== undefined,
    suppressYM2612Dac:
      options?.suppressYM2612Dac ?? options?.dacWavPath !== undefined,
  });
  converter.exportToFile(outputPath);
  if (options?.noiseWavPath) {
    renderNoiseWav(playback.data, playback.totalSamples, options.noiseWavPath);
  }
  if (options?.dacWavPath) {
    renderDacWav(playback.data, playback.totalSamples, options.dacWavPath);
  }
}

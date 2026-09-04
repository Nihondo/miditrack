#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { VGMParser } from './vgm-parser';
import { MidiConverter } from './midi-converter';
import { prepareVGMPlayback } from './vgm-playback';
import { renderNoiseWav } from './noise-renderer';
import { renderDacWav } from './dac-renderer';
import { renderLibvgmStems } from './stems';

function parseLoopCount(value: string): number {
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new InvalidArgumentError('must be an integer greater than or equal to 1');
  }
  return parsedValue;
}

function parseDuration(value: string): number {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new InvalidArgumentError('must be a positive number of seconds');
  }
  return parsedValue;
}

function formatFlaggedClock(rawClock: number): string {
  const clock = rawClock & 0x3FFFFFFF;
  const chipCount = (rawClock & 0x40000000) !== 0 ? ', dual chip' : '';
  return `${clock} Hz${chipCount}`;
}

const program = new Command();

program
  .name('vgm2midi')
  .description('Convert VGM/VGZ (Video Game Music) files to MIDI format')
  .version('0.2.0')
  .argument('<input>', 'Input VGM or VGZ file')
  .option('-o, --output <file>', 'Output MIDI file (default: input filename with .mid extension)')
  .option('-t, --tempo <bpm>', 'MIDI tempo in BPM', '120')
  .option('--loops <count>', 'Total loop-section playback count, including the logged pass', parseLoopCount)
  .option('--duration <seconds>', 'Target output duration in seconds', parseDuration)
  .option('-v, --verbose', 'Verbose output')
  .option('--noise-wav <file>', 'Render SN76489/HuC6280 hardware noise to a separate WAV stem')
  .option('--keep-noise-midi', 'Keep GM percussion notes when --noise-wav is used')
  .option('--dac-wav <file>', 'Render YM2612 DAC/PCM sample audio to a separate WAV stem')
  .option('--keep-dac-midi', 'Keep GM percussion notes when --dac-wav is used')
  .option('--ch3-special-percussion', 'Collapse OPN Ch3 Special composite hits to GM percussion')
  .option('--strict', 'Fail before output when parsed content would be omitted')
  .option('--split-chips', 'Also write collision-free chip/instance MIDI sidecars')
  .option('--stems <directory>', 'Render sample-exact libvgm mix/chip WAV stems and manifest')
  .option('--track-metadata <file>', 'Write MIDI-track to libvgm channel mapping JSON')
  .action((input, options) => {
    try {
      if (options.loops !== undefined && options.duration !== undefined) {
        throw new Error('--loops and --duration cannot be used together');
      }
      if (options.keepNoiseMidi && options.noiseWav === undefined) {
        throw new Error('--keep-noise-midi requires --noise-wav');
      }
      if (options.keepDacMidi && options.dacWav === undefined) {
        throw new Error('--keep-dac-midi requires --dac-wav');
      }

      // Validate input file
      if (!fs.existsSync(input)) {
        console.error(`Error: Input file '${input}' not found`);
        process.exit(1);
      }

      // Determine output file
      let output = options.output;
      if (!output) {
        const parsedPath = path.parse(input);
        output = path.join(parsedPath.dir, `${parsedPath.name}.mid`);
      }

      if (options.trackMetadata !== undefined) {
        const metadataPath = path.resolve(options.trackMetadata);
        const reservedPaths = [path.resolve(output)];
        if (options.noiseWav !== undefined) reservedPaths.push(path.resolve(options.noiseWav));
        if (options.dacWav !== undefined) reservedPaths.push(path.resolve(options.dacWav));
        if (reservedPaths.includes(metadataPath)) {
          throw new Error('--track-metadata must not overwrite another output');
        }
      }

      if (options.noiseWav !== undefined) {
        const noisePath = path.resolve(options.noiseWav);
        if (noisePath === path.resolve(output)) {
          throw new Error('--noise-wav must not overwrite the MIDI output');
        }
      }

      if (options.dacWav !== undefined) {
        const dacPath = path.resolve(options.dacWav);
        if (dacPath === path.resolve(output)) {
          throw new Error('--dac-wav must not overwrite the MIDI output');
        }
        if (options.noiseWav !== undefined && dacPath === path.resolve(options.noiseWav)) {
          throw new Error('--dac-wav must not overwrite the --noise-wav output');
        }
      }
      if (options.verbose) {
        console.log(`Input: ${input}`);
        console.log(`Output: ${output}`);
        console.log(`Tempo: ${options.tempo} BPM`);
        console.log('');
      }

      // Parse VGM file
      if (options.verbose) {
        console.log('Parsing VGM file...');
      }

      const parser = VGMParser.fromFile(input);
      const vgmData = parser.parse();
      if (vgmData.diagnostics.hasOmittedContent) {
        const omittedChips = vgmData.diagnostics.chips
          .filter(chip => chip.midiSupport === 'none')
          .map(chip => `${chip.chip}${chip.instance === 0 ? '' : ` #${chip.instance + 1}`} (writes ${chip.writeCount}, streams ${chip.streamCount})`);
        const details = omittedChips.length > 0 ? `: ${omittedChips.join('; ')}` : '';
        const message = `Warning: ${vgmData.diagnostics.unsupportedWriteCount} unsupported VGM write(s) will be omitted${details}`;
        if (options.strict) throw new Error(message.replace('Warning: ', 'Strict conversion refused: '));
        console.error(message);
      }
      const playback = prepareVGMPlayback(vgmData, {
        loopCount: options.loops,
        durationSeconds: options.duration,
      });

      if (options.verbose) {
        const versionHex = vgmData.header.version.toString(16).padStart(4, '0');
        console.log(`VGM Version: ${parseInt(versionHex.slice(0, 2), 10)}.${versionHex.slice(2)}`);
        console.log(`Total samples: ${vgmData.header.totalSamples}`);
        console.log(`Duration: ${(vgmData.header.totalSamples / 44100).toFixed(2)} seconds`);
        if (vgmData.loopCommandIndex !== undefined) {
          console.log(`Intro duration: ${(playback.introSamples / 44100).toFixed(2)} seconds`);
          console.log(`Loop duration: ${(playback.loopSamples / 44100).toFixed(2)} seconds`);
        }
        if (options.loops !== undefined) {
          console.log(`Loop section plays: ${options.loops}`);
        }
        if (options.duration !== undefined) {
          console.log(`Requested duration: ${options.duration} seconds`);
        }
        console.log(`Output duration: ${(playback.totalSamples / 44100).toFixed(2)} seconds`);
        console.log('');

        // Show detected chips
        console.log('Detected sound chips:');
        if (vgmData.header.sn76489Clock > 0) {
          console.log(`  - SN76489 PSG (${formatFlaggedClock(vgmData.header.sn76489Clock)})`);
        }
        if (vgmData.header.ym2612Clock > 0) {
          console.log(`  - YM2612 FM (${formatFlaggedClock(vgmData.header.ym2612Clock)})`);
        }
        if (vgmData.header.ym2203Clock > 0) {
          console.log(`  - YM2203 FM/SSG (${formatFlaggedClock(vgmData.header.ym2203Clock)})`);
        }
        if (vgmData.header.ym2608Clock > 0) {
          console.log(`  - YM2608 FM/SSG/Rhythm/ADPCM-B (${formatFlaggedClock(vgmData.header.ym2608Clock)})`);
        }
        if (vgmData.header.ym3812Clock > 0) {
          console.log(`  - YM3812 OPL2 FM/Rhythm (${formatFlaggedClock(vgmData.header.ym3812Clock)})`);
        }
        if (vgmData.header.ym3526Clock > 0) {
          console.log(`  - YM3526 OPL FM/Rhythm (${formatFlaggedClock(vgmData.header.ym3526Clock)})`);
        }
        if (vgmData.header.y8950Clock > 0) {
          console.log(`  - Y8950 OPL FM/Rhythm (${formatFlaggedClock(vgmData.header.y8950Clock)}; ADPCM not converted)`);
        }
        if (vgmData.header.ym2413Clock > 0) {
          console.log(`  - YM2413 FM (${vgmData.header.ym2413Clock} Hz)`);
        }
        if (vgmData.header.ym2151Clock > 0) {
          console.log(`  - YM2151 FM (${formatFlaggedClock(vgmData.header.ym2151Clock)})`);
        }
        if (vgmData.header.segaPCMClock > 0) {
          console.log(`  - SegaPCM (${vgmData.header.segaPCMClock} Hz)`);
        }
        if (vgmData.header.ay8910Clock > 0) {
          console.log(`  - AY-3-8910 PSG (${formatFlaggedClock(vgmData.header.ay8910Clock)})`);
        }
        if (vgmData.header.huc6280Clock > 0) {
          console.log(`  - HuC6280 PSG (${formatFlaggedClock(vgmData.header.huc6280Clock)})`);
        }
        if (vgmData.header.c140Clock > 0) {
          console.log(`  - C140 PCM (${vgmData.header.c140Clock} Hz)`);
        }
        if (vgmData.header.gbDmgClock > 0) {
          console.log(`  - GameBoy DMG APU (${vgmData.header.gbDmgClock} Hz)`);
        }
        console.log(`Total commands: ${vgmData.commands.length}`);
        if (playback.data.commands.length !== vgmData.commands.length) {
          console.log(`Output commands: ${playback.data.commands.length}`);
        }
        console.log('');
      }

      // Convert to MIDI
      if (options.verbose) {
        console.log('Converting to MIDI...');
      }

      const converter = new MidiConverter(playback.data, {
        tempo: parseInt(options.tempo),
        verbose: options.verbose,
        suppressHardwareNoise: options.noiseWav !== undefined && !options.keepNoiseMidi,
        suppressYM2612Dac: options.dacWav !== undefined && !options.keepDacMidi,
        opnCh3SpecialPercussion: options.ch3SpecialPercussion,
        splitChips: options.splitChips,
      });

      converter.exportToFile(output);
      if (options.trackMetadata !== undefined) {
        converter.exportTrackMetadata(options.trackMetadata, playback.totalSamples);
      }

      console.log(`Successfully converted ${input} to ${output}`);

      if (options.noiseWav !== undefined) {
        const result = renderNoiseWav(playback.data, playback.totalSamples, options.noiseWav);
        if (result.voicesFound > 0) {
          console.log(`Rendered ${result.voicesFound} hardware noise voice(s) to ${options.noiseWav}`);
        } else if (options.verbose) {
          console.log('No audible SN76489/HuC6280 noise voices were found; no stem was written');
        }
      }

      if (options.dacWav !== undefined) {
        const result = renderDacWav(playback.data, playback.totalSamples, options.dacWav);
        if (result.voicesFound > 0) {
          console.log(`Rendered YM2612 DAC sample audio to ${options.dacWav}`);
        } else if (options.verbose) {
          console.log('No audible YM2612 DAC samples were found; no stem was written');
        }
      }

      if (options.stems !== undefined) {
        renderLibvgmStems(input, options.stems, playback.totalSamples);
        console.log(`Rendered libvgm stems to ${options.stems}`);
      }

    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      if (options.verbose && error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program.parse();

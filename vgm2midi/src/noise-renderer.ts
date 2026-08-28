import * as fs from 'fs';

import { VGMCommand, VGMData } from './types';
import { WAV_CHANNELS as CHANNELS, WAV_SAMPLE_RATE as SAMPLE_RATE, clampInt16, writeWaveFile } from './wav-writer';

const SN76489_LFSR_SEED = 0x8000;
const HUC6280_LFSR_SEED = 1;

interface SN76489State {
  tonePeriods: number[];
  noiseControl: number;
  noiseVolume: number;
  lastLatchedChannel: number;
  lfsr: number;
  phase: number;
}

interface HuC6280ChannelState {
  control: number;
  noiseControl: number;
  lfsr: number;
  phase: number;
}

interface HuC6280State {
  selectedChannel: number;
  channels: HuC6280ChannelState[];
}

/**
 * ループ展開済みVGMからSN76489/HuC6280のノイズだけを16bit/44.1kHz/stereo WAVへ描画する。
 *
 * これは完全なチップエミュレーションではなくLFSR専用レンダラである。トーン、FM、
 * HuC6280のDDA/PCM、マスター/チャンネルバランスは描画しない。ノイズが実際に発音する
 * 区間が無い場合は出力ファイルを作らず、voicesFound=0を返す。
 */
export function renderNoiseWav(
  data: VGMData,
  totalSamples: number,
  outPath: string
): { framesWritten: number; voicesFound: number } {
  if (!Number.isSafeInteger(totalSamples) || totalSamples < 0) {
    throw new Error(`totalSamples must be a non-negative safe integer: ${totalSamples}`);
  }

  fs.rmSync(outPath, { force: true });

  const output = new Int16Array(totalSamples * CHANNELS);
  const sn76489 = createSN76489State();
  const huc6280 = [createHuC6280State(), createHuC6280State()];
  const voices = new Set<string>();
  let cursor = 0;

  const renderInterval = (requestedSamples: number): void => {
    const sampleCount = Math.max(0, Math.min(requestedSamples, totalSamples - cursor));
    for (let offset = 0; offset < sampleCount; offset++) {
      let mixedSample = 0;

      if (sn76489.noiseVolume < 0x0f) {
        voices.add('sn76489');
        advanceSN76489Lfsr(sn76489, data);
        const amplitude = sn76489Amplitude(sn76489.noiseVolume);
        mixedSample += (sn76489.lfsr & 1) !== 0 ? amplitude : -amplitude;
      }

      for (let instance = 0; instance < huc6280.length; instance++) {
        const chip = huc6280[instance];
        for (let channel = 4; channel <= 5; channel++) {
          const state = chip.channels[channel];
          if (!isHuC6280NoiseActive(state)) continue;
          voices.add(`huc6280_${instance}_${channel}`);
          advanceHuC6280Lfsr(state, data.header.huc6280Clock);
          const level = huc6280Level(state.control & 0x1f);
          mixedSample += ((state.lfsr & 1) !== 0 ? 15 : -16) * level;
        }
      }

      const pcmSample = clampInt16(Math.round(mixedSample));
      const frameIndex = (cursor + offset) * CHANNELS;
      output[frameIndex] = pcmSample;
      output[frameIndex + 1] = pcmSample;
    }
    cursor += sampleCount;
  };

  for (const command of data.commands) {
    if (cursor >= totalSamples) break;
    if (command.type === 'wait' || command.type === 'pcm_write') {
      renderInterval(command.samples ?? 0);
    } else if (command.type === 'psg_write' && command.data !== undefined) {
      updateSN76489State(sn76489, command.data);
    } else if (command.type === 'chip_write' && command.chip === 'HuC6280') {
      updateHuC6280State(huc6280, command);
    }
  }
  renderInterval(totalSamples - cursor);

  if (voices.size === 0) {
    return { framesWritten: 0, voicesFound: 0 };
  }

  writeWaveFile(outPath, output);
  return { framesWritten: totalSamples, voicesFound: voices.size };
}

function createSN76489State(): SN76489State {
  return {
    tonePeriods: [0, 0, 0],
    noiseControl: 0,
    noiseVolume: 0x0f,
    lastLatchedChannel: 0,
    lfsr: SN76489_LFSR_SEED,
    phase: 0,
  };
}

function createHuC6280State(): HuC6280State {
  return {
    selectedChannel: 0,
    channels: Array.from({ length: 6 }, () => ({
      control: 0,
      noiseControl: 0,
      lfsr: HUC6280_LFSR_SEED,
      phase: 0,
    })),
  };
}

function updateSN76489State(state: SN76489State, data: number): void {
  if ((data & 0x80) !== 0) {
    const channel = (data >> 5) & 0x03;
    const registerType = (data >> 4) & 0x01;
    const nibble = data & 0x0f;
    state.lastLatchedChannel = channel;

    if (registerType === 0) {
      if (channel < 3) {
        state.tonePeriods[channel] = (state.tonePeriods[channel] & 0x3f0) | nibble;
      } else {
        state.noiseControl = nibble & 0x07;
        // Sega-style PSGs reset the 16-bit LFSR on every noise-control write. Resetting
        // the local fractional phase as well gives every logged retrigger a deterministic
        // attack instead of inheriting sub-sample phase from the preceding hit.
        state.lfsr = SN76489_LFSR_SEED;
        state.phase = 0;
      }
    } else if (channel === 3) {
      state.noiseVolume = nibble;
    }
    return;
  }

  if (state.lastLatchedChannel < 3) {
    const channel = state.lastLatchedChannel;
    state.tonePeriods[channel] = ((data & 0x3f) << 4) | (state.tonePeriods[channel] & 0x0f);
  }
}

function advanceSN76489Lfsr(state: SN76489State, data: VGMData): void {
  const rate = sn76489ShiftRate(state, data);
  state.phase += rate / SAMPLE_RATE;
  while (state.phase >= 1) {
    const isWhiteNoise = (state.noiseControl & 0x04) !== 0;
    const feedback = isWhiteNoise
      ? ((state.lfsr & 0x0001) !== 0) !== ((state.lfsr & 0x0008) !== 0)
      : (state.lfsr & 0x0001) !== 0;
    state.lfsr = (state.lfsr >> 1) | (feedback ? SN76489_LFSR_SEED : 0);
    state.phase -= 1;
  }
}

function sn76489ShiftRate(state: SN76489State, data: VGMData): number {
  const clock = data.header.sn76489Clock & 0x3fffffff;
  const divisor = (data.header.sn76489Flags & 0x08) === 0 ? 32 : 4;
  const noiseFrequency = state.noiseControl & 0x03;
  let period: number;
  if (noiseFrequency === 3) {
    period = state.tonePeriods[2];
    if (period === 0 && (data.header.sn76489Flags & 0x01) !== 0) period = 0x400;
  } else {
    period = [0x10, 0x20, 0x40][noiseFrequency];
  }
  if (clock === 0 || period === 0) return 0;
  return clock / (divisor * period);
}

function sn76489Amplitude(volume: number): number {
  const maximum = 0x7fff / 4;
  return Math.round(maximum / Math.pow(10, volume / 10));
}

function updateHuC6280State(chips: HuC6280State[], command: VGMCommand): void {
  if (command.register === undefined || command.data === undefined) return;
  const instance = command.instance === 1 ? 1 : 0;
  const chip = chips[instance];
  const value = command.data & 0xff;

  if (command.register === 0x00) {
    chip.selectedChannel = value & 0x07;
    return;
  }
  if (chip.selectedChannel >= chip.channels.length) return;

  const channel = chip.channels[chip.selectedChannel];
  if (command.register === 0x04) {
    channel.control = value;
  } else if (command.register === 0x07 && chip.selectedChannel >= 4) {
    channel.noiseControl = value;
  }
}

function isHuC6280NoiseActive(state: HuC6280ChannelState): boolean {
  const isEnabled = (state.control & 0x80) !== 0;
  const isDda = (state.control & 0x40) !== 0;
  const volume = state.control & 0x1f;
  const isNoise = (state.noiseControl & 0x80) !== 0;
  return isEnabled && !isDda && isNoise && volume > 0;
}

function advanceHuC6280Lfsr(state: HuC6280ChannelState, rawClock: number): void {
  const clock = rawClock & 0x3fffffff;
  const step = (state.noiseControl & 0x1f) ^ 0x1f;
  // MAME c6280.cpp clocks its output stream at the chip clock and reloads noise_counter
  // with step << 6. A zero step reloads zero and therefore advances once per chip tick.
  const counter = Math.max(1, step << 6);
  state.phase += (clock / counter) / SAMPLE_RATE;
  while (state.phase >= 1) {
    const seed = state.lfsr;
    const feedback = ((seed >> 0) ^ (seed >> 1) ^ (seed >> 11) ^ (seed >> 12) ^ (seed >> 17)) & 1;
    state.lfsr = (seed >> 1) | (feedback << 17);
    state.phase -= 1;
  }
}

function huc6280Level(volume: number): number {
  const maximumLevel = 65535 / 6 / 32;
  const attenuationSteps = 31 - volume;
  return maximumLevel / Math.pow(10, (attenuationSteps * 1.5) / 20);
}

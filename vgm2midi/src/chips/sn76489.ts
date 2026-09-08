// MidiConverterから抽出した、SN76489（PSG）とGame Gearステレオ拡張のレジスタ処理。
// `host: MidiConverter`のper-conversion可変状態（channels/lastLatchedChannel等）を
// 直接読み書きする——詳細な設計判断はvgm2midi/CLAUDE.mdの「Refactor: event-output.ts」
// を参照。

import MidiWriter from 'midi-writer-js';
import type { MidiConverter } from '../midi-converter';
import { psgRegisterToFrequency, noiseDrumNote, samplesToTicks } from '../midi-math';
import { addPan, addExpression, noteOn, noteOff, noteOnPercussion, updateNotePitch } from '../event-output';

type ActiveNoteMap = Map<string, { note: number; startTime: number; startVolume: number }>;

/** Game Gear $4F のLRルーティングをSN76489各voiceのCC10へ反映する。 */
export function handleGameGearStereo(host: MidiConverter, data: number, currentTime: number): void {
  host.gameGearStereo = data;
  for (let channel = 0; channel < 4; channel++) {
    addPan(host, `psg_${channel}`, (data & (1 << channel)) !== 0, (data & (1 << (channel + 4))) !== 0, currentTime);
  }
}

export function handlePSGWrite(
  host: MidiConverter,
  data: number,
  currentTime: number,
  activeNotes: ActiveNoteMap,
  cmdIndex: number
): void {
  if ((data & 0x80) === 0x80) {
    // Latch/Data byte
    const channel = (data >> 5) & 0x03;
    const type = (data >> 4) & 0x01;
    const nibble = data & 0x0F;

    host.lastLatchedChannel = channel;

    if (type === 0) {
      // Tone register - lower 4 bits
      if (channel < 3) {
        const key = `psg_${channel}`;
        const state = host.channels.get(key)!;
        const oldFreq = state.frequency;

        // Peek ahead check for split-byte updates
        let isMultiByteUpdate = false;
        for (let k = cmdIndex + 1; k < host.vgmData.commands.length; k++) {
           const next = host.vgmData.commands[k];
           if (next.type === 'wait') continue;
           if (next.type === 'psg_write' && next.data !== undefined) {
               if ((next.data & 0x80) === 0) {
                   isMultiByteUpdate = true;
               }
               break;
           } else {
               break;
           }
        }

        // Keep upper 6 bits, set lower 4 bits
        state.frequency = (state.frequency & 0x3F0) | nibble;

        if (state.frequency !== oldFreq && !isMultiByteUpdate) {
          if (state.active) {
              updateNotePitch(host, key, channel, currentTime, activeNotes);
          }
          // NF=3 makes the noise generator track this channel's own tone frequency, so
          // a change here can move the noise's effective pitch even if this channel's
          // own tone isn't currently active.
          if (channel === 2) {
            reevaluateSN76489NoiseForChannel2Frequency(host, currentTime, activeNotes);
          }
        }
      } else {
        handleSN76489NoiseControl(host, nibble, currentTime, activeNotes);
      }
    } else {
      // Volume register
      const key = `psg_${channel}`;
      const state = host.channels.get(key)!;
      const oldVolume = state.volume;
      state.volume = nibble;

      if (channel < 3) {
        const wasOff = oldVolume === 0x0F;
        const isOff = nibble === 0x0F;

        if (wasOff && !isOff) {
          // Note ON
          state.active = true;
          noteOn(host, key, channel, currentTime, activeNotes);
        } else if (!wasOff && isOff) {
          // Note OFF
          state.active = false;
          noteOff(host, key, channel, currentTime, activeNotes);
        } else if (!isOff && state.active && oldVolume !== nibble) {
          // Volume change while active -> Send Expression (CC 11)
          const expression = Math.max(0, Math.min(127, 127 - (state.volume * 8)));

          const trackState = host.getTrack(key);
          const currentTick = samplesToTicks(currentTime, host.options.tempo!, host.sampleRate);
          const gap = Math.max(0, currentTick - trackState.cursor);

          const midiCh = host.midiChannelForKey(key);

          trackState.track.addEvent(new MidiWriter.ControllerChangeEvent({
              controllerNumber: 11,
              controllerValue: expression,
              channel: midiCh,
              delta: gap
          }));

          trackState.cursor = currentTick;
        }
      } else {
        syncSN76489NoiseVolume(host, oldVolume, currentTime, activeNotes);
      }
    }
  } else {
    // Data byte - upper 6 bits of tone frequency
    const dataBits = data & 0x3F;
    const channel = host.lastLatchedChannel;

    if (channel < 3) {
      const key = `psg_${channel}`;
      const state = host.channels.get(key)!;
      const oldFreq = state.frequency;
      // Set upper 6 bits, keep lower 4 bits
      state.frequency = (dataBits << 4) | (state.frequency & 0x0F);

      if (state.frequency !== oldFreq) {
        if (state.active) {
             updateNotePitch(host, key, channel, currentTime, activeNotes);
        }
        if (channel === 2) {
          reevaluateSN76489NoiseForChannel2Frequency(host, currentTime, activeNotes);
        }
      }
    }
  }
}

export function handleSN76489NoiseControl(
  host: MidiConverter,
  data: number,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  const state = host.channels.get('psg_3')!;
  state.frequency = data & 0x07;
  if (state.volume === 0x0F) return;
  if (host.options.suppressHardwareNoise) return;

  const noiseKey = 'psg_noise_3';
  if (state.isNoiseActive) noteOff(host, noiseKey, 3, currentTime, activeNotes);
  state.isNoiseActive = true;
  noteOnPercussion(host,
    noiseKey,
    sn76489Velocity(state.volume),
    currentTime,
    activeNotes,
    sn76489NoiseNote(host)
  );
}

export function syncSN76489NoiseVolume(
  host: MidiConverter,
  oldVolume: number,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  const state = host.channels.get('psg_3')!;
  if (host.options.suppressHardwareNoise) return;
  const noiseKey = 'psg_noise_3';
  const shouldSound = state.volume !== 0x0F;

  if (shouldSound && !state.isNoiseActive) {
    state.isNoiseActive = true;
    noteOnPercussion(host,
      noiseKey,
      sn76489Velocity(state.volume),
      currentTime,
      activeNotes,
      sn76489NoiseNote(host)
    );
  } else if (!shouldSound && state.isNoiseActive) {
    state.isNoiseActive = false;
    noteOff(host, noiseKey, 3, currentTime, activeNotes);
  } else if (shouldSound && oldVolume !== state.volume) {
    addExpression(host, noiseKey, sn76489Expression(state.volume), currentTime);
  }
}

export function sn76489Velocity(volume: number): number {
  return Math.max(1, Math.round(((15 - volume) / 15) * 100));
}

export function sn76489Expression(volume: number): number {
  return Math.max(0, Math.round(((15 - volume) / 15) * 127));
}

// psg_3's `frequency` field holds the noise control nibble (data & 0x07) rather than an
// actual tone period — see handleSN76489NoiseControl(). Bit2 = FB (0 = periodic/tonal
// noise, 1 = white noise), bits0-1 = NF (fixed clock/512, /1024, /2048 divisor select;
// NF=3 instead follows channel 2's own tone frequency).
export function sn76489NoiseNote(host: MidiConverter): number {
  const control = host.channels.get('psg_3')!.frequency;
  const isPeriodic = (control & 0x04) === 0;
  const nf = control & 0x03;
  let normalizedRate: number;
  if (nf === 3) {
    const toneFreq = psgRegisterToFrequency(
      host.channels.get('psg_2')!.frequency,
      host.vgmData.header.sn76489Clock,
      host.vgmData.header.sn76489Flags
    );
    const clamped = Math.max(100, Math.min(8000, toneFreq || 100));
    normalizedRate = Math.log2(clamped / 100) / Math.log2(8000 / 100);
  } else {
    normalizedRate = [1.0, 0.55, 0.25][nf];
  }
  return noiseDrumNote(normalizedRate, isPeriodic);
}

// NF=3 makes the noise generator follow channel 2's own tone frequency, so a change to
// that channel's period can move the noise's effective pitch even though nothing on
// channel 3 itself was written. Called from channel 2's tone-frequency write paths.
export function reevaluateSN76489NoiseForChannel2Frequency(
  host: MidiConverter,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  if (host.options.suppressHardwareNoise) return;
  const noiseState = host.channels.get('psg_3')!;
  if (!noiseState.isNoiseActive || (noiseState.frequency & 0x03) !== 3) return;
  const noiseKey = 'psg_noise_3';
  const newNote = sn76489NoiseNote(host);
  const active = activeNotes.get(noiseKey);
  if (active === undefined || active.note === newNote) return;
  noteOff(host, noiseKey, 3, currentTime, activeNotes);
  noteOnPercussion(host,
    noiseKey,
    sn76489Velocity(noiseState.volume),
    currentTime,
    activeNotes,
    newNote
  );
}

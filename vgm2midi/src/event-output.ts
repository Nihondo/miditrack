// MidiConverterから抽出した、MIDIトラックへのイベント出力（Note On/Off、CC、Pitch
// Bend、descriptor単位の発音追跡）。MidiConverter自身のper-conversion可変状態
// （channels/tracks/generatedNoteCount等）を`host`引数として受け取り、その場で
// 読み書きする——チップごとのレジスタ解釈やdispatchはMidiConverter側に残したまま、
// イベント生成の定型処理だけをここへ集める。

import MidiWriter from 'midi-writer-js';
import type {
  MidiConverter,
  TrackDescriptor,
  PCMPlaybackRangeMetadata,
  ChannelState,
  OPLChip,
} from './midi-converter';
import { CHIP_PITCH_BEND_RANGE, GBDMG_SQUARE_KEYS } from './midi-converter';
import type { PCMDataBlockMetadata, PCMAnalysisMetadata } from './pcm-analysis';
import {
  samplesToTicks,
  frequencyToMidiNote,
  frequencyToExactMidi,
  psgRegisterToFrequency,
  ym2612FrequencyToHz,
  ym2203FrequencyToHz,
  oplFrequencyToHz,
  ay8910RegisterToFrequency,
  ym2203SSGRegisterToFrequency,
  huc6280RegisterToFrequency,
  ym2413RegisterToFrequency,
  gbDmgWaveFrequencyToHz,
  gbDmgSquareFrequencyToHz,
} from './midi-math';

// GM Closed Hi-Hat (byte value 41, 0-based) — noteOnPercussion()のデフォルト打点。
const GM_CLOSED_HI_HAT_NOTE = 42;
const GM_PCM_PERCUSSION_FIRST_NOTE = 35;
const GM_PCM_PERCUSSION_LAST_NOTE = 81;

type ActiveNoteMap = Map<string, { note: number; startTime: number; startVolume: number }>;

/** 同じMIDI channelで異なるdescriptorが同時発音した場合だけ警告を記録する。 */
export function registerDescriptorStart(host: MidiConverter, descriptor: TrackDescriptor, currentTime: number): void {
  for (const [activeId, active] of host.activeMidiDescriptors) {
    if (activeId === descriptor.id || active.midiChannel !== descriptor.midiChannel) continue;
    const warning = `MIDI channel ${descriptor.midiChannel} overlap: ${activeId} and ${descriptor.id}`;
    if (!host.warnings.includes(warning)) host.warnings.push(warning);
  }
  host.activeMidiDescriptors.set(descriptor.id, { midiChannel: descriptor.midiChannel, startTime: currentTime });
}

/** descriptor単位で終了し、同一source keyの別instanceを消さない。 */
export function registerDescriptorStop(host: MidiConverter, descriptorId: string): void {
  host.activeMidiDescriptors.delete(descriptorId);
}

export function addExpression(host: MidiConverter, key: string, expression: number, currentTime: number): void {
  const descriptor = host.resolveDescriptor(key);
  const trackState = host.getTrack(descriptor.id);
  const currentTick = samplesToTicks(currentTime, host.options.tempo!, host.sampleRate);
  const gap = Math.max(0, currentTick - trackState.cursor);
  const clampedExpression = Math.max(0, Math.min(127, expression));

  trackState.track.addEvent(new MidiWriter.ControllerChangeEvent({
    controllerNumber: 11,
    controllerValue: clampedExpression,
    channel: descriptor.midiChannel,
    delta: gap,
  }));
  trackState.cursor = currentTick;
  trackState.expression = clampedExpression;
}

// SegaPCM/C140 sample tracks all share GM percussion channel 10, so CC10 (Pan) sent on
// one track's own MidiTrack object still affects every other sample track on that
// channel. A per-track "did I already send this pan" cache would therefore be wrong: if
// voice A pans left, voice B pans right, and A retriggers, a per-track cache would see
// "A's pan is unchanged" and skip resending — leaving channel 10 pointed right while A
// is actually sounding on the left. Caching one shared value for the whole channel and
// resending right before every Note On (regardless of which track sends it) avoids that.
// The one remaining limitation is inherent to sharing a channel: simultaneously
// sounding PCM voices on different pans still cannot be panned independently.
export function addPCMPan(host: MidiConverter, key: string, pan: number, currentTime: number): void {
  const clampedPan = Math.max(0, Math.min(127, pan));
  if (host.pcmChannel10Pan === clampedPan) return;
  host.pcmChannel10Pan = clampedPan;

  const descriptor = host.resolveDescriptor(key);
  const trackState = host.getTrack(descriptor.id);
  const currentTick = samplesToTicks(currentTime, host.options.tempo!, host.sampleRate);
  const gap = Math.max(0, currentTick - trackState.cursor);
  trackState.track.addEvent(new MidiWriter.ControllerChangeEvent({
    controllerNumber: 10,
    controllerValue: clampedPan,
    channel: descriptor.midiChannel,
    delta: gap,
  }));
  trackState.cursor = currentTick;
}

/** 左のみ/両方/右のみを CC10 の 0/64/127 に正規化して送る。 */
export function addPan(host: MidiConverter, key: string, hasLeft: boolean, hasRight: boolean, currentTime: number): void {
  const pan = hasLeft && hasRight ? 64 : hasLeft ? 0 : hasRight ? 127 : 64;
  const state = host.channels.get(key);
  if (state?.pan === pan) return;
  if (state) state.pan = pan;
  const descriptor = host.resolveDescriptor(key);
  const trackState = host.getTrack(descriptor.id);
  const currentTick = samplesToTicks(currentTime, host.options.tempo!, host.sampleRate);
  const gap = Math.max(0, currentTick - trackState.cursor);
  trackState.track.addEvent(new MidiWriter.ControllerChangeEvent({ controllerNumber: 10, controllerValue: pan, channel: descriptor.midiChannel, delta: gap }));
  trackState.cursor = currentTick;
}

export function addPitchBend(
  host: MidiConverter,
  key: string,
  semitoneOffset: number,
  semitoneRange: number,
  currentTime: number
): void {
  const descriptor = host.resolveDescriptor(key);
  const trackState = host.getTrack(descriptor.id);
  const currentTick = samplesToTicks(currentTime, host.options.tempo!, host.sampleRate);
  const gap = Math.max(0, currentTick - trackState.cursor);
  const midiChannel = descriptor.midiChannel;
  const bend = Math.max(-1, Math.min(1, semitoneOffset / semitoneRange));

  // PitchBendEvent is the one midi-writer-js channel event that expects 0-based input.
  trackState.track.addEvent(new MidiWriter.PitchBendEvent({
    bend,
    channel: midiChannel - 1,
    delta: gap,
  }));
  trackState.cursor = currentTick;
}

export function noteOnPercussion(
  host: MidiConverter,
  key: string,
  velocity: number,
  currentTime: number,
  activeNotes: ActiveNoteMap,
  pitch = GM_CLOSED_HI_HAT_NOTE
): void {
  const descriptor = host.resolveDescriptor(key);
  activeNotes.set(descriptor.id, {
    note: pitch,
    startTime: currentTime,
    startVolume: velocity,
  });

  const trackState = host.getTrack(descriptor.id);
  const currentTick = samplesToTicks(currentTime, host.options.tempo!, host.sampleRate);
  const gap = Math.max(0, currentTick - trackState.cursor);
  trackState.track.addEvent(new MidiWriter.NoteOnEvent({
    pitch,
    velocity: Math.max(1, Math.min(100, velocity)),
    channel: descriptor.midiChannel,
    wait: `T${gap}`,
  }));
  trackState.cursor = currentTick;
  host.generatedNoteCount += 1;
  registerDescriptorStart(host, descriptor, currentTime);
}

export function noteOnPCMPercussion(
  host: MidiConverter,
  key: string,
  pitch: number,
  velocity: number,
  currentTime: number,
  isLoop = false,
  dataBlock?: PCMDataBlockMetadata,
  durationSamples?: number,
  playbackRange?: PCMPlaybackRangeMetadata,
  analysis?: PCMAnalysisMetadata
): string {
  const descriptor = host.resolveDescriptor(key);
  const trackState = host.getTrack(descriptor.id);
  trackState.pcmEvents ??= [];
  trackState.pcmDataBlock ??= dataBlock;
  trackState.pcmAnalysis ??= analysis;
  trackState.pcmEvents.push({
    type: 'start',
    sampleTime: currentTime,
    ...(isLoop ? { isLoop: true } : {}),
    ...(playbackRange === undefined ? {} : { endAddressExclusive: playbackRange.endAddressExclusive }),
    ...(playbackRange?.loopAddress === undefined ? {} : { loopAddress: playbackRange.loopAddress }),
    ...(isLoop || durationSamples === undefined ? {} : { durationSamples }),
    ...(dataBlock?.lengthBytes === undefined ? {} : { dataLengthBytes: dataBlock.lengthBytes }),
  });
  const currentTick = samplesToTicks(currentTime, host.options.tempo!, host.sampleRate);
  const gap = Math.max(0, currentTick - trackState.cursor);
  trackState.track.addEvent(new MidiWriter.NoteOnEvent({
    pitch,
    velocity: Math.max(1, Math.min(100, velocity)),
    channel: descriptor.midiChannel,
    wait: `T${gap}`,
  }));
  trackState.cursor = currentTick;
  host.generatedNoteCount += 1;
  registerDescriptorStart(host, descriptor, currentTime);
  host.activePCMNotes.set(descriptor.id, pitch);
  return descriptor.id;
}

export function noteOffPCMPercussion(host: MidiConverter, key: string, pitch: number, currentTime: number): void {
  const descriptor = host.resolveDescriptor(key);
  const trackState = host.getTrack(descriptor.id);
  trackState.pcmEvents ??= [];
  trackState.pcmEvents.push({ type: 'stop', sampleTime: currentTime });
  const currentTick = samplesToTicks(currentTime, host.options.tempo!, host.sampleRate);
  const gap = Math.max(0, currentTick - trackState.cursor);
  trackState.track.addEvent(new MidiWriter.NoteOffEvent({
    pitch,
    velocity: 64,
    channel: descriptor.midiChannel,
    duration: `T${gap}`,
  }));
  trackState.cursor = currentTick;
  registerDescriptorStop(host, descriptor.id);
  host.activePCMNotes.delete(descriptor.id);
}

export function pcmNoteForSample(host: MidiConverter, sampleKey: string): number {
  const existingNote = host.pcmSampleNotes.get(sampleKey);
  if (existingNote !== undefined) return existingNote;

  const noteCount = GM_PCM_PERCUSSION_LAST_NOTE - GM_PCM_PERCUSSION_FIRST_NOTE + 1;
  const note = GM_PCM_PERCUSSION_FIRST_NOTE + (host.pcmSampleNotes.size % noteCount);
  host.pcmSampleNotes.set(sampleKey, note);
  return note;
}

export function getNoteFrequency(host: MidiConverter, key: string, state: ChannelState): number {
    if (key.startsWith('psg_')) {
        return psgRegisterToFrequency(
          state.frequency,
          host.vgmData.header.sn76489Clock,
          host.vgmData.header.sn76489Flags
        );
    } else if (key.startsWith('ym2612_')) {
        const baseFrequency = ym2612FrequencyToHz(
          state.frequency,
          state.block || 0,
          host.vgmData.header.ym2612Clock
        );
        const pitchScale = state.active
          ? (state.opnActivePitchScale ?? 1)
          : host.opnPitchScale(state);
        return baseFrequency * pitchScale;
    } else if (key.startsWith('ym2203_')) {
        const [, instanceText, section] = key.split('_');
        const instance = parseInt(instanceText);
        const prescaler = host.ym2203Prescalers[instance];
        if (section === 'fm' || section === 'ch3sp') {
          const baseFrequency = ym2203FrequencyToHz(
            state.frequency,
            state.block ?? 0,
            host.vgmData.header.ym2203Clock,
            prescaler
          );
          const pitchScale = state.active
            ? (state.opnActivePitchScale ?? 1)
            : host.opnPitchScale(state);
          return baseFrequency * pitchScale;
        }
        return ym2203SSGRegisterToFrequency(
          state.frequency,
          host.vgmData.header.ym2203Clock,
          prescaler,
          host.vgmData.header.ym2203AyFlags
        );
    } else if (key.startsWith('ym2608_')) {
        const [, instanceText, section] = key.split('_');
        const instance = parseInt(instanceText);
        const prescaler = host.ym2608Prescalers[instance];
        if (section === 'fm' || section === 'ch3sp') {
          const baseFrequency = ym2203FrequencyToHz(
            state.frequency,
            state.block ?? 0,
            host.vgmData.header.ym2608Clock,
            prescaler
          );
          const pitchScale = state.active
            ? (state.opnActivePitchScale ?? 1)
            : host.opnPitchScale(state);
          return baseFrequency * pitchScale;
        }
        return ym2203SSGRegisterToFrequency(
          state.frequency,
          host.vgmData.header.ym2608Clock,
          prescaler,
          host.vgmData.header.ym2608AyFlags
        );
    } else if (host.isOPLFMKey(key)) {
        const chip = key.split('_')[0].toUpperCase() as OPLChip;
        const clockRate = chip === 'YM3812'
          ? host.vgmData.header.ym3812Clock
          : chip === 'YM3526'
            ? host.vgmData.header.ym3526Clock
            : host.vgmData.header.y8950Clock;
        const baseFrequency = oplFrequencyToHz(
          state.frequency,
          state.block ?? 0,
          clockRate
        );
        const pitchScale = state.active
          ? (state.opnActivePitchScale ?? 1)
          : host.oplPitchScale(state);
        return baseFrequency * pitchScale;
    } else if (key.startsWith('ym2151_')) {
        return ym2151KeyToFrequency(host, state.keyCode || 0, state.keyFraction || 0);
    } else if (key.startsWith('ay8910_')) {
        return ay8910RegisterToFrequency(
          state.frequency,
          host.vgmData.header.ay8910Clock,
          host.vgmData.header.ay8910Flags
        );
    } else if (key.startsWith('huc6280_')) {
        return huc6280RegisterToFrequency(state.frequency, host.vgmData.header.huc6280Clock);
    } else if (key.startsWith('ym2413_')) {
        const rawFrequency = ym2413RegisterToFrequency(state.frequency, state.block ?? 0, host.vgmData.header.ym2413Clock);
        return rawFrequency * (state.active ? (state.opnActivePitchScale ?? 1) : host.ym2413PitchScale(state));
    } else if (key === 'gbdmg_2') {
        return gbDmgWaveFrequencyToHz(state.frequency, host.vgmData.header.gbDmgClock);
    } else if (GBDMG_SQUARE_KEYS.includes(key as typeof GBDMG_SQUARE_KEYS[number])) {
        return gbDmgSquareFrequencyToHz(state.frequency, host.vgmData.header.gbDmgClock);
    }
    return 0;
}

export function ym2151KeyToFrequency(host: MidiConverter, keyCode: number, keyFraction: number): number {
    // YM2151 NOTE codes contain gaps. Both values on either side of a gap map
    // to the same chromatic note, matching the chip's own phase-generator logic.
    const semitoneByCode = [1, 2, 3, 3, 4, 5, 6, 6, 7, 8, 9, 9, 10, 11, 12, 12];
    const octave = (keyCode >> 4) & 0x07;
    const semitone = semitoneByCode[keyCode & 0x0F];
    const clockRate = host.vgmData.header.ym2151Clock & 0x3FFFFFFF;
    const clockShift = clockRate > 0 ? 12 * Math.log2(clockRate / 3579545) : 0;
    const exactMidiNote = ((octave + 1) * 12) + semitone + (keyFraction / 64) + clockShift;
    return 440 * Math.pow(2, (exactMidiNote - 69) / 12);
}

export function noteOn(
  host: MidiConverter,
  key: string,
  _midiChannelOffset: number,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  const descriptor = host.resolveDescriptor(key);
  key = descriptor.sourceKey;
  const state = host.channels.get(key)!;
  const freq = getNoteFrequency(host, key, state);
  const midiNote = frequencyToMidiNote(freq);

  if (midiNote > 0 && midiNote < 128) {
    state.midiNote = midiNote;
    state.baseMidiNote = midiNote; // Capture base note
    activeNotes.set(descriptor.id, { note: midiNote, startTime: currentTime, startVolume: state.volume });

    const trackState = host.getTrack(descriptor.id);
    const currentTick = samplesToTicks(currentTime, host.options.tempo!, host.sampleRate);
    const gap = Math.max(0, currentTick - trackState.cursor);

    // Simple velocity mapping
    let velocity = 80;
    if (key.startsWith('psg_')) {
        velocity = Math.max(20, Math.min(127, 100 - (state.volume * 6)));
    } else if (
        key.startsWith('ym2612_')
        || (
          (key.startsWith('ym2203_') || key.startsWith('ym2608_'))
          && (key.includes('_fm_') || key.includes('_ch3sp_'))
        )
    ) {
        // Derived from the channel's audible carrier operator(s) Total Level at key-on
        // (opnCarrierVelocity(), latched alongside opnActivePitchScale). Falls back to a
        // neutral 80 when no carrier was reachable for the active algorithm/key-on mask.
        velocity = state.opnActiveVelocity ?? 80;
    } else if (key.startsWith('ym2151_')) {
        velocity = state.opnActiveVelocity ?? 80;
    } else if (host.isOPLFMKey(key)) {
        velocity = state.opnActiveVelocity ?? 80;
    } else if (key.startsWith('huc6280_')) {
        // midi-writer-js expects velocity as a percentage (1-100).
        velocity = Math.max(1, Math.round((state.volume / 31) * 100));
    } else if (key.startsWith('ym2413_')) {
        // Latched from the channel's 4-bit volume register at key-on by
        // handleYM2413KeyAndFrequencyWrite() via ym2413Velocity().
        velocity = state.opnActiveVelocity ?? 80;
    } else if (key.startsWith('gbdmg_')) {
        // Latched from the channel's envelope initial-volume (or, for the wave channel,
        // its 2-bit output-level code) at trigger time by handleGBDMGTriggerWrite().
        velocity = state.opnActiveVelocity ?? 80;
    } else {
        velocity = Math.max(20, Math.min(127, 40 + (state.volume * 5)));
    }

    // Assign unique MIDI channel based on chip/channel
    const midiCh = descriptor.midiChannel;

    // Tune the rounded MIDI note back to the source chip's exact frequency. This
    // avoids retaining as much as ±50 cents of onset quantization error.
    // Unlike NoteOnEvent/NoteOffEvent/ControllerChangeEvent (which take a 1-based
    // channel and subtract 1 internally), midi-writer-js's PitchBendEvent ORs the
    // raw `channel` field into the status byte with no such conversion. Passing our
    // 1-based midiCh straight through is off by one for every chip, and for
    // midiCh === 16 (HuC6280's highest channel) it overflows into the status byte's
    // event-type nibble, producing 0xE0 | 16 === 0xF0 (a SysEx-start byte) instead
    // of a Pitch Bend byte — corrupting the rest of the track for any MIDI reader
    // that doesn't happen to resync (GarageBand does not).
    const exactMidiNote = frequencyToExactMidi(freq);
    const semitoneOffset = exactMidiNote - midiNote;
    const bendRange = host.pitchBendRangeForKey(key);
    const bend = Math.max(-1, Math.min(1, semitoneOffset / bendRange));
    let eventGap = gap;
    // CC11 is persistent channel state. Reset it at every Note On so the previous
    // note's FM TL envelope does not attenuate the new TL-derived velocity a second time.
    if (trackState.expression !== 127) {
      trackState.track.addEvent(new MidiWriter.ControllerChangeEvent({
        controllerNumber: 11,
        controllerValue: 127,
        channel: midiCh,
        delta: eventGap,
      }));
      trackState.expression = 127;
      eventGap = 0;
    }
    trackState.track.addEvent(new MidiWriter.PitchBendEvent({
        bend,
        channel: midiCh - 1,
        delta: eventGap
    }));

    // Note On immediately follows (delta 0 since gap used by PitchBend)
    trackState.track.addEvent(new MidiWriter.NoteOnEvent({
        pitch: midiNote,
        velocity: velocity,
        channel: midiCh,
        wait: `T0`
    }));
    host.generatedNoteCount += 1;
    registerDescriptorStart(host, descriptor, currentTime);

    // Advance cursor
    trackState.cursor = currentTick;
  }
}

export function noteOff(
  host: MidiConverter,
  key: string,
  _midiChannelOffset: number,
  currentTime: number,
  activeNotes: ActiveNoteMap
): void {
  const descriptor = host.resolveDescriptor(key);
  if (activeNotes.has(descriptor.id)) {
    const noteInfo = activeNotes.get(descriptor.id)!;
    // We don't need duration from start time anymore, just delta from last event (cursor)
    const trackState = host.getTrack(descriptor.id);
    const currentTick = samplesToTicks(currentTime, host.options.tempo!, host.sampleRate);
    const gap = Math.max(0, currentTick - trackState.cursor);

    const midiCh = descriptor.midiChannel;

    trackState.track.addEvent(new MidiWriter.NoteOffEvent({
        pitch: noteInfo.note,
        velocity: 64,
        channel: midiCh,
        duration: `T${gap}` // 'duration' is the wait/delta for NoteOffEvent
    }));

    trackState.cursor = currentTick;
    activeNotes.delete(descriptor.id);
    registerDescriptorStop(host, descriptor.id);
  }
}

export function updateNotePitch(
    host: MidiConverter,
    key: string,
    midiChannelOffset: number,
    currentTime: number,
    activeNotes: ActiveNoteMap
): void {
    const state = host.channels.get(key)!;
    const freq = getNoteFrequency(host, key, state);
    const newExactNote = frequencyToExactMidi(freq);

    if (activeNotes.has(key)) {
        const diff = newExactNote - state.baseMidiNote;

        // Dynamic Threshold Logic:
        // Bass (psg_2) uses the full standard ±2-semitone MIDI bend range to allow
        // "decayed sustain" pitch slides without clipping the bend value.
        // Melody channels need a tight threshold (e.g. 0.8) so that actual notes (semitones)
        // are retriggered as new notes, not bent.
        const isContinuousPSG = key.startsWith('psg_') || key.startsWith('ay8910_')
          || key.startsWith('huc6280_') || key.startsWith('gbdmg_') || key.includes('_ssg_');
        const threshold = isContinuousPSG ? CHIP_PITCH_BEND_RANGE : (key === 'psg_2' ? 2 : 0.8);

        if (Math.abs(diff) <= threshold) {
            addPitchBend(host, key, diff, host.pitchBendRangeForKey(key), currentTime);
        } else {
            // Large pitch change -> Retrigger
            noteOff(host, key, midiChannelOffset, currentTime, activeNotes);
            noteOn(host, key, midiChannelOffset, currentTime, activeNotes);
        }
    } else {
        // If state.active is true, we should try to start it.
        if (state.active) {
            noteOn(host, key, midiChannelOffset, currentTime, activeNotes);
        }
    }
}

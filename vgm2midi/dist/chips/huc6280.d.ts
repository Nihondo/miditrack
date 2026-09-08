import type { MidiConverter, ChannelState } from '../midi-converter';
import type { VGMCommand } from '../types';
type ActiveNoteMap = Map<string, {
    note: number;
    startTime: number;
    startVolume: number;
}>;
export declare function handleHuC6280Write(host: MidiConverter, cmd: VGMCommand, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number): void;
export declare function updateHuC6280Pan(host: MidiConverter, instance: number, channel: number, currentTime: number): void;
export declare function syncHuC6280ToneState(host: MidiConverter, key: string, channel: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function syncHuC6280NoiseState(host: MidiConverter, key: string, channel: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function updateHuC6280NoiseEnvelope(host: MidiConverter, key: string, channel: number, oldVolume: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function noteOnHuC6280Noise(host: MidiConverter, key: string, state: ChannelState, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function huc6280NoiseNoteForPeriod(rawValue: number): number;
export declare function addHuC6280Expression(host: MidiConverter, key: string, volume: number, currentTime: number): void;
export declare function isHuC6280MultiByteFreqUpdate(host: MidiConverter, cmdIndex: number, otherReg: number, instance: number): boolean;
export {};

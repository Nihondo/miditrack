import type { MidiConverter } from '../midi-converter';
import type { VGMCommand } from '../types';
type ActiveNoteMap = Map<string, {
    note: number;
    startTime: number;
    startVolume: number;
}>;
export declare function handleYM2413Write(host: MidiConverter, cmd: VGMCommand, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number): void;
export declare function handleYM2413RhythmModeWrite(host: MidiConverter, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function updateYM2413Frequency(host: MidiConverter, channel: number, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number, data: number, instance: number): void;
export declare function handleYM2413KeyAndFrequencyWrite(host: MidiConverter, channel: number, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number, data: number, instance: number): void;
/** YM2413 key-onを、両方のfrequency byteとpatch carrier Multiple確定後にcommitする。 */
export declare function commitYM2413KeyOn(host: MidiConverter, channel: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function handleYM2413VolumeWrite(host: MidiConverter, channel: number, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function ym2413Velocity(volume: number): number;
export declare function ym2413RhythmVelocity(host: MidiConverter, index: number): number;
export {};

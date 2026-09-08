import type { MidiConverter, OPNCh3Context } from '../midi-converter';
import type { VGMCommand } from '../types';
type ActiveNoteMap = Map<string, {
    note: number;
    startTime: number;
    startVolume: number;
}>;
export declare function handleYM2608Write(host: MidiConverter, cmd: VGMCommand, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number): void;
export declare function handleYM2608KeyWrite(host: MidiConverter, context: OPNCh3Context, data: number, register: number, currentTime: number, activeNotes: ActiveNoteMap): boolean;
export declare function updateYM2608Frequency(host: MidiConverter, instance: number, port: number, reg: number, data: number, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number): void;
export declare function updateYM2608Prescaler(host: MidiConverter, instance: number, register: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function handleYM2608RhythmWrite(host: MidiConverter, instance: number, register: number, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function updateYM2608RhythmKeys(host: MidiConverter, instance: number, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function updateYM2608RhythmExpression(host: MidiConverter, instance: number, currentTime: number, activeNotes: ActiveNoteMap, selectedChannel?: number): void;
export declare function ym2608RhythmVelocity(host: MidiConverter, instance: number, channel: number): number;
export declare function handleYM2608ADPCMBWrite(host: MidiConverter, instance: number, register: number, data: number, currentTime: number): void;
/** YM2608 ADPCM-Bの非repeat範囲を、VGMの44.1 kHz時間単位へ概算変換する。 */
export declare function ym2608ADPCMDurationSamples(host: MidiConverter, startAddress: number, endAddress: number, deltaN: number, addressUnitBytes: number): number | undefined;
export declare function stopYM2608ADPCMBVoice(host: MidiConverter, instance: number, currentTime: number): void;
export {};

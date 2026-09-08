import type { MidiConverter, OPLChip } from '../midi-converter';
import type { VGMCommand } from '../types';
type ActiveNoteMap = Map<string, {
    note: number;
    startTime: number;
    startVolume: number;
}>;
export declare function handleOPLWrite(host: MidiConverter, cmd: VGMCommand, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number): void;
export declare function oplKey(chip: OPLChip, instance: number, section: 'fm' | 'rhythm', channel: number): string;
export declare function oplOperatorSlot(register: number, bankStart: number): readonly [number, number] | undefined;
export declare function setOPLOperatorMultiple(host: MidiConverter, chip: OPLChip, instance: number, register: number, data: number, currentTime: number): void;
export declare function setOPLOperatorTotalLevel(host: MidiConverter, chip: OPLChip, instance: number, register: number, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function setOPLConnection(host: MidiConverter, chip: OPLChip, instance: number, channel: number, data: number, currentTime: number): void;
export declare function updateOPLFrequencyLow(host: MidiConverter, chip: OPLChip, instance: number, channel: number, data: number, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number): void;
export declare function updateOPLKeyAndBlock(host: MidiConverter, chip: OPLChip, instance: number, channel: number, data: number, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number): void;
export declare function commitOPLKeyOn(host: MidiConverter, chip: OPLChip, instance: number, channel: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function handleOPLRhythmWrite(host: MidiConverter, chip: OPLChip, instance: number, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function oplRhythmVelocity(host: MidiConverter, chip: OPLChip, instance: number, index: number): number;
export {};

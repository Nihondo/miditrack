import type { MidiConverter, OPNCh3Context } from '../midi-converter';
import type { VGMCommand } from '../types';
type ActiveNoteMap = Map<string, {
    note: number;
    startTime: number;
    startVolume: number;
}>;
export declare function handleYM2203Write(host: MidiConverter, cmd: VGMCommand, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number): void;
export declare function handleYM2203KeyWrite(host: MidiConverter, context: OPNCh3Context, data: number, register: number, currentTime: number, activeNotes: ActiveNoteMap): boolean;
export declare function updateYM2203Frequency(host: MidiConverter, instance: number, reg: number, data: number, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number): void;
export declare function updateYM2203Prescaler(host: MidiConverter, instance: number, register: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export {};

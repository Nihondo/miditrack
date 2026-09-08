import type { MidiConverter } from '../midi-converter';
import type { VGMCommand } from '../types';
type ActiveNoteMap = Map<string, {
    note: number;
    startTime: number;
    startVolume: number;
}>;
export declare function handleYM2612Write(host: MidiConverter, cmd: VGMCommand, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number): void;
export declare function handleYM2612TimbreWrite(host: MidiConverter, port: number, reg: number, data: number, currentTime: number): boolean;
export declare function handleYM2612DACSeek(host: MidiConverter, cmd: VGMCommand): void;
export declare function handleYM2612DACWrite(host: MidiConverter, currentTime: number): void;
export declare function stopYM2612DACVoice(host: MidiConverter, currentTime: number): void;
export declare function handleYM2612DirectDACWrite(host: MidiConverter, currentTime: number): void;
export declare function stopYM2612DirectDACVoice(host: MidiConverter, currentTime: number): void;
export {};

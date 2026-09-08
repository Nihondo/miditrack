import type { MidiConverter } from '../midi-converter';
type ActiveNoteMap = Map<string, {
    note: number;
    startTime: number;
    startVolume: number;
}>;
export declare function handleSSGWrite(host: MidiConverter, keyPrefix: string, reg: number, data: number, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number, chip: string, instance: number): void;
export declare function updateSSGNoisePeriod(host: MidiConverter, keyPrefix: string, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function ssgNoiseNoteForPeriod(period: number): number;
export declare function ssgNoiseNote(host: MidiConverter, keyPrefix: string): number;
export declare function updateSSGTonePeriod(host: MidiConverter, keyPrefix: string, reg: number, data: number, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number, chip: string, instance: number): void;
export declare function updateSSGVolume(host: MidiConverter, keyPrefix: string, channel: number, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function updateSSGMixer(host: MidiConverter, keyPrefix: string, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function syncSSGToneState(host: MidiConverter, keyPrefix: string, channel: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function syncSSGNoiseState(host: MidiConverter, keyPrefix: string, channel: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function retriggerSSGEnvelope(host: MidiConverter, keyPrefix: string, currentTime: number, activeNotes: ActiveNoteMap): void;
export {};

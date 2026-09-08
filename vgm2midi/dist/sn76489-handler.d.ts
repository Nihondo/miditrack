import type { MidiConverter } from './midi-converter';
type ActiveNoteMap = Map<string, {
    note: number;
    startTime: number;
    startVolume: number;
}>;
/** Game Gear $4F のLRルーティングをSN76489各voiceのCC10へ反映する。 */
export declare function handleGameGearStereo(host: MidiConverter, data: number, currentTime: number): void;
export declare function handlePSGWrite(host: MidiConverter, data: number, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number): void;
export declare function handleSN76489NoiseControl(host: MidiConverter, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function syncSN76489NoiseVolume(host: MidiConverter, oldVolume: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function sn76489Velocity(volume: number): number;
export declare function sn76489Expression(volume: number): number;
export declare function sn76489NoiseNote(host: MidiConverter): number;
export declare function reevaluateSN76489NoiseForChannel2Frequency(host: MidiConverter, currentTime: number, activeNotes: ActiveNoteMap): void;
export {};

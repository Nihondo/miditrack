import type { MidiConverter } from '../midi-converter';
import type { VGMCommand } from '../types';
type ActiveNoteMap = Map<string, {
    note: number;
    startTime: number;
    startVolume: number;
}>;
/** OPM Timer Aの値をCSM schedulerへ反映する。 */
export declare function updateOPMCsmTimerRegister(host: MidiConverter, instance: number, register: number, data: number): void;
/** OPM $14のCSM有効状態とTimer Aの開始状態を更新する。 */
export declare function updateOPMCsmTimer(host: MidiConverter, instance: number, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function handleYM2151Write(host: MidiConverter, cmd: VGMCommand, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function syncYM2151ToneState(host: MidiConverter, channel: number, shouldRetrigger: boolean, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function syncYM2151NoiseState(host: MidiConverter, shouldRetrigger: boolean, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function ym2151NoiseNoteForPeriod(nfrq: number): number;
export {};

import type { MidiConverter } from '../midi-converter';
import type { VGMCommand } from '../types';
export declare function handleAY8910Write(host: MidiConverter, cmd: VGMCommand, currentTime: number, activeNotes: Map<string, {
    note: number;
    startTime: number;
    startVolume: number;
}>, cmdIndex: number): void;

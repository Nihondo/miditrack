import type { MidiConverter } from '../midi-converter';
import type { VGMCommand } from '../types';
export declare function handleC140Write(host: MidiConverter, cmd: VGMCommand, currentTime: number): void;
export declare function triggerC140Voice(host: MidiConverter, channel: number, instance: number, currentTime: number): void;

import type { MidiConverter } from '../midi-converter';
import type { VGMCommand } from '../types';
export declare function handleSegaPCMWrite(host: MidiConverter, cmd: VGMCommand, currentTime: number): void;
export declare function triggerSegaPCMVoice(host: MidiConverter, channel: number, control: number, instance: number, currentTime: number): void;

import type { MidiConverter, TrackDescriptor, PCMPlaybackRangeMetadata, ChannelState } from './midi-converter';
import type { PCMDataBlockMetadata, PCMAnalysisMetadata } from './pcm-analysis';
type ActiveNoteMap = Map<string, {
    note: number;
    startTime: number;
    startVolume: number;
}>;
/** 同じMIDI channelで異なるdescriptorが同時発音した場合だけ警告を記録する。 */
export declare function registerDescriptorStart(host: MidiConverter, descriptor: TrackDescriptor, currentTime: number): void;
/** descriptor単位で終了し、同一source keyの別instanceを消さない。 */
export declare function registerDescriptorStop(host: MidiConverter, descriptorId: string): void;
export declare function addExpression(host: MidiConverter, key: string, expression: number, currentTime: number): void;
export declare function addPCMPan(host: MidiConverter, key: string, pan: number, currentTime: number): void;
/** 左のみ/両方/右のみを CC10 の 0/64/127 に正規化して送る。 */
export declare function addPan(host: MidiConverter, key: string, hasLeft: boolean, hasRight: boolean, currentTime: number): void;
export declare function addPitchBend(host: MidiConverter, key: string, semitoneOffset: number, semitoneRange: number, currentTime: number): void;
export declare function noteOnPercussion(host: MidiConverter, key: string, velocity: number, currentTime: number, activeNotes: ActiveNoteMap, pitch?: number): void;
export declare function noteOnPCMPercussion(host: MidiConverter, key: string, pitch: number, velocity: number, currentTime: number, isLoop?: boolean, dataBlock?: PCMDataBlockMetadata, durationSamples?: number, playbackRange?: PCMPlaybackRangeMetadata, analysis?: PCMAnalysisMetadata): string;
export declare function noteOffPCMPercussion(host: MidiConverter, key: string, pitch: number, currentTime: number): void;
export declare function pcmNoteForSample(host: MidiConverter, sampleKey: string): number;
export declare function getNoteFrequency(host: MidiConverter, key: string, state: ChannelState): number;
export declare function ym2151KeyToFrequency(host: MidiConverter, keyCode: number, keyFraction: number): number;
export declare function noteOn(host: MidiConverter, key: string, _midiChannelOffset: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function noteOff(host: MidiConverter, key: string, _midiChannelOffset: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function updateNotePitch(host: MidiConverter, key: string, midiChannelOffset: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export {};

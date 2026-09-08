import type { MidiConverter, ChannelState } from '../midi-converter';
import type { VGMCommand } from '../types';
type ActiveNoteMap = Map<string, {
    note: number;
    startTime: number;
    startVolume: number;
}>;
/** VGMの絶対sample時刻まで、両方のDMG APUフレームシーケンサを進める。 */
export declare function advanceGBDMGFrameSequencers(host: MidiConverter, targetSamples: number, activeNotes: ActiveNoteMap): void;
/** 512Hzの一段を実行し、長さ・sweep・envelopeの該当段だけをclockする。 */
export declare function clockGBDMGFrameStep(host: MidiConverter, instance: number, currentTime: number, activeNotes: ActiveNoteMap): void;
/** length-enableされた発音を256Hzで減算し、ゼロになった時点でMIDI Note Offにする。 */
export declare function clockGBDMGLengths(host: MidiConverter, currentTime: number, activeNotes: ActiveNoteMap): void;
/** Channel 1のNR10 sweepを128Hzで評価し、連続音程はpitch bendで表現する。 */
export declare function clockGBDMGSweep(host: MidiConverter, currentTime: number, activeNotes: ActiveNoteMap): void;
/** 64HzのDMG envelopeをCC11へ変換する。 */
export declare function clockGBDMGEnvelopes(host: MidiConverter, currentTime: number, activeNotes: ActiveNoteMap): void;
/** NRx2の初期音量とenvelope timerを、ハードウェアtrigger時に再初期化する。 */
export declare function startGBDMGEnvelope(state: ChannelState): void;
/** Channel 1 trigger時にNR10 shadow/timerを初期化する。 */
export declare function startGBDMGSweep(state: ChannelState): void;
/** NRx1/NR31/NR41の長さロード値を保存する。 */
export declare function setGBDMGLength(host: MidiConverter, key: string, data: number, maximum: number): void;
/** trigger時に長さ0をハードウェア最大値へ再ロードする。 */
export declare function reloadGBDMGLength(state: ChannelState, maximum: number): void;
/** NR50/NR51から指定DMGチャンネルの左右出力を求め、CC10を送る。 */
export declare function updateGBDMGPan(host: MidiConverter, key: string, channel: number, currentTime: number): void;
/** NR50/NR51更新後、現在鳴っているDMG voiceだけを再panする。 */
export declare function refreshGBDMGPans(host: MidiConverter, currentTime: number): void;
export declare function handleGBDMGWrite(host: MidiConverter, cmd: VGMCommand, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number): void;
/** NR10のsweep設定をChannel 1へ保存し、次のtriggerから適用する。 */
export declare function handleGBDMGSweepWrite(host: MidiConverter, data: number): void;
export declare function gbDmgEnvelopeDacEnabled(rawEnvelope: number): boolean;
export declare function gbDmgEnvelopeVelocity(rawEnvelope: number): number;
export declare function handleGBDMGEnvelopeWrite(host: MidiConverter, key: string, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function updateGBDMGFrequencyLSB(host: MidiConverter, key: string, reg: number, data: number, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number, instance: number): void;
export declare function handleGBDMGTriggerWrite(host: MidiConverter, key: string, reg: number, data: number, currentTime: number, activeNotes: ActiveNoteMap, cmdIndex: number, instance: number): void;
export declare function handleGBDMGWaveDACWrite(host: MidiConverter, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function handleGBDMGWaveOutputLevelWrite(host: MidiConverter, data: number, currentTime: number): void;
export declare function gbDmgWaveVelocity(outputLevelCode: number): number;
export declare function handleGBDMGNoiseEnvelopeWrite(host: MidiConverter, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function handleGBDMGNoiseFrequencyWrite(host: MidiConverter, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function handleGBDMGNoiseTriggerWrite(host: MidiConverter, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export declare function handleGBDMGMasterControlWrite(host: MidiConverter, data: number, currentTime: number, activeNotes: ActiveNoteMap): void;
export {};

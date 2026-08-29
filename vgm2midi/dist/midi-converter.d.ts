import { VGMData, ConversionOptions } from './types';
/** libvgm/emu2413.c由来のYM2413内蔵patch carrier register ($01) byte。 */
export declare const YM2413_BUILTIN_CARRIER_REGISTER_BYTES: readonly [0, 97, 65, 1, 97, 33, 34, 97, 33, 97, 97, 1, 193, 80, 1, 65];
/** 内蔵patch carrier registerのMultiple下位nibble（patch番号を添字にする）。 */
export declare const YM2413_BUILTIN_CARRIER_MULTIPLES: readonly [0, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 0, 1, 1];
/** VGMのチップ書き込みを解析し、音程・音量・ノイズの発音状態をMIDIイベントへ変換する。 */
export declare class MidiConverter {
    private vgmData;
    private options;
    private sampleRate;
    private channels;
    private tracks;
    private descriptors;
    /** 実際に重なった異descriptorのMIDI channelだけを記録する。 */
    warnings: string[];
    private activeMidiDescriptors;
    private activePCMNotes;
    private generatedNoteCount;
    private lastLatchedChannel;
    private gameGearStereo;
    private huc6280SelectedChannels;
    private segaPCMRegisters;
    private c140Registers;
    private segaPCMActiveVoices;
    private c140ActiveVoices;
    private pcmSampleNotes;
    private isYM2612DACEnabled;
    private ym2612DACPendingAddress?;
    private ym2612DACActiveVoice?;
    private ym2612DirectDACActiveVoice?;
    private ym2612DirectDACLastWriteTime?;
    private opnCh3SpecialModes;
    private opnCh3PercussionActiveKeys;
    private oplRhythmModes;
    private oplRhythmControlBytes;
    private ym2203Prescalers;
    private ym2608Prescalers;
    private ym2608RhythmTotalLevels;
    private ym2608RhythmInstrumentLevels;
    private ym2608ADPCMRegisters;
    private ym2608ADPCMActiveVoices;
    private ym2413RhythmMode;
    private ym2413RhythmControlByte;
    private ym2413RhythmVolumes;
    private ym2413CustomPatch;
    private hasYM2413CustomCarrierMultiple;
    private ssgNoisePeriods;
    private pcmChannel10Pan?;
    private initialChannels;
    private streams;
    private huc6280GlobalBalance;
    private secondaryChipStates;
    private activeChipInstance?;
    private gbDmgMasterVolume;
    private gbDmgStereoRouting;
    private gbDmgFrameSteps;
    private gbDmgNextFrameSamples;
    constructor(vgmData: VGMData, options?: ConversionOptions);
    /** 第二チップの可変状態を一時的に主チップのhandlerへ差し替えて隔離する。 */
    private withChipInstance;
    private belongsToChip;
    private captureChipScalars;
    private restoreChipScalars;
    /** 変換間で可変レジスタを共有しないための深い状態複製。 */
    private cloneChannels;
    private opnCh3Context;
    private initializeOPNCh3SpecialChannels;
    private midiChannelForKey;
    /** VGM Extra Headerのチップ別volumeを、CC7に出力する0-127の値へ変換する。
     *
     * volume=0x0100（256）が100%（GM既定のCC7=100相当）。エントリが無い、
     * volume未指定、または相対値指定（isAbsoluteVolume!==true）の場合は
     * undefinedを返す — 相対値は「既定値からの差分」であり既定値そのものを
     * このパーサーは知らないため、絶対値指定のときだけ安全に採用できる。
     */
    private extraHeaderVolumePercent;
    /** source keyを、現在のchip instanceを含む不変のtrack descriptorへ変換する。 */
    private descriptorForKey;
    /** descriptor IDまたは従来source keyからdescriptorを得る。 */
    private resolveDescriptor;
    private getTrack;
    private isPercussionKey;
    private isWidePitchBendFMKey;
    private isYM2151FMKey;
    private isOPLKey;
    private isOPLFMKey;
    private pitchBendRangeForKey;
    private addPitchBendRange;
    private formatPCMTrackName;
    private ym2203MidiChannel;
    private oplMidiChannel;
    private oplTrackName;
    private ay8910MidiChannel;
    private ay8910TrackName;
    private huc6280MidiChannel;
    private huc6280TrackName;
    private ym2203TrackName;
    private opnCh3DisplayNameForKey;
    private opnCh3SpecialTrackName;
    private opnCh3PercussionTrackName;
    private ym2608MidiChannel;
    private ym2608TrackName;
    private frequencyToMidiNote;
    private frequencyToExactMidi;
    private psgRegisterToFrequency;
    private ym2612FrequencyToHz;
    private ym2203FrequencyToHz;
    private oplFrequencyToHz;
    private ay8910RegisterToFrequency;
    private ym2203SSGRegisterToFrequency;
    private huc6280RegisterToFrequency;
    private ym2413RegisterToFrequency;
    /** 選択patchのcarrier Multipleを、明確な2の累乗だけoctave補正に変換する。 */
    private ym2413PitchScale;
    private gbDmgSquareFrequencyToHz;
    private gbDmgWaveFrequencyToHz;
    private gbDmgNoiseFrequencyToHz;
    private gbDmgNoiseNoteForPeriod;
    private samplesToTicks;
    convert(): any[];
    /** Game Gear $4F のLRルーティングをSN76489各voiceのCC10へ反映する。 */
    private handleGameGearStereo;
    /** VGM $31 のAY/OPN SSG LR maskを各SSG voiceのCC10へ変換する。 */
    private handleAYSSGStereo;
    private handlePSGWrite;
    private handleSN76489NoiseControl;
    private syncSN76489NoiseVolume;
    private sn76489Velocity;
    private sn76489Expression;
    private sn76489NoiseNote;
    private reevaluateSN76489NoiseForChannel2Frequency;
    private handleYM2612Write;
    private isOPNCh3SpecialMode;
    private handleOPNCh3ModeWrite;
    private handleOPNCh3SpecialKeyWrite;
    private handleOPNCh3SpecialOperators;
    private handleOPNCh3SpecialPercussion;
    private opnCh3SpecialPercussionNote;
    private opnCh3OperatorFrequency;
    private opnCh3PercussionNoteForCarrierNotes;
    private handleOPNCh3SpecialFrequencyWrite;
    private handleYM2612TimbreWrite;
    private handleOPNTimbreWrite;
    /** OPN/OPNA の $B4-$B6 LR 出力マスクを CC10 に変換する。 */
    private handleOPNPanWrite;
    private opnPitchScale;
    private oplPitchScale;
    private fmPitchScale;
    private opnCarrierVelocity;
    private oplCarrierVelocity;
    private fmCarrierVelocity;
    private operatorTotalLevelVelocity;
    /** Key On時のvelocityを基準に、発音中TL変化だけを相対CC11へ変換する。 */
    private opnCarrierExpression;
    private oplCarrierExpression;
    private fmCarrierExpression;
    private handleYM2612DACSeek;
    private handleYM2612DACWrite;
    private stopYM2612DACVoice;
    private handleYM2612DirectDACWrite;
    private stopYM2612DirectDACVoice;
    private handleYM2203Write;
    private handleYM2203KeyWrite;
    private updateYM2203Frequency;
    private updateYM2203Prescaler;
    private updateKeyBoundFMPitch;
    private handleYM2608Write;
    private handleYM2608KeyWrite;
    private updateYM2608Frequency;
    private updateYM2608Prescaler;
    private updateActiveOPNCh3SpecialPitches;
    private handleYM2608RhythmWrite;
    private updateYM2608RhythmKeys;
    private updateYM2608RhythmExpression;
    private ym2608RhythmVelocity;
    private handleYM2608ADPCMBWrite;
    private stopYM2608ADPCMBVoice;
    private handleAY8910Write;
    private handleSSGWrite;
    private updateSSGNoisePeriod;
    private ssgNoiseNoteForPeriod;
    private ssgNoiseNote;
    private updateSSGTonePeriod;
    private updateSSGVolume;
    private updateSSGMixer;
    private syncSSGToneState;
    private syncSSGNoiseState;
    private retriggerSSGEnvelope;
    private handleYM2151Write;
    private syncYM2151ToneState;
    private syncYM2151NoiseState;
    private ym2151NoiseNoteForPeriod;
    private handleHuC6280Write;
    private updateHuC6280Pan;
    private handleSegaPCMWrite;
    private triggerSegaPCMVoice;
    private handleC140Write;
    private triggerC140Voice;
    private handleOPLWrite;
    private oplKey;
    private oplOperatorSlot;
    private setOPLOperatorMultiple;
    private setOPLOperatorTotalLevel;
    private setOPLConnection;
    private updateOPLFrequencyLow;
    private updateOPLKeyAndBlock;
    private commitOPLKeyOn;
    private handleOPLRhythmWrite;
    private oplRhythmVelocity;
    private handleYM2413Write;
    private handleYM2413RhythmModeWrite;
    private updateYM2413Frequency;
    private handleYM2413KeyAndFrequencyWrite;
    /** YM2413 key-onを、両方のfrequency byteとpatch carrier Multiple確定後にcommitする。 */
    private commitYM2413KeyOn;
    private handleYM2413VolumeWrite;
    private ym2413Velocity;
    private ym2413RhythmVelocity;
    /** VGMの絶対sample時刻まで、両方のDMG APUフレームシーケンサを進める。 */
    private advanceGBDMGFrameSequencers;
    /** 512Hzの一段を実行し、長さ・sweep・envelopeの該当段だけをclockする。 */
    private clockGBDMGFrameStep;
    /** length-enableされた発音を256Hzで減算し、ゼロになった時点でMIDI Note Offにする。 */
    private clockGBDMGLengths;
    /** Channel 1のNR10 sweepを128Hzで評価し、連続音程はpitch bendで表現する。 */
    private clockGBDMGSweep;
    /** 64HzのDMG envelopeをCC11へ変換する。 */
    private clockGBDMGEnvelopes;
    /** NRx2の初期音量とenvelope timerを、ハードウェアtrigger時に再初期化する。 */
    private startGBDMGEnvelope;
    /** Channel 1 trigger時にNR10 shadow/timerを初期化する。 */
    private startGBDMGSweep;
    /** NRx1/NR31/NR41の長さロード値を保存する。 */
    private setGBDMGLength;
    /** trigger時に長さ0をハードウェア最大値へ再ロードする。 */
    private reloadGBDMGLength;
    /** NR50/NR51から指定DMGチャンネルの左右出力を求め、CC10を送る。 */
    private updateGBDMGPan;
    /** NR50/NR51更新後、現在鳴っているDMG voiceだけを再panする。 */
    private refreshGBDMGPans;
    private handleGBDMGWrite;
    /** NR10のsweep設定をChannel 1へ保存し、次のtriggerから適用する。 */
    private handleGBDMGSweepWrite;
    private gbDmgEnvelopeDacEnabled;
    private gbDmgEnvelopeVelocity;
    private handleGBDMGEnvelopeWrite;
    private updateGBDMGFrequencyLSB;
    private handleGBDMGTriggerWrite;
    private handleGBDMGWaveDACWrite;
    private handleGBDMGWaveOutputLevelWrite;
    private gbDmgWaveVelocity;
    private handleGBDMGNoiseEnvelopeWrite;
    private handleGBDMGNoiseFrequencyWrite;
    private handleGBDMGNoiseTriggerWrite;
    private handleGBDMGMasterControlWrite;
    private stopPCMVoice;
    private stopAllPCMVoices;
    /** DAC stream 0x90–0x95 を処理し、MSM6258は編集用GMトリガーとして残す。 */
    private handleStreamCommand;
    /** 開始済みDAC streamのGM編集トリガーを停止する。 */
    private stopStreamVoice;
    /** 0x91で選択したbank内の連結offsetとblock番号を求める。 */
    private resolveStreamBankOffset;
    /** bankの連結sizeを返し、0x93「終端まで」のcommand数計算に使用する。 */
    private streamBankSize;
    /** setup先のVGM command/data幅から、stream一回のwriteに必要なbyte数を得る。 */
    private streamCommandSize;
    /** 0x93/0x95のlength modeをcommand数と絶対sample durationへ正規化する。 */
    private resolveStreamRange;
    /** bank/block/start/length/step/flagを含む安定したMSM6258編集トリガーidentityを作る。 */
    private streamIdentity;
    private syncHuC6280ToneState;
    private syncHuC6280NoiseState;
    private updateHuC6280NoiseEnvelope;
    private noteOnHuC6280Noise;
    private huc6280NoiseNoteForPeriod;
    private addHuC6280Expression;
    private isHuC6280MultiByteFreqUpdate;
    private isOPNMultiByteFreqUpdate;
    private noteOnPCMPercussion;
    private noteOffPCMPercussion;
    private noteOnPercussion;
    private pcmNoteForSample;
    /** 同じMIDI channelで異なるdescriptorが同時発音した場合だけ警告を記録する。 */
    private registerDescriptorStart;
    /** descriptor単位で終了し、同一source keyの別instanceを消さない。 */
    private registerDescriptorStop;
    private addExpression;
    private addPCMPan;
    /** 左のみ/両方/右のみを CC10 の 0/64/127 に正規化して送る。 */
    private addPan;
    private getNoteFrequency;
    private ym2151KeyToFrequency;
    private noteOn;
    private noteOff;
    private updateNotePitch;
    private addPitchBend;
    /** MIDIトラック記述子をlibvgmのdevice/channel mute選択へ変換する。 */
    private libvgmTargetForDescriptor;
    /** MIDIファイルを書き出し、音符が生成されなかった場合は空ファイルを作らず失敗させる。 */
    exportToFile(outputPath: string): void;
    /** 出力MIDIのトラック順とlibvgmのmute対象を結ぶJSON sidecarを書き出す。 */
    exportTrackMetadata(outputPath: string, totalSamples: number): void;
    /** MIDI writer の固定divisionを 960 PPQ へ置換する。 */
    private buildMidiFile;
    /** チップ別DAW編集用sidecarを、通常の混在出力と併せて書き出す。 */
    private exportSplitChipFiles;
    /** sidecar名はsource keyではなくdescriptorのchip/instanceから生成する。 */
    private chipNameForDescriptor;
}

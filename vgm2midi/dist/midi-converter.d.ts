import { VGMData, ConversionOptions } from './types';
import { PCMTrackEvent, PCMDataBlockMetadata, PCMAnalysisMetadata } from './pcm-analysis';
export declare const OPL_FM_PITCH_BEND_RANGE = 96;
export declare const CHIP_PITCH_BEND_RANGE = 96;
export type OPLChip = 'YM3812' | 'YM3526' | 'Y8950';
export declare const OPL_CHIPS: readonly ["YM3812", "YM3526", "Y8950"];
/** libvgm/emu2413.c由来のYM2413内蔵patch carrier register ($01) byte。 */
export declare const YM2413_BUILTIN_CARRIER_REGISTER_BYTES: readonly [0, 97, 65, 1, 97, 33, 34, 97, 33, 97, 97, 1, 193, 80, 1, 65];
/** 内蔵patch carrier registerのMultiple下位nibble（patch番号を添字にする）。 */
export declare const YM2413_BUILTIN_CARRIER_MULTIPLES: readonly [0, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 0, 1, 1];
export declare const GBDMG_SQUARE_KEYS: readonly ["gbdmg_0", "gbdmg_1"];
export declare const GBDMG_FRAME_SAMPLES: number;
interface OPNOperatorPath {
    carrier: number;
    operators: readonly number[];
}
export interface ChannelState {
    frequency: number;
    volume: number;
    active: boolean;
    midiNote: number;
    baseMidiNote: number;
    block?: number;
    opnAlgorithm?: number;
    opnOperatorMultipliers?: number[];
    opnOperatorMultiplierWritten?: boolean[];
    opnOperatorTotalLevels?: number[];
    opnActivePitchScale?: number;
    opnActiveVelocity?: number;
    freqLSB?: number;
    freqMSB?: number;
    hasPendingFrequencyUpdate?: boolean;
    keyCode?: number;
    keyFraction?: number;
    keyOnMask?: number;
    isToneEnabled?: boolean;
    isEnvelope?: boolean;
    isEnabled?: boolean;
    isDDA?: boolean;
    isNoise?: boolean;
    isNoiseActive?: boolean;
    noisePeriod?: number;
    pan?: number;
    balance?: number;
    gbDmgLengthCounter?: number;
    gbDmgLengthEnabled?: boolean;
    gbDmgEnvelopeVolume?: number;
    gbDmgEnvelopeTimer?: number;
    gbDmgEnvelopePeriod?: number;
    gbDmgEnvelopeIncrease?: boolean;
    gbDmgSweepShadow?: number;
    gbDmgSweepTimer?: number;
    gbDmgSweepPeriod?: number;
    gbDmgSweepShift?: number;
    gbDmgSweepNegate?: boolean;
    gbDmgSweepEnabled?: boolean;
    ym2413Instrument?: number;
    ym2413PendingKeyOn?: boolean;
    oplKeyOn?: boolean;
    oplPendingKeyOn?: boolean;
}
/** MIDI出力を一意に識別するチップ／instance／発音部の記述子。 */
export interface TrackDescriptor {
    chip: string;
    instance: number;
    section: string;
    channel: number;
    sourceKey: string;
    midiChannel: number;
    id: string;
}
/** 最初の発音時点におけるFMトラックの音色解釈。MIDIには表せない値をsidecarへ残す。 */
interface FMTimbreMetadata {
    model: 'opn' | 'opm' | 'opl' | 'opll';
    suggestedProgram: number;
    algorithm?: number;
    carrierOperators?: number[];
    operatorMultipliers?: number[];
    operatorMultiplierWritten?: boolean[];
    operatorTotalLevels?: number[];
    keyOnMask?: number;
    ym2413Instrument?: number;
    ym2413CarrierMultiple?: number;
    ym2413Volume?: number;
    specialOperator?: number;
    /** OPN Ch3 Specialの出力モード。CSM時はTimer Aによる自動キーオンを伴う。 */
    opnCh3Mode?: 'special' | 'special-csm';
}
interface FMTimbreEvent {
    sampleTime: number;
    source: 'ym2413-patch' | 'ym2413-custom-patch' | 'opn-timbre' | 'opm-timbre' | 'opl-timbre';
    timbre: FMTimbreMetadata;
}
interface TrackState {
    descriptor: TrackDescriptor;
    track: any;
    cursor: number;
    expression: number;
    fmTimbre?: FMTimbreMetadata;
    fmEvents?: FMTimbreEvent[];
    pcmEvents?: PCMTrackEvent[];
    pcmDataBlock?: PCMDataBlockMetadata;
    pcmAnalysis?: PCMAnalysisMetadata;
}
/** PCMトリガーに付随するチップ固有の再生範囲。 */
export interface PCMPlaybackRangeMetadata {
    endAddressExclusive: number;
    loopAddress?: number;
}
/** VGMのチップ書き込みを解析し、音程・音量・ノイズの発音状態をMIDIイベントへ変換する。 */
export declare class MidiConverter {
    vgmData: VGMData;
    options: ConversionOptions;
    sampleRate: number;
    channels: Map<string, ChannelState>;
    private tracks;
    private descriptors;
    /** 実際に重なった異descriptorのMIDI channelだけを記録する（開発者向け、--verboseで表示）。 */
    warnings: string[];
    /** ヒューリスティック変換が誤りやすい入力を検出したときの、エンドユーザー向け注意事項。
     * warnings（技術的な内部診断）とは別に扱い、--track-metadataサイドカーへ書き出して
     * miditrackのWeb UIがそのまま表示できるようにする。 */
    userWarnings: string[];
    activeMidiDescriptors: Map<string, {
        midiChannel: number;
        startTime: number;
    }>;
    activePCMNotes: Map<string, number>;
    generatedNoteCount: number;
    lastLatchedChannel: number;
    gameGearStereo: number;
    huc6280SelectedChannels: number[];
    private segaPCMRegisters;
    private c140Registers;
    private segaPCMActiveVoices;
    private c140ActiveVoices;
    pcmSampleNotes: Map<string, number>;
    private isYM2612DACEnabled;
    private ym2612DACPendingAddress?;
    private ym2612DACActiveVoice?;
    private ym2612DirectDACActiveVoice?;
    private ym2612DirectDACLastWriteTime?;
    private opnCh3SpecialModes;
    private opnCh3PercussionActiveKeys;
    private opnCh3UnisonStats;
    private opnCsmTimers;
    private opmCsmTimers;
    oplRhythmModes: Map<string, boolean>;
    oplRhythmControlBytes: Map<string, number>;
    ym2203Prescalers: number[];
    ym2608Prescalers: number[];
    private ym2608RhythmTotalLevels;
    private ym2608RhythmInstrumentLevels;
    private ym2608ADPCMRegisters;
    private ym2608ADPCMActiveVoices;
    ym2413RhythmMode: boolean;
    ym2413RhythmControlByte: number;
    ym2413RhythmVolumes: number[];
    ym2413CustomPatch: Uint8Array<ArrayBuffer>;
    hasYM2413CustomCarrierMultiple: boolean;
    private ssgNoisePeriods;
    pcmChannel10Pan?: number;
    private initialChannels;
    private streams;
    huc6280GlobalBalance: number[];
    private secondaryChipStates;
    private activeChipInstance?;
    gbDmgMasterVolume: number;
    gbDmgStereoRouting: number;
    gbDmgFrameSteps: number[];
    gbDmgNextFrameSamples: number[];
    constructor(vgmData: VGMData, options?: ConversionOptions);
    /** 第二チップの可変状態を一時的に主チップのhandlerへ差し替えて隔離する。 */
    withChipInstance(chip: string, instance: number, action: () => void): void;
    private belongsToChip;
    private captureChipScalars;
    private restoreChipScalars;
    /** 変換間で可変レジスタを共有しないための深い状態複製。 */
    private cloneChannels;
    /** OPN Ch3 Special関連state（opnCh3SpecialModes等）のMapキーを、YM2612は
     * インスタンス非依存、YM2203/YM2608はチップ+インスタンスで構築する。 */
    private opnCh3StateKey;
    private opnCh3Context;
    private initializeOPNCh3SpecialChannels;
    midiChannelForKey(key: string): number;
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
    resolveDescriptor(key: string): TrackDescriptor;
    /** FMトラックの初回発音時に使うGM音色候補を返す。 */
    private suggestedProgramForFMTimbre;
    /** YM2413内蔵patch番号に対応するGM試聴音色候補を返す。 */
    private suggestedProgramForYM2413Patch;
    /** YM2413の選択patchからcarrier Multipleを取得する。 */
    private ym2413CarrierMultiple;
    /** OPN Ch3 Specialのオペレータトラックから親FMチャンネルを解決する。 */
    private opnCh3ParentStateForSourceKey;
    /** OPN Ch3の親／オペレータ別トラックなら、現在のSpecial/CSM状態を返す。 */
    private opnCh3ModeForDescriptor;
    /** MIDIの初回Program Changeと同じ時点のFM状態をsidecar用に複製する。 */
    private fmTimbreForDescriptor;
    /** 発音中のFMトラックへ、レジスタ変更後の音色スナップショットを追記する。 */
    recordFMTimbreEvent(key: string, currentTime: number, source: FMTimbreEvent['source']): void;
    /** 発音後のYM2413音色状態をsidecarの時系列イベントへ追記する。 */
    recordYM2413TimbreEvent(channel: number, currentTime: number, source: FMTimbreEvent['source']): void;
    /** OPN Ch3 Special時は親と発音中のオペレータ別トラックをまとめて更新する。 */
    private recordOPNTimbreEvents;
    /** PCMトラックの循環しない元サンプルIDとMIDIノートの対応をsidecar向けに返す。 */
    private pcmMetadataForTrack;
    getTrack(key: string): TrackState;
    private isPercussionKey;
    private isWidePitchBendFMKey;
    isYM2151FMKey(key: string): boolean;
    isOPLKey(key: string): boolean;
    isOPLFMKey(key: string): boolean;
    pitchBendRangeForKey(key: string): number;
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
    /** 選択patchのcarrier Multipleを、明確な2の累乗だけoctave補正に変換する。 */
    ym2413PitchScale(state: ChannelState): number;
    convert(): any[];
    /** VGM $31 のAY/OPN SSG LR maskを各SSG voiceのCC10へ変換する。 */
    private handleAYSSGStereo;
    private handleYM2612Write;
    private isOPNCh3SpecialMode;
    private handleOPNCh3ModeWrite;
    /** OPN Timer Aの値をCSM schedulerへ反映する。 */
    private updateOPNCsmTimerRegister;
    /** OPN $27のCSM有効状態とTimer Aの開始状態を更新する。 */
    private updateOPNCsmTimer;
    /** OPM Timer Aの値をCSM schedulerへ反映する。 */
    private updateOPMCsmTimerRegister;
    /** OPM $14のCSM有効状態とTimer Aの開始状態を更新する。 */
    private updateOPMCsmTimer;
    /** すべての動作中CSM Timer Aをwait区間内で進める。 */
    private advanceCSMTimers;
    /** Timer AのoverflowとMIDI pulse終了を時刻順に処理する。 */
    private advanceCSMTimer;
    /** OPN CSMを既存のCh3 Special出力形式へ変換する。 */
    private emitOPNCsmPulse;
    /** OPM CSMを各チャンネルの短いMIDIアタックとして出力する。 */
    private emitOPMCsmPulse;
    /** OPN/OPMが共通で使う1 MIDI tick分のCSM pulse長をsampleへ換算する。 */
    private csmPulseSamples;
    /** OPN Timer Aの1周期をVGM sampleへ換算する。 */
    private opnCsmPeriodSamples;
    /** OPM Timer Aの1周期をVGM sampleへ換算する。 */
    private opmCsmPeriodSamples;
    /** OPN各機種のヘッダーclockを取得する。 */
    private opnClockRate;
    /** OPNチップインスタンスのCSM状態を初期化して返す。 */
    private opnCsmTimer;
    /** OPMチップインスタンスのCSM状態を初期化して返す。 */
    private opmCsmTimer;
    private handleOPNCh3SpecialKeyWrite;
    /** Ch3 Specialの新規キーオンで、発音中オペレータ同士がユニゾン(ほぼ同一音程)かを集計する。
     *
     * handleOPNCh3SpecialOperators()/handleOPNCh3SpecialPercussion()が parentState.keyOnMask を
     * 書き換える前に呼ぶ必要がある — 「新規にキーオンされたオペレータ」の判定に前回のマスクを使うため。
     */
    private trackOPNCh3UnisonAttack;
    /** ユニゾン比率が高いOPN Ch3 Specialチップインスタンスをthis.warningsへ追記する。
     *
     * 全オペレータがほぼ同一音程で動いているチャンネルは、実際には複数オペレータで補強された
     * 1つのメロディ楽器であり、デフォルト変換の「独立4トラック」表示にもGMドラム変換にも
     * 適さない — 見た目上の見た目はどちらも「複数の異なる発音」だが、本来は1音。
     */
    private appendOPNCh3UnisonWarnings;
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
    opnPitchScale(state: ChannelState): number;
    oplPitchScale(state: ChannelState): number;
    fmPitchScale(state: ChannelState, paths: readonly (readonly OPNOperatorPath[])[], silentTotalLevel: number, doubledMultiples: readonly number[]): number;
    private opnCarrierVelocity;
    oplCarrierVelocity(state: ChannelState): number;
    private fmCarrierVelocity;
    operatorTotalLevelVelocity(totalLevel: number): number;
    /** Key On時のvelocityを基準に、発音中TL変化だけを相対CC11へ変換する。 */
    private opnCarrierExpression;
    oplCarrierExpression(state: ChannelState): number;
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
    updateKeyBoundFMPitch(key: string, currentTime: number, activeNotes: Map<string, {
        note: number;
        startTime: number;
        startVolume: number;
    }>, pitchBendRange: number): void;
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
    /** YM2608 ADPCM-Bの非repeat範囲を、VGMの44.1 kHz時間単位へ概算変換する。 */
    private ym2608ADPCMDurationSamples;
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
    private handleSegaPCMWrite;
    private triggerSegaPCMVoice;
    private handleC140Write;
    private triggerC140Voice;
    private stopPCMVoice;
    private stopAllPCMVoices;
    /** DAC stream 0x90–0x95 を処理し、MSM6258は編集用GMトリガーとして残す。 */
    private handleStreamCommand;
    /** 開始済みDAC streamのGM編集トリガーを停止する。 */
    private stopStreamVoice;
    /** 0x91で選択したbank内の連結offsetとblock番号を求める。 */
    private resolveStreamBankOffset;
    /** data bank内の連結offsetを、sidecar用のblock/offset情報へ変換する。 */
    private pcmDataBlockForRange;
    /** ROM data blockの実データ範囲から、物理サンプルアドレスをsidecar情報へ解決する。 */
    private pcmROMDataBlockForAddress;
    /** bankの連結sizeを返し、0x93「終端まで」のcommand数計算に使用する。 */
    private streamBankSize;
    /** setup先のVGM command/data幅から、stream一回のwriteに必要なbyte数を得る。 */
    private streamCommandSize;
    /** 0x93/0x95のlength modeをcommand数と絶対sample durationへ正規化する。 */
    private resolveStreamRange;
    /** bank/block/start/length/step/flagを含む安定したMSM6258編集トリガーidentityを作る。 */
    private streamIdentity;
    isOPNMultiByteFreqUpdate(cmdIndex: number, chip: string, port: number, otherReg: number, instance?: number): boolean;
    /** MIDIトラック記述子をlibvgmのdevice/channel mute選択へ変換する。
     *
     * Ch3 Specialの4オペレータ別トラック（Op1-3の専用トラックとOp4=通常のchannel3トラック）
     * および複合ドラム化トラック（--ch3-special-percussion時）は、全部が同じ物理channel3の
     * レジスタ操作を見ているだけの別視点に過ぎない。安全な一対一のミュート対象は無いため
     * 個別のlibvgm選択は提供できないが、4トラック全部をchannel3のmainMaskへ束ねることで、
     * まとめて「原曲」へ切り替えたときだけ物理channel3全体（Special/Normal両モードの composite
     * 音を含む）を実機音源としてレンダリングできる。一部だけ「原曲」に切り替えると、
     * レンダリング後もSoundFontを選んだ残りのトラックはミュートされる（一切鳴らない）ため、
     * 二重発音は起きない——同じgroupIdの範囲は必ず一括で切り替わる
     * （validate_sources()のgroup_indices()展開を参照）。 */
    private libvgmTargetForDescriptor;
    /** MIDIファイルを書き出し、音符が生成されなかった場合は空ファイルを作らず失敗させる。 */
    exportToFile(outputPath: string): void;
    /** 出力MIDIのトラック順とlibvgmのmute対象を結ぶJSON sidecarを書き出す。
     *
     * warningsフィールドはuserWarnings（ヒューリスティック変換が誤りやすい入力を検出した
     * ときのエンドユーザー向け注意事項）を書き出す。this.warnings（MIDIチャンネル重複などの
     * 技術的な内部診断、--verboseでのみ表示）とは意図的に別で、miditrackのWeb UIが
     * そのままユーザーへ表示できる内容に限定する。 */
    exportTrackMetadata(outputPath: string, totalSamples: number): void;
    /** MIDI writer の固定divisionを 960 PPQ へ置換する。 */
    private buildMidiFile;
    /** チップ別DAW編集用sidecarを、通常の混在出力と併せて書き出す。 */
    private exportSplitChipFiles;
    /** sidecar名はsource keyではなくdescriptorのchip/instanceから生成する。 */
    private chipNameForDescriptor;
}
export {};

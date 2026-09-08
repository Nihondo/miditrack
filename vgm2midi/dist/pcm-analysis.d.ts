import { VGMData, VGMDataBlock } from './types';
export interface PCMTrackEvent {
    type: 'start' | 'stop';
    sampleTime: number;
    isLoop?: boolean;
    /** PCMアドレス空間における排他的な再生終了位置。 */
    endAddressExclusive?: number;
    /** ループ時の再開位置。`isLoop`がtrueの場合だけ出力する。 */
    loopAddress?: number;
    /** チップまたはVGM streamから解決できた再生予定長。loop時は省略する。 */
    durationSamples?: number;
    /** VGM data bankから要求されるエンコード済みbyte数。 */
    dataLengthBytes?: number;
}
/** PCMトリガーが参照するVGM 0x67 data bank内の範囲。 */
export interface PCMDataBlockMetadata {
    bankType: number;
    bankInstance: number;
    blockId: number;
    /** stream bankでは連結先頭offset、ROMでは物理サンプルアドレス。 */
    bankOffset: number;
    /** block内の先頭offset。 */
    blockOffset: number;
    /** stream開始時に要求されたbyte数。長さを解決できない場合は省略する。 */
    lengthBytes?: number;
    /** ROM data blockが示すチップ側ROM全体のsize。 */
    romSizeBytes?: number;
    /** このROM data blockがロードするチップ側の先頭アドレス。 */
    romStartAddress?: number;
    /** ROM data block内の実データ部のsize。8 byteのROM headerは含まない。 */
    romDataLengthBytes?: number;
}
/** sidecarへ出力する、形式が確定した生PCMの基本波形特徴量。 */
export interface PCMAnalysisMetadata {
    format: 'signed-8bit-pcm' | 'yamaha-adpcm-b' | 'signed-12bit-be-pcm' | 'c140-compressed-pcm' | 'c219-mulaw';
    sourceByteLength: number;
    analyzedSampleCount: number;
    isDownsampled?: true;
    peak: number;
    mean: number;
    rms: number;
    zeroCrossingCount: number;
}
/** 波形特徴量だけから決める、楽器種別を主張しない説明的な音色ラベル。 */
export interface PCMTimbreMetadata {
    name: 'quiet' | 'tonal' | 'noise-like';
    confidence: number;
}
/** sidecarのdata block参照から実ROM blockを探す。 */
export declare function romDataBlockForMetadata(vgmData: VGMData, dataBlock: PCMDataBlockMetadata): VGMDataBlock | undefined;
/** ROM block内のbyteアドレス範囲を安全に取得する。 */
export declare function romBytesForRange(vgmData: VGMData, dataBlock: PCMDataBlockMetadata, endAddress: number): Buffer | undefined;
/** C140のwordアドレス範囲を、ROM block上のbig-endian byte列へ変換する。 */
export declare function c140ROMBytesForRange(vgmData: VGMData, dataBlock: PCMDataBlockMetadata, endAddress: number): Buffer | undefined;
/** 数値sample列を均等に間引き、正規化された波形特徴量へ変換する。 */
export declare function analyzePCMValues(format: PCMAnalysisMetadata['format'], sourceByteLength: number, sampleCount: number, maximumAmplitude: number, sampleAt: (index: number) => number): PCMAnalysisMetadata | undefined;
/** 波形統計から、楽器種別を断定しない説明的な音色ラベルを作る。 */
export declare function pcmTimbreForAnalysis(analysis: PCMAnalysisMetadata): PCMTimbreMetadata;
/** 8-bit符号PCMを均等に間引き、振幅とゼロクロスの基本特徴量を返す。 */
export declare function analyzeSigned8BitPCM(samples: Buffer, sign?: number): PCMAnalysisMetadata | undefined;
/** 単一ROM blockに完全に収まる符号付き8-bit PCMの基本波形特徴量を返す。 */
export declare function signed8BitPCMAnalysisForROMRange(vgmData: VGMData, dataBlock: PCMDataBlockMetadata, endAddress: number, sign?: number): PCMAnalysisMetadata | undefined;
/** C219 μ-law tableをMAMEと同じ手順で作り、復号後の波形を解析する。 */
export declare function c219MuLawAnalysisForROMRange(vgmData: VGMData, dataBlock: PCMDataBlockMetadata, endAddress: number, sign: number): PCMAnalysisMetadata | undefined;
/** C140のbig-endian 12-bit word PCMを解析する。 */
export declare function c14012BitPCMAnalysisForROMRange(vgmData: VGMData, dataBlock: PCMDataBlockMetadata, endAddress: number): PCMAnalysisMetadata | undefined;
/** C140圧縮PCMのMAME互換テーブル復号を解析に用いる。 */
export declare function c140CompressedPCMAnalysisForROMRange(vgmData: VGMData, dataBlock: PCMDataBlockMetadata, endAddress: number): PCMAnalysisMetadata | undefined;
/** YM2608 ADPCM-BをYamahaの予測式で復号し、全nibbleを解析する。 */
export declare function ym2608ADPCMBAnalysis(vgmData: VGMData, dataBlock: PCMDataBlockMetadata | undefined, sourceByteLength: number | undefined): PCMAnalysisMetadata | undefined;
/** 単一ROM blockへ完全に収まるSegaPCMの生8-bit PCMを解析する。 */
export declare function segaPCMAnalysisForTrack(vgmData: VGMData, dataBlock: PCMDataBlockMetadata | undefined, events: PCMTrackEvent[]): PCMAnalysisMetadata | undefined;
/** C140/C219の確認済みPCMモードを、物理ROM範囲から解析する。 */
export declare function c140PCMAnalysisForVoice(vgmData: VGMData, dataBlock: PCMDataBlockMetadata | undefined, startAddress: number, endAddress: number, mode: number): PCMAnalysisMetadata | undefined;
/** SegaPCM interface registerのROMバンク設定を物理アドレスの先頭へ変換する。 */
export declare function segaPCMBankBaseAddress(vgmData: VGMData, control: number): number;
/** SegaPCMの非ループ範囲を、VGMの44.1 kHz時間単位へ概算変換する。 */
export declare function segaPCMDurationSamples(vgmData: VGMData, address: number, endPage: number, frequency: number, sampleRate: number): number | undefined;
/** C140/C219の非ループ範囲を、VGMの44.1 kHz時間単位へ概算変換する。 */
export declare function c140DurationSamples(vgmData: VGMData, start: number, end: number, frequency: number, sampleRate: number): number | undefined;
/** C140系レジスタのバンク・開始位置を、VGM ROM blockで使う物理ROMアドレスへ変換する。 */
export declare function c140ROMAddress(vgmData: VGMData, c140Registers: Uint8Array, channel: number, bank: number, address: number): number;

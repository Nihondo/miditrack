export interface VGMHeader {
    fileId: string;
    eofOffset: number;
    version: number;
    sn76489Clock: number;
    sn76489Flags: number;
    ym2413Clock: number;
    gd3Offset: number;
    totalSamples: number;
    loopOffset: number;
    loopDataOffset?: number;
    loopSamples: number;
    rate: number;
    ym2203Clock: number;
    ym2608Clock: number;
    ym3812Clock: number;
    ym3526Clock: number;
    y8950Clock: number;
    ym2612Clock: number;
    ym2151Clock: number;
    vgmDataOffset: number;
    segaPCMClock: number;
    segaPCMInterface: number;
    ay8910Clock: number;
    ay8910Type: number;
    ay8910Flags: number;
    ym2203AyFlags: number;
    ym2608AyFlags: number;
    huc6280Clock: number;
    c140Clock: number;
    gbDmgClock: number;
    /** MSM6258 の VGM header clock。bit 30/31 を除いた値は diagnostics が報告する。 */
    msm6258Clock: number;
    /** VGM 1.72 の全 header clock をチップ名で引ける診断用の表。 */
    chipClocks: Record<string, number>;
}
export interface VGMCommand {
    type: string;
    chip?: string;
    instance?: number;
    port?: number;
    register?: number;
    data?: number;
    samples?: number;
    address?: number;
    /** 元の VGM コマンド。診断用に未対応書き込みも保持する。 */
    command?: number;
    /** DAC stream のデータバンク、開始位置、長さ、周波数など。 */
    streamId?: number;
    bankId?: number;
    length?: number;
    frequency?: number;
    stepSize?: number;
    /** 0x91 のStep Base。Start Offsetへcommand data-size単位で加算する。 */
    stepBase?: number;
    /** 0x93 Length Modeの下位nibble（lengthの単位）。 */
    lengthMode?: number;
    /** 0x95が参照する、選択bank内のdata block番号。 */
    blockId?: number;
    /** 未対応chip writeの生operand。境界・診断を失わないために保持する。 */
    operands?: number[];
    /** DAC stream setup で決まる出力先。後続 stream command の診断に使用する。 */
    targetChip?: string;
    targetInstance?: number;
}
/** 検出されたチップ書き込みの変換可否を示す集計行。 */
export interface VGMChipDiagnostic {
    chip: string;
    instance: number;
    clock: number;
    commandCount: number;
    writeCount: number;
    streamCount: number;
    midiSupport: 'full' | 'trigger' | 'none';
}
/** 変換で省略されるコンテンツを明示する、失敗しない既定診断。 */
export interface VGMDiagnostics {
    chips: VGMChipDiagnostic[];
    unsupportedCommandCount: number;
    unsupportedWriteCount: number;
    streamCount: number;
    hasOmittedContent: boolean;
}
/** data bank typeごとに連番を持つVGM 0x67 data block。 */
export interface VGMDataBlock {
    /** 解凍後に属するVGM data bank type（0x00..0xFF）。 */
    type: number;
    /** 同じtypeのblock ID。0x95がこの番号を参照する。 */
    blockId: number;
    /** block payloadのbyte数。 */
    size: number;
    /** parser入力から安全に保持したblock payload。 */
    payload: Buffer;
    /** sizeのbit31で指定される第二チップdata bankなら1、それ以外は0。 */
    instance?: number;
    /** 圧縮blockでは元の0x40..0x7E type。未圧縮ではtypeと同じ。 */
    originalType?: number;
    /** 圧縮data blockを展開済みならtrue。 */
    isCompressed?: boolean;
}
export interface VGMData {
    header: VGMHeader;
    commands: VGMCommand[];
    loopCommandIndex?: number;
    /** YM2612 PCM data bank (VGM data block type 0x00), concatenated in file order. */
    ym2612PcmData?: Buffer;
    /** typeごと・block ID順で保持した全0x67 data block。 */
    dataBlocks?: VGMDataBlock[];
    /** VGM 1.70 extra header が報告した追加デバイス情報。 */
    extraHeader?: Array<{
        chip: string;
        instance: number;
        clock: number;
        volume: number;
    }>;
    diagnostics: VGMDiagnostics;
}
export interface MidiNote {
    channel: number;
    note: number;
    velocity: number;
    startTime: number;
    duration: number;
}
export interface PlaybackOptions {
    loopCount?: number;
    durationSeconds?: number;
}
export interface ConversionOptions extends PlaybackOptions {
    tempo?: number;
    trackPerChannel?: boolean;
    verbose?: boolean;
    suppressHardwareNoise?: boolean;
    noiseWavPath?: string;
    suppressYM2612Dac?: boolean;
    dacWavPath?: string;
    opnCh3SpecialPercussion?: boolean;
    /** @deprecated Use opnCh3SpecialPercussion. */
    ym2612Ch3SpecialPercussion?: boolean;
    /** チップごとの衝突しない MIDI sidecar を生成する。 */
    splitChips?: boolean;
}

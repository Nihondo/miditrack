import { VGMHeader, VGMCommand, VGMData } from './types';
export declare class VGMParser {
    private buffer;
    private position;
    constructor(buffer: Buffer);
    /** VGM/VGZのBufferを受け取り、必要ならgzipを展開したparserを作成する。 */
    static fromBuffer(buffer: Buffer): VGMParser;
    /** ファイルを読み取り、VGM/VGZを自動判別してparserを作成する。 */
    static fromFile(filePath: string): VGMParser;
    private readUInt32LE;
    private readUInt8;
    private readUInt16LE;
    private seek;
    private ensureAvailable;
    private skipBytes;
    /** VGM圧縮table blockを読み、後続compressed data block用に登録する。 */
    private readCompressionTable;
    /** MSB先行のVGM bit-packed値を一つ読む。 */
    private readPackedValue;
    /** VGM 0x40..0x7E compressed data blockを仕様のcompression headerから展開する。 */
    private decompressDataBlock;
    private readHeaderUInt32LE;
    private readHeaderUInt8;
    /** VGM 1.00/1.01の共有FM clockが属する最初のFM writeを境界通り探索する。 */
    private findLegacyFMChip;
    parseHeader(): VGMHeader;
    /** VGM 1.70 extra header の第二チップclock/volumeリストを安全に読む。
     *
     * volumeはエントリが無ければundefinedのまま（=「未指定」）にする。かつては
     * clockリストが先にvolume:0のプレースホルダを作ってしまい、clockだけ指定
     * されたチップが「音量0（無音）」に見えるバグがあった。isAbsoluteVolumeは
     * Flagsバイトのbit0（絶対値指定か、既定値からの相対値か）。miditrack側は
     * 絶対値のみ採用する。
     */
    private parseExtraHeader;
    private parseCommandStream;
    /** VGMコマンド列を解析し、従来互換のコマンド配列を返します。 */
    parseCommands(header: VGMHeader): VGMCommand[];
    private getUnsupportedCommandOperandCount;
    parse(): VGMData;
    /** 書き込みを捨てず、CLI の警告/strict 判定に使う変換診断を集計する。 */
    private createDiagnostics;
}

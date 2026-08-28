/** VGM 1.72 command/chip metadata. Parser and diagnostics share this single table. */
export declare const CLOCK_MASK = 1073741823;
export declare const DUAL_CHIP_FLAG = 1073741824;
/** Y8950のFM部と共有されない、今回変換対象外のDelta-T ADPCMレジスタ。 */
export declare const Y8950_ADPCM_REGISTERS: ReadonlySet<number>;
/** VGM command operand から第2 chip を選ぶ方法。 */
export interface ChipCommandMetadata {
    chip: string;
    width: number;
    port?: number;
    instance?: number;
    instanceOperand?: number;
    minVersion?: number;
}
/** Header clock-order used by DAC stream target device numbers. */
export declare const STREAM_DEVICE_CHIPS: readonly ["SN76489", "YM2413", "YM2612", "YM2151", "SegaPCM", "RF5C68", "YM2203", "YM2608", "YM2610", "YM3812", "YM3526", "Y8950", "YMF262", "YMF278B", "YMF271", "YMZ280B", "RF5C164", "PWM", "AY8910", "GBDMG", "NESAPU", "MultiPCM", "uPD7759", "MSM6258", "MSM6295", "K051649", "K054539", "HuC6280", "C140", "K053260", "Pokey", "QSound", "SCSP", "WonderSwan", "VSU", "SAA1099", "ES5503", "ES5506", "X1-010", "C352", "GA20", "Mikey", "K007232", "K005289", "MSM5205", "MSM5232", "BSMT2000", "ICS2115"];
/**
 * VGM 1.72 の定義済み chip-write command 一覧。
 * instanceOperand は第1引数（SegaPCMだけ第2引数）の bit 7 で第2 chip を示す。
 */
export declare const COMMAND_CHIPS: Record<number, ChipCommandMetadata>;
/** Command operand length varies before VGM 1.60 at the 0x40 boundary. */
export declare function unsupportedOperandCount(command: number, version: number): number | undefined;
